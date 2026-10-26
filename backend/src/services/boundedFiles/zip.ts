// SHARED (the portfolio worker and the main API: resume parsing). Imports only node's zlib. A small, dependency-free, BOUNDED reader for the ZIP archives a candidate hands us
// (.docx and .pptx are ZIPs). It replaces jszip / mammoth on candidate files because neither can be told "stop at N
// bytes": a 31 KB .docx whose word/document.xml inflates to 40 MB built a DOM of gigabytes and OOM-killed the worker.
//
// The whole design is that nothing here trusts the archive about its own sizes:
//   - the End Of Central Directory record and the central directory are parsed by hand, each field bounds-checked, and the
//     archive is refused outright when they disagree with each other (a directory that is not exactly consumed, an entry
//     count above ZIP_MAX_ENTRIES, zip64 markers we cannot bound, encrypted parts, names that climb out with '..');
//   - an entry is inflated with zlib.inflateRawSync(slice, { maxOutputLength }) where the limit is the SMALLER of the
//     caller's cap and the size the entry declares, so a part that lies about its size is stopped at the cap (or at its
//     own claim) instead of being decompressed, and one that inflates to less than it claimed is refused too;
//   - everything inflated from one archive is added up against ZIP_MAX_TOTAL_INFLATED, so 2,000 honest 5 MB parts cannot
//     add up to 10 GB either.
// The CRC is not checked: nothing here depends on it, and the size checks above already prove the part is what it says.
import zlib from 'zlib';

export const ZIP_MAX_ENTRIES = 2000;
/** Longest entry name accepted. Real OOXML part names are well under 200 bytes. */
export const ZIP_MAX_NAME_BYTES = 1024;
/** Everything read out of one archive, added up. */
export const ZIP_MAX_TOTAL_INFLATED = 24 * 1024 * 1024;
/** What one XML part (document.xml, a slide) may inflate to unless the caller asks for less. */
export const ZIP_MAX_XML_PART_BYTES = 4 * 1024 * 1024;
/** What one picture may inflate to. */
export const ZIP_MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export const BAD_ZIP_REASON = 'This file could not be opened';
export const TOO_MANY_ENTRIES_REASON = 'The file contains too many parts to be opened safely';
export const TOO_BIG_REASON = 'The file expands to more than the size that is opened safely';
export const ENCRYPTED_ZIP_REASON = 'The file is password-protected, so it cannot be opened';

/** A ZIP that must not be opened; `reason` is plain language for HR (never raw text from the file). */
export class ZipGuardError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'ZipGuardError';
  }
}

/**
 * A cap of OURS was reached (this part is larger than the caller allows, or the archive's total budget is spent). Not a
 * sign of a hostile file: a caller reading optional parts (pictures) can stop there and keep what it has.
 */
export class ZipLimitError extends ZipGuardError {
  constructor() {
    super(TOO_BIG_REASON);
    this.name = 'ZipLimitError';
  }
}

const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const EOCD_LENGTH = 22;
/** DEFLATE cannot do better than about 1032:1, so an entry claiming more than that from its compressed size is lying. */
const MAX_DEFLATE_RATIO = 1032;

export interface ZipEntry {
  readonly name: string;
  readonly dir: boolean;
  /** 0 = stored, 8 = deflate. Anything else can be listed but not read. */
  readonly method: number;
  readonly compressedSize: number;
  /** The uncompressed size the central directory claims. Checked against the real output on every read. */
  readonly size: number;
  /** Offset of the compressed bytes inside the archive buffer. */
  readonly dataStart: number;
}

/** True when `name` could climb out of, or sit outside, the archive's own tree ('..' segments, absolute paths, NUL). */
function isUnsafeName(name: string): boolean {
  if (name.includes('\0') || name.startsWith('/') || name.startsWith('\\') || /^[A-Za-z]:/.test(name)) return true;
  return name.split(/[\\/]/).some(segment => segment === '..');
}

/** Offset of the real End Of Central Directory record: the one whose comment reaches exactly to the end of the file. */
function findEndRecord(bytes: Buffer): number {
  const lowest = Math.max(0, bytes.length - EOCD_LENGTH - 0xffff);
  for (let i = bytes.length - EOCD_LENGTH; i >= lowest; i--) {
    if (bytes.readUInt32LE(i) === EOCD_SIG && i + EOCD_LENGTH + bytes.readUInt16LE(i + 20) === bytes.length) return i;
  }
  return -1;
}

export class ZipArchive {
  private readonly byName = new Map<string, ZipEntry>();
  private inflated = 0;

  constructor(
    private readonly bytes: Buffer,
    /** Every entry, in central-directory order. */
    readonly entries: readonly ZipEntry[],
    private readonly totalCap: number,
  ) {
    for (const e of entries) this.byName.set(e.name, e);
  }

  /** The entry with exactly this name, or undefined. */
  find(name: string): ZipEntry | undefined {
    return this.byName.get(name);
  }

  /** Bytes inflated out of this archive so far. */
  get inflatedBytes(): number {
    return this.inflated;
  }

  /** What may still be inflated before the archive's total budget is spent. */
  get inflateLeft(): number {
    return Math.max(0, this.totalCap - this.inflated);
  }

  /**
   * The entry's bytes, never holding more than `maxBytes` (and never more than the entry declares). Throws ZipLimitError
   * when the entry is larger than `maxBytes` or the archive's total budget cannot take it (nothing is inflated then), and
   * ZipGuardError when it cannot be read: an unsupported method, a corrupt stream, or a size that is not what the
   * central directory said.
   */
  inflate(entry: ZipEntry, maxBytes: number): Buffer {
    if (entry.dir || entry.size === 0) return Buffer.alloc(0);
    if (entry.method !== 0 && entry.method !== 8) throw new ZipGuardError(BAD_ZIP_REASON);
    if (entry.size > maxBytes || entry.size > this.inflateLeft) throw new ZipLimitError();

    const compressed = this.bytes.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
    let out: Buffer;
    if (entry.method === 0) {
      out = Buffer.from(compressed);
    } else {
      try {
        // The limit is the entry's own claim: a part that holds more than it declared overflows here and is refused.
        out = zlib.inflateRawSync(compressed, { maxOutputLength: entry.size });
      } catch {
        throw new ZipGuardError(BAD_ZIP_REASON);
      }
    }
    if (out.length !== entry.size) throw new ZipGuardError(BAD_ZIP_REASON);
    this.inflated += out.length;
    return out;
  }
}

/**
 * Parses an archive's directory — nothing is inflated — and refuses it (ZipGuardError) when it is not a plain, honest
 * ZIP: no end record, a multi-disk or zip64 archive, more than ZIP_MAX_ENTRIES entries, a central directory that does
 * not lie exactly between the data and the end record, an encrypted or oddly named entry, a duplicate name, or an entry
 * whose local header, offsets or sizes do not add up.
 */
export function openZip(bytes: Buffer, o: { maxTotalInflated?: number } = {}): ZipArchive {
  const eocd = findEndRecord(bytes);
  if (eocd < 0) throw new ZipGuardError(BAD_ZIP_REASON);
  if (eocd >= 20 && bytes.readUInt32LE(eocd - 20) === ZIP64_LOCATOR_SIG) throw new ZipGuardError(BAD_ZIP_REASON);

  const disk = bytes.readUInt16LE(eocd + 4);
  const directoryDisk = bytes.readUInt16LE(eocd + 6);
  const entriesOnDisk = bytes.readUInt16LE(eocd + 8);
  const count = bytes.readUInt16LE(eocd + 10);
  const directorySize = bytes.readUInt32LE(eocd + 12);
  const directoryStart = bytes.readUInt32LE(eocd + 16);
  // 0xFFFF is also the zip64 marker; either way it is more parts than are opened.
  if (count > ZIP_MAX_ENTRIES) throw new ZipGuardError(TOO_MANY_ENTRIES_REASON);
  if (disk !== 0 || directoryDisk !== 0 || entriesOnDisk !== count) throw new ZipGuardError(BAD_ZIP_REASON);
  if (directorySize === 0xffffffff || directoryStart === 0xffffffff) throw new ZipGuardError(BAD_ZIP_REASON);
  const directoryEnd = directoryStart + directorySize;
  if (directoryEnd > eocd || directorySize < count * 46) throw new ZipGuardError(BAD_ZIP_REASON);

  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let p = directoryStart;
  for (let i = 0; i < count; i++) {
    if (p + 46 > directoryEnd || bytes.readUInt32LE(p) !== CENTRAL_SIG) throw new ZipGuardError(BAD_ZIP_REASON);
    const flags = bytes.readUInt16LE(p + 8);
    const method = bytes.readUInt16LE(p + 10);
    const compressedSize = bytes.readUInt32LE(p + 20);
    const size = bytes.readUInt32LE(p + 24);
    const nameLength = bytes.readUInt16LE(p + 28);
    const extraLength = bytes.readUInt16LE(p + 30);
    const commentLength = bytes.readUInt16LE(p + 32);
    const startDisk = bytes.readUInt16LE(p + 34);
    const localStart = bytes.readUInt32LE(p + 42);
    const next = p + 46 + nameLength + extraLength + commentLength;
    if (next > directoryEnd || nameLength === 0 || nameLength > ZIP_MAX_NAME_BYTES) throw new ZipGuardError(BAD_ZIP_REASON);
    if (flags & 0x41) throw new ZipGuardError(ENCRYPTED_ZIP_REASON);   // bit 0: encrypted, bit 6: strong encryption
    // 0xFFFFFFFF in any of these means "see the zip64 extra field", which is not read.
    if (startDisk !== 0 || compressedSize === 0xffffffff || size === 0xffffffff || localStart === 0xffffffff) throw new ZipGuardError(BAD_ZIP_REASON);

    const name = bytes.toString('utf8', p + 46, p + 46 + nameLength);
    if (isUnsafeName(name) || seen.has(name)) throw new ZipGuardError(BAD_ZIP_REASON);
    seen.add(name);

    // The local header says where the data really starts (its name/extra lengths may differ from the directory's).
    if (localStart + 30 > directoryStart || bytes.readUInt32LE(localStart) !== LOCAL_SIG) throw new ZipGuardError(BAD_ZIP_REASON);
    const dataStart = localStart + 30 + bytes.readUInt16LE(localStart + 26) + bytes.readUInt16LE(localStart + 28);
    if (dataStart + compressedSize > directoryStart) throw new ZipGuardError(BAD_ZIP_REASON);
    if (method === 0 && compressedSize !== size) throw new ZipGuardError(BAD_ZIP_REASON);
    if (method === 8 && size > (compressedSize + 1) * MAX_DEFLATE_RATIO) throw new ZipGuardError(BAD_ZIP_REASON);

    entries.push({ name, dir: name.endsWith('/'), method, compressedSize, size, dataStart });
    p = next;
  }
  // The directory must be exactly the entries the end record counts: more bytes than that is a forged count.
  if (p !== directoryEnd) throw new ZipGuardError(BAD_ZIP_REASON);
  return new ZipArchive(bytes, entries, o.maxTotalInflated ?? ZIP_MAX_TOTAL_INFLATED);
}

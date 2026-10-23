// Test-only: builds ZIP archives byte by byte, including hostile ones (a central directory that lies about sizes, forged
// counts, odd names, encrypted flags). It exists so the tests need no zip library: the reader under test is hand-written,
// and a library cannot produce the dishonest archives that matter here. Never imported by production code.
import { deflateRawSync } from 'zlib';

export interface FixtureEntry {
  name: string;
  data?: Buffer | string;
  /** 0 = stored, 8 = deflate (default). Other numbers are written as given, with the data as it is. */
  method?: number;
  /** Written into the central directory instead of the real uncompressed size. */
  declaredSize?: number;
  /** Written into the central directory instead of the real compressed size. */
  declaredCompressedSize?: number;
  /** General-purpose flag bits (bit 0 = encrypted). */
  flags?: number;
  /** Compressed bytes to use as they are (the real size is then `rawSize`). */
  rawCompressed?: Buffer;
  rawSize?: number;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface BuildOptions {
  comment?: string;
  /** Written into the end record instead of the real entry count. */
  declaredCount?: number;
}

/** A well-formed archive of `entries`, with whatever lies each entry asks for. */
export function buildZip(entries: FixtureEntry[], o: BuildOptions = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = typeof e.data === 'string' ? Buffer.from(e.data) : e.data ?? Buffer.alloc(0);
    const method = e.method ?? 8;
    const name = Buffer.from(e.name, 'utf8');
    const stored = e.rawCompressed ?? (method === 8 ? deflateRawSync(data) : data);
    const size = e.rawCompressed ? e.rawSize ?? 0 : data.length;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(e.flags ?? 0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(e.flags ?? 0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(e.declaredCompressedSize ?? stored.length, 20);
    central.writeUInt32LE(e.declaredSize ?? size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, stored);
    centrals.push(central, name);
    offset += local.length + name.length + stored.length;
  }
  const directory = Buffer.concat(centrals);
  const comment = Buffer.from(o.comment ?? '', 'utf8');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(o.declaredCount ?? entries.length, 8);
  end.writeUInt16LE(o.declaredCount ?? entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...locals, directory, end, comment]);
}

/** A zip of `files` (name -> bytes), deflated. */
export function zipOf(files: Record<string, string | Buffer>): Buffer {
  return buildZip(Object.entries(files).map(([name, data]) => ({ name, data })));
}

/** Offset of the end-of-central-directory record of a zip built here. */
export function endRecordOffset(zip: Buffer): number {
  let at = zip.length - 22;
  while (zip.readUInt32LE(at) !== 0x06054b50) at--;
  return at;
}

/** Rewrites the uncompressed size each central-directory record claims — what a hostile archive does. */
export function patchDeclaredSizes(zip: Buffer, size: (name: string, real: number) => number): Buffer {
  const out = Buffer.from(zip);
  const eocd = endRecordOffset(out);
  let at = out.readUInt32LE(eocd + 16);
  for (let i = 0; i < out.readUInt16LE(eocd + 10); i++) {
    if (out.readUInt32LE(at) !== 0x02014b50) throw new Error('bad central directory in fixture');
    const nameLength = out.readUInt16LE(at + 28);
    const name = out.toString('utf8', at + 46, at + 46 + nameLength);
    out.writeUInt32LE(size(name, out.readUInt32LE(at + 24)), at + 24);
    at += 46 + nameLength + out.readUInt16LE(at + 30) + out.readUInt16LE(at + 32);
  }
  return out;
}

/** A buffer of `count` central-directory records and an end record that says `declaredCount`: a forged entry count. */
export function forgedDirectory(count: number, declaredCount: number): Buffer {
  const name = Buffer.from('a');
  const record = Buffer.alloc(46 + name.length);
  record.writeUInt32LE(0x02014b50, 0);
  record.writeUInt16LE(name.length, 28);
  name.copy(record, 46);
  const directory = Buffer.alloc(record.length * count);
  for (let i = 0; i < count; i++) record.copy(directory, i * record.length);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(declaredCount & 0xffff, 8);
  end.writeUInt16LE(declaredCount & 0xffff, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(0, 16);
  return Buffer.concat([directory, end]);
}

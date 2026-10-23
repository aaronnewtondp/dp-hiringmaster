import { describe, it, expect, vi, afterEach } from 'vitest';
import zlib from 'zlib';
import {
  BAD_ZIP_REASON, ENCRYPTED_ZIP_REASON, TOO_BIG_REASON, TOO_MANY_ENTRIES_REASON, ZIP_MAX_ENTRIES, ZIP_MAX_NAME_BYTES, ZIP_MAX_TOTAL_INFLATED,
  ZipGuardError, ZipLimitError, openZip,
} from './zip.js';
import { buildZip, endRecordOffset, forgedDirectory, patchDeclaredSizes, zipOf } from './zip.fixtures.js';

afterEach(() => { vi.restoreAllMocks(); });

const MB = 1024 * 1024;
const rejects = (bytes: Buffer, reason: string) => {
  let caught: unknown;
  try { openZip(bytes); } catch (e) { caught = e; }
  expect(caught).toBeInstanceOf(ZipGuardError);
  expect((caught as ZipGuardError).reason).toBe(reason);
};

describe('openZip - an ordinary archive', () => {
  it('lists its entries and reads deflated and stored parts exactly as stored', () => {
    const text = 'slide text '.repeat(500);
    const zip = openZip(buildZip([
      { name: 'a.txt', data: text },
      { name: 'dir/', data: '' },
      { name: 'b.bin', data: Buffer.from([1, 2, 3, 4]), method: 0 },
      { name: 'empty.txt', data: '' },
    ]));
    expect(zip.entries.map(e => [e.name, e.dir, e.method, e.size])).toEqual([
      ['a.txt', false, 8, text.length], ['dir/', true, 8, 0], ['b.bin', false, 0, 4], ['empty.txt', false, 8, 0],
    ]);
    expect(zip.inflate(zip.find('a.txt')!, MB).toString()).toBe(text);
    expect([...zip.inflate(zip.find('b.bin')!, MB)]).toEqual([1, 2, 3, 4]);
    expect(zip.inflate(zip.find('empty.txt')!, MB).length).toBe(0);
    expect(zip.inflate(zip.find('dir/')!, MB).length).toBe(0);
    expect(zip.find('missing')).toBeUndefined();
    expect(zip.inflatedBytes).toBe(text.length + 4);
  });

  it('copes with an archive comment after the end record, and with an empty archive', () => {
    const commented = buildZip([{ name: 'a.txt', data: 'x' }], { comment: 'a comment that follows the end record' });
    expect(commented.toString('latin1')).toContain('a comment that follows the end record');
    expect(openZip(commented).entries).toHaveLength(1);
    expect(openZip(buildZip([])).entries).toEqual([]);
  });

  it('reads multi-byte names as UTF-8', () => {
    expect(openZip(buildZip([{ name: 'word/media/schéma-数据.png', data: 'x' }])).entries[0].name).toBe('word/media/schéma-数据.png');
  });

  it('accepts a name that merely contains two dots', () => {
    expect(openZip(zipOf({ 'word/media/a..b.png': 'x', '..hidden': 'y' })).entries).toHaveLength(2);
  });
});

describe('openZip - not a zip, or not an honest one', () => {
  it('refuses anything without a real end record, including bytes that merely contain the signature', () => {
    for (const bytes of [Buffer.from('not a zip at all'), Buffer.alloc(0), Buffer.alloc(10), Buffer.from('PK\x03\x04 but not really')]) rejects(bytes, BAD_ZIP_REASON);
    const trap = Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18), Buffer.from('trailing bytes the comment length does not cover')]);
    rejects(trap, BAD_ZIP_REASON);
    rejects(zipOf({ 'a.txt': 'hello'.repeat(100) }).subarray(0, 40), BAD_ZIP_REASON);
  });

  it(`accepts ${ZIP_MAX_ENTRIES} entries and refuses ${ZIP_MAX_ENTRIES + 1}, before inflating anything`, () => {
    const files = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}.txt`, 'x']));
    const spy = vi.spyOn(zlib, 'inflateRawSync');
    expect(openZip(zipOf(files(ZIP_MAX_ENTRIES))).entries).toHaveLength(ZIP_MAX_ENTRIES);
    rejects(zipOf(files(ZIP_MAX_ENTRIES + 1)), TOO_MANY_ENTRIES_REASON);
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses the zip64 count marker (0xFFFF) and a count wrapped past 16 bits, as too many parts', () => {
    const marker = Buffer.from(zipOf({ 'a.txt': 'x' }));
    marker.writeUInt16LE(0xffff, endRecordOffset(marker) + 10);
    marker.writeUInt16LE(0xffff, endRecordOffset(marker) + 8);
    rejects(marker, TOO_MANY_ENTRIES_REASON);
    // 300,000 real directory records: the 16-bit count wraps to 37,856, which is still far over the cap.
    const started = Date.now();
    rejects(forgedDirectory(300_000, 300_000), TOO_MANY_ENTRIES_REASON);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('refuses a directory that holds more entries than the end record counts (a forged count), without walking it', () => {
    const started = Date.now();
    rejects(forgedDirectory(300_000, 3), BAD_ZIP_REASON);
    const many = Buffer.from(zipOf(Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`f${i}.txt`, 'x']))));
    many.writeUInt16LE(3, endRecordOffset(many) + 8);
    many.writeUInt16LE(3, endRecordOffset(many) + 10);
    rejects(many, BAD_ZIP_REASON);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('refuses multi-disk archives, zip64 locators and 0xFFFFFFFF sizes it cannot bound', () => {
    const base = zipOf({ 'a.txt': 'x' });
    const multi = Buffer.from(base);
    multi.writeUInt16LE(1, endRecordOffset(multi) + 4);
    rejects(multi, BAD_ZIP_REASON);

    const offset = Buffer.from(base);
    offset.writeUInt32LE(0xffffffff, endRecordOffset(offset) + 16);
    rejects(offset, BAD_ZIP_REASON);

    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    const end = endRecordOffset(base);
    rejects(Buffer.concat([base.subarray(0, end), locator, base.subarray(end)]), BAD_ZIP_REASON);

    rejects(patchDeclaredSizes(base, () => 0xffffffff), BAD_ZIP_REASON);
  });

  it('refuses an encrypted part, whatever else the archive holds', () => {
    rejects(buildZip([{ name: 'a.txt', data: 'x' }, { name: 'secret.xml', data: 'y', flags: 0x0801 }]), ENCRYPTED_ZIP_REASON);
    rejects(buildZip([{ name: 'secret.xml', data: 'y', flags: 0x0040 }]), ENCRYPTED_ZIP_REASON);
  });

  it.each([
    ['a dot-dot segment', '../evil.xml'],
    ['a dot-dot in the middle', 'word/../../evil.xml'],
    ['a dot-dot with a backslash', 'word\\..\\evil.xml'],
    ['an absolute path', '/etc/passwd'],
    ['a rooted Windows path', '\\windows\\system32'],
    ['a drive letter', 'C:evil.xml'],
    ['a NUL byte', 'word/doc\0ument.xml'],
  ])('refuses an entry named with %s', (_why, name) => {
    rejects(buildZip([{ name: 'ok.txt', data: 'x' }, { name, data: 'y' }]), BAD_ZIP_REASON);
  });

  it('refuses duplicate names (two parts that could be read as one) and names that are absurdly long', () => {
    rejects(buildZip([{ name: 'word/document.xml', data: 'a' }, { name: 'word/document.xml', data: 'b' }]), BAD_ZIP_REASON);
    rejects(buildZip([{ name: 'a'.repeat(ZIP_MAX_NAME_BYTES + 1), data: 'x' }]), BAD_ZIP_REASON);
    expect(openZip(buildZip([{ name: 'a'.repeat(ZIP_MAX_NAME_BYTES), data: 'x' }])).entries).toHaveLength(1);
  });

  it('refuses a directory that is not exactly where the end record says, and entries whose data cannot be where they claim', () => {
    const base = zipOf({ 'a.txt': 'x'.repeat(100), 'b.txt': 'y'.repeat(100) });
    const shifted = Buffer.from(base);
    shifted.writeUInt32LE(shifted.readUInt32LE(endRecordOffset(shifted) + 16) + 5, endRecordOffset(shifted) + 16);
    rejects(shifted, BAD_ZIP_REASON);

    const pastEnd = Buffer.from(base);
    pastEnd.writeUInt32LE(base.length, endRecordOffset(pastEnd) + 16);
    rejects(pastEnd, BAD_ZIP_REASON);

    const badLocal = Buffer.from(base);
    badLocal.writeUInt32LE(0, 0);   // wipe the first local header signature
    rejects(badLocal, BAD_ZIP_REASON);

    // A compressed size that runs into the central directory.
    rejects(buildZip([{ name: 'a.txt', data: 'x'.repeat(100), declaredCompressedSize: 5000 }]), BAD_ZIP_REASON);
  });

  it('refuses a stored part whose two sizes disagree, and a deflated part that claims an impossible ratio', () => {
    rejects(buildZip([{ name: 'a.bin', data: 'abcd', method: 0, declaredSize: 9 }]), BAD_ZIP_REASON);
    const small = buildZip([{ name: 'a.txt', data: Buffer.alloc(2000) }]);
    rejects(patchDeclaredSizes(small, () => 500 * MB), BAD_ZIP_REASON);
  });
});

describe('ZipArchive.inflate - sizes may lie, memory and work stay bounded', () => {
  it('a part that inflates to more than it declared is stopped at its own claim', () => {
    const spy = vi.spyOn(zlib, 'inflateRawSync');
    const real = 3 * MB;
    const liar = patchDeclaredSizes(zipOf({ 'big.bin': Buffer.alloc(real) }), () => 1000);
    const zip = openZip(liar);
    const started = Date.now();
    expect(() => zip.inflate(zip.find('big.bin')!, 4 * MB)).toThrow(ZipGuardError);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(spy).toHaveBeenCalledTimes(1);
    expect((spy.mock.calls[0][1] as { maxOutputLength: number }).maxOutputLength).toBe(1000);   // never the real size
    expect(zip.inflatedBytes).toBe(0);
  });

  it('a 31 KB part that really inflates to 40 MB is refused by the cap, without a byte being inflated', () => {
    const bomb = zlib.deflateRawSync(Buffer.alloc(40 * MB));
    expect(bomb.length).toBeLessThan(60_000);
    const spy = vi.spyOn(zlib, 'inflateRawSync');
    const zip = openZip(buildZip([{ name: 'word/document.xml', rawCompressed: bomb, rawSize: 40 * MB }]));
    expect(zip.find('word/document.xml')!.size).toBe(40 * MB);   // an honest claim, so the cap refuses it up front
    expect(() => zip.inflate(zip.find('word/document.xml')!, 4 * MB)).toThrow(ZipLimitError);
    expect(spy).not.toHaveBeenCalled();
  });

  it('the same bomb with a small claim is stopped by the claim, never allowed to grow to the cap', () => {
    const bomb = zlib.deflateRawSync(Buffer.alloc(40 * MB));
    const spy = vi.spyOn(zlib, 'inflateRawSync');
    const zip = openZip(buildZip([{ name: 'word/document.xml', rawCompressed: bomb, rawSize: 40 * MB, declaredSize: 20_000 }]));
    const memory = process.memoryUsage().rss;
    expect(() => zip.inflate(zip.find('word/document.xml')!, 4 * MB)).toThrow(ZipGuardError);
    expect((spy.mock.calls[0][1] as { maxOutputLength: number }).maxOutputLength).toBe(20_000);
    expect(process.memoryUsage().rss - memory).toBeLessThan(20 * MB);
  });

  it('a part that inflates to LESS than it declared is refused too', () => {
    const zip = openZip(patchDeclaredSizes(zipOf({ 'a.bin': Buffer.alloc(5000) }), () => 9000));
    expect(() => zip.inflate(zip.find('a.bin')!, MB)).toThrow(ZipGuardError);
    expect(zip.inflatedBytes).toBe(0);
  });

  it('refuses a corrupt deflate stream and a method it does not read, with the generic reason', () => {
    const corrupt = openZip(buildZip([{ name: 'a.bin', rawCompressed: Buffer.alloc(40, 0xff), rawSize: 100 }]));
    expect(() => corrupt.inflate(corrupt.find('a.bin')!, MB)).toThrow(expect.objectContaining({ reason: BAD_ZIP_REASON }));
    const other = openZip(buildZip([{ name: 'a.bin', data: 'abc', method: 9 }]));
    expect(other.entries[0].method).toBe(9);   // listed ...
    expect(() => other.inflate(other.find('a.bin')!, MB)).toThrow(expect.objectContaining({ reason: BAD_ZIP_REASON }));   // ... but never read
  });

  it('an entry larger than the caller allows is a ZipLimitError (a cap of ours), not a hostile-file error', () => {
    const zip = openZip(zipOf({ 'a.xml': 'x'.repeat(5000) }));
    let caught: unknown;
    try { zip.inflate(zip.find('a.xml')!, 4999); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(ZipLimitError);
    expect(caught).toBeInstanceOf(ZipGuardError);
    expect((caught as ZipLimitError).reason).toBe(TOO_BIG_REASON);
    expect(zip.inflate(zip.find('a.xml')!, 5000).length).toBe(5000);   // exactly at the cap is fine
  });

  it('everything read from one archive shares one total budget', () => {
    expect(ZIP_MAX_TOTAL_INFLATED).toBe(24 * MB);
    const zip = openZip(zipOf({ 'a.bin': Buffer.alloc(6000, 1), 'b.bin': Buffer.alloc(6000, 2), 'c.bin': Buffer.alloc(6000, 3) }), { maxTotalInflated: 13_000 });
    expect(zip.inflate(zip.find('a.bin')!, MB).length).toBe(6000);
    expect(zip.inflate(zip.find('b.bin')!, MB).length).toBe(6000);
    expect(zip.inflateLeft).toBe(1000);
    expect(() => zip.inflate(zip.find('c.bin')!, MB)).toThrow(ZipLimitError);
    expect(zip.inflatedBytes).toBe(12_000);
  });

  it('reading the same part again counts again (an overlapping-entries archive cannot multiply its output)', () => {
    const zip = openZip(zipOf({ 'a.bin': Buffer.alloc(6000, 1) }), { maxTotalInflated: 13_000 });
    const entry = zip.find('a.bin')!;
    zip.inflate(entry, MB);
    zip.inflate(entry, MB);
    expect(() => zip.inflate(entry, MB)).toThrow(ZipLimitError);
  });

  it('overlapping entries that share one compressed run are each still bounded by their own claim and the total', () => {
    const bomb = zlib.deflateRawSync(Buffer.alloc(8 * MB));
    const entries = Array.from({ length: 6 }, (_, i) => ({ name: `part${i}.xml`, rawCompressed: bomb, rawSize: 8 * MB }));
    const zip = openZip(buildZip(entries));
    let read = 0;
    let stoppedBy: unknown;
    for (const e of zip.entries) {
      try { read += zip.inflate(e, 8 * MB).length; } catch (error) { stoppedBy = error; break; }
    }
    expect(stoppedBy).toBeInstanceOf(ZipLimitError);
    expect(read).toBeLessThanOrEqual(ZIP_MAX_TOTAL_INFLATED);
    expect(zip.inflatedBytes).toBe(read);
  });
});

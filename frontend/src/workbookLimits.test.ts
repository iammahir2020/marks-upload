import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { checkWorkbookSize, MAX_UNPACKED_BYTES, MAX_WORKBOOK_BYTES } from './workbookLimits';

// A zip containing only a central directory and an end record — enough for
// the gate, which never reads file data, to see what sizes are DECLARED.
function zipDeclaring(entries: { name: string; unpacked: number }[], opts: { zip64Count?: boolean } = {}) {
  const enc = new TextEncoder();
  const headers = entries.map(({ name, unpacked }) => {
    const n = enc.encode(name);
    const h = new DataView(new ArrayBuffer(46 + n.length));
    h.setUint32(0, 0x02014b50, true);
    h.setUint32(20, 100, true); // compressed size
    h.setUint32(24, unpacked, true); // uncompressed size
    h.setUint16(28, n.length, true);
    new Uint8Array(h.buffer).set(n, 46);
    return new Uint8Array(h.buffer);
  });
  const directorySize = headers.reduce((s, h) => s + h.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, opts.zip64Count ? 0xffff : entries.length, true);
  eocd.setUint32(12, directorySize, true);
  eocd.setUint32(16, 0, true);
  const out = new Uint8Array(directorySize + 22);
  let at = 0;
  for (const h of headers) {
    out.set(h, at);
    at += h.length;
  }
  out.set(new Uint8Array(eocd.buffer), at);
  return out.buffer;
}

describe('checkWorkbookSize (issues.md N53)', () => {
  it('lets a real class-list workbook through', async () => {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('data');
    sheet.addRow(['STUDENT ID', 'STUDENT NAME']);
    for (let i = 0; i < 40; i++) sheet.addRow([`21${String(10000 + i)}`, `Student ${i}`]);
    const buffer = new Uint8Array(await wb.xlsx.writeBuffer());
    expect(checkWorkbookSize(buffer)).toBeNull();
  });

  it('refuses a zip that claims to unpack to more than a class list ever could', () => {
    const bomb = zipDeclaring([
      { name: 'xl/worksheets/sheet1.xml', unpacked: 0xfffffffe },
    ]);
    expect(bomb.byteLength).toBeLessThan(200);
    expect(checkWorkbookSize(bomb)).toBe('unpacks_too_large');
  });

  it('adds every part up, so many medium parts are refused too', () => {
    const parts = Array.from({ length: 60 }, (_, i) => ({ name: `p${i}.xml`, unpacked: MAX_UNPACKED_BYTES / 50 }));
    expect(checkWorkbookSize(zipDeclaring(parts))).toBe('unpacks_too_large');
  });

  it('accepts a zip whose parts add up to less than the limit', () => {
    expect(checkWorkbookSize(zipDeclaring([{ name: 'a.xml', unpacked: 16_000 }]))).toBeNull();
  });

  it('refuses ZIP64, which no class list needs', () => {
    expect(checkWorkbookSize(zipDeclaring([{ name: 'a.xml', unpacked: 10 }], { zip64Count: true }))).toBe(
      'unpacks_too_large',
    );
  });

  it('refuses a file over the byte cap without parsing it', () => {
    expect(checkWorkbookSize(new ArrayBuffer(MAX_WORKBOOK_BYTES + 1))).toBe('too_large');
  });

  it('reports something that is not a zip at all as unreadable', () => {
    expect(checkWorkbookSize(new TextEncoder().encode('STUDENT ID,STUDENT NAME\n1,A').buffer)).toBe('not_a_zip');
  });
});

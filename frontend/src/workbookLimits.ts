// A size gate for the class-list workbook, run before ExcelJS unzips a byte
// of it (issues.md N53).
//
// An .xlsx is a zip, and ExcelJS inflates every part of it into memory on
// `xlsx.load`. A zip bomb — a few KB on disk that claims gigabytes — crashes
// the tab, and since the picked file's bytes are also kept in IndexedDB, an
// over-large one bloats storage that every later visit loads. The instructor
// picks this file themselves, but a "shared template" passed between faculty
// is exactly how a hostile one would arrive.
//
// Two limits, because the file size alone does not bound the work:
//
//   - the file itself (MAX_WORKBOOK_BYTES)
//   - what its zip directory says the parts unpack to (MAX_UNPACKED_BYTES)
//
// A real class list is ~5 KB on disk and ~16 KB unpacked (measured on the
// CSE211L marksheet); one that has collected a semester of exam sheets is
// still well under a megabyte. The limits are three orders of magnitude
// above that.
//
// What this does NOT catch: a zip whose directory lies about its sizes.
// Deflate cannot expand by more than ~1032:1, so the file-size cap still
// bounds that case (5 MB -> ~5 GB worst case) — reduced, not eliminated.
// ZIP64 is refused outright: it exists only for archives over 4 GB or 65,535
// entries, which no class list is.

export const MAX_WORKBOOK_BYTES = 5 * 1024 * 1024;
export const MAX_UNPACKED_BYTES = 50 * 1024 * 1024;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const EOCD_MIN_LENGTH = 22;
// The EOCD record sits at the end, after a comment of at most 65,535 bytes.
const EOCD_SEARCH_WINDOW = EOCD_MIN_LENGTH + 0xffff;

export type WorkbookSizeProblem = 'too_large' | 'unpacks_too_large' | 'not_a_zip';

/** null if the workbook is safe to hand to ExcelJS, else why it isn't. */
export function checkWorkbookSize(buffer: ArrayBuffer | Uint8Array): WorkbookSizeProblem | null {
  if (buffer.byteLength > MAX_WORKBOOK_BYTES) return 'too_large';

  const view = buffer instanceof Uint8Array
    ? new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    : new DataView(buffer);
  const eocd = findEocd(view);
  if (eocd === null) return 'not_a_zip';

  const entries = view.getUint16(eocd + 10, true);
  const directorySize = view.getUint32(eocd + 12, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  if (entries === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    return 'unpacks_too_large'; // ZIP64 — see the header comment
  }
  if (directoryOffset + directorySize > eocd) return 'not_a_zip';

  let offset = directoryOffset;
  let unpacked = 0;
  for (let i = 0; i < entries; i++) {
    if (offset + 46 > eocd || view.getUint32(offset, true) !== CENTRAL_HEADER_SIGNATURE) {
      return 'not_a_zip';
    }
    const size = view.getUint32(offset + 24, true);
    if (size === 0xffffffff) return 'unpacks_too_large';
    unpacked += size;
    if (unpacked > MAX_UNPACKED_BYTES) return 'unpacks_too_large';
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

function findEocd(view: DataView): number | null {
  const last = view.byteLength - EOCD_MIN_LENGTH;
  const first = Math.max(0, view.byteLength - EOCD_SEARCH_WINDOW);
  for (let i = last; i >= first; i--) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) return i;
  }
  return null;
}

/** A minimal .zip writer for several downloads in one file. Entries are stored, not compressed. */
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let bit = 0; bit < 8; bit++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n;
});

function crc32(bytes) {
  let crc = -1;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  return ~crc >>> 0;
}

function record(length, write) {
  const view = new DataView(new ArrayBuffer(length));
  write(view);
  return view;
}

/** files: [{ name, data }], where data is a string, Blob or bytes. Names must be unique. */
export async function zipBlob(files) {
  if (files.length > 0xffff) throw new Error('Too many files for one zip.');
  const encoder = new TextEncoder(), entries = [], directory = [];
  const now = new Date();
  const time = now.getHours() << 11 | now.getMinutes() << 5 | now.getSeconds() >> 1;
  const date = Math.max(0, now.getFullYear() - 1980) << 9 | now.getMonth() + 1 << 5 | now.getDate();
  let offset = 0, directorySize = 0;
  for (const { name, data } of files) {
    const bytes = new Uint8Array(await new Blob([data]).arrayBuffer()), path = encoder.encode(name);
    // The entry's own header and its line in the directory share these fields:
    // version 2.0, UTF-8 name, stored, time, date, checksum, both sizes, name length.
    const fields = record(26, view => {
      [20, 0x0800, 0, time, date].forEach((value, i) => view.setUint16(i * 2, value, true));
      view.setUint32(10, crc32(bytes), true);
      view.setUint32(14, bytes.length, true);
      view.setUint32(18, bytes.length, true);
      view.setUint16(22, path.length, true);
    });
    entries.push(record(4, view => view.setUint32(0, 0x04034b50, true)), fields, path, bytes);
    directory.push(record(6, view => { view.setUint32(0, 0x02014b50, true); view.setUint16(4, 20, true); }),
      fields, record(14, view => view.setUint32(10, offset, true)), path);
    offset += 30 + path.length + bytes.length;
    directorySize += 46 + path.length;
    if (offset + directorySize > 0xffffffff) throw new Error('These files are too large for one zip.');
  }
  const end = record(22, view => {
    view.setUint32(0, 0x06054b50, true);
    view.setUint16(8, files.length, true);
    view.setUint16(10, files.length, true);
    view.setUint32(12, directorySize, true);
    view.setUint32(16, offset, true);
  });
  return new Blob([...entries, ...directory, end], { type: 'application/zip' });
}

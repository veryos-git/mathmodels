// static/zip.js must write archives other tools can read. Python's zipfile
// checks every entry's checksum and reads the names and contents back.
import assert from 'node:assert/strict';
import { zipBlob } from '../static/zip.js';

const bytes = Uint8Array.from({ length: 70000 }, (_, i) => i * 31 % 251);
const files = [
  { name: 'gothic-slice-1-1.5mm.svg', data: '<svg xmlns="http://www.w3.org/2000/svg"><title>Höhe 1,5 mm</title></svg>' },
  { name: 'gothic-slice-1-1.5mm.png', data: new Blob([bytes], { type: 'image/png' }) },
  { name: 'Spitzbögen ✂/empty.txt', data: new Uint8Array() },
];
const zip = await zipBlob(files);
assert.equal(zip.type, 'application/zip');

const script = `
import base64, io, json, sys, zipfile
archive = zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))
assert archive.testzip() is None, 'a checksum does not match'
json.dump([[info.filename, info.compress_type, base64.b64encode(archive.read(info)).decode()]
           for info in archive.infolist()], sys.stdout)
`;
const PY = Deno.build.os === 'windows' ? '.venv/Scripts/python.exe' : '.venv/bin/python';
const child = new Deno.Command(PY, {
  args: ['-c', script], stdin: 'piped', stdout: 'piped', stderr: 'piped',
}).spawn();
const writer = child.stdin.getWriter();
await writer.write(new Uint8Array(await zip.arrayBuffer()));
await writer.close();
const result = await child.output();
if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
const entries = JSON.parse(new TextDecoder().decode(result.stdout));

assert.deepEqual(entries.map(([name]) => name), files.map(file => file.name));
assert.ok(entries.every(([, method]) => method === 0), 'entries are stored');
for (const [i, [, , data]] of entries.entries()) {
  const expected = new Uint8Array(await new Blob([files[i].data]).arrayBuffer());
  assert.deepEqual(Uint8Array.from(atob(data), c => c.charCodeAt(0)), expected, files[i].name);
}
assert.equal((await zipBlob([])).size, 22, 'an empty archive is just its end record');
console.log('Zip checks passed: names, contents, checksums, empty archive.');

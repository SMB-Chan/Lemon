'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../core.js');

function rejects(fn, pattern) {
  assert.throws(fn, pattern);
}

// CRC32 canonical check vector.
assert.equal(C.crc32(Buffer.from('123456789')), 0xcbf43926);

// Path hardening: keep normal UTF-8 paths, reject traversal/absolute/control paths.
assert.equal(C.safeZipPath('資料/画像/テスト.png', 'fallback'), '資料/画像/テスト.png');
rejects(() => C.safeZipPath('../secret.txt', 'fallback'), /親ディレクトリ/);
rejects(() => C.safeZipPath('/etc/passwd', 'fallback'), /絶対パス/);
rejects(() => C.safeZipPath('C:\\Windows\\system.ini', 'fallback'), /絶対パス/);
rejects(() => C.safeZipPath('bad\0name', 'fallback'), /NUL|制御文字/);

// Metadata is intentionally strict at the protocol boundary.
assert.equal(C.validateTransferMeta({ id: 'x', name: 'a.bin', size: 0 }).size, 0);
rejects(() => C.validateTransferMeta({ id: 'x', name: 'a.bin', size: -1 }), /ファイルサイズ/);
rejects(() => C.validateGroupMeta({ id: 'g', name: 'folder', size: 10, count: -1 }), /ファイル数/);

// End-of-transfer validation catches truncation and CRC mismatch.
const meta = { size: 9 };
assert.equal(C.verifyEnd(meta, 9, 0x1234, { size: 9, crc: 0x1234 }).ok, true);
assert.equal(C.verifyEnd(meta, 8, 0x1234, { size: 9, crc: 0x1234 }).ok, false);
assert.equal(C.verifyEnd(meta, 9, 0x1234, { size: 9, crc: 0x9999 }).ok, false);

// Streaming ZIP plan must account for headers/descriptors/central directory and keep flags aligned.
const plan = C.planZip([
  { name: 'a.txt', path: 'dir/a.txt', size: 3, mtime: Date.UTC(2026, 0, 1) },
  { name: 'b.bin', path: 'b.bin', size: 5, mtime: Date.UTC(2026, 0, 1) },
]);
assert.equal(plan.entries.length, 2);
assert.ok(plan.totalSize > 8);
assert.equal(new DataView(plan.entries[0].header).getUint16(6, true), C.ZIP_STREAM_FLAGS);
const central = C.buildCentralRecord({
  nameBytes: plan.entries[0].nameBytes,
  crc: 0,
  size: plan.entries[0].size,
  offset: plan.entries[0].offset,
  time: plan.entries[0].time,
  date: plan.entries[0].date,
  flags: C.ZIP_STREAM_FLAGS,
});
assert.equal(new DataView(central).getUint16(8, true), C.ZIP_STREAM_FLAGS);

// Partitioning preserves oversized single files as their own part instead of looping or dropping them.
const fake = (size) => ({ file: { size } });
assert.deepEqual(C.partitionEntries([fake(6), fake(6), fake(2)], 10).map((p) => p.length), [1, 2]);
assert.deepEqual(C.partitionEntries([fake(20), fake(1)], 10).map((p) => p.length), [1, 1]);

// Browser application must at least parse as JavaScript without executing DOM code.
const appPath = path.join(__dirname, '..', 'app.js');
const appSource = fs.readFileSync(appPath, 'utf8');
assert.doesNotThrow(() => new Function(appSource));

// The HTML entrypoint must load dependencies in the expected order.
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const peerAt = html.indexOf('peerjs.min.js');
const qrAt = html.indexOf('qrcode.min.js');
const coreAt = html.indexOf('core.js');
const appAt = html.indexOf('app.js');
assert.ok(peerAt >= 0 && qrAt > peerAt && coreAt > qrAt && appAt > coreAt, 'script loading order is invalid');

console.log('Lemon smoke tests passed');

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../core.js');
const Pair = require('../pairing-core.js');

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

// Pairing core basics are available to both browser and Node tests.
const fixedSecret = Pair.toBase64Url(new Uint8Array(16));
assert.equal(Pair.parseShareCode(Pair.formatShareCode('drop-test', fixedSecret)).paired, true);

// Browser scripts must at least parse as JavaScript without executing DOM code.
const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const pairingSource = fs.readFileSync(path.join(__dirname, '..', 'pairing.js'), 'utf8');
const pairingCoreSource = fs.readFileSync(path.join(__dirname, '..', 'pairing-core.js'), 'utf8');
assert.doesNotThrow(() => new Function(appSource));
assert.doesNotThrow(() => new Function(pairingSource));
assert.doesNotThrow(() => new Function(pairingCoreSource));
assert.ok(pairingSource.includes("'#peer=' + encodeURIComponent(token)"), 'new pairing URLs must place the secret in the fragment');
assert.ok(pairingSource.includes('channelBindingFromSdps'), 'pairing must bind HMAC proof to DTLS fingerprints');
assert.ok(pairingSource.includes('AUTH_VERSION = 2'), 'unexpected pairing protocol version');
assert.ok(!/metadata\s*:\s*[^,}]*secret/i.test(pairingSource), 'pairing secret must not be placed in PeerJS metadata');

// Entry point dependency order and supply-chain policy.
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const peerUrl = 'https://cdnjs.cloudflare.com/ajax/libs/peerjs/1.5.5/peerjs.min.js';
const qrUrl = 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js';
const peerSri = 'sha512-XEKeWX+mI3Ov+tg2evDlVQFzVOIp4T8J3cNcCEPaEUGpxJV3eZaN8rHuvnFPvQpGJBHPmrozJDMpm2xcDvtmyQ==';
const qrSri = 'sha512-ZDSPMa/JM1D+7kdg2x3BsruQ6T/JpJo3jWDWkCZsP+5yVyp1KfESqLI+7RqB5k24F7p2cV7i2YHh/890y6P6Sw==';
const styleAt = html.indexOf('href="./styles.css"');
const peerAt = html.indexOf(peerUrl);
const qrAt = html.indexOf(qrUrl);
const pairingCoreAt = html.indexOf('src="./pairing-core.js"');
const pairingAt = html.indexOf('src="./pairing.js"');
const coreAt = html.indexOf('src="./core.js"');
const appAt = html.indexOf('src="./app.js"');
assert.ok(
  styleAt >= 0 && peerAt > styleAt && qrAt > peerAt && pairingCoreAt > qrAt
  && pairingAt > pairingCoreAt && coreAt > pairingAt && appAt > coreAt,
  'resource loading order is invalid'
);
assert.ok(html.includes(`integrity="${peerSri}"`), 'PeerJS SRI is missing or changed');
assert.ok(html.includes(`integrity="${qrSri}"`), 'QR SRI is missing or changed');
assert.ok(!html.includes('unpkg.com'), 'unpkg must not be part of the runtime trust surface');
assert.ok(!/<style(?:\s|>)/i.test(html), 'inline style blocks are forbidden by CSP');

const cspMatch = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i);
assert.ok(cspMatch, 'CSP meta policy is missing');
const csp = cspMatch[1];
for (const required of [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "script-src 'self' https://cdnjs.cloudflare.com",
  "style-src 'self'",
  "connect-src 'self' https://0.peerjs.com wss://0.peerjs.com",
]) {
  assert.ok(csp.includes(required), `CSP directive missing: ${required}`);
}
assert.ok(!csp.includes("'unsafe-inline'"), 'CSP must not allow unsafe-inline');
assert.ok(!csp.includes("'unsafe-eval'"), 'CSP must not allow unsafe-eval');

// Every remote script must be pinned with SRI, anonymous CORS and no referrer.
const remoteScripts = [...html.matchAll(/<script\b([^>]*\bsrc="https:\/\/[^\"]+"[^>]*)><\/script>/gi)];
assert.equal(remoteScripts.length, 2, 'unexpected number of remote scripts');
for (const [, attrs] of remoteScripts) {
  assert.match(attrs, /\bintegrity="sha512-[^"]+"/i);
  assert.match(attrs, /\bcrossorigin="anonymous"/i);
  assert.match(attrs, /\breferrerpolicy="no-referrer"/i);
}

const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
assert.ok(css.includes(':root'), 'styles.css appears incomplete');

console.log('Lemon smoke tests passed');

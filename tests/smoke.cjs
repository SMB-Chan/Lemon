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

// Browser modules must at least parse as JavaScript without executing DOM code.
for (const file of ['diagnostics.js', 'app.js']) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  assert.doesNotThrow(() => new Function(source), `${file} has a syntax error`);
}

// Entry point dependency order and supply-chain policy.
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const lock = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'third-party-lock.json'), 'utf8'));
assert.equal(lock.schema, 1, 'unsupported third-party lock schema');
assert.equal(lock.policy.runtimeScriptOrigin, 'https://cdnjs.cloudflare.com');
assert.equal(lock.policy.requireExactVersion, true, 'dependency versions must remain exact');
assert.equal(lock.policy.requireSri, 'sha512', 'runtime dependencies must remain SHA-512 pinned');
assert.equal(lock.policy.allowRemoteScripts, 2, 'unexpected remote-script allowance');
assert.equal(lock.dependencies.length, lock.policy.allowRemoteScripts, 'lock dependency count mismatch');

const names = new Set();
for (const dep of lock.dependencies) {
  assert.equal(typeof dep.name, 'string');
  assert.ok(dep.name && !names.has(dep.name), `duplicate dependency: ${dep.name}`);
  names.add(dep.name);
  assert.match(dep.version, /^\d+\.\d+\.\d+$/, `${dep.name} must use an exact semver`);
  assert.ok(dep.url.startsWith(lock.policy.runtimeScriptOrigin + '/'), `${dep.name} escaped the pinned CDN origin`);
  assert.ok(dep.url.includes(`/${dep.version}/`), `${dep.name} URL does not contain its exact version`);
  assert.match(dep.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/, `${dep.name} SRI is not SHA-512`);
  assert.equal(dep.license, 'MIT', `${dep.name} license changed; review notices explicitly`);
  assert.match(dep.upstream, /^https:\/\/github\.com\//, `${dep.name} upstream must be reviewable`);
  assert.ok(html.includes(`src="${dep.url}"`), `${dep.name} runtime URL diverged from lock`);
  assert.ok(html.includes(`integrity="${dep.integrity}"`), `${dep.name} runtime SRI diverged from lock`);
}

const styleAt = html.indexOf('./styles.css');
const peerAt = html.indexOf(lock.dependencies.find((d) => d.name === 'peerjs').url);
const qrAt = html.indexOf(lock.dependencies.find((d) => d.name === 'qrcode-generator').url);
const coreAt = html.indexOf('core.js');
const diagAt = html.indexOf('diagnostics.js');
const appAt = html.indexOf('app.js');
assert.ok(
  styleAt >= 0 && peerAt > styleAt && qrAt > peerAt && coreAt > qrAt && diagAt > coreAt && appAt > diagAt,
  'resource loading order is invalid'
);
assert.ok(html.includes('id="diag-refresh"'), 'diagnostics refresh control is missing');
assert.ok(html.includes('id="diag-output"'), 'diagnostics output container is missing');
assert.ok(!html.includes('unpkg.com'), 'unpkg must not be part of the runtime trust surface');
assert.ok(!/<style(?:\s|>)/i.test(html), 'inline style blocks are forbidden by CSP');

const cspMatch = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i);
assert.ok(cspMatch, 'CSP meta policy is missing');
const csp = cspMatch[1];
for (const required of [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  `script-src 'self' ${lock.policy.runtimeScriptOrigin}`,
  "style-src 'self'",
  "connect-src 'self' https://0.peerjs.com wss://0.peerjs.com",
]) {
  assert.ok(csp.includes(required), `CSP directive missing: ${required}`);
}
assert.ok(!csp.includes("'unsafe-inline'"), 'CSP must not allow unsafe-inline');
assert.ok(!csp.includes("'unsafe-eval'"), 'CSP must not allow unsafe-eval');

// Every remote script must be exactly represented in the dependency lock.
const remoteScripts = [...html.matchAll(/<script\b([^>]*\bsrc="(https:\/\/[^\"]+)"[^>]*)><\/script>/gi)];
assert.equal(remoteScripts.length, lock.policy.allowRemoteScripts, 'unexpected number of remote scripts');
for (const [, attrs, src] of remoteScripts) {
  const dep = lock.dependencies.find((item) => item.url === src);
  assert.ok(dep, `remote script is not locked: ${src}`);
  assert.ok(attrs.includes(`integrity="${dep.integrity}"`), `runtime SRI mismatch: ${dep.name}`);
  assert.match(attrs, /\bcrossorigin="anonymous"/i);
  assert.match(attrs, /\breferrerpolicy="no-referrer"/i);
}

const notices = fs.readFileSync(path.join(__dirname, '..', 'THIRD_PARTY_NOTICES.md'), 'utf8');
assert.ok(notices.includes('third-party-lock.json'), 'third-party notice must point to the canonical lock');
for (const dep of lock.dependencies) {
  assert.ok(notices.includes(dep.url), `${dep.name} URL missing from notices`);
  assert.ok(notices.includes(dep.integrity), `${dep.name} SRI missing from notices`);
}

const diagnostics = fs.readFileSync(path.join(__dirname, '..', 'diagnostics.js'), 'utf8');
for (const token of ['getStats', 'selectedCandidatePairId', 'candidate-pair', 'availableOutgoingBitrate', 'maxMessageSize', 'bufferedAmount']) {
  assert.ok(diagnostics.includes(token), `diagnostics coverage missing: ${token}`);
}

const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
assert.ok(css.includes(':root'), 'styles.css appears incomplete');
assert.ok(css.includes('.diag-peer'), 'diagnostics styles are missing');

console.log('Lemon smoke tests passed');

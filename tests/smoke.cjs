'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../core.js');
const A = require('../auth.js');

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

// Authenticated pairing uses a canonical 128-bit capability secret.
const zeroSecret = 'AAAAAAAAAAAAAAAAAAAAAA';
assert.equal(A.validateSecret(zeroSecret), zeroSecret);
assert.equal(A.decodeBase64Url(zeroSecret).byteLength, 16);
assert.equal(A.encodeBase64Url(A.decodeBase64Url(zeroSecret)), zeroSecret);
rejects(() => A.validateSecret('short'), /認証秘密/);
rejects(() => A.validateSecret('AAAAAAAAAAAAAAAAAAAAA!'), /認証秘密/);

const invite = A.makeInvite('drop-testpeer2', zeroSecret);
assert.equal(invite, 'drop-testpeer2~' + zeroSecret);
assert.deepEqual(A.parseInvite(invite), {
  peerId: 'drop-testpeer2',
  secret: zeroSecret,
  invite,
});
assert.deepEqual(A.parseInvite('https://example.test/lemon/#peer=' + encodeURIComponent(invite)), {
  peerId: 'drop-testpeer2',
  secret: zeroSecret,
  invite,
});
assert.deepEqual(A.parseInvite('https://example.test/lemon/?peer=drop-testpeer2&key=' + zeroSecret), {
  peerId: 'drop-testpeer2',
  secret: zeroSecret,
  invite,
});

// Pairing URLs keep the capability in the fragment rather than the HTTP request query.
const pairingUrl = new URL(A.makePairingUrl('https://example.test/lemon/?debug=1&peer=legacy#view=diag', invite));
assert.equal(pairingUrl.searchParams.get('debug'), '1');
assert.equal(pairingUrl.searchParams.has('peer'), false);
assert.equal(new URLSearchParams(pairingUrl.hash.slice(1)).get('peer'), invite);

// DTLS fingerprint channel binding is deterministic across endpoint order.
const localSdp = 'v=0\r\na=fingerprint:sha-256 AA:BB:CC\r\n';
const remoteSdp = 'v=0\r\na=fingerprint:sha-256 11:22:33\r\n';
const bindingA = A.channelBindingFromSdps(localSdp, remoteSdp);
const bindingB = A.channelBindingFromSdps(remoteSdp, localSdp);
assert.equal(bindingA, bindingB);
assert.ok(bindingA.includes('sha-256:AA:BB:CC'));
assert.ok(bindingA.includes('sha-256:11:22:33'));
rejects(() => A.channelBindingFromSdps(localSdp, ''), /フィンガープリント/);

// Mutual proofs are role-separated even when every other transcript field is identical.
const responderTranscript = A.authTranscript('responder', 'drop-r', 'drop-i', zeroSecret, bindingA);
const initiatorTranscript = A.authTranscript('initiator', 'drop-r', 'drop-i', zeroSecret, bindingA);
assert.notEqual(responderTranscript, initiatorTranscript);
assert.ok(responderTranscript.startsWith('lemon-auth/v1\nresponder\n'));
assert.ok(initiatorTranscript.startsWith('lemon-auth/v1\ninitiator\n'));

// Browser modules must at least parse as JavaScript without executing DOM code.
for (const file of ['auth.js', 'diagnostics.js', 'pairing-ui.js', 'app.js']) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  assert.doesNotThrow(() => new Function(source), `${file} has a syntax error`);
}

// Entry point dependency order and machine-verifiable supply-chain policy.
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const lock = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'third-party-lock.json'), 'utf8'));
assert.equal(lock.schema, 1, 'unsupported third-party lock schema');
assert.equal(lock.policy.runtimeScriptOrigin, 'https://cdnjs.cloudflare.com');
assert.equal(lock.policy.requireExactVersion, true, 'dependency versions must remain exact');
assert.equal(lock.policy.requireSri, 'sha512', 'runtime dependencies must remain SHA-512 pinned');
assert.equal(lock.policy.allowRemoteScripts, 2, 'unexpected remote-script allowance');
assert.equal(lock.dependencies.length, lock.policy.allowRemoteScripts, 'lock dependency count mismatch');

const dependencyNames = new Set();
for (const dep of lock.dependencies) {
  assert.equal(typeof dep.name, 'string');
  assert.ok(dep.name && !dependencyNames.has(dep.name), `duplicate dependency: ${dep.name}`);
  dependencyNames.add(dep.name);
  assert.match(dep.version, /^\d+\.\d+\.\d+$/, `${dep.name} must use an exact semver`);
  assert.ok(dep.url.startsWith(lock.policy.runtimeScriptOrigin + '/'), `${dep.name} escaped the pinned CDN origin`);
  assert.ok(dep.url.includes(`/${dep.version}/`), `${dep.name} URL does not contain its exact version`);
  assert.match(dep.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/, `${dep.name} SRI is not SHA-512`);
  assert.equal(dep.license, 'MIT', `${dep.name} license changed; review notices explicitly`);
  assert.match(dep.upstream, /^https:\/\/github\.com\//, `${dep.name} upstream must be reviewable`);
  assert.ok(html.includes(`src="${dep.url}"`), `${dep.name} runtime URL diverged from lock`);
  assert.ok(html.includes(`integrity="${dep.integrity}"`), `${dep.name} runtime SRI diverged from lock`);
}

const peerDep = lock.dependencies.find((d) => d.name === 'peerjs');
const qrDep = lock.dependencies.find((d) => d.name === 'qrcode-generator');
assert.ok(peerDep && qrDep, 'required runtime dependencies are missing from lock');

const styleAt = html.indexOf('./styles.css');
const peerAt = html.indexOf(peerDep.url);
const qrAt = html.indexOf(qrDep.url);
const authAt = html.indexOf('auth.js');
const coreAt = html.indexOf('core.js');
const diagAt = html.indexOf('diagnostics.js');
const pairingAt = html.indexOf('pairing-ui.js');
const appAt = html.indexOf('app.js');
assert.ok(
  styleAt >= 0 && peerAt > styleAt && qrAt > peerAt && authAt > qrAt && coreAt > authAt &&
  diagAt > coreAt && pairingAt > diagAt && appAt > pairingAt,
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

const authSource = fs.readFileSync(path.join(__dirname, '..', 'auth.js'), 'utf8');
for (const token of ['HMAC', 'SHA-256', 'lemon-auth-challenge', 'lemon-auth-response', 'lemon-auth-ok', 'localDescription', 'remoteDescription']) {
  assert.ok(authSource.includes(token), `authentication coverage missing: ${token}`);
}
assert.ok(!authSource.includes('console.log'), 'authentication code must not log pairing material');

const pairingSource = fs.readFileSync(path.join(__dirname, '..', 'pairing-ui.js'), 'utf8');
assert.ok(pairingSource.includes('history.replaceState'), 'pairing URL must be scrubbed after capture');
assert.ok(pairingSource.includes('makePairingUrl'), 'pairing UI must generate fragment-based URLs');

const diagnostics = fs.readFileSync(path.join(__dirname, '..', 'diagnostics.js'), 'utf8');
for (const token of ['getStats', 'selectedCandidatePairId', 'candidate-pair', 'availableOutgoingBitrate', 'maxMessageSize', 'bufferedAmount']) {
  assert.ok(diagnostics.includes(token), `diagnostics coverage missing: ${token}`);
}

const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
assert.ok(css.includes(':root'), 'styles.css appears incomplete');
assert.ok(css.includes('.diag-peer'), 'diagnostics styles are missing');

console.log('Lemon smoke tests passed');

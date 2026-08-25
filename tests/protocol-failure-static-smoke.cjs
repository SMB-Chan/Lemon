'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'tests/live-protocol-failure-smoke.mjs'), 'utf8');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/browser-smoke.yml'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

for (const token of [
  'bad-end-good-id',
  'bad-end-wrong-id',
  'wrong end ID connection close',
  "name: 'oversize.bin', size: 32",
  'new Uint8Array(64).buffer',
  'oversized payload connection close',
  'malformed receives created a Blob download URL',
  'definitely-another-transfer-id',
  'wrong transfer-ID flow did not stall sender',
  '6 * 1024 * 1024',
  'wrong-ID flow frame caused data loss or sender stall',
  'wrong end ID + oversized payload fail-closed + wrong flow ID ignored',
]) {
  assert.ok(source.includes(token), `protocol-failure browser invariant missing: ${token}`);
}

assert.match(source, /authenticated connection timed out: malicious Peer open/,
  'malicious Peer bootstrap timeout must be explicitly retry-classifiable');
assert.match(source, /authenticated connection timed out: malicious DataConnection open/,
  'malicious DataConnection bootstrap timeout must be explicitly retry-classifiable');
assert.doesNotMatch(source, /console\.log\([^\n]*invite/i,
  'protocol-failure smoke must not log authenticated invites');
assert.match(workflow,
  /node tests\/run-browser-smoke\.mjs tests\/live-protocol-failure-smoke\.mjs "\$LEMON_URL"/,
  'production workflow must run malformed protocol smoke through scoped bootstrap retry');
assert.match(pkg.scripts.test, /node --check tests\/live-protocol-failure-smoke\.mjs/,
  'normal CI must syntax-check malformed protocol browser smoke');
assert.equal(pkg.version, '1.3.8', 'CI-only malformed protocol coverage must not change runtime version');

console.log('Lemon malformed protocol static tests passed');

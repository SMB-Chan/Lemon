'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const runner = fs.readFileSync(path.join(root, 'tests/run-browser-smoke.mjs'), 'utf8');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/browser-smoke.yml'), 'utf8');

assert.match(runner, /const MAX_ATTEMPTS = 3;/, 'browser retry attempts changed unexpectedly');
assert.match(runner, /authenticated connection timed out/i, 'retry boundary must remain connection-bootstrap timeout only');
assert.match(runner, /outside the retryable connection-bootstrap boundary; not retrying/, 'non-retryable failures must fail immediately');
assert.match(runner, /combined\.length > 128 \* 1024/, 'retry runner must bound captured output');
assert.doesNotMatch(runner, /RETRYABLE\s*=\s*\/.+(?:SHA|CRC|abort|integrity|payload|transfer|protocol)/i,
  'retry predicate must not include transfer/integrity/protocol failures');

for (const script of [
  'tests/live-direct-save-smoke.mjs',
  'tests/live-direct-interrupt-smoke.mjs',
  'tests/live-protocol-failure-smoke.mjs',
]) {
  const escaped = script.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(workflow, new RegExp(`node tests/run-browser-smoke\\.mjs ${escaped}`),
    `production workflow must use scoped retry runner for ${script}`);
}
assert.doesNotMatch(workflow, /run-browser-smoke\.mjs tests\/live-auth-zip-smoke\.mjs/,
  'auth/ZIP smoke should not be broadened into retry scope without evidence');
assert.doesNotMatch(workflow, /run-browser-smoke\.mjs tests\/live-browser-smoke\.mjs/,
  'base browser smoke should not be broadened into retry scope without evidence');

console.log('Lemon browser retry-runner tests passed');

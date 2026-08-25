'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const CP = require('../connection-policy.js');
const Caps = require('../capabilities.js');

const rootDir = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(rootDir, p), 'utf8');

// Simultaneous cross-connects must deterministically converge on one direction.
assert.equal(CP.preferredDirection('drop-a', 'drop-b'), 'outgoing');
assert.equal(CP.preferredDirection('drop-b', 'drop-a'), 'incoming');
assert.throws(() => CP.preferredDirection('drop-a', 'drop-a'), /同一Peer/);
assert.equal(CP.shouldReplaceExisting('drop-a', 'drop-b', false, true, false), true,
  'smaller peer should replace pending incoming with outgoing');
assert.equal(CP.shouldReplaceExisting('drop-b', 'drop-a', true, false, false), true,
  'larger peer should replace pending outgoing with incoming');
assert.equal(CP.shouldReplaceExisting('drop-a', 'drop-b', true, false, false), false,
  'non-preferred new direction must not replace');
assert.equal(CP.shouldReplaceExisting('drop-a', 'drop-b', false, true, true), false,
  'an established connection must not be replaced');
assert.equal(CP.shouldReplaceExisting('drop-a', 'drop-b', true, true, false), false,
  'same-direction duplicates must not replace');

// Flow-control frames are scoped to the exact currently active standalone transfer.
assert.equal(Caps.validFlowMessage({ t: 'lemon-flow', c: Caps.CAP_VERSION, id: 'm1', paused: true }, 'm1'), true);
assert.equal(Caps.validFlowMessage({ t: 'lemon-flow', c: Caps.CAP_VERSION, id: 'other', paused: true }, 'm1'), false);
assert.equal(Caps.validFlowMessage({ t: 'lemon-flow', c: Caps.CAP_VERSION + 1, id: 'm1', paused: true }, 'm1'), false);
assert.equal(Caps.validFlowMessage({ t: 'lemon-flow', c: Caps.CAP_VERSION, id: 'm1', paused: 'yes' }, 'm1'), false);
assert.equal(Caps.validFlowMessage({ t: 'lemon-flow', c: Caps.CAP_VERSION, id: 'm1', paused: false }, null), false);

// Browser modules introduced by the stabilization layer must parse.
for (const file of ['connection-policy.js', 'capabilities.js', 'app.js']) {
  assert.doesNotThrow(() => new Function(read(file)), `${file} has a syntax error`);
}

const app = read('app.js');
for (const token of [
  'CP.shouldReplaceExisting',
  '_lemonOutgoing',
  'connections.get(remoteId) === conn',
]) {
  assert.ok(app.includes(token), `simultaneous-connection hardening missing: ${token}`);
}

const caps = read('capabilities.js');
for (const token of [
  'directWakeLockRequest',
  'releaseDirectState',
  'activeOutgoingId',
  'validFlowMessage(data, state.activeOutgoingId)',
]) {
  assert.ok(caps.includes(token), `capability hardening missing: ${token}`);
}

// Every third-party GitHub Action must be pinned to an immutable 40-hex commit.
for (const workflow of ['.github/workflows/test.yml', '.github/workflows/jekyll-gh-pages.yml']) {
  const source = read(workflow);
  const usesLines = source.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith('uses:'));
  assert.ok(usesLines.length > 0, `${workflow} contains no action references`);
  for (const line of usesLines) {
    const match = line.match(/^uses:\s+([^\s#]+)(?:\s+#.*)?$/);
    assert.ok(match, `cannot parse action reference: ${line}`);
    assert.match(match[1], /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/,
      `mutable or non-SHA action reference: ${line}`);
  }
  assert.doesNotMatch(source, /uses:\s+[^\s]+@v\d+/i, `${workflow} contains a mutable major tag`);
}

const pagesWorkflow = read('.github/workflows/jekyll-gh-pages.yml');
assert.ok(!pagesWorkflow.includes('jekyll-build-pages'), 'Pages must not run an unnecessary Jekyll build action');
assert.ok(pagesWorkflow.includes('pages-files.txt'), 'Pages build must use the explicit runtime allowlist');
assert.ok(pagesWorkflow.includes('path: ./_site'), 'Pages upload must publish only the constructed artifact');

// The Pages artifact is an explicit, unique set of runtime files only.
const manifest = read('pages-files.txt').split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'));
assert.equal(new Set(manifest).size, manifest.length, 'Pages manifest contains duplicate paths');
for (const file of manifest) {
  assert.equal(path.isAbsolute(file), false, `absolute Pages path is forbidden: ${file}`);
  assert.ok(!file.includes('..'), `parent traversal is forbidden in Pages manifest: ${file}`);
  assert.ok(!file.startsWith('.github/'), 'workflow files must not be deployed');
  assert.ok(!file.startsWith('tests/'), 'test files must not be deployed');
  assert.ok(fs.statSync(path.join(rootDir, file)).isFile(), `Pages runtime file is missing: ${file}`);
}
for (const forbidden of ['README.md', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md', 'package.json', 'third-party-lock.json']) {
  assert.ok(!manifest.includes(forbidden), `non-runtime repository file leaked into Pages artifact: ${forbidden}`);
}

const html = read('index.html');
const localScripts = [...html.matchAll(/<script\b[^>]*\bsrc="\.\/([^\"]+)"[^>]*><\/script>/gi)].map((m) => m[1]);
const localStyles = [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="\.\/([^\"]+)"[^>]*>/gi)].map((m) => m[1]);
for (const file of [...localScripts, ...localStyles, 'index.html']) {
  assert.ok(manifest.includes(file), `HTML runtime dependency is absent from Pages manifest: ${file}`);
}
const policyAt = html.indexOf('./connection-policy.js');
const appAt = html.indexOf('./app.js');
assert.ok(policyAt >= 0 && appAt > policyAt, 'connection-policy.js must load before app.js');

console.log('Lemon stability/security tests passed');

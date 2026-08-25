'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const rootDir = path.join(__dirname, '..');
const guardSource = fs.readFileSync(path.join(rootDir, 'auth-guard.js'), 'utf8');
assert.doesNotThrow(() => new Function(guardSource), 'auth-guard.js has a syntax error');

function makeDocument() {
  const elements = new Map();
  for (const id of ['status', 'connect-btn', 'file-btn', 'folder-btn']) {
    elements.set(id, { id, disabled: false, textContent: '', className: '' });
  }
  return {
    getElementById(id) { return elements.get(id) || null; },
    elements,
  };
}

function runGuard(overrides = {}) {
  const document = makeDocument();
  const Peer = overrides.Peer === undefined ? function Peer() {} : overrides.Peer;
  if (overrides.wrapped !== false && typeof Peer === 'function') {
    Object.defineProperty(Peer, '__lemonAuthWrapped', { value: true, configurable: true });
  }
  const window = {
    Peer,
    LemonAuth: overrides.LemonAuth || { install: () => true },
    crypto: overrides.crypto === undefined ? {
      getRandomValues(bytes) { return bytes; },
      subtle: {},
    } : overrides.crypto,
    document,
    setTimeout(fn) { fn(); return 1; },
  };
  window.window = window;
  const context = vm.createContext({ window, setTimeout: window.setTimeout });
  vm.runInContext(guardSource, context, { filename: 'auth-guard.js' });
  return { window, document };
}

// Normal authenticated wrapper remains usable.
{
  const { window, document } = runGuard();
  assert.equal(window.__LEMON_AUTH_GUARD__.ok, true);
  assert.equal(typeof window.Peer, 'function');
  assert.equal(document.elements.get('connect-btn').disabled, false);
}

// If auth installation is missing/broken, the raw PeerJS constructor is removed.
{
  function RawPeer() {}
  const { window, document } = runGuard({
    Peer: RawPeer,
    wrapped: false,
    LemonAuth: { install: () => false },
  });
  assert.equal(window.__LEMON_AUTH_GUARD__.ok, false);
  assert.equal(window.Peer, undefined);
  assert.equal(document.elements.get('connect-btn').disabled, true);
  assert.equal(document.elements.get('file-btn').disabled, true);
  assert.equal(document.elements.get('folder-btn').disabled, true);
  assert.match(document.elements.get('status').textContent, /停止しました/);
}

// Web Crypto is mandatory; do not silently fall back to unauthenticated PeerJS.
{
  const { window } = runGuard({
    crypto: { getRandomValues(bytes) { return bytes; }, subtle: null },
  });
  assert.equal(window.__LEMON_AUTH_GUARD__.ok, false);
  assert.equal(window.Peer, undefined);
  assert.match(window.__LEMON_AUTH_GUARD__.reason, /Web Crypto/);
}

// A timing retry is allowed, but only success that leaves a wrapped constructor is accepted.
{
  function RawPeer() {}
  const auth = {
    install() {
      Object.defineProperty(RawPeer, '__lemonAuthWrapped', { value: true, configurable: true });
      return true;
    },
  };
  const { window } = runGuard({ Peer: RawPeer, wrapped: false, LemonAuth: auth });
  assert.equal(window.__LEMON_AUTH_GUARD__.ok, true);
  assert.equal(window.Peer.__lemonAuthWrapped, true);
}

// The guard must execute after pairing helpers but before app.js can touch Peer.
const html = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');
const authAt = html.indexOf('./auth.js');
const pairingAt = html.indexOf('./pairing-ui.js');
const guardAt = html.indexOf('./auth-guard.js');
const appAt = html.indexOf('./app.js');
assert.ok(authAt >= 0 && pairingAt > authAt && guardAt > pairingAt && appAt > guardAt,
  'authentication guard must run before app.js');

for (const token of ['__lemonAuthWrapped', 'Web Crypto API', 'root.Peer = undefined', '__LEMON_AUTH_GUARD__']) {
  assert.ok(guardSource.includes(token), `auth guard coverage missing: ${token}`);
}

console.log('Lemon authentication guard tests passed');

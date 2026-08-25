'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Pair = require('../pairing-core.js');

class FakePeer {
  constructor(id) {
    this.id = id;
    this.listeners = new Map();
    this.destroyed = false;
  }

  on(event, listener) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(listener);
    return this;
  }

  emit(event, ...args) {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) fn(...args);
  }
}

(async () => {
  const secret = Pair.toBase64Url(Uint8Array.from({ length: 16 }, (_, i) => i + 1));
  const targetToken = Pair.formatShareCode('drop-target', secret);
  const idEl = { textContent: '' };
  const input = { value: '', placeholder: '' };
  const button = { clicks: 0, click() { this.clicks++; } };
  const toast = {
    textContent: '',
    classList: { add() {}, remove() {} },
  };

  const document = {
    querySelector(selector) {
      if (selector === '#my-id') return idEl;
      if (selector === '#peer-input') return input;
      if (selector === '#connect-btn') return button;
      if (selector === '#toast') return toast;
      if (selector === '#my-qr') return null;
      return null;
    },
  };

  const replacements = [];
  const history = {
    replaceState(_state, _title, url) { replacements.push(url); },
  };
  const location = {
    protocol: 'https:',
    origin: 'https://lemon.test',
    pathname: '/index.html',
    search: '?debug=1',
    hash: '#peer=' + encodeURIComponent(targetToken),
  };

  const fixedLocalSecret = Pair.toBase64Url(Uint8Array.from({ length: 16 }, () => 7));
  const BrowserPair = Object.assign({}, Pair, { createSecret: () => fixedLocalSecret });
  const window = { Peer: FakePeer, LemonPairingCore: BrowserPair };
  window.window = window;

  const sandbox = {
    window,
    document,
    location,
    history,
    URLSearchParams,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    console,
    Proxy,
    Reflect,
    Object,
    Array,
    Map,
    Set,
    Promise,
    Error,
  };

  const source = fs.readFileSync(path.join(__dirname, '..', 'pairing.js'), 'utf8');
  vm.runInNewContext(source, sandbox, { filename: 'pairing.js' });

  assert.equal(button.clicks, 0, 'QR auto-connect must not run before PeerJS is open');
  assert.deepEqual(replacements, ['/index.html?debug=1'], 'pairing fragment should be removed while preserving unrelated query parameters');

  const Peer = sandbox.window.Peer;
  const local = new Peer('drop-local');
  assert.equal(button.clicks, 0);

  local.emit('open', 'drop-local');
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(button.clicks, 1, 'QR auto-connect should run once after PeerJS open');
  assert.equal(input.value, targetToken);
  assert.equal(idEl.textContent, Pair.formatShareCode('drop-local', fixedLocalSecret));

  // A second raw open event must not reuse the consumed remote token.
  local.emit('open', 'drop-local');
  await Promise.resolve();
  assert.equal(button.clicks, 1);

  console.log('Lemon pairing URL tests passed');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

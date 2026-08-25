'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Pair = require('../pairing-core.js');

function bytes(seed) {
  return Uint8Array.from({ length: 16 }, (_, i) => (seed + i) & 0xff);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    delay(ms).then(() => { throw new Error(label + ' timed out'); }),
  ]);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function coreChecks() {
  const secret = Pair.toBase64Url(bytes(1));
  const otherSecret = Pair.toBase64Url(bytes(2));
  const nonceA = Pair.toBase64Url(bytes(3));
  const nonceB = Pair.toBase64Url(bytes(4));

  assert.equal(secret.length, 22);
  const token = Pair.formatShareCode('drop-alpha', secret);
  assert.deepEqual(Pair.parseShareCode(token), {
    peerId: 'drop-alpha', secret, paired: true, malformed: false,
  });
  assert.equal(Pair.parseShareCode('drop-alpha').paired, false);
  assert.equal(Pair.parseShareCode('drop-alpha~bad').malformed, true);

  const sdpA = [
    'v=0',
    'a=fingerprint:sha-256 AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA',
    '',
  ].join('\r\n');
  const sdpB = [
    'v=0',
    'a=fingerprint:sha-256 bb:bb:bb:bb:bb:bb:bb:bb:bb:bb:bb:bb:bb:bb:bb:bb',
    '',
  ].join('\r\n');
  const binding = Pair.channelBindingFromSdps(sdpA, sdpB);
  assert.equal(binding, Pair.channelBindingFromSdps(sdpB, sdpA), 'channel binding must be direction independent');
  assert.match(binding, /sha-256 AA:AA/);
  assert.match(binding, /sha-256 BB:BB/);
  assert.throws(() => Pair.channelBindingFromSdps('v=0', sdpB), /fingerprint/);

  const proof = await Pair.makeProof(
    secret, 'drop-alpha', 'drop-bravo', nonceA, nonceB, 'responder', binding
  );
  const proofAgain = await Pair.makeProof(
    secret, 'drop-alpha', 'drop-bravo', nonceA, nonceB, 'responder', binding
  );
  const initiatorProof = await Pair.makeProof(
    secret, 'drop-alpha', 'drop-bravo', nonceA, nonceB, 'initiator', binding
  );
  const otherBindingProof = await Pair.makeProof(
    secret,
    'drop-alpha',
    'drop-bravo',
    nonceA,
    nonceB,
    'responder',
    binding.replace(/AA/g, 'CC')
  );
  const wrongSecretProof = await Pair.makeProof(
    otherSecret, 'drop-alpha', 'drop-bravo', nonceA, nonceB, 'responder', binding
  );

  assert.equal(proof.length, 43);
  assert.equal(proof, proofAgain);
  assert.notEqual(proof, initiatorProof, 'initiator/responder proofs must be domain separated');
  assert.notEqual(proof, otherBindingProof, 'proof must be bound to DTLS fingerprints');
  assert.notEqual(proof, wrongSecretProof, 'proof must depend on the pairing secret');
  assert.equal(Pair.secureEqual(proof, proofAgain), true);
  assert.equal(Pair.secureEqual(proof, wrongSecretProof), false);
}

class Emitter {
  constructor() {
    this.listeners = new Map();
  }

  on(event, listener) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(listener);
    return this;
  }

  emit(event, ...args) {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) listener(...args);
  }
}

function fakeFingerprint(byte) {
  return Array.from({ length: 32 }, () => byte).join(':');
}

function fakeSdp(byte) {
  return `v=0\r\na=fingerprint:sha-256 ${fakeFingerprint(byte)}\r\n`;
}

class FakeDataConnection extends Emitter {
  constructor(peer) {
    super();
    this.peer = peer;
    this.open = false;
    this.peerConnection = null;
    this.dataChannel = { bufferedAmount: 0 };
    this.other = null;
  }

  send(data) {
    if (!this.open) throw new Error('raw data channel is closed');
    const other = this.other;
    queueMicrotask(() => {
      if (other && other.open) other.emit('data', data);
    });
  }

  close() {
    if (!this.open && !(this.other && this.other.open)) return;
    const other = this.other;
    this.open = false;
    queueMicrotask(() => this.emit('close'));
    if (other && other.open) {
      other.open = false;
      queueMicrotask(() => other.emit('close'));
    }
  }
}

class FakePeer extends Emitter {
  static registry = new Map();
  static serial = 1;

  constructor(id) {
    super();
    this.id = id;
    this.destroyed = false;
    FakePeer.registry.set(id, this);
    queueMicrotask(() => this.emit('open', id));
  }

  connect(targetId) {
    const target = FakePeer.registry.get(targetId);
    if (!target) throw new Error('peer unavailable');

    const outgoing = new FakeDataConnection(targetId);
    const incoming = new FakeDataConnection(this.id);
    outgoing.other = incoming;
    incoming.other = outgoing;

    const serial = FakePeer.serial++;
    const localSdp = fakeSdp(serial.toString(16).padStart(2, '0').toUpperCase());
    const remoteSdp = fakeSdp((serial + 64).toString(16).padStart(2, '0').toUpperCase());
    outgoing.peerConnection = {
      localDescription: { sdp: localSdp },
      remoteDescription: { sdp: remoteSdp },
    };
    incoming.peerConnection = {
      localDescription: { sdp: remoteSdp },
      remoteDescription: { sdp: localSdp },
    };

    queueMicrotask(() => {
      target.emit('connection', incoming);
      outgoing.open = true;
      incoming.open = true;
      incoming.emit('open');
      outgoing.emit('open');
    });

    return outgoing;
  }

  destroy() {
    this.destroyed = true;
    FakePeer.registry.delete(this.id);
  }
}

async function wrapperSimulation() {
  FakePeer.registry.clear();
  FakePeer.serial = 1;

  const secrets = [
    Pair.toBase64Url(bytes(10)),
    Pair.toBase64Url(bytes(20)),
    Pair.toBase64Url(bytes(30)),
    Pair.toBase64Url(bytes(40)),
  ];
  let secretIndex = 0;
  const BrowserPair = Object.assign({}, Pair, {
    createSecret: () => secrets[secretIndex++],
  });

  const document = {
    querySelector: () => null,
    addEventListener: () => {},
  };
  const location = {
    protocol: 'https:',
    origin: 'https://lemon.test',
    pathname: '/index.html',
    search: '',
    hash: '',
  };
  const history = { replaceState: () => {} };
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

  const pairingSource = fs.readFileSync(path.join(__dirname, '..', 'pairing.js'), 'utf8');
  vm.runInNewContext(pairingSource, sandbox, { filename: 'pairing.js' });
  const Peer = sandbox.window.Peer;

  const alice = new Peer('drop-alice');
  const bob = new Peer('drop-bob');
  const bobSecret = secrets[1];
  const incomingReady = deferred();
  const outgoingReady = deferred();
  const dataReceived = deferred();
  let bobConnection = null;

  bob.on('connection', (conn) => {
    bobConnection = conn;
    conn.on('open', incomingReady.resolve);
    conn.on('error', incomingReady.reject);
    conn.on('data', dataReceived.resolve);
  });

  const aliceConnection = alice.connect(Pair.formatShareCode('drop-bob', bobSecret));
  aliceConnection.on('open', outgoingReady.resolve);
  aliceConnection.on('error', outgoingReady.reject);

  assert.equal(aliceConnection.open, false, 'application connection must stay closed during pairing');
  await withTimeout(Promise.all([incomingReady.promise, outgoingReady.promise]), 2000, 'successful pairing');
  assert.equal(aliceConnection.open, true);
  assert.equal(bobConnection.open, true);

  const payload = { t: 'post-auth-data', value: 42 };
  aliceConnection.send(payload);
  assert.deepEqual(await withTimeout(dataReceived.promise, 1000, 'post-auth data'), payload);

  const carol = new Peer('drop-carol');
  const dave = new Peer('drop-dave');
  const wrongSecret = Pair.toBase64Url(bytes(99));
  const rejected = deferred();
  let daveOpened = false;

  dave.on('connection', (conn) => {
    conn.on('open', () => { daveOpened = true; });
  });

  const badConnection = carol.connect(Pair.formatShareCode('drop-dave', wrongSecret));
  badConnection.on('open', () => rejected.reject(new Error('wrong-secret connection unexpectedly authenticated')));
  badConnection.on('error', rejected.resolve);
  await withTimeout(rejected.promise, 2000, 'wrong-secret rejection');
  await delay(10);
  assert.equal(badConnection.open, false);
  assert.equal(daveOpened, false);
}

(async () => {
  await coreChecks();
  await wrapperSimulation();
  console.log('Lemon pairing tests passed');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

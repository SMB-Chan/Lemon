import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [, , baseArg] = process.argv;
if (!baseArg) {
  console.error('usage: node tests/live-protocol-failure-smoke.mjs <page-url>');
  process.exit(2);
}
const chromeBin = process.env.CHROME_BIN;
if (!chromeBin) throw new Error('CHROME_BIN is not set');
if (typeof WebSocket !== 'function') throw new Error('Node.js WebSocket client is unavailable');

const base = new URL(baseArg.endsWith('/') ? baseArg : baseArg + '/');
assert.equal(base.protocol, 'https:', 'production protocol-failure smoke requires HTTPS');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const processes = [];
const tempDirs = [];

function smokeUrl(label) {
  const url = new URL(base);
  url.searchParams.set('debug', '1');
  url.searchParams.set('protocolFailureSmoke', label);
  return url.href;
}

function launchChrome(label, port) {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), `lemon-proto-${label}-`));
  tempDirs.push(userDir);
  const logFd = fs.openSync(path.join(userDir, 'chrome.log'), 'w');
  const child = spawn(chromeBin, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
    '--disable-extensions', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--no-first-run', '--no-default-browser-check',
    '--remote-allow-origins=*', `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDir}`, '--window-size=1280,800', smokeUrl(label),
  ], { stdio: ['ignore', logFd, logFd] });
  processes.push({ child, logFd });
}

function cleanup() {
  for (const item of processes) {
    try { item.child.kill('SIGKILL'); } catch (_) {}
    try { fs.closeSync(item.logFd); } catch (_) {}
  }
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

async function waitForTarget(port, timeoutMs = 20000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const targets = await res.json();
      const target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      if (target) return target;
    } catch (err) { lastError = err; }
    await sleep(250);
  }
  throw new Error(`Chrome DevTools target did not appear on port ${port}: ${lastError && lastError.message ? lastError.message : lastError}`);
}

class CdpClient {
  constructor(url, label) {
    this.label = label;
    this.seq = 0;
    this.pending = new Map();
    this.closed = false;
    this.socket = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', () => reject(new Error(`${label} CDP WebSocket failed`)), { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(String(event.data)); } catch (_) { return; }
      if (!msg.id) return;
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(`${label} CDP ${pending.method}: ${msg.error.message || JSON.stringify(msg.error)}`));
      else pending.resolve(msg.result || {});
    });
    this.socket.addEventListener('close', () => {
      this.closed = true;
      for (const pending of this.pending.values()) pending.reject(new Error(`${label} CDP socket closed during ${pending.method}`));
      this.pending.clear();
    });
  }

  async send(method, params = {}) {
    await this.ready;
    if (this.closed) throw new Error(`${this.label} CDP socket is closed`);
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() { try { this.socket.close(); } catch (_) {} }
}

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, userGesture: true,
  });
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception && result.exceptionDetails.exception.description;
    throw new Error(`${client.label} page evaluation failed: ${detail || result.exceptionDetails.text || 'unknown exception'}`);
  }
  return result.result ? result.result.value : undefined;
}

async function waitFor(label, fn, timeoutMs = 30000, intervalMs = 150) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) { lastError = err; }
    await sleep(intervalMs);
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ''}`);
}

async function rowState(client, name) {
  return evaluate(client, `(() => {
    const row = [...document.querySelectorAll('#transfer-list .transfer')].find((x) =>
      x.querySelector('.t-name')?.textContent === ${JSON.stringify(name)});
    return row ? {
      status: row.querySelector('.t-status')?.textContent || '',
      classes: row.className,
      save: !!row.querySelector('.save-btn'),
    } : null;
  })()`);
}

async function approve(client, name) {
  await waitFor(`approve button for ${name}`, () => evaluate(client, `(() => {
    const row = [...document.querySelectorAll('#transfer-list .transfer')].find((x) =>
      x.querySelector('.t-name')?.textContent === ${JSON.stringify(name)});
    return !!row?.querySelector('.t-actions .ok');
  })()`), 15000);
  await evaluate(client, `(() => {
    const row = [...document.querySelectorAll('#transfer-list .transfer')].find((x) =>
      x.querySelector('.t-name')?.textContent === ${JSON.stringify(name)});
    const button = row?.querySelector('.t-actions .ok');
    if (!button) throw new Error('approve button missing');
    button.click();
    return true;
  })()`);
}

async function waitConnection(client, peerId, label) {
  return waitFor(label, () => evaluate(client, `(() => {
    const c = window.__p2p.state().connections.find((x) => x.peer === ${JSON.stringify(peerId)});
    return c && c.open ? c.peer : null;
  })()`), 20000);
}

let a = null;
let b = null;
try {
  launchChrome('a', 9272);
  launchChrome('b', 9273);
  const [targetA, targetB] = await Promise.all([waitForTarget(9272), waitForTarget(9273)]);
  a = new CdpClient(targetA.webSocketDebuggerUrl, 'A');
  b = new CdpClient(targetB.webSocketDebuggerUrl, 'B');
  await Promise.all([a.ready, b.ready]);
  await Promise.all([a.send('Runtime.enable'), b.send('Runtime.enable')]);

  await Promise.all([
    waitFor('A Lemon initialization', () => evaluate(a, `document.readyState === 'complete' && !!window.Peer && !!window.LemonAuth && !!window.LemonCapabilities`)),
    waitFor('B Lemon initialization', () => evaluate(b, `document.readyState === 'complete' && !!window.__p2p && !!window.LemonAuth && !!window.LemonCapabilities`)),
  ]);

  await evaluate(b, `(() => {
    const state = window.__protocolFailureTest = { objectUrls: 0 };
    const original = URL.createObjectURL.bind(URL);
    URL.createObjectURL = function (blob) { state.objectUrls++; return original(blob); };
    return true;
  })()`);

  const inviteB = await waitFor('B authenticated invite', () => evaluate(b, `(() => {
    const v = document.querySelector('#my-id')?.textContent || '';
    return v.includes('~') ? v : null;
  })()`), 30000);

  await evaluate(a, `(() => {
    window.__malPeers = [];
    window.__makeMalicious = async (targetInvite, label) => {
      const peerId = 'mal-' + label + '-' + Math.random().toString(36).slice(2, 10);
      const peer = new Peer(peerId, { debug: 0 });
      window.__malPeers.push(peer);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('authenticated connection timed out: malicious Peer open')), 15000);
        peer.on('open', () => { clearTimeout(timer); resolve(); });
        peer.on('error', (err) => { clearTimeout(timer); reject(err); });
      });
      const conn = peer.connect(targetInvite, { reliable: true, serialization: 'binary' });
      const state = { peerId, conn, messages: [], binaryBytes: 0, blobPromises: [], end: null, closed: false, wrongFlowSent: 0 };
      conn.on('data', (data) => {
        if (data instanceof ArrayBuffer) state.binaryBytes += data.byteLength;
        else if (ArrayBuffer.isView(data)) state.binaryBytes += data.byteLength;
        else if (typeof Blob !== 'undefined' && data instanceof Blob) {
          state.blobPromises.push(data.arrayBuffer().then((buf) => { state.binaryBytes += buf.byteLength; }));
        } else {
          state.messages.push(data);
          if (data && data.t === 'end') state.end = data;
        }
      });
      conn.on('close', () => { state.closed = true; });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('authenticated connection timed out: malicious DataConnection open')), 20000);
        conn.on('open', () => { clearTimeout(timer); resolve(); });
        conn.on('error', (err) => { clearTimeout(timer); reject(err); });
      });
      conn.send({ t: 'hello', app: 'lemon', v: 2 });
      window.__mal = state;
      return peerId;
    };
    return true;
  })()`);

  // 1. A valid meta followed by an end frame for another ID must fail closed.
  const badEndPeer = await evaluate(a, `window.__makeMalicious(${JSON.stringify(inviteB)}, 'badend')`);
  await waitConnection(b, badEndPeer, 'bad-end authenticated connection');
  await evaluate(a, `window.__mal.conn.send({ t: 'meta', id: 'bad-end-good-id', name: 'bad-end.bin', size: 16, mime: 'application/octet-stream' }); true`);
  await approve(b, 'bad-end.bin');
  await waitFor('bad-end accept', () => evaluate(a, `window.__mal.messages.some((x) => x && x.t === 'accept' && x.id === 'bad-end-good-id')`), 10000);
  await evaluate(a, `window.__mal.conn.send({ t: 'end', id: 'bad-end-wrong-id', size: 0, crc: 0 }); true`);
  await waitFor('wrong end ID connection close', () => evaluate(b, `!window.__p2p.state().connections.some((x) => x.peer === ${JSON.stringify(badEndPeer)})`), 15000);
  await waitFor('wrong end ID transfer cleanup', () => evaluate(b, `window.__p2p.state().activeTransfers === 0`), 10000);
  const badEndRow = await rowState(b, 'bad-end.bin');
  assert.ok(badEndRow && badEndRow.classes.includes('failed'), 'wrong end ID did not fail the receive row');
  assert.equal(badEndRow.save, false, 'wrong end ID exposed a save link');

  // 2. Binary data larger than the declared meta size must fail closed before Blob creation.
  const oversizePeer = await evaluate(a, `window.__makeMalicious(${JSON.stringify(inviteB)}, 'oversize')`);
  await waitConnection(b, oversizePeer, 'oversize authenticated connection');
  await evaluate(a, `window.__mal.conn.send({ t: 'meta', id: 'oversize-id', name: 'oversize.bin', size: 32, mime: 'application/octet-stream' }); true`);
  await approve(b, 'oversize.bin');
  await waitFor('oversize accept', () => evaluate(a, `window.__mal.messages.some((x) => x && x.t === 'accept' && x.id === 'oversize-id')`), 10000);
  await evaluate(a, `window.__mal.conn.send(new Uint8Array(64).buffer); true`);
  await waitFor('oversized payload connection close', () => evaluate(b, `!window.__p2p.state().connections.some((x) => x.peer === ${JSON.stringify(oversizePeer)})`), 15000);
  await waitFor('oversized payload transfer cleanup', () => evaluate(b, `window.__p2p.state().activeTransfers === 0`), 10000);
  const oversizeRow = await rowState(b, 'oversize.bin');
  assert.ok(oversizeRow && oversizeRow.classes.includes('failed'), 'oversized payload did not fail the receive row');
  assert.equal(oversizeRow.save, false, 'oversized payload exposed a save link');
  assert.equal(await evaluate(b, `window.__protocolFailureTest.objectUrls`), 0, 'malformed receives created a Blob download URL');

  // 3. A lemon-flow pause for another transfer ID must be ignored and must not stall the real sender.
  const wrongFlowPeer = await evaluate(a, `window.__makeMalicious(${JSON.stringify(inviteB)}, 'wrongflow')`);
  await waitConnection(b, wrongFlowPeer, 'wrong-flow authenticated connection');
  await waitFor('wrong-flow peer selected', () => evaluate(b, `window.__p2p.state().selected === ${JSON.stringify(wrongFlowPeer)}`), 10000);

  await evaluate(a, `(() => {
    const state = window.__mal;
    state.conn.on('data', (data) => {
      if (data && data.t === 'meta' && data.name === 'wrong-flow-target.bin') {
        state.conn.send({ t: 'accept', id: data.id });
        state.conn.send({ t: 'lemon-flow', c: 1, id: 'definitely-another-transfer-id', paused: true });
        state.wrongFlowSent++;
      }
    });
    return true;
  })()`);

  await evaluate(b, `(() => {
    const size = 6 * 1024 * 1024;
    const bytes = new Uint8Array(size);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + (i >>> 8) + 9) & 255;
    const file = new File([bytes], 'wrong-flow-target.bin', { type: 'application/octet-stream' });
    window.__wrongFlowSendDone = false;
    window.__p2p.sendEntries([{ file, path: file.name }]).finally(() => { window.__wrongFlowSendDone = true; });
    return size;
  })()`);

  await waitFor('wrong transfer-ID flow frame sent', () => evaluate(a, `window.__mal.wrongFlowSent === 1`), 10000);
  await waitFor('wrong transfer-ID flow did not stall sender', async () => {
    const row = await rowState(b, 'wrong-flow-target.bin');
    return row && row.classes.includes('done') ? true : null;
  }, 30000);
  await waitFor('wrong-flow sender cleanup', () => evaluate(b, `window.__p2p.state().activeTransfers === 0`), 10000);
  await evaluate(a, `Promise.all(window.__mal.blobPromises).then(() => true)`);
  const flowState = await evaluate(a, `(() => ({
    bytes: window.__mal.binaryBytes,
    end: window.__mal.end,
    wrongFlowSent: window.__mal.wrongFlowSent,
  }))()`);
  assert.equal(flowState.wrongFlowSent, 1, 'wrong-ID flow frame was not sent exactly once');
  assert.equal(flowState.bytes, 6 * 1024 * 1024, 'wrong-ID flow frame caused data loss or sender stall');
  assert.ok(flowState.end && flowState.end.size === 6 * 1024 * 1024, 'wrong-ID flow transfer did not reach a valid end frame');
  const flowRow = await rowState(b, 'wrong-flow-target.bin');
  assert.ok(flowRow && flowRow.classes.includes('done'), 'wrong-ID flow frame incorrectly failed the sender transfer');

  await evaluate(a, `(() => {
    for (const peer of window.__malPeers || []) {
      try { peer.destroy(); } catch (_) {}
    }
    return true;
  })()`);

  console.log('Lemon production protocol-failure smoke passed: wrong end ID + oversized payload fail-closed + wrong flow ID ignored');
} catch (err) {
  console.error(`Lemon production protocol-failure smoke failed: ${err && err.stack ? err.stack : err}`);
  process.exitCode = 1;
} finally {
  if (a) a.close();
  if (b) b.close();
  cleanup();
}

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [, , baseArg] = process.argv;
if (!baseArg) {
  console.error('usage: node tests/live-direct-save-smoke.mjs <page-url>');
  process.exit(2);
}

const chromeBin = process.env.CHROME_BIN;
if (!chromeBin) throw new Error('CHROME_BIN is not set');
if (typeof WebSocket !== 'function') throw new Error('Node.js WebSocket client is unavailable');

const base = new URL(baseArg.endsWith('/') ? baseArg : baseArg + '/');
assert.equal(base.protocol, 'https:', 'production direct-save smoke requires HTTPS');

const FLOW_BLOCK_AMOUNT = 16 * 1024 * 1024;
const PAYLOAD_SIZE = 24 * 1024 * 1024;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const processes = [];
const tempDirs = [];

function smokeUrl(label) {
  const url = new URL(base);
  url.searchParams.set('debug', '1');
  url.searchParams.set('directSaveSmoke', label);
  return url.href;
}

function launchChrome(label, port) {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), `lemon-direct-${label}-`));
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

async function summary(client) {
  try {
    return await evaluate(client, `(() => ({
      status: document.querySelector('#status')?.textContent || '',
      connections: window.__p2p ? window.__p2p.state().connections : [],
      activeTransfers: window.__p2p ? window.__p2p.state().activeTransfers : null,
      direct: window.__lemonDirectTest ? {
        pickerCalls: window.__lemonDirectTest.pickerCalls,
        writeCalls: window.__lemonDirectTest.writeCalls,
        total: window.__lemonDirectTest.total,
        firstWriteStarted: window.__lemonDirectTest.firstWriteStarted,
        closed: window.__lemonDirectTest.closed,
        aborted: window.__lemonDirectTest.aborted,
        starts: window.__lemonDirectTest.starts,
        completes: window.__lemonDirectTest.completes,
        errors: window.__lemonDirectTest.errors,
        objectUrls: window.__lemonDirectTest.objectUrls,
      } : null,
      transfers: [...document.querySelectorAll('#transfer-list .transfer')].map((row) => ({
        name: row.querySelector('.t-name')?.textContent || '',
        status: row.querySelector('.t-status')?.textContent || '',
        pct: row.querySelector('.t-pct')?.textContent || '',
        classes: row.className,
      })),
    }))()`);
  } catch (err) { return { error: err.message }; }
}

async function waitForOpenV2(client, label) {
  return waitFor(label, () => evaluate(client, `(() => {
    const s = window.__p2p.state(); const c = s.connections[0];
    return s.connections.length === 1 && c.open && c.remoteVersion === 2 ? c.peer : null;
  })()`), 35000);
}

async function bufferedAmount(client) {
  return evaluate(client, `window.LemonDiagnostics.snapshot().then((items) => items.length === 1 ? items[0].bufferedAmount : null)`);
}

let a = null;
let b = null;
try {
  launchChrome('a', 9242);
  launchChrome('b', 9243);
  const [targetA, targetB] = await Promise.all([waitForTarget(9242), waitForTarget(9243)]);
  a = new CdpClient(targetA.webSocketDebuggerUrl, 'A');
  b = new CdpClient(targetB.webSocketDebuggerUrl, 'B');
  await Promise.all([a.ready, b.ready]);
  await Promise.all([a.send('Runtime.enable'), b.send('Runtime.enable'), a.send('Page.enable'), b.send('Page.enable')]);

  await Promise.all([
    waitFor('A Lemon initialization', () => evaluate(a, `document.readyState === 'complete' && !!window.__p2p && !!window.LemonAuth && !!window.LemonDiagnostics`)),
    waitFor('B Lemon initialization', () => evaluate(b, `document.readyState === 'complete' && !!window.__p2p && !!window.LemonAuth && !!window.LemonDiagnostics`)),
  ]);

  await evaluate(b, `(() => {
    let releaseFirstWrite;
    const firstWriteGate = new Promise((resolve) => { releaseFirstWrite = resolve; });
    const state = window.__lemonDirectTest = {
      pickerCalls: 0, writeCalls: 0, total: 0, chunks: [], firstWriteStarted: false,
      firstWriteReleased: false, closed: false, aborted: false, starts: 0,
      completes: 0, errors: 0, objectUrls: 0, suggestedName: null,
      releaseFirstWrite() {
        if (this.firstWriteReleased) return;
        this.firstWriteReleased = true;
        releaseFirstWrite();
      },
    };
    window.addEventListener('lemon-direct-save-start', () => { state.starts++; });
    window.addEventListener('lemon-direct-save-complete', () => { state.completes++; });
    window.addEventListener('lemon-direct-save-error', () => { state.errors++; });
    const originalObjectUrl = URL.createObjectURL.bind(URL);
    URL.createObjectURL = function (blob) { state.objectUrls++; return originalObjectUrl(blob); };
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: async (options) => {
        state.pickerCalls++;
        state.suggestedName = options && options.suggestedName || null;
        return {
          createWritable: async () => ({
            write: async (buffer) => {
              const source = buffer instanceof ArrayBuffer
                ? new Uint8Array(buffer)
                : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
              const copy = new Uint8Array(source.length);
              copy.set(source);
              state.writeCalls++;
              if (state.writeCalls === 1) {
                state.firstWriteStarted = true;
                await firstWriteGate;
              }
              state.chunks.push(copy);
              state.total += copy.byteLength;
              await new Promise((resolve) => setTimeout(resolve, 1));
            },
            close: async () => { state.closed = true; },
            abort: async () => { state.aborted = true; },
          }),
        };
      },
    });
    return { secure: isSecureContext, picker: typeof showSaveFilePicker };
  })()`);

  const [inviteA, inviteB] = await Promise.all([
    waitFor('A authenticated invite', () => evaluate(a, `(() => { const v = document.querySelector('#my-id')?.textContent || ''; return v.includes('~') ? v : null; })()`)),
    waitFor('B authenticated invite', () => evaluate(b, `(() => { const v = document.querySelector('#my-id')?.textContent || ''; return v.includes('~') ? v : null; })()`)),
  ]);
  const peerA = inviteA.split('~')[0];
  const peerB = inviteB.split('~')[0];
  assert.ok(peerA && peerB && peerA !== peerB, 'browser peers must have distinct IDs');

  await evaluate(a, `(() => {
    const input = document.querySelector('#peer-input');
    input.value = ${JSON.stringify(inviteB)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#connect-btn').click();
    return true;
  })()`);
  await Promise.all([waitForOpenV2(a, 'A direct-save authenticated connection'), waitForOpenV2(b, 'B direct-save authenticated connection')]);

  const expected = await evaluate(a, `(async () => {
    const bytes = new Uint8Array(${PAYLOAD_SIZE});
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 29 + (i >>> 7) + (i >>> 15) + 41) & 255;
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const sha256 = [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('');
    const file = new File([bytes], 'lemon-direct-smoke.bin', { type: 'application/octet-stream' });
    window.__lemonDirectSendState = 'pending';
    window.__lemonDirectSendError = null;
    window.__p2p.sendEntries([{ file, path: file.name }]).then(
      () => { window.__lemonDirectSendState = 'fulfilled'; },
      (err) => { window.__lemonDirectSendState = 'rejected'; window.__lemonDirectSendError = String(err && err.message ? err.message : err); }
    );
    return { size: bytes.length, sha256 };
  })()`);

  await waitFor('direct-save button', () => evaluate(b, `!!document.querySelector('#transfer-list .transfer .direct-save-btn')`), 20000);
  await evaluate(b, `(() => {
    const button = document.querySelector('#transfer-list .transfer .direct-save-btn');
    if (!button) throw new Error('direct-save button missing');
    button.click();
    return true;
  })()`);

  await waitFor('first direct writable write', () => evaluate(b, `window.__lemonDirectTest.firstWriteStarted === true`), 20000);

  const pausedAmount = await waitFor('sender flow-control pause', async () => {
    const value = await bufferedAmount(a);
    return Number.isFinite(value) && value >= FLOW_BLOCK_AMOUNT ? value : null;
  }, 30000, 100);
  assert.ok(pausedAmount >= FLOW_BLOCK_AMOUNT, 'sender never entered the flow-control blocked state');

  const pctWhilePaused = await evaluate(a, `(() => {
    const row = [...document.querySelectorAll('#transfer-list .transfer')].find((x) => x.querySelector('.t-name')?.textContent === 'lemon-direct-smoke.bin');
    return Number.parseInt(row?.querySelector('.t-pct')?.textContent || '0', 10);
  })()`);
  assert.ok(pctWhilePaused < 100, 'sender completed before the direct-save flow pause could protect the receiver');
  assert.equal(await evaluate(a, `window.__p2p.state().activeTransfers`), 1, 'sender transfer was not active while flow-paused');

  await evaluate(b, `window.__lemonDirectTest.releaseFirstWrite(); true`);

  await waitFor('sender flow-control resume', async () => {
    const value = await bufferedAmount(a);
    return Number.isFinite(value) && value < FLOW_BLOCK_AMOUNT;
  }, 30000, 100);

  await Promise.all([
    waitFor('direct sender completion', () => evaluate(a, `window.__lemonDirectSendState === 'fulfilled'`), 60000),
    waitFor('direct receiver completion', () => evaluate(b, `window.__lemonDirectTest.completes === 1 && window.__lemonDirectTest.closed === true`), 60000),
  ]);
  assert.equal(await evaluate(a, `window.__lemonDirectSendError`), null, 'direct-save sender promise rejected');

  const received = await evaluate(b, `(async () => {
    const state = window.__lemonDirectTest;
    const out = new Uint8Array(state.total);
    let offset = 0;
    for (const chunk of state.chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
    const digest = await crypto.subtle.digest('SHA-256', out);
    const sha256 = [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('');
    const row = [...document.querySelectorAll('#transfer-list .transfer')].find((x) => x.querySelector('.t-name')?.textContent === 'lemon-direct-smoke.bin');
    return {
      size: out.byteLength,
      sha256,
      status: row?.querySelector('.t-status')?.textContent || '',
      pickerCalls: state.pickerCalls,
      writeCalls: state.writeCalls,
      suggestedName: state.suggestedName,
      closed: state.closed,
      aborted: state.aborted,
      starts: state.starts,
      completes: state.completes,
      errors: state.errors,
      objectUrls: state.objectUrls,
    };
  })()`);

  assert.equal(received.size, expected.size, 'direct-save byte count differs from sender payload');
  assert.equal(received.sha256, expected.sha256, 'direct-save SHA-256 differs from sender payload');
  assert.equal(received.pickerCalls, 1, 'direct-save picker was not invoked exactly once');
  assert.ok(received.writeCalls > 1, 'direct-save did not stream multiple writes');
  assert.equal(received.suggestedName, 'lemon-direct-smoke.bin', 'direct-save suggested file name mismatch');
  assert.equal(received.closed, true, 'direct-save writable was not closed');
  assert.equal(received.aborted, false, 'successful direct-save unexpectedly aborted');
  assert.equal(received.starts, 1, 'direct-save start event count mismatch');
  assert.equal(received.completes, 1, 'direct-save complete event count mismatch');
  assert.equal(received.errors, 0, 'direct-save emitted an error');
  assert.equal(received.objectUrls, 0, 'direct-save incorrectly created a Blob download URL');
  assert.match(received.status, /直接保存済み.*整合性確認済み/, 'direct-save UI did not report verified completion');
  assert.equal(await evaluate(a, `window.__p2p.state().activeTransfers`), 0, 'direct-save sender leaked active transfer state');
  assert.equal(await evaluate(b, `window.__p2p.state().activeTransfers`), 0, 'direct-save receiver leaked active transfer state');

  console.log(`Lemon production direct-save smoke passed: ${expected.size} bytes + flow pause/resume + SHA-256 match + writable close`);
} catch (err) {
  console.error(`Lemon production direct-save smoke failed: ${err && err.stack ? err.stack : err}`);
  if (a) console.error('A state:', JSON.stringify(await summary(a)));
  if (b) console.error('B state:', JSON.stringify(await summary(b)));
  process.exitCode = 1;
} finally {
  if (a) a.close();
  if (b) b.close();
  cleanup();
}

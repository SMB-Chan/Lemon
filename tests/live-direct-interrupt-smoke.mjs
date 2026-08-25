import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [, , baseArg] = process.argv;
if (!baseArg) {
  console.error('usage: node tests/live-direct-interrupt-smoke.mjs <page-url>');
  process.exit(2);
}
const chromeBin = process.env.CHROME_BIN;
if (!chromeBin) throw new Error('CHROME_BIN is not set');
if (typeof WebSocket !== 'function') throw new Error('Node.js WebSocket client is unavailable');

const base = new URL(baseArg.endsWith('/') ? baseArg : baseArg + '/');
assert.equal(base.protocol, 'https:', 'production direct-interrupt smoke requires HTTPS');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const processes = [];
const tempDirs = [];

function smokeUrl(label) {
  const url = new URL(base);
  url.searchParams.set('debug', '1');
  url.searchParams.set('directInterruptSmoke', label);
  return url.href;
}

function launchChrome(label, port) {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), `lemon-direct-interrupt-${label}-`));
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

async function waitForOpenV2(client, label) {
  return waitFor(label, () => evaluate(client, `(() => {
    const s = window.__p2p.state(); const c = s.connections[0];
    return s.connections.length === 1 && c.open && c.remoteVersion === 2 ? c.peer : null;
  })()`), 35000);
}

async function rowState(client, name) {
  return evaluate(client, `(() => {
    const row = [...document.querySelectorAll('#transfer-list .transfer')].find((x) =>
      x.querySelector('.t-name')?.textContent === ${JSON.stringify(name)});
    return row ? {
      status: row.querySelector('.t-status')?.textContent || '',
      pct: row.querySelector('.t-pct')?.textContent || '',
      classes: row.className,
      save: !!row.querySelector('.save-btn'),
    } : null;
  })()`);
}

let a = null;
let b = null;
try {
  launchChrome('a', 9262);
  launchChrome('b', 9263);
  const [targetA, targetB] = await Promise.all([waitForTarget(9262), waitForTarget(9263)]);
  a = new CdpClient(targetA.webSocketDebuggerUrl, 'A');
  b = new CdpClient(targetB.webSocketDebuggerUrl, 'B');
  await Promise.all([a.ready, b.ready]);
  await Promise.all([a.send('Runtime.enable'), b.send('Runtime.enable')]);

  await Promise.all([
    waitFor('A Lemon initialization', () => evaluate(a, `document.readyState === 'complete' && !!window.__p2p && !!window.LemonAuth && !!window.LemonCapabilities`)),
    waitFor('B Lemon initialization', () => evaluate(b, `document.readyState === 'complete' && !!window.__p2p && !!window.LemonAuth && !!window.LemonCapabilities`)),
  ]);

  await evaluate(b, `(() => {
    let releaseWrite;
    const gate = new Promise((resolve) => { releaseWrite = resolve; });
    const state = window.__lemonInterruptTest = {
      pickerCalls: 0, writeCalls: 0, bytes: 0, firstWriteStarted: false,
      aborted: false, closed: false, starts: 0, completes: 0, errors: 0, objectUrls: 0,
    };
    window.addEventListener('lemon-direct-save-start', () => { state.starts++; });
    window.addEventListener('lemon-direct-save-complete', () => { state.completes++; });
    window.addEventListener('lemon-direct-save-error', () => { state.errors++; });
    const originalObjectUrl = URL.createObjectURL.bind(URL);
    URL.createObjectURL = function (blob) { state.objectUrls++; return originalObjectUrl(blob); };
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: async () => {
        state.pickerCalls++;
        return { createWritable: async () => ({
          write: async (buffer) => {
            state.writeCalls++;
            if (state.writeCalls === 1) {
              state.firstWriteStarted = true;
              await gate;
            }
            state.bytes += buffer instanceof ArrayBuffer ? buffer.byteLength : buffer.byteLength || 0;
          },
          close: async () => { state.closed = true; },
          abort: async () => {
            state.aborted = true;
            releaseWrite();
          },
        }) };
      },
    });
    return true;
  })()`);

  const [inviteA, inviteB] = await Promise.all([
    waitFor('A authenticated invite', () => evaluate(a, `(() => { const v = document.querySelector('#my-id')?.textContent || ''; return v.includes('~') ? v : null; })()`)),
    waitFor('B authenticated invite', () => evaluate(b, `(() => { const v = document.querySelector('#my-id')?.textContent || ''; return v.includes('~') ? v : null; })()`)),
  ]);
  assert.notEqual(inviteA.split('~')[0], inviteB.split('~')[0], 'browser peers must have distinct IDs');

  await evaluate(a, `(() => {
    const input = document.querySelector('#peer-input');
    input.value = ${JSON.stringify(inviteB)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#connect-btn').click();
    return true;
  })()`);
  await Promise.all([waitForOpenV2(a, 'A interrupt authenticated connection'), waitForOpenV2(b, 'B interrupt authenticated connection')]);

  await evaluate(a, `(() => {
    const size = 32 * 1024 * 1024;
    const bytes = new Uint8Array(size);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 17 + (i >>> 9) + 23) & 255;
    const file = new File([bytes], 'lemon-direct-interrupt.bin', { type: 'application/octet-stream' });
    window.__lemonInterruptSendDone = false;
    window.__p2p.sendEntries([{ file, path: file.name }]).finally(() => { window.__lemonInterruptSendDone = true; });
    return size;
  })()`);

  await waitFor('direct-save button before interruption', () => evaluate(b, `!!document.querySelector('#transfer-list .transfer .direct-save-btn')`), 20000);
  await evaluate(b, `document.querySelector('#transfer-list .transfer .direct-save-btn').click(); true`);
  await waitFor('first direct writable write before interruption', () => evaluate(b, `window.__lemonInterruptTest.firstWriteStarted === true`), 20000);

  const senderBefore = await rowState(a, 'lemon-direct-interrupt.bin');
  assert.ok(senderBefore && !senderBefore.classes.includes('done'), 'sender completed before forced direct-save disconnect');
  assert.equal(await evaluate(a, `window.__p2p.state().activeTransfers`), 1, 'sender was not active before forced disconnect');

  await evaluate(b, `(() => {
    const row = document.querySelector('#conn-list .conn-row');
    const cut = row && [...row.querySelectorAll('button')].find((x) => x.textContent === '切断');
    if (!cut) throw new Error('disconnect button missing');
    cut.click();
    return true;
  })()`);

  await waitFor('direct-save abort after forced disconnect', () => evaluate(b, `window.__lemonInterruptTest.aborted === true && window.__lemonInterruptTest.errors === 1`), 15000);
  await waitFor('sender state cleanup after forced disconnect', () => evaluate(a, `window.__p2p.state().activeTransfers === 0 && window.__p2p.state().connections.length === 0`), 20000);
  await waitFor('receiver state cleanup after forced disconnect', () => evaluate(b, `window.__p2p.state().activeTransfers === 0 && window.__p2p.state().connections.length === 0`), 20000);

  const sink = await evaluate(b, `window.__lemonInterruptTest`);
  assert.equal(sink.pickerCalls, 1, 'interrupt test picker invocation count mismatch');
  assert.equal(sink.starts, 1, 'interrupt direct-save did not start exactly once');
  assert.equal(sink.completes, 0, 'interrupted direct-save was incorrectly marked complete');
  assert.equal(sink.closed, false, 'interrupted direct-save incorrectly committed writable');
  assert.equal(sink.aborted, true, 'interrupted direct-save did not abort writable');
  assert.equal(sink.objectUrls, 0, 'interrupted direct-save incorrectly created a Blob download URL');

  const receiverRow = await rowState(b, 'lemon-direct-interrupt.bin');
  assert.ok(receiverRow && receiverRow.classes.includes('failed'), 'interrupted receiver row was not marked failed');
  assert.equal(receiverRow.save, false, 'interrupted receiver exposed a save link');
  assert.match(receiverRow.status, /直接保存に失敗|切断/, 'interrupted receiver did not report a failure');

  const senderRow = await rowState(a, 'lemon-direct-interrupt.bin');
  assert.ok(senderRow && senderRow.classes.includes('failed'), 'interrupted sender row was not marked failed');
  assert.match(senderRow.status, /切断/, 'interrupted sender did not report disconnect');

  console.log('Lemon production direct-save interruption smoke passed: writable abort + no commit + state cleanup');
} catch (err) {
  console.error(`Lemon production direct-save interruption smoke failed: ${err && err.stack ? err.stack : err}`);
  process.exitCode = 1;
} finally {
  if (a) a.close();
  if (b) b.close();
  cleanup();
}

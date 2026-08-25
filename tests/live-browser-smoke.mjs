import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [, , baseArg] = process.argv;
if (!baseArg) {
  console.error('usage: node tests/live-browser-smoke.mjs <page-url>');
  process.exit(2);
}

const chromeBin = process.env.CHROME_BIN;
if (!chromeBin) throw new Error('CHROME_BIN is not set');
if (typeof WebSocket !== 'function') throw new Error('Node.js WebSocket client is unavailable');

const base = new URL(baseArg.endsWith('/') ? baseArg : baseArg + '/');
assert.equal(base.protocol, 'https:', 'production browser smoke requires HTTPS');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const processes = [];
const tempDirs = [];

function smokeUrl(label) {
  const url = new URL(base);
  url.searchParams.set('debug', '1');
  url.searchParams.set('browserSmoke', label);
  return url.href;
}

function launchChrome(label, port) {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), `lemon-${label}-`));
  tempDirs.push(userDir);
  const logPath = path.join(userDir, 'chrome.log');
  const logFd = fs.openSync(logPath, 'w');
  const child = spawn(chromeBin, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
    '--disable-extensions', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--no-first-run', '--no-default-browser-check',
    '--remote-allow-origins=*', `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDir}`, '--window-size=1280,800', smokeUrl(label),
  ], { stdio: ['ignore', logFd, logFd] });
  processes.push({ child, label, logPath, logFd });
  return child;
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

async function waitFor(label, fn, timeoutMs = 30000, intervalMs = 200) {
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

async function pageSummary(client) {
  try {
    return await evaluate(client, `(() => ({
      readyState: document.readyState,
      status: document.querySelector('#status')?.textContent || '',
      connections: window.__p2p ? window.__p2p.state().connections : [],
      activeTransfers: window.__p2p ? window.__p2p.state().activeTransfers : null,
      transfers: [...document.querySelectorAll('#transfer-list .transfer')].map((row) => ({
        name: row.querySelector('.t-name')?.textContent || '',
        status: row.querySelector('.t-status')?.textContent || '',
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

async function diagnostics(client) {
  return evaluate(client, `window.LemonDiagnostics.snapshot().then((items) => items.map((x) => ({ peer: x.peer, open: x.open, path: x.path })))`);
}

let a = null;
let b = null;
try {
  launchChrome('a', 9222);
  launchChrome('b', 9223);
  const [targetA, targetB] = await Promise.all([waitForTarget(9222), waitForTarget(9223)]);
  a = new CdpClient(targetA.webSocketDebuggerUrl, 'A');
  b = new CdpClient(targetB.webSocketDebuggerUrl, 'B');
  await Promise.all([a.ready, b.ready]);
  await Promise.all([a.send('Runtime.enable'), b.send('Runtime.enable'), a.send('Page.enable'), b.send('Page.enable')]);

  await Promise.all([
    waitFor('A Lemon initialization', () => evaluate(a, `document.readyState === 'complete' && !!window.__p2p && !!window.LemonAuth && !!window.LemonDiagnostics`)),
    waitFor('B Lemon initialization', () => evaluate(b, `document.readyState === 'complete' && !!window.__p2p && !!window.LemonAuth && !!window.LemonDiagnostics`)),
  ]);

  await evaluate(b, `(() => {
    if (!window.__lemonSmokeOriginalCreateObjectURL) {
      const original = URL.createObjectURL.bind(URL);
      window.__lemonSmokeOriginalCreateObjectURL = original;
      URL.createObjectURL = function (blob) {
        window.__lemonSmokeLastBlob = blob;
        return original(blob);
      };
    }
    window.__lemonSmokeLastBlob = null;
    return true;
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
    if (input.value.includes('~')) throw new Error('pairing UI did not normalize the authenticated invite');
    document.querySelector('#connect-btn').click();
    return input.value;
  })()`);
  await Promise.all([waitForOpenV2(a, 'A authenticated connection + protocol hello'), waitForOpenV2(b, 'B authenticated connection + protocol hello')]);

  const stateA = await evaluate(a, `window.__p2p.state()`);
  const stateB = await evaluate(b, `window.__p2p.state()`);
  assert.equal(stateA.connections[0].peer, peerB, 'A connected to an unexpected peer');
  assert.equal(stateB.connections[0].peer, peerA, 'B connected to an unexpected peer');

  const expected = await evaluate(a, `(async () => {
    const size = 256 * 1024;
    const bytes = new Uint8Array(size);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 131 + (i >>> 8) + 17) & 255;
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    const file = new File([bytes], 'lemon-browser-smoke.bin', { type: 'application/octet-stream' });
    window.__lemonSmokeSendState = 'pending'; window.__lemonSmokeSendError = null;
    window.__p2p.sendEntries([{ file, path: file.name }]).then(
      () => { window.__lemonSmokeSendState = 'fulfilled'; },
      (err) => { window.__lemonSmokeSendState = 'rejected'; window.__lemonSmokeSendError = String(err && err.message ? err.message : err); }
    );
    return { size, sha256 };
  })()`);

  await waitFor('receiver accept prompt', () => evaluate(b, `!!document.querySelector('#transfer-list .transfer .t-actions button.ok')`), 20000);
  await evaluate(b, `(() => { const button = document.querySelector('#transfer-list .transfer .t-actions button.ok'); if (!button) throw new Error('accept button missing'); button.click(); return true; })()`);
  await Promise.all([
    waitFor('sender transfer completion', () => evaluate(a, `window.__lemonSmokeSendState === 'fulfilled'`), 45000),
    waitFor('receiver transfer completion', () => evaluate(b, `(() => { const row = document.querySelector('#transfer-list .transfer.done'); return !!row && !!row.querySelector('a.save-btn') && window.__lemonSmokeLastBlob instanceof Blob; })()`), 45000),
  ]);

  assert.equal(await evaluate(a, `window.__lemonSmokeSendError`), null, 'sender transfer promise rejected');
  const received = await evaluate(b, `(async () => {
    const link = [...document.querySelectorAll('#transfer-list .transfer.done a.save-btn')].find((item) => item.download === 'lemon-browser-smoke.bin');
    if (!link) throw new Error('completed receiver blob link is missing');
    const blob = window.__lemonSmokeLastBlob;
    if (!(blob instanceof Blob)) throw new Error('captured receiver Blob is missing');
    const buffer = await blob.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    return { size: buffer.byteLength, sha256, status: link.closest('.transfer')?.querySelector('.t-status')?.textContent || '' };
  })()`);
  assert.equal(received.size, expected.size, 'received Blob size differs from sender payload');
  assert.equal(received.sha256, expected.sha256, 'received Blob SHA-256 differs from sender payload');
  assert.match(received.status, /整合性確認済み/, 'receiver did not report integrity verification');
  assert.equal(await evaluate(a, `window.__p2p.state().activeTransfers`), 0, 'sender transfer counter did not return to zero');
  assert.equal(await evaluate(b, `window.__p2p.state().activeTransfers`), 0, 'receiver transfer counter did not return to zero');

  // Tear down the proven connection, then have both endpoints connect at once.
  await evaluate(a, `(() => { const button = document.querySelector('#conn-list .conn-row button.danger'); if (!button) throw new Error('disconnect button missing'); button.click(); return true; })()`);
  await Promise.all([
    waitFor('A connection teardown', () => evaluate(a, `window.__p2p.state().connections.length === 0`), 10000),
    waitFor('B connection teardown', () => evaluate(b, `window.__p2p.state().connections.length === 0`), 10000),
  ]);
  await Promise.all([
    waitFor('A diagnostics teardown', async () => (await diagnostics(a)).length === 0, 10000),
    waitFor('B diagnostics teardown', async () => (await diagnostics(b)).length === 0, 10000),
  ]);

  await Promise.all([
    evaluate(a, `(() => { const input = document.querySelector('#peer-input'); input.value = ${JSON.stringify(peerB)}; document.querySelector('#connect-btn').click(); return true; })()`),
    evaluate(b, `(() => { const input = document.querySelector('#peer-input'); input.value = ${JSON.stringify(peerA)}; document.querySelector('#connect-btn').click(); return true; })()`),
  ]);
  await Promise.all([waitForOpenV2(a, 'A simultaneous reconnect'), waitForOpenV2(b, 'B simultaneous reconnect')]);
  await sleep(1200);

  const [crossStateA, crossStateB, diagA, diagB] = await Promise.all([
    evaluate(a, `window.__p2p.state()`), evaluate(b, `window.__p2p.state()`), diagnostics(a), diagnostics(b),
  ]);
  assert.equal(crossStateA.connections.length, 1, 'A app state did not converge to one connection');
  assert.equal(crossStateB.connections.length, 1, 'B app state did not converge to one connection');
  assert.equal(diagA.length, 1, 'A diagnostics still tracks a duplicate open DataConnection');
  assert.equal(diagB.length, 1, 'B diagnostics still tracks a duplicate open DataConnection');
  assert.equal(diagA[0].peer, peerB, 'A diagnostics peer mismatch after simultaneous reconnect');
  assert.equal(diagB[0].peer, peerA, 'B diagnostics peer mismatch after simultaneous reconnect');

  // Rejection on the surviving connection must not create a receiver Blob or leak active transfer state.
  await evaluate(b, `window.__lemonSmokeLastBlob = null`);
  await evaluate(a, `(() => {
    const bytes = new Uint8Array(32768); bytes.fill(0x5a);
    const file = new File([bytes], 'lemon-reject-smoke.bin', { type: 'application/octet-stream' });
    window.__lemonRejectState = 'pending';
    window.__p2p.sendEntries([{ file, path: file.name }]).then(
      () => { window.__lemonRejectState = 'fulfilled'; },
      () => { window.__lemonRejectState = 'rejected'; }
    );
    return true;
  })()`);

  await waitFor('receiver reject prompt', () => evaluate(b, `(() => {
    const row = [...document.querySelectorAll('#transfer-list .transfer')].find((x) => x.querySelector('.t-name')?.textContent === 'lemon-reject-smoke.bin');
    return !!row?.querySelector('.t-actions button.danger');
  })()`), 20000);
  await evaluate(b, `(() => {
    const row = [...document.querySelectorAll('#transfer-list .transfer')].find((x) => x.querySelector('.t-name')?.textContent === 'lemon-reject-smoke.bin');
    const button = row?.querySelector('.t-actions button.danger'); if (!button) throw new Error('reject button missing'); button.click(); return true;
  })()`);

  await Promise.all([
    waitFor('sender rejection completion', () => evaluate(a, `(() => {
      const row = [...document.querySelectorAll('#transfer-list .transfer')].find((x) => x.querySelector('.t-name')?.textContent === 'lemon-reject-smoke.bin');
      return window.__lemonRejectState === 'fulfilled' && /拒否/.test(row?.querySelector('.t-status')?.textContent || '');
    })()`), 15000),
    waitFor('receiver rejection completion', () => evaluate(b, `(() => {
      const row = [...document.querySelectorAll('#transfer-list .transfer')].find((x) => x.querySelector('.t-name')?.textContent === 'lemon-reject-smoke.bin');
      return /拒否/.test(row?.querySelector('.t-status')?.textContent || '');
    })()`), 15000),
  ]);
  assert.equal(await evaluate(b, `window.__lemonSmokeLastBlob === null`), true, 'rejected transfer created a receiver Blob');
  assert.equal(await evaluate(a, `window.__p2p.state().activeTransfers`), 0, 'sender rejection leaked active transfer state');
  assert.equal(await evaluate(b, `window.__p2p.state().activeTransfers`), 0, 'receiver rejection leaked active transfer state');

  console.log(`Lemon production browser smoke passed: authenticated ${expected.size}-byte SHA-256 transfer + simultaneous reconnect convergence + rejection isolation`);
} catch (err) {
  console.error(`Lemon production browser smoke failed: ${err && err.stack ? err.stack : err}`);
  if (a) console.error('A state:', JSON.stringify(await pageSummary(a)));
  if (b) console.error('B state:', JSON.stringify(await pageSummary(b)));
  process.exitCode = 1;
} finally {
  if (a) a.close(); if (b) b.close(); cleanup();
}

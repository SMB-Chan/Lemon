import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [, , baseArg] = process.argv;
if (!baseArg) {
  console.error('usage: node tests/live-auth-zip-smoke.mjs <page-url>');
  process.exit(2);
}

const chromeBin = process.env.CHROME_BIN;
if (!chromeBin) throw new Error('CHROME_BIN is not set');
if (typeof WebSocket !== 'function') throw new Error('Node.js WebSocket client is unavailable');

const base = new URL(baseArg.endsWith('/') ? baseArg : baseArg + '/');
assert.equal(base.protocol, 'https:', 'production auth/ZIP smoke requires HTTPS');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const processes = [];
const tempDirs = [];

function smokeUrl(label) {
  const url = new URL(base);
  url.searchParams.set('debug', '1');
  url.searchParams.set('authZipSmoke', label);
  return url.href;
}

function launchChrome(label, port) {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), `lemon-authzip-${label}-`));
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

async function summary(client) {
  try {
    return await evaluate(client, `(() => ({
      status: document.querySelector('#status')?.textContent || '',
      authErrors: window.__lemonAuthZipErrors || 0,
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

let a = null;
let b = null;
try {
  launchChrome('a', 9232);
  launchChrome('b', 9233);
  const [targetA, targetB] = await Promise.all([waitForTarget(9232), waitForTarget(9233)]);
  a = new CdpClient(targetA.webSocketDebuggerUrl, 'A');
  b = new CdpClient(targetB.webSocketDebuggerUrl, 'B');
  await Promise.all([a.ready, b.ready]);
  await Promise.all([a.send('Runtime.enable'), b.send('Runtime.enable'), a.send('Page.enable'), b.send('Page.enable')]);

  await Promise.all([
    waitFor('A Lemon initialization', () => evaluate(a, `document.readyState === 'complete' && !!window.__p2p && !!window.LemonAuth && !!window.LemonCore`)),
    waitFor('B Lemon initialization', () => evaluate(b, `document.readyState === 'complete' && !!window.__p2p && !!window.LemonAuth && !!window.LemonCore`)),
  ]);

  await Promise.all([
    evaluate(a, `(() => { window.__lemonAuthZipErrors = 0; window.addEventListener('lemon-auth-error', () => { window.__lemonAuthZipErrors++; }); return true; })()`),
    evaluate(b, `(() => {
      window.__lemonAuthZipErrors = 0;
      window.addEventListener('lemon-auth-error', () => { window.__lemonAuthZipErrors++; });
      const original = URL.createObjectURL.bind(URL);
      window.__lemonAuthZipLastBlob = null;
      URL.createObjectURL = function (blob) { window.__lemonAuthZipLastBlob = blob; return original(blob); };
      return true;
    })()`),
  ]);

  const [inviteA, inviteB] = await Promise.all([
    waitFor('A authenticated invite', () => evaluate(a, `(() => { const v = document.querySelector('#my-id')?.textContent || ''; return v.includes('~') ? v : null; })()`)),
    waitFor('B authenticated invite', () => evaluate(b, `(() => { const v = document.querySelector('#my-id')?.textContent || ''; return v.includes('~') ? v : null; })()`)),
  ]);
  const peerA = inviteA.split('~')[0];
  const [peerB, secretB] = inviteB.split('~');
  assert.ok(peerA && peerB && secretB && peerA !== peerB, 'browser pairing material is incomplete');

  // A validly encoded but incorrect 128-bit capability must fail closed before app data can flow.
  const wrongSecret = (secretB[0] === 'A' ? 'B' : 'A') + secretB.slice(1);
  const wrongInvite = `${peerB}~${wrongSecret}`;
  await evaluate(a, `(() => {
    const input = document.querySelector('#peer-input');
    input.value = ${JSON.stringify(wrongInvite)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    if (input.value.includes('~')) throw new Error('pairing UI did not normalize the wrong-secret invite');
    document.querySelector('#connect-btn').click();
    return true;
  })()`);

  await waitFor('wrong pairing secret auth failure', () => evaluate(a, `window.__lemonAuthZipErrors >= 1`), 20000);
  await Promise.all([
    waitFor('A wrong-secret connection cleanup', () => evaluate(a, `window.__p2p.state().connections.length === 0`), 15000),
    waitFor('B wrong-secret connection isolation', () => evaluate(b, `window.__p2p.state().connections.length === 0`), 15000),
    waitFor('connect button recovery after auth failure', () => evaluate(a, `document.querySelector('#connect-btn').disabled === false`), 12000),
  ]);
  assert.equal(await evaluate(a, `window.__p2p.state().activeTransfers`), 0, 'wrong-secret attempt leaked sender transfer state');
  assert.equal(await evaluate(b, `window.__p2p.state().activeTransfers`), 0, 'wrong-secret attempt leaked receiver transfer state');

  // Replace the remembered bad capability with the correct invite and establish the real session.
  await evaluate(a, `(() => {
    const input = document.querySelector('#peer-input');
    input.value = ${JSON.stringify(inviteB)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    if (input.value.includes('~')) throw new Error('pairing UI did not normalize the correct invite');
    document.querySelector('#connect-btn').click();
    return true;
  })()`);
  await Promise.all([waitForOpenV2(a, 'A correct authenticated connection'), waitForOpenV2(b, 'B correct authenticated connection')]);

  // Exercise sender-side STORE ZIP with two files and a nested path.
  const expected = await evaluate(a, `(async () => {
    const alpha = new Uint8Array(4096);
    const beta = new Uint8Array(12345);
    for (let i = 0; i < alpha.length; i++) alpha[i] = (i * 17 + 3) & 255;
    for (let i = 0; i < beta.length; i++) beta[i] = (i * 73 + (i >>> 3) + 11) & 255;
    const digestHex = async (bytes) => {
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('');
    };
    const entries = [
      { name: 'alpha.txt', bytes: alpha },
      { name: 'folder/beta.bin', bytes: beta },
    ];
    const expectedEntries = [];
    for (const item of entries) expectedEntries.push({
      name: item.name,
      size: item.bytes.length,
      crc: LemonCore.crc32(item.bytes) >>> 0,
      sha256: await digestHex(item.bytes),
    });
    const zipOpt = document.querySelector('#zip-opt');
    if (zipOpt) { zipOpt.checked = true; zipOpt.dispatchEvent(new Event('change', { bubbles: true })); }
    window.__lemonAuthZipSendState = 'pending';
    window.__lemonAuthZipSendError = null;
    window.__p2p.sendEntries(entries.map((item) => ({
      file: new File([item.bytes], item.name.split('/').pop(), { type: 'application/octet-stream' }),
      path: item.name,
    }))).then(
      () => { window.__lemonAuthZipSendState = 'fulfilled'; },
      (err) => { window.__lemonAuthZipSendState = 'rejected'; window.__lemonAuthZipSendError = String(err && err.message ? err.message : err); }
    );
    return expectedEntries;
  })()`);

  await waitFor('ZIP receiver accept prompt', () => evaluate(b, `!!document.querySelector('#transfer-list .transfer .t-actions button.ok')`), 20000);
  await evaluate(b, `(() => { const button = document.querySelector('#transfer-list .transfer .t-actions button.ok'); if (!button) throw new Error('ZIP accept button missing'); button.click(); return true; })()`);
  await Promise.all([
    waitFor('ZIP sender completion', () => evaluate(a, `window.__lemonAuthZipSendState === 'fulfilled'`), 45000),
    waitFor('ZIP receiver completion', () => evaluate(b, `(() => { const row = document.querySelector('#transfer-list .transfer.done'); return !!row?.querySelector('a.save-btn') && window.__lemonAuthZipLastBlob instanceof Blob; })()`), 45000),
  ]);
  assert.equal(await evaluate(a, `window.__lemonAuthZipSendError`), null, 'ZIP sender promise rejected');

  const parsed = await evaluate(b, `(async () => {
    const blob = window.__lemonAuthZipLastBlob;
    if (!(blob instanceof Blob)) throw new Error('captured ZIP Blob is missing');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u16 = (p) => view.getUint16(p, true);
    const u32 = (p) => view.getUint32(p, true);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let eocd = -1;
    const floor = Math.max(0, bytes.length - 65557);
    for (let p = bytes.length - 22; p >= floor; p--) {
      if (u32(p) === 0x06054b50) { eocd = p; break; }
    }
    if (eocd < 0) throw new Error('ZIP EOCD not found');
    const disk = u16(eocd + 4);
    const cdDisk = u16(eocd + 6);
    const entriesDisk = u16(eocd + 8);
    const entryCount = u16(eocd + 10);
    const cdSize = u32(eocd + 12);
    const cdOffset = u32(eocd + 16);
    const commentLen = u16(eocd + 20);
    if (disk !== 0 || cdDisk !== 0 || entriesDisk !== entryCount) throw new Error('multi-disk ZIP is unexpected');
    if (eocd + 22 + commentLen !== bytes.length) throw new Error('ZIP EOCD/comment length mismatch');
    const out = [];
    let p = cdOffset;
    for (let i = 0; i < entryCount; i++) {
      if (u32(p) !== 0x02014b50) throw new Error('central directory signature mismatch');
      const flags = u16(p + 8);
      const method = u16(p + 10);
      const crc = u32(p + 16) >>> 0;
      const compressedSize = u32(p + 20);
      const size = u32(p + 24);
      const nameLen = u16(p + 28);
      const extraLen = u16(p + 30);
      const entryCommentLen = u16(p + 32);
      const localOffset = u32(p + 42);
      const name = decoder.decode(bytes.slice(p + 46, p + 46 + nameLen));
      if (method !== 0 || compressedSize !== size) throw new Error('ZIP entry is not STORE');
      if ((flags & 0x0008) === 0 || (flags & 0x0800) === 0) throw new Error('ZIP streaming/UTF-8 flags missing');
      if (u32(localOffset) !== 0x04034b50) throw new Error('local header signature mismatch');
      const localFlags = u16(localOffset + 6);
      const localMethod = u16(localOffset + 8);
      const localNameLen = u16(localOffset + 26);
      const localExtraLen = u16(localOffset + 28);
      const localName = decoder.decode(bytes.slice(localOffset + 30, localOffset + 30 + localNameLen));
      if (localFlags !== flags || localMethod !== method || localName !== name) throw new Error('local/central ZIP header mismatch');
      const dataStart = localOffset + 30 + localNameLen + localExtraLen;
      const data = bytes.slice(dataStart, dataStart + size);
      const actualCrc = LemonCore.crc32(data) >>> 0;
      if (actualCrc !== crc) throw new Error('ZIP entry CRC mismatch');
      const digest = await crypto.subtle.digest('SHA-256', data);
      const sha256 = [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('');
      out.push({ name, size, crc, sha256, flags, method });
      p += 46 + nameLen + extraLen + entryCommentLen;
    }
    if (p !== cdOffset + cdSize) throw new Error('central directory size mismatch');
    return { entryCount, entries: out, blobSize: bytes.length };
  })()`);

  assert.equal(parsed.entryCount, expected.length, 'ZIP entry count mismatch');
  const expectedByName = new Map(expected.map((item) => [item.name, item]));
  for (const item of parsed.entries) {
    const exp = expectedByName.get(item.name);
    assert.ok(exp, `unexpected ZIP entry: ${item.name}`);
    assert.equal(item.size, exp.size, `ZIP size mismatch for ${item.name}`);
    assert.equal(item.crc, exp.crc, `ZIP CRC mismatch for ${item.name}`);
    assert.equal(item.sha256, exp.sha256, `ZIP payload SHA-256 mismatch for ${item.name}`);
    expectedByName.delete(item.name);
  }
  assert.equal(expectedByName.size, 0, 'one or more expected ZIP entries are missing');
  assert.ok(parsed.blobSize > expected.reduce((sum, item) => sum + item.size, 0), 'ZIP framing bytes are missing');
  assert.equal(await evaluate(a, `window.__p2p.state().activeTransfers`), 0, 'ZIP sender leaked active transfer state');
  assert.equal(await evaluate(b, `window.__p2p.state().activeTransfers`), 0, 'ZIP receiver leaked active transfer state');

  console.log(`Lemon production auth/ZIP smoke passed: wrong-secret fail-closed + ${parsed.entryCount}-entry STORE ZIP verified`);
} catch (err) {
  console.error(`Lemon production auth/ZIP smoke failed: ${err && err.stack ? err.stack : err}`);
  if (a) console.error('A state:', JSON.stringify(await summary(a)));
  if (b) console.error('B state:', JSON.stringify(await summary(b)));
  process.exitCode = 1;
} finally {
  if (a) a.close();
  if (b) b.close();
  cleanup();
}

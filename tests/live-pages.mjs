import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const [, , baseArg, expectedSha, expectedVersion] = process.argv;
if (!baseArg || !expectedSha || !expectedVersion) {
  console.error('usage: node tests/live-pages.mjs <page-url> <commit-sha> <version>');
  process.exit(2);
}

const base = new URL(baseArg.endsWith('/') ? baseArg : baseArg + '/');
assert.equal(base.protocol, 'https:', 'Pages verification must use HTTPS');
assert.match(expectedSha, /^[0-9a-f]{40}$/i, 'expected commit SHA must be 40 hex characters');
assert.match(expectedVersion, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, 'expected version is invalid');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const verifyToken = expectedSha.slice(0, 16);
const configuredWaitAttempts = Number.parseInt(process.env.LEMON_BUILD_WAIT_ATTEMPTS || '20', 10);
const buildWaitAttempts = Number.isSafeInteger(configuredWaitAttempts)
  && configuredWaitAttempts >= 1 && configuredWaitAttempts <= 120
  ? configuredWaitAttempts : 20;

function withCacheBust(url) {
  const out = new URL(url);
  out.searchParams.set('__lemon_verify', verifyToken);
  return out;
}

async function fetchResponse(url, attempts = 8, delayMs = 1500) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        headers: {
          'cache-control': 'no-cache',
          'user-agent': 'Lemon-live-pages-smoke/1',
        },
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return res;
    } catch (err) {
      lastError = err;
      if (attempt < attempts) await sleep(delayMs);
    }
  }
  throw new Error(`cannot fetch ${url}: ${lastError && lastError.message ? lastError.message : lastError}`);
}

async function waitForBuildInfo() {
  const url = withCacheBust(new URL('build-info.json', base));
  let last = 'not fetched';
  for (let attempt = 1; attempt <= buildWaitAttempts; attempt++) {
    try {
      const res = await fetchResponse(url, 1);
      const info = JSON.parse(await res.text());
      if (info.commit !== expectedSha) {
        last = `stale commit ${String(info.commit)}`;
      } else if (info.version !== expectedVersion) {
        last = `unexpected version ${String(info.version)}`;
      } else {
        return info;
      }
    } catch (err) {
      last = err && err.message ? err.message : String(err);
    }
    if (attempt < buildWaitAttempts) await sleep(1500);
  }
  throw new Error(`deployed build-info did not converge after ${buildWaitAttempts} attempts: ${last}`);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sriSha512(buffer) {
  return 'sha512-' + crypto.createHash('sha512').update(buffer).digest('base64');
}

function attribute(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}="([^"]+)"`, 'i'));
  return match ? match[1] : null;
}

const info = await waitForBuildInfo();
assert.equal(info.commit, expectedSha);
assert.equal(info.version, expectedVersion);
assert.ok(info.files && typeof info.files === 'object' && !Array.isArray(info.files), 'build-info files map is missing');

const files = Object.entries(info.files);
assert.ok(files.length >= 10, 'build-info contains too few runtime files');
assert.ok(Object.prototype.hasOwnProperty.call(info.files, 'index.html'), 'index.html is absent from build-info');
for (const forbidden of ['README.md', 'SECURITY.md', 'package.json', 'third-party-lock.json']) {
  assert.equal(Object.prototype.hasOwnProperty.call(info.files, forbidden), false, `non-runtime file deployed: ${forbidden}`);
}

let html = '';
for (const [path, expectedHash] of files) {
  assert.match(path, /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/, `unsafe deployed path: ${path}`);
  assert.match(expectedHash, /^[0-9a-f]{64}$/i, `invalid SHA-256 for ${path}`);
  const url = withCacheBust(new URL(path, base));
  const res = await fetchResponse(url);
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.ok(bytes.length > 0, `empty deployed runtime file: ${path}`);
  assert.equal(sha256(bytes), expectedHash, `deployed bytes do not match build artifact: ${path}`);
  if (path === 'index.html') html = bytes.toString('utf8');
}

assert.match(html, /<title>Lemon — P2P ファイル転送<\/title>/, 'live page title is unexpected');
assert.match(html, /Content-Security-Policy/i, 'live page lost its CSP');
assert.match(html, /name="referrer"\s+content="no-referrer"/i, 'live page lost no-referrer policy');

const localScripts = [...html.matchAll(/<script\b[^>]*\bsrc="\.\/([^"]+)"[^>]*><\/script>/gi)].map((m) => m[1]);
const localStyles = [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="\.\/([^"]+)"[^>]*>/gi)].map((m) => m[1]);
for (const path of [...localScripts, ...localStyles]) {
  assert.ok(Object.prototype.hasOwnProperty.call(info.files, path), `HTML references undeclared local runtime file: ${path}`);
}

const remoteScriptTags = [...html.matchAll(/<script\b[^>]*\bsrc="https:\/\/[^\"]+"[^>]*><\/script>/gi)].map((m) => m[0]);
assert.ok(remoteScriptTags.length > 0, 'expected remote runtime scripts are absent; update live smoke when dependencies are vendored');
for (const tag of remoteScriptTags) {
  const src = attribute(tag, 'src');
  const integrity = attribute(tag, 'integrity');
  assert.ok(src && integrity, `remote script is not integrity-pinned: ${tag}`);
  assert.match(integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/, `unsupported SRI value for ${src}`);
  assert.equal(attribute(tag, 'crossorigin'), 'anonymous', `remote script lacks crossorigin=anonymous: ${src}`);
  assert.equal(attribute(tag, 'referrerpolicy'), 'no-referrer', `remote script lacks no-referrer: ${src}`);

  const res = await fetchResponse(new URL(src));
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.equal(sriSha512(bytes), integrity, `remote runtime dependency bytes fail SRI: ${src}`);
}

console.log(`Lemon live Pages smoke passed: ${base.href} @ ${expectedSha} v${expectedVersion}`);

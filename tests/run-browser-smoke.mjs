import { spawn } from 'node:child_process';

const [, , script, ...args] = process.argv;
if (!script) {
  console.error('usage: node tests/run-browser-smoke.mjs <script> [args...]');
  process.exit(2);
}

const MAX_ATTEMPTS = 3;
const RETRYABLE = /authenticated connection timed out/i;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function runOnce(attempt) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let combined = '';
    const capture = (chunk, stream) => {
      const text = String(chunk);
      combined += text;
      if (combined.length > 128 * 1024) combined = combined.slice(-128 * 1024);
      stream.write(chunk);
    };
    child.stdout.on('data', (chunk) => capture(chunk, process.stdout));
    child.stderr.on('data', (chunk) => capture(chunk, process.stderr));
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code: code ?? 1, signal, combined, attempt }));
  });
}

for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  if (attempt > 1) console.error(`Retrying browser smoke after authenticated connection timeout (${attempt}/${MAX_ATTEMPTS})`);
  const result = await runOnce(attempt);
  if (result.code === 0) process.exit(0);

  const retryable = RETRYABLE.test(result.combined);
  if (!retryable || attempt === MAX_ATTEMPTS) {
    if (retryable) console.error(`Authenticated connection timeout persisted for ${MAX_ATTEMPTS} attempts`);
    else console.error('Browser smoke failed outside the retryable connection-bootstrap boundary; not retrying');
    process.exit(result.code || 1);
  }
  await sleep(2000);
}

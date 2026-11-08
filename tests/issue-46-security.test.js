import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import test from 'node:test';

const workerPath = fileURLToPath(new URL('./helpers/issue-46-parser-worker.js', import.meta.url));
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const syntheticLogin = { name: 'Issue 46 Security Test Admin', pin: '4826' };
const workerReadyPattern = /(?:^|\n)READY (\d+) (\d+)\n/;
const startupTimeoutMs = 5000;
const requestTimeoutMs = 3000;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function startParserWorker() {
  const directory = await mkdtemp(join(tmpdir(), 'run-together-issue-46-parser-'));
  const child = spawn(process.execPath, [workerPath, join(directory, 'synthetic.sqlite')], {
    cwd: projectRoot,
    env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  const outputWaiters = [];
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    for (let index = outputWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = outputWaiters[index];
      if (stdout.includes(waiter.marker)) {
        outputWaiters.splice(index, 1);
        clearTimeout(waiter.timeout);
        waiter.resolve(stdout);
      }
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = once(child, 'exit').then(([code, signal]) => ({ code, signal }));
  child.once('exit', (code, signal) => {
    for (const waiter of outputWaiters.splice(0)) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error(`Parser worker exited (code ${code}, signal ${signal}). ${stderr}`));
    }
  });
  const waitForOutput = (marker) => {
    if (stdout.includes(marker)) return Promise.resolve(stdout);
    return new Promise((resolve, reject) => {
      const waiter = {
        marker,
        resolve,
        reject,
        timeout: setTimeout(() => {
          outputWaiters.splice(outputWaiters.indexOf(waiter), 1);
          reject(new Error(`Parser worker did not emit ${marker}. ${stderr}`));
        }, startupTimeoutMs),
      };
      outputWaiters.push(waiter);
    });
  };

  try {
    await waitForOutput('READY ');
    const match = stdout.match(workerReadyPattern);
    assert.ok(match, 'Parser worker must report its ephemeral localhost ports.');
    return {
      child,
      directory,
      port: Number(match[1]),
      parserPort: Number(match[2]),
      exited,
      waitForOutput,
      get stderr() { return stderr; },
    };
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await Promise.race([exited, delay(1000)]);
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function stopParserWorker(worker) {
  if (worker.child.exitCode === null && worker.child.signalCode === null) {
    worker.child.kill('SIGTERM');
    await Promise.race([worker.exited, delay(1500)]);
  }
  if (worker.child.exitCode === null && worker.child.signalCode === null) {
    worker.child.kill('SIGKILL');
    await worker.exited;
  }
  await rm(worker.directory, { recursive: true, force: true });
}

async function withParserWorker(callback) {
  const worker = await startParserWorker();
  try {
    await callback(worker);
  } finally {
    await stopParserWorker(worker);
  }
}

async function loginRequest(port, { encoding = 'identity' } = {}) {
  const json = Buffer.from(JSON.stringify(syntheticLogin));
  const body = encoding === 'gzip' ? gzipSync(json) : json;
  const headers = {
    'content-type': 'application/json',
    'content-length': body.length,
    origin: `http://127.0.0.1:${port}`,
  };
  if (encoding !== 'identity') headers['content-encoding'] = encoding;

  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/auth/login', headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.once('error', reject);
      response.once('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.once('error', reject);
    request.setTimeout(requestTimeoutMs, () => request.destroy(new Error('Login request timed out.')));
    request.end(body);
  });
}

async function runTrailingProbe(worker) {
  worker.child.stdin.write('RUN_TRAILING\n');
  const result = await worker.waitForOutput('TRAILING_RESULT ');
  assert.match(result, /TRAILING_RESULT PASS\n/, `Local parser probe failed. ${worker.stderr}`);
}

function assertSyntheticLogin(response) {
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body).user.displayName, syntheticLogin.name);
}

function versionAtLeast(actual, minimum) {
  const actualParts = actual.split('.').map(Number);
  const minimumParts = minimum.split('.').map(Number);
  for (let index = 0; index < minimumParts.length; index += 1) {
    if (actualParts[index] !== minimumParts[index]) return actualParts[index] > minimumParts[index];
  }
  return true;
}

test('Issue 46 security lockfile entries meet each advisory fixed version', async () => {
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const fixedVersions = {
    'body-parser': '2.4.0',
    'proxy-addr': '2.0.8',
    qs: '6.16.1',
  };
  for (const [name, minimum] of Object.entries(fixedVersions)) {
    const version = lock.packages[`node_modules/${name}`]?.version;
    assert.ok(version, `package-lock.json must include ${name}`);
    assert.match(version, /^\d+\.\d+\.\d+$/, `${name} lockfile version must be a stable semver release`);
    assert.ok(versionAtLeast(version, minimum), `${name}@${version} must be at least the patched ${minimum}`);
  }
});

test('Issue 46 ordinary identity-encoded JSON login remains functional in an isolated process', async () => {
  await withParserWorker(async ({ port }) => {
    assertSyntheticLogin(await loginRequest(port));
  });
});

test('Issue 46 valid gzip-compressed JSON login remains functional in an isolated process', async () => {
  await withParserWorker(async ({ port }) => {
    assertSyntheticLogin(await loginRequest(port, { encoding: 'gzip' }));
  });
});

test('Issue 46 trailing bytes after a compressed JSON frame do not crash the isolated server', async () => {
  await withParserWorker(async (worker) => {
    await runTrailingProbe(worker);
    await delay(250);
    assert.equal(worker.child.exitCode, null, `Parser worker exited after trailing bytes. ${worker.stderr}`);
    assert.equal(worker.child.signalCode, null, `Parser worker was signaled after trailing bytes. ${worker.stderr}`);
    assertSyntheticLogin(await loginRequest(worker.port));
  });
});

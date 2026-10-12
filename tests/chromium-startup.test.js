import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readDevToolsPort, spawnChromium } from './helpers/chromium-startup.js';

async function withTemporaryProfile(callback) {
  const directory = await mkdtemp(join(tmpdir(), 'run-together-chromium-startup-'));
  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('Chromium startup diagnostics include captured stderr and the selected executable', async () => {
  await withTemporaryProfile(async (directory) => {
    const browser = spawnChromium(process.execPath, [
      '-e',
      'process.stderr.write("fixture startup diagnostic\\n"); setInterval(() => {}, 1000);',
    ]);

    try {
      await new Promise((resolve, reject) => {
        browser.stderr.once('data', resolve);
        browser.once('error', reject);
      });
      await assert.rejects(
        readDevToolsPort(directory, browser, { timeoutMs: 0 }),
        (error) => {
          assert.match(error.message, /did not publish its DevTools port within 0ms/);
          assert.match(error.message, /fixture startup diagnostic/);
          assert.ok(error.message.includes(process.execPath), 'identifies the selected executable');
          return true;
        },
      );
    } finally {
      if (browser.exitCode === null && !browser.spawnError) {
        const exited = new Promise((resolve) => browser.once('exit', resolve));
        browser.kill('SIGTERM');
        await exited;
      }
    }
  });
});

test('Chromium spawn errors fail immediately with their operating-system code', async () => {
  await withTemporaryProfile(async (directory) => {
    const missingExecutable = join(directory, 'missing-chromium');
    const browser = spawnChromium(missingExecutable, []);

    await assert.rejects(
      readDevToolsPort(directory, browser, { timeoutMs: 1000, pollIntervalMs: 10 }),
      (error) => {
        assert.match(error.message, /Could not start Chromium/);
        assert.match(error.message, /ENOENT/);
        return true;
      },
    );
  });
});

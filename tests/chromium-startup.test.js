import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readDevToolsPort, spawnChromium, stopChromium } from './helpers/chromium-startup.js';

async function withTemporaryProfile(callback) {
  const directory = await mkdtemp(join(tmpdir(), 'run-together-chromium-startup-'));
  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function waitForChildExit(browser, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const finish = (callback, value) => {
      clearTimeout(timer);
      browser.off('exit', onExit);
      browser.off('error', onError);
      callback(value);
    };
    const onExit = (code, signal) => finish(resolve, { code, signal });
    const onError = (error) => finish(reject, error);
    const timer = setTimeout(() => finish(reject, new Error('Chromium child did not exit within the test bound')), timeoutMs);
    browser.once('exit', onExit);
    browser.once('error', onError);
  });
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
      await stopChromium(browser);
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

test('Chromium teardown handles active and already-signalled children within a bound', async () => {
  const { stopChromium } = await import('./helpers/chromium-startup.js');
  assert.equal(typeof stopChromium, 'function', 'provides the shared bounded Chromium teardown');

  const browser = spawnChromium(process.execPath, ['-e', 'setInterval(() => {}, 1000);']);
  try {
    await new Promise((resolve, reject) => {
      browser.once('spawn', resolve);
      browser.once('error', reject);
    });
    const exited = waitForChildExit(browser);
    browser.kill('SIGTERM');
    const result = await exited;
    assert.equal(result.signal, 'SIGTERM');

    const startedAt = Date.now();
    await stopChromium(browser, { timeoutMs: 100 });
    assert.ok(Date.now() - startedAt < 250, 'does not wait for an exit event after the child already exited');

    const activeBrowser = spawnChromium(process.execPath, ['-e', 'setInterval(() => {}, 1000);']);
    await new Promise((resolve, reject) => {
      activeBrowser.once('spawn', resolve);
      activeBrowser.once('error', reject);
    });
    const activeStartedAt = Date.now();
    await stopChromium(activeBrowser, { timeoutMs: 500 });
    assert.ok(Date.now() - activeStartedAt < 1000, 'terminates a live child within the configured bound');
    assert.ok(activeBrowser.exitCode !== null || activeBrowser.signalCode !== null, 'confirms the child exited');

    const resistantBrowser = new EventEmitter();
    Object.assign(resistantBrowser, {
      exitCode: null,
      signalCode: null,
      spawnError: null,
      spawnfile: 'fixture-browser',
      stderrTail: '',
    });
    const signals = [];
    resistantBrowser.kill = (signal) => {
      signals.push(signal);
      if (signal === 'SIGTERM') {
        queueMicrotask(() => resistantBrowser.emit('error', new Error('SIGTERM could not stop fixture process')));
      } else {
        resistantBrowser.signalCode = signal;
        queueMicrotask(() => resistantBrowser.emit('exit', null, signal));
      }
      return true;
    };
    await stopChromium(resistantBrowser, { timeoutMs: 50 });
    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'], 'escalates after a termination error instead of assuming the process exited');
    assert.equal(resistantBrowser.signalCode, 'SIGKILL');
  } finally {
    if (browser.exitCode === null && browser.signalCode === null && !browser.spawnError) {
      const exited = waitForChildExit(browser);
      browser.kill('SIGTERM');
      await exited;
    }
  }
});

test('spawned Chromium escalates a failed SIGTERM kill to SIGKILL', async () => {
  const browser = spawnChromium(process.execPath, ['-e', 'setInterval(() => {}, 1000);']);
  const realKill = browser.kill.bind(browser);
  const signals = [];

  try {
    await new Promise((resolve, reject) => {
      browser.once('spawn', resolve);
      browser.once('error', reject);
    });
    browser.kill = (signal) => {
      signals.push(signal);
      if (signal === 'SIGTERM') {
        queueMicrotask(() => browser.emit('error', Object.assign(new Error('SIGTERM denied by fixture'), {
          code: 'EPERM',
          syscall: 'kill',
        })));
        return false;
      }
      return realKill(signal);
    };

    await stopChromium(browser, { timeoutMs: 100 });

    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'], 'a failed graceful kill does not masquerade as a spawn failure');
    assert.ok(browser.exitCode !== null || browser.signalCode !== null, 'confirms the escalated child exited');
  } finally {
    browser.kill = realKill;
    if (browser.exitCode === null && browser.signalCode === null) {
      const exited = waitForChildExit(browser);
      realKill('SIGKILL');
      await exited;
    }
  }
});

test('spawned Chromium reports bounded cleanup failure when SIGTERM and SIGKILL both fail', async () => {
  const browser = spawnChromium(process.execPath, ['-e', 'setInterval(() => {}, 1000);']);
  const realKill = browser.kill.bind(browser);
  const signals = [];

  try {
    await new Promise((resolve, reject) => {
      browser.once('spawn', resolve);
      browser.once('error', reject);
    });
    browser.kill = (signal) => {
      signals.push(signal);
      queueMicrotask(() => browser.emit('error', Object.assign(new Error(`${signal} denied by fixture`), {
        code: 'EPERM',
        syscall: 'kill',
      })));
      return false;
    };

    const startedAt = Date.now();
    await assert.rejects(
      stopChromium(browser, { timeoutMs: 75 }),
      /Chromium did not exit after SIGTERM and SIGKILL within 150ms.*EPERM/,
    );
    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'], 'attempts both bounded termination signals');
    assert.ok(Date.now() - startedAt < 500, 'surfaces repeated kill failure within a bounded interval');
  } finally {
    browser.kill = realKill;
    if (browser.exitCode === null && browser.signalCode === null) {
      const exited = waitForChildExit(browser);
      realKill('SIGKILL');
      await exited;
    }
  }
});

test('signal-terminated Chromium fails readiness immediately with its signal', async () => {
  await withTemporaryProfile(async (directory) => {
    const browser = spawnChromium(process.execPath, ['-e', 'setInterval(() => {}, 1000);']);

    try {
      await new Promise((resolve, reject) => {
        browser.once('spawn', resolve);
        browser.once('error', reject);
      });
      const exited = waitForChildExit(browser);
      browser.kill('SIGTERM');
      const result = await exited;
      assert.equal(result.signal, 'SIGTERM');
      assert.equal(browser.exitCode, null, 'Node leaves exitCode null after signal termination');
      assert.equal(browser.signalCode, 'SIGTERM');

      const startedAt = Date.now();
      await assert.rejects(
        readDevToolsPort(directory, browser, { timeoutMs: 5000, pollIntervalMs: 10 }),
        (error) => {
          assert.match(error.message, /Chromium exited before publishing its DevTools port/);
          assert.match(error.message, /signal SIGTERM/);
          return true;
        },
      );
      assert.ok(Date.now() - startedAt < 1000, 'reports an exited browser without waiting for the DevTools timeout');
    } finally {
      await stopChromium(browser);
    }
  });
});

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const stderrLimit = 2000;
export const chromiumReadinessTimeoutMs = 15_000;

function hasExited(browser) {
  return browser.exitCode !== null || browser.signalCode !== null;
}

function waitForExit(browser, timeoutMs) {
  if (browser.spawnError || hasExited(browser)) return Promise.resolve(true);

  return new Promise((resolve) => {
    let timer;
    const finish = (exited) => {
      clearTimeout(timer);
      browser.off('exit', onExit);
      browser.off('error', onError);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const onError = () => finish(false);
    browser.once('exit', onExit);
    browser.once('error', onError);
    timer = setTimeout(() => finish(false), timeoutMs);
    if (browser.spawnError || hasExited(browser)) finish(true);
  });
}

function startupDetails(browser) {
  const details = [];
  if (browser.spawnfile) details.push(`executable: ${browser.spawnfile}`);
  if (browser.processError) details.push(`process error: ${browser.processError.code ?? browser.processError.message}`);
  if (browser.stderrTail?.trim()) details.push(`stderr: ${browser.stderrTail.trim()}`);
  return details.length ? `; ${details.join('; ')}` : '';
}

export function spawnChromium(executable, args) {
  const browser = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  browser.spawnError = null;
  browser.processError = null;
  browser.spawned = false;
  browser.stderrTail = '';
  browser.stderr?.setEncoding('utf8');
  browser.stderr?.on('data', (chunk) => {
    browser.stderrTail = `${browser.stderrTail}${chunk}`.slice(-stderrLimit);
  });
  browser.once('spawn', () => {
    browser.spawned = true;
  });
  browser.on('error', (error) => {
    if (browser.spawned) browser.processError = error;
    else browser.spawnError = error;
  });
  return browser;
}

export async function stopChromium(browser, { timeoutMs = 1000 } = {}) {
  if (!browser || browser.spawnError || hasExited(browser)) return;

  const gracefulExit = waitForExit(browser, timeoutMs);
  if (!browser.spawnError && !hasExited(browser)) browser.kill('SIGTERM');
  if (await gracefulExit || browser.spawnError || hasExited(browser)) return;

  const forcedExit = waitForExit(browser, timeoutMs);
  if (!browser.spawnError && !hasExited(browser)) browser.kill('SIGKILL');
  if (await forcedExit || browser.spawnError || hasExited(browser)) return;

  throw new Error(`Chromium did not exit after SIGTERM and SIGKILL within ${timeoutMs * 2}ms${startupDetails(browser)}`);
}

export async function readDevToolsPort(userDataDirectory, browser, {
  timeoutMs = chromiumReadinessTimeoutMs,
  pollIntervalMs = 50,
  read = readFile,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  const activePortFile = join(userDataDirectory, 'DevToolsActivePort');
  const startedAt = Date.now();

  while (true) {
    if (browser.spawnError) {
      throw new Error(`Could not start Chromium (${browser.spawnError.code ?? browser.spawnError.message})${startupDetails(browser)}`);
    }
    if (hasExited(browser)) {
      throw new Error(`Chromium exited before publishing its DevTools port (code ${browser.exitCode ?? 'none'}, signal ${browser.signalCode ?? 'none'})${startupDetails(browser)}`);
    }

    try {
      const [port] = (await read(activePortFile, 'utf8')).split('\n');
      return Number(port);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    const elapsed = Date.now() - startedAt;
    if (elapsed >= timeoutMs) break;
    await wait(Math.min(pollIntervalMs, timeoutMs - elapsed));
  }

  if (browser.spawnError) {
    throw new Error(`Could not start Chromium (${browser.spawnError.code ?? browser.spawnError.message})${startupDetails(browser)}`);
  }
  if (hasExited(browser)) {
    throw new Error(`Chromium exited before publishing its DevTools port (code ${browser.exitCode ?? 'none'}, signal ${browser.signalCode ?? 'none'})${startupDetails(browser)}`);
  }
  const state = hasExited(browser) ? 'exited' : 'running';
  throw new Error(`Chromium did not publish its DevTools port within ${timeoutMs}ms (elapsed ${Date.now() - startedAt}ms; state: ${state}; exitCode: ${browser.exitCode ?? 'null'}; signalCode: ${browser.signalCode ?? 'null'})${startupDetails(browser)}`);
}

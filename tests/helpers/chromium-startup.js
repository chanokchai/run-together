import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const stderrLimit = 2000;

function startupDetails(browser) {
  const details = [];
  if (browser.spawnfile) details.push(`executable: ${browser.spawnfile}`);
  if (browser.stderrTail?.trim()) details.push(`stderr: ${browser.stderrTail.trim()}`);
  return details.length ? `; ${details.join('; ')}` : '';
}

export function spawnChromium(executable, args) {
  const browser = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  browser.spawnError = null;
  browser.stderrTail = '';
  browser.stderr?.setEncoding('utf8');
  browser.stderr?.on('data', (chunk) => {
    browser.stderrTail = `${browser.stderrTail}${chunk}`.slice(-stderrLimit);
  });
  browser.once('error', (error) => {
    browser.spawnError = error;
  });
  return browser;
}

export async function readDevToolsPort(userDataDirectory, browser, {
  timeoutMs = 5000,
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
    if (browser.exitCode !== null) {
      throw new Error(`Chromium exited before publishing its DevTools port (code ${browser.exitCode}, signal ${browser.signalCode ?? 'none'})${startupDetails(browser)}`);
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
  throw new Error(`Chromium did not publish its DevTools port within ${timeoutMs}ms (exit code ${browser.exitCode ?? 'still running'})${startupDetails(browser)}`);
}

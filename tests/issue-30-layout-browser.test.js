import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { removeProfileWithRetry } from './helpers/chromium-profile-cleanup.js';

test('Chromium profile cleanup retries transient directory races', async () => {
  let attempts = 0;
  const transientError = Object.assign(new Error('directory changed during cleanup'), { code: 'ENOTEMPTY' });
  await removeProfileWithRetry('/unused/profile', {
    remove: async () => {
      attempts += 1;
      if (attempts < 3) throw transientError;
    },
    wait: async () => {},
    maxAttempts: 4,
  });
  assert.equal(attempts, 3, 'retries a transient ENOTEMPTY failure and then succeeds');
});

test('Chromium profile cleanup surfaces exhausted and non-transient failures', async () => {
  let attempts = 0;
  const exhaustedError = Object.assign(new Error('directory remains busy'), { code: 'ENOTEMPTY' });
  await assert.rejects(removeProfileWithRetry('/unused/profile', {
    remove: async () => {
      attempts += 1;
      throw exhaustedError;
    },
    wait: async () => {},
    maxAttempts: 3,
  }), (error) => error === exhaustedError);
  assert.equal(attempts, 3, 'stops after the configured retry bound and preserves the real cleanup error');

  attempts = 0;
  const permanentError = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  await assert.rejects(removeProfileWithRetry('/unused/profile', {
    remove: async () => {
      attempts += 1;
      throw permanentError;
    },
    wait: async () => {},
    maxAttempts: 3,
  }), (error) => error === permanentError);
  assert.equal(attempts, 1, 'does not retry a non-transient cleanup failure');
});

const chromePath = process.env.CHROME_BIN ?? [
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
  '/opt/google/chrome/chrome',
  '/opt/data/tmp/chrome/opt/google/chrome/chrome',
].find((path) => existsSync(path));

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readDevToolsPort(userDataDirectory, browser) {
  const activePortFile = join(userDataDirectory, 'DevToolsActivePort');
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (browser.exitCode !== null) throw new Error(`Chrome exited with code ${browser.exitCode}`);
    try {
      const [port] = (await readFile(activePortFile, 'utf8')).split('\n');
      return Number(port);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await delay(50);
    }
  }
  throw new Error('Chrome did not publish its DevTools port');
}

function createTarget(port) {
  return new Promise((resolve, reject) => {
    const targetRequest = request({
      host: '127.0.0.1',
      port,
      path: '/json/new?about:blank',
      method: 'PUT',
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(`Chrome target creation returned HTTP ${response.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    targetRequest.on('error', reject);
    targetRequest.end();
  });
}

function createCdpClient(url) {
  const socket = new WebSocket(url);
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (!message.id) return;
    const requestState = pending.get(message.id);
    if (!requestState) return;
    pending.delete(message.id);
    if (message.error) requestState.reject(new Error(message.error.message));
    else requestState.resolve(message.result);
  });
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  return {
    socket,
    async send(method, params = {}) {
      await opened;
      const id = ++nextId;
      const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      socket.send(JSON.stringify({ id, method, params }));
      return result;
    },
    close() {
      socket.close();
    },
  };
}

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', { expression, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}

function timelineMarkup() {
  const totals = [0, 7, 42, 100, 18, 256, 99];
  return Array.from({ length: 21 }, (_, index) => {
    const day = String(index + 11).padStart(2, '0');
    const total = totals[index % totals.length];
    return `<li class="vote-timeline__day" aria-label="${day} Oct, ${total} votes"><span class="vote-timeline__count">${total}</span><span class="vote-timeline__track" aria-hidden="true"><span class="vote-timeline__bar" style="height:100%"></span></span><time class="vote-timeline__date" datetime="2026-10-${day}"><span>${Number(day)}</span></time></li>`;
  }).join('');
}

async function inspectLayout(client, width) {
  await client.send('Emulation.setDeviceMetricsOverride', {
    width,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  return evaluate(client, `(() => {
    const timeline = document.querySelector('#vote-timeline');
    const days = [...document.querySelectorAll('.vote-timeline__day')];
    const counts = days.map((day) => {
      const label = day.querySelector('.vote-timeline__count');
      const box = label.getBoundingClientRect();
      const item = day.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(label);
      return {
        text: label.textContent,
        fontSize: Number.parseFloat(getComputedStyle(label).fontSize),
        box: { left: box.left, right: box.right, top: box.top, bottom: box.bottom },
        item: { left: item.left, right: item.right },
        glyphs: [...range.getClientRects()].map((rect) => ({
          left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
        })),
      };
    });
    const dates = days.map((day) => {
      const label = day.querySelector('.vote-timeline__date').firstElementChild;
      const range = document.createRange();
      range.selectNodeContents(label);
      return {
        text: label.textContent,
        fontSize: Number.parseFloat(getComputedStyle(label.parentElement).fontSize),
        item: (() => { const box = day.getBoundingClientRect(); return { left: box.left, right: box.right }; })(),
        glyphs: [...range.getClientRects()].map((rect) => ({
          left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
        })),
      };
    });
    const overlaps = [];
    for (let index = 0; index < counts.length - 1; index += 1) {
      for (let nextIndex = index + 1; nextIndex < counts.length; nextIndex += 1) {
        for (const first of counts[index].glyphs) {
          for (const second of counts[nextIndex].glyphs) {
            const horizontalOverlap = Math.min(first.right, second.right) - Math.max(first.left, second.left);
            const verticalOverlap = Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top);
            if (horizontalOverlap > 0.1 && verticalOverlap > 0.1) overlaps.push([index, nextIndex]);
          }
        }
      }
    }
    const dateOverlaps = [];
    for (let index = 0; index < dates.length - 1; index += 1) {
      for (let nextIndex = index + 1; nextIndex < dates.length; nextIndex += 1) {
        for (const first of dates[index].glyphs) {
          for (const second of dates[nextIndex].glyphs) {
            const horizontalOverlap = Math.min(first.right, second.right) - Math.max(first.left, second.left);
            const verticalOverlap = Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top);
            if (horizontalOverlap > 0.1 && verticalOverlap > 0.1) dateOverlaps.push([index, nextIndex]);
          }
        }
      }
    }
    return {
      viewportWidth: innerWidth,
      pageWidth: document.documentElement.scrollWidth,
      timelineHeight: timeline.getBoundingClientRect().height,
      dayCount: days.length,
      counts,
      overlaps,
      dates,
      dateOverlaps,
    };
  })()`);
}

test('vote timeline renders 21 exact multi-digit totals without overlap at 320px', {
  skip: chromePath ? false : 'Chromium is unavailable; set CHROME_BIN to run rendered layout coverage',
}, async (t) => {
  const appSource = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
  const css = appSource.match(/<style>\s*([\s\S]*?)\s*<\/style>/)?.[1];
  assert.ok(css, 'extracts the vote page CSS from the real page template');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><main class="vote-page-main"><section id="protected-content"><h1>Run Together</h1><section id="vote-timeline" class="vote-timeline" aria-labelledby="vote-timeline-heading"><h2 id="vote-timeline-heading">Vote timeline</h2><p class="vote-timeline__range">11 Oct – 31 Oct · ★ = highest votes</p><ol class="vote-timeline__days" style="grid-template-columns:repeat(21,minmax(0,1fr))">${timelineMarkup()}</ol></section></section></main></body></html>`;
  const scratchRoot = process.env.TMPDIR || tmpdir();
  const userDataDirectory = await mkdtemp(join(scratchRoot, 'run-together-layout-'));
  const browser = spawn(chromePath, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--remote-debugging-port=0', `--user-data-dir=${userDataDirectory}`, 'about:blank',
  ], { stdio: 'ignore' });
  let client;
  t.after(async () => {
    client?.close();
    if (browser.exitCode === null) {
      const exited = new Promise((resolve) => browser.once('exit', resolve));
      browser.kill('SIGTERM');
      await exited;
    }
    await removeProfileWithRetry(userDataDirectory);
  });

  const port = await readDevToolsPort(userDataDirectory, browser);
  const target = await createTarget(port);
  client = createCdpClient(target.webSocketDebuggerUrl);
  await client.send('Page.enable');
  await client.send('Page.navigate', { url: `data:text/html;base64,${Buffer.from(html).toString('base64')}` });
  await delay(100);

  const narrow = await inspectLayout(client, 320);
  assert.equal(narrow.dayCount, 21, 'renders the full supported 21-date range');
  const expectedTotals = Array.from({ length: 21 }, (_, index) => ['0', '7', '42', '100', '18', '256', '99'][index % 7]);
  assert.deepEqual(narrow.counts.map(({ text }) => text), expectedTotals, 'shows every full exact two- and three-digit count');
  assert.ok(narrow.counts.every(({ glyphs }) => glyphs.length === 1), 'keeps every count on one unbroken visible line');
  assert.ok(narrow.counts.every(({ fontSize }) => fontSize >= 9.5), 'keeps count labels readable at 320px');
  assert.ok(narrow.dates.every(({ glyphs, fontSize }) => glyphs.length === 1 && fontSize >= 8.5), 'keeps every date label complete and readable at 320px');
  assert.deepEqual(narrow.dateOverlaps, [], 'keeps date labels visually separate at 320px');
  assert.ok(narrow.counts.every(({ box, glyphs }) => glyphs.length > 0
    && glyphs.every(({ left, right }) => left >= box.left - 0.1 && right <= box.right + 0.1)),
  'keeps every count glyph inside its own date column');
  assert.deepEqual(narrow.overlaps, [], 'keeps adjacent count labels visually separate');
  assert.ok(narrow.pageWidth <= 320, 'does not create horizontal page scrolling at 320px');
  const minimumNarrowColumnWidth = Math.min(...narrow.counts.map(({ box }) => box.right - box.left));
  const maximumNarrowGlyphWidth = Math.max(...narrow.counts.flatMap(({ glyphs }) => glyphs.map(({ right, left }) => right - left)));

  const regular = await inspectLayout(client, 390);
  assert.ok(regular.timelineHeight <= 180, 'keeps the timeline section at or below 180px at 390px');
  assert.ok(regular.pageWidth <= 390, 'does not create horizontal page scrolling at 390px');
  const regularCountsUnbroken = regular.counts.every(({ glyphs }) => glyphs.length === 1);
  assert.ok(regularCountsUnbroken, 'keeps every count on one unbroken visible line at 390px');
  assert.ok(regular.counts.every(({ fontSize }) => fontSize >= 9.5), 'keeps count labels readable at 390px');
  assert.deepEqual(regular.overlaps, [], 'keeps adjacent count labels visually separate at 390px');
  assert.ok(regular.dates.every(({ glyphs, fontSize }) => glyphs.length === 1 && fontSize >= 8.5), 'keeps every date label complete and readable at 390px');
  assert.deepEqual(regular.dateOverlaps, [], 'keeps date labels visually separate at 390px');
  t.diagnostic(`320px: 21 exact mixed two-/three-digit totals, minimum column ${minimumNarrowColumnWidth}px, widest count line ${maximumNarrowGlyphWidth}px, section ${narrow.timelineHeight}px, no overlap or page overflow; 390px section ${regular.timelineHeight}px, no overlap or page overflow.`);
});

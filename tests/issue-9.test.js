import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createServer } from '../src/server.js';

const ENV = { ADMIN_NAME: 'Issue 9 Test Admin', ADMIN_PIN: '4826', PIN_PEPPER: 'synthetic-pepper' };

async function withServer(callback) {
  const directory = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'run-together-issue-9-'));
  const server = createServer({ databasePath: join(directory, 'test.sqlite'), env: ENV });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    server.database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('Issue 9 serves an installable public offline shell without caching protected pages', async () => {
  await withServer(async (baseUrl) => {
    const [login, manifestResponse, serviceWorkerResponse, offlineResponse] = await Promise.all([
      fetch(`${baseUrl}/`),
      fetch(`${baseUrl}/manifest.webmanifest`),
      fetch(`${baseUrl}/sw.js`),
      fetch(`${baseUrl}/offline`),
    ]);
    assert.equal(login.status, 200);
    assert.equal(manifestResponse.status, 200);
    assert.equal(serviceWorkerResponse.status, 200);
    assert.equal(offlineResponse.status, 200);

    const loginHtml = await login.text();
    assert.match(loginHtml, /rel="manifest" href="\/manifest\.webmanifest"/);
    assert.match(loginHtml, /name="theme-color"/);
    assert.match(loginHtml, /pwa-client\.js\?v=issue-9-pwa-2/);
    assert.match(login.headers.get('cache-control') ?? '', /no-store/);

    const manifest = await manifestResponse.json();
    assert.equal(manifest.name, 'Run Together');
    assert.equal(manifest.display, 'standalone');
    assert.equal(manifest.start_url, '/');
    assert.ok(manifest.icons.some((icon) => icon.sizes === '192x192' && icon.type === 'image/png'));
    assert.ok(manifest.icons.some((icon) => icon.sizes === '512x512' && icon.type === 'image/png'));
    for (const icon of manifest.icons) {
      const response = await fetch(new URL(icon.src, baseUrl));
      assert.equal(response.status, 200, `${icon.src} is served`);
      assert.match(response.headers.get('content-type') ?? '', /image\/png/);
      const bytes = new Uint8Array(await response.arrayBuffer());
      assert.deepEqual([...bytes.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    }

    const worker = await serviceWorkerResponse.text();
    assert.match(worker, /run-together-pwa-shell-v2/);
    assert.match(worker, /request\.mode\s*===\s*['"]navigate['"]/);
    assert.match(worker, /request\.method\s*!==\s*['"]GET['"]/);
    assert.doesNotMatch(worker, /sync['"]|backgroundSync|BackgroundSync/);

    const offlineHtml = await offlineResponse.text();
    assert.match(offlineHtml, /Offline|ออฟไลน์/);
    assert.match(offlineHtml, /Clear saved offline data/);
    assert.match(offlineHtml, /offline\.js\?v=issue-9-pwa-2/);
    assert.match(offlineResponse.headers.get('cache-control') ?? '', /no-store/);
  });
});

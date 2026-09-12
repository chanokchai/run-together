import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createServer } from '../src/server.js';

async function withServer(callback) {
  const directory = await mkdtemp(join(tmpdir(), 'run-together-server-'));
  const server = createServer({
    databasePath: join(directory, 'test.sqlite'),
    env: { ADMIN_NAME: 'Synthetic Coach', ADMIN_PIN: '4826', PIN_PEPPER: 'synthetic-pepper' },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const { port } = server.address();
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
    await once(server, 'close');
    server.database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('GET /health returns compatible status and safe database readiness', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: 'ok',
      database: 'ready',
      timeZone: 'Asia/Bangkok',
    });
  });
});

test('GET / renders the bilingual placeholder landing response', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.match(body, /Run Together/);
    assert.match(body, /วิ่งไปด้วยกัน/);
  });
});

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

test('GET / renders the approved login introduction and sign-in controls', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.match(body, /<span class="app-brand">VOTE&RUN!<\/span>/, 'the shared brand remains unchanged');
    assert.match(body, /<strong class="login-introduction__lead">Vote for the days you can run\.<\/strong>/);
    assert.match(body, /See when others are free, then suggest a day to <span class="login-introduction__nowrap">your group\.<\/span>/);
    assert.match(body, /This App make planning your next run easier\./);
    assert.doesNotMatch(body, /<h1>Run Together<\/h1>|<p>วิ่งไปด้วยกัน \/ Run together<\/p>/,
      'the legacy login-section heading and subtitle are removed');
    assert.match(body, /<p>เข้าสู่ระบบ \/ Sign in<\/p>/);
    assert.match(body, /<form id="login-form">/);
    assert.match(body, /<input name="name" autocomplete="username" required maxlength="40">/);
    assert.match(body, /<input name="pin" type="password" inputmode="numeric" pattern="\[0-9\]\{4\}" maxlength="4" autocomplete="current-password" required>/);
    assert.match(body, /<button>เข้าสู่ระบบ \/ Sign in<\/button>/);
    assert.match(body, /<p id="message" class="message" role="status"><\/p>/);
    assert.match(body, /<a href="\/register">สมัครสมาชิก \/ Register<\/a>/);
  });
});

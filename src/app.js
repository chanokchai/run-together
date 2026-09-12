import express from 'express';
import { CANONICAL_TIME_ZONE } from './calendar.js';

export function createApp({ databaseReady = false } = {}) {
  const app = express();
  app.disable('x-powered-by');

  app.get('/health', (_request, response) => {
    response.json({
      status: 'ok',
      database: databaseReady ? 'ready' : 'not_ready',
      timeZone: CANONICAL_TIME_ZONE,
    });
  });

  app.get('/', (_request, response) => {
    response.type('html').send(`<!doctype html>
<html lang="th">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Run Together | วิ่งไปด้วยกัน</title>
  </head>
  <body>
    <main>
      <h1>Run Together</h1>
      <p>วิ่งไปด้วยกัน</p>
      <p>Bilingual running practice voting is coming soon.</p>
      <p>ระบบโหวตวันซ้อมวิ่งสองภาษากำลังจะมาเร็ว ๆ นี้</p>
    </main>
  </body>
</html>`);
  });

  return app;
}

export default createApp();

import { createServer as createHttpServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import app from './app.js';

export function createServer() {
  return createHttpServer(app);
}

export function startServer({
  host = process.env.HOST || '127.0.0.1',
  port = Number(process.env.PORT) || 3000,
} = {}) {
  const server = createServer();
  let shuttingDown = false;

  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close((error) => {
      if (error) {
        console.error(`Failed to shut down after ${signal}:`, error);
        process.exitCode = 1;
      }
      process.exit();
    });
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  server.listen(port, host, () => {
    console.log(`Run Together listening at http://${host}:${port}`);
  });

  return server;
}

const entrypoint = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;

if (entrypoint === import.meta.url) {
  startServer();
}

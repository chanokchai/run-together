import { createServer as createHttpServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp } from './app.js';
import { openDatabase, migrate } from './database.js';
import { bootstrapAdmin } from './domain.js';

export function initializeDatabase({ databasePath, env = process.env, now = () => new Date() }) {
  const database = openDatabase(databasePath);
  try {
    migrate(database);
    bootstrapAdmin(database, { env, now });
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function createServer({
  databasePath = process.env.DB_PATH || resolve('db/run-together.sqlite'),
  env = process.env,
  now = () => new Date(),
} = {}) {
  const database = initializeDatabase({ databasePath, env, now });
  const server = createHttpServer(createApp({ databaseReady: true }));
  server.database = database;
  return server;
}

export function startServer({
  host = process.env.HOST || '127.0.0.1',
  port = Number(process.env.PORT) || 3000,
  databasePath = process.env.DB_PATH || resolve('db/run-together.sqlite'),
  env = process.env,
} = {}) {
  const server = createServer({ databasePath, env });
  let shuttingDown = false;

  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close((error) => {
      server.database.close();
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

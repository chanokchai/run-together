import express from 'express';
import http from 'node:http';
import { createServer as createHttpServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { createServer } from '../../src/server.js';

const databasePath = process.argv[2];
if (!databasePath) throw new Error('A new synthetic database path is required.');

const server = createServer({
  databasePath,
  env: {
    ADMIN_NAME: 'Issue 46 Security Test Admin',
    ADMIN_PIN: '4826',
    PIN_PEPPER: 'issue-46-security-test-pepper',
  },
});

const parserApp = express();
parserApp.use(express.json({ limit: '10kb' }));
parserApp.post('/parse', (request, response) => {
  process.stdout.write(`PARSED complete=${request.complete}\n`);
  if (request.complete) {
    response.json(request.body);
    return;
  }
  request.once('end', () => response.json(request.body));
});
const parserServer = createHttpServer(parserApp);

function runTrailingProbe() {
  const compressed = gzipSync(Buffer.from('{"a":1}'));
  const body = Buffer.concat([compressed, Buffer.from([0x00]), Buffer.alloc(100 * 1024, 0x58)]);
  return new Promise((resolve, reject) => {
    const client = http.request({
      host: '127.0.0.1',
      port: parserServer.address().port,
      method: 'POST',
      path: '/parse',
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'content-length': body.length,
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.once('error', reject);
      response.once('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve(response.statusCode === 200 && body === '{"a":1}');
      });
    });
    client.once('error', reject);
    client.setTimeout(3000, () => client.destroy(new Error('Local compressed parser request timed out.')));
    client.end(body);
  });
}

server.once('close', () => server.database.close());
process.once('SIGTERM', () => {
  parserServer.close();
  server.close(() => process.exit(0));
});
process.stdin.setEncoding('utf8');
process.stdin.on('data', (input) => {
  if (!input.includes('RUN_TRAILING')) return;
  runTrailingProbe().then((passed) => {
    process.stdout.write(`TRAILING_RESULT ${passed ? 'PASS' : 'FAIL'}\n`);
  }).catch((error) => {
    process.stdout.write(`TRAILING_RESULT FAIL ${error.code ?? 'ERROR'}\n`);
  });
});
let appReady = false;
let parserReady = false;
const reportReady = () => {
  if (appReady && parserReady) {
    process.stdout.write(`READY ${server.address().port} ${parserServer.address().port}\n`);
  }
};
server.listen(0, '127.0.0.1', () => {
  appReady = true;
  reportReady();
});
parserServer.listen(0, '127.0.0.1', () => {
  parserReady = true;
  reportReady();
});

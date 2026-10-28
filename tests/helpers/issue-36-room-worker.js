import { openDatabase } from '../../src/database.js';
import { createRoom } from '../../src/room-storage.js';

const database = openDatabase(process.env.ISSUE36_DB_PATH);
process.stdout.write('READY\n');
process.stdin.once('data', () => {
  try {
    const room = createRoom(database, {
      creatorUserId: Number(process.env.ISSUE36_USER_ID),
      title: `Concurrent ${process.env.ISSUE36_WORKER_ID}`,
    });
    process.stdout.write(`RESULT ${JSON.stringify({ ...room, pid: process.pid })}\n`);
    database.close();
  } catch (error) {
    process.stderr.write(String(error.stack || error));
    database.close();
    process.exitCode = 1;
  }
});

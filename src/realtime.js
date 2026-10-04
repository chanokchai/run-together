import { Server } from 'socket.io';
import { getDayPatch } from './domain.js';

function isLocalProxy(request) {
  const remote = request.socket?.remoteAddress;
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
}

function expectedOrigin(request) {
  const forwardedProto = isLocalProxy(request) ? request.headers['x-forwarded-proto'] : null;
  const protocol = forwardedProto === 'https' || forwardedProto === 'http' ? forwardedProto : 'http';
  return `${protocol}://${request.headers.host}`;
}

function sameOrigin(request) {
  const origin = request.headers.origin;
  return typeof origin === 'string' && origin === expectedOrigin(request);
}

export function attachRealtime(server, { auth, database }) {
  const io = new Server(server, {
    serveClient: true,
    allowRequest(request, callback) {
      if (!sameOrigin(request)) {
        callback(new Error('origin mismatch'), false);
        return;
      }
      callback(null, true);
    },
  });

  io.use((socket, next) => {
    const session = auth.authenticateSocket(socket.request);
    if (!session) {
      next(new Error('unauthenticated'));
      return;
    }
    socket.data.userId = session.user_id;
    next();
  });

  io.on('connection', (socket) => {
    socket.emit('realtime:ready');
  });

  function broadcastVoteChanged(date) {
    for (const socket of io.sockets.sockets.values()) {
      const patch = getDayPatch(database, { date, currentUserId: socket.data.userId });
      socket.emit('vote:changed', patch);
    }
  }

  function disconnectUser(userId) {
    for (const socket of io.sockets.sockets.values()) {
      if (socket.data.userId !== userId) continue;
      socket.emit('auth:revoked');
      socket.disconnect(true);
    }
  }

  function broadcastWeekReset(monday, sunday) {
    io.emit('week:reset', { monday, sunday });
  }

  return { io, broadcastVoteChanged, broadcastWeekReset, disconnectUser };
}

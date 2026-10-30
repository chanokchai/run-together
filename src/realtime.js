import { Server } from 'socket.io';
import { getDayPatch, getRunEventForDate } from './domain.js';
import { LEGACY_ROOM_ID } from './room-contract.js';
import { getRoom, getRoomSummary, hasRoomMember, listRooms } from './room-storage.js';

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

const boardChannel = (roomId) => `board:${roomId}`;
const SUMMARY_CHANNEL = 'room-summaries';

function roomSummaryState(database, now) {
  return { rooms: listRooms(database, { now }) };
}

export function attachRealtime(server, { auth, database, now = () => new Date() }) {
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
    socket.data.roomIds = new Set();
    next();
  });

  io.on('connection', (socket) => {
    socket.join(SUMMARY_CHANNEL);
    if (hasRoomMember(database, { roomId: LEGACY_ROOM_ID, userId: socket.data.userId })) {
      socket.join(boardChannel(LEGACY_ROOM_ID));
      socket.data.roomIds.add(LEGACY_ROOM_ID);
    }
    socket.on('rooms:refresh', (acknowledge = () => {}) => {
      acknowledge(roomSummaryState(database, now));
    });
    socket.emit('realtime:ready');
    socket.emit('rooms:summary-state', roomSummaryState(database, now));
    socket.on('room:subscribe', (payload, acknowledge = () => {}) => {
      const roomId = typeof payload === 'string' ? payload : payload?.roomId;
      const room = typeof roomId === 'string' ? getRoom(database, { roomId }) : null;
      if (!room || !hasRoomMember(database, { roomId, userId: socket.data.userId })) {
        acknowledge({ ok: false, code: 'ROOM_MEMBERSHIP_REQUIRED' });
        return;
      }
      socket.join(boardChannel(roomId));
      socket.data.roomIds.add(roomId);
      acknowledge({ ok: true, roomId });
    });
    socket.on('room:unsubscribe', (payload, acknowledge = () => {}) => {
      const roomId = typeof payload === 'string' ? payload : payload?.roomId;
      if (typeof roomId === 'string') {
        socket.leave(boardChannel(roomId));
        socket.data.roomIds.delete(roomId);
      }
      acknowledge({ ok: true, roomId: typeof roomId === 'string' ? roomId : null });
    });
  });

  function resolveRoomDate(roomOrDate, maybeDate) {
    return maybeDate === undefined
      ? { roomId: LEGACY_ROOM_ID, date: roomOrDate }
      : { roomId: roomOrDate, date: maybeDate };
  }

  function subscribedSockets(roomId) {
    const members = io.sockets.adapter.rooms.get(boardChannel(roomId)) ?? new Set();
    return [...members].map((socketId) => io.sockets.sockets.get(socketId)).filter(Boolean);
  }

  function broadcastRoomSummary(roomId) {
    const room = getRoom(database, { roomId });
    if (!room) return;
    const summary = getRoomSummary(database, { roomId, now });
    io.to(SUMMARY_CHANNEL).emit('rooms:summary-changed', {
      roomId,
      room: { ...room, summary },
    });
  }

  function broadcastVoteChanged(roomOrDate, maybeDate) {
    const { roomId, date } = resolveRoomDate(roomOrDate, maybeDate);
    for (const socket of subscribedSockets(roomId)) {
      const patch = { ...getDayPatch(database, { roomId, date, currentUserId: socket.data.userId }), roomId };
      socket.emit('vote:changed', patch);
      socket.emit('event:changed', {
        roomId,
        date,
        event: getRunEventForDate(database, { roomId, eventDate: date }),
      });
    }
    broadcastRoomSummary(roomId);
  }

  function broadcastRunEventChanged(roomOrDate, maybeDate) {
    const { roomId, date } = resolveRoomDate(roomOrDate, maybeDate);
    const event = getRunEventForDate(database, { roomId, eventDate: date });
    io.to(boardChannel(roomId)).emit('event:changed', {
      roomId,
      date,
      event: event ? { ...event, roomId } : null,
    });
    broadcastRoomSummary(roomId);
  }

  function disconnectUser(userId) {
    for (const socket of io.sockets.sockets.values()) {
      if (socket.data.userId !== userId) continue;
      socket.emit('auth:revoked');
      socket.disconnect(true);
    }
  }

  function broadcastWeekReset(roomOrMonday, mondayOrSunday, maybeSunday) {
    const roomId = maybeSunday === undefined ? LEGACY_ROOM_ID : roomOrMonday;
    const monday = maybeSunday === undefined ? roomOrMonday : mondayOrSunday;
    const sunday = maybeSunday === undefined ? mondayOrSunday : maybeSunday;
    io.to(boardChannel(roomId)).emit('week:reset', { roomId, monday, sunday });
  }

  return {
    io,
    broadcastVoteChanged,
    broadcastRunEventChanged,
    broadcastWeekReset,
    broadcastRoomSummary,
    disconnectUser,
  };
}

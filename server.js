// Multiplayer draw.io Whiteboard — realtime server
//
// Responsibilities:
//   1. Serve the static frontend in /public.
//   2. Run a WebSocket hub that keeps every participant of a "room" in sync:
//        - broadcasts diagram (draw.io XML) changes to everyone else,
//        - tracks presence (who is in the room, name + colour),
//        - relays lightweight chat + pointer messages,
//        - stores the latest diagram per room so late joiners load current state.
//
// The server is intentionally in-memory only. Rooms live as long as the process
// and are discarded when the last participant leaves. This keeps the project
// dependency-light and easy to self-host anywhere Node runs.

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// Basic health endpoint (handy for platform deploys).
app.get('/healthz', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/**
 * rooms: Map<roomId, {
 *   xml: string | null,               // latest diagram XML
 *   clients: Map<clientId, {          // connected participants
 *     ws, name, color, id
 *   }>
 * }>
 */
const rooms = new Map();

// A pleasant, distinguishable palette assigned round-robin to participants.
const PALETTE = [
  '#e6194B', '#3cb44b', '#4363d8', '#f58231', '#911eb4',
  '#42d4f4', '#f032e6', '#bfef45', '#fabed4', '#469990',
  '#dcbeff', '#9A6324', '#800000', '#808000', '#000075',
];

let clientSeq = 0;

function getRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    room = { xml: null, clients: new Map() };
    rooms.set(roomId, room);
  }
  return room;
}

function roster(room) {
  return [...room.clients.values()].map((c) => ({
    id: c.id,
    name: c.name,
    color: c.color,
  }));
}

function broadcast(room, payload, exceptId = null) {
  const data = JSON.stringify(payload);
  for (const client of room.clients.values()) {
    if (client.id === exceptId) continue;
    if (client.ws.readyState === client.ws.OPEN) {
      client.ws.send(data);
    }
  }
}

function sendPresence(room) {
  broadcast(room, { type: 'presence', users: roster(room), count: room.clients.size });
}

wss.on('connection', (ws) => {
  const clientId = `c${++clientSeq}`;
  let joinedRoomId = null;

  const safeSend = (obj) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  };

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // ignore malformed frames
    }

    switch (msg.type) {
      case 'join': {
        const roomId = String(msg.room || 'lobby').slice(0, 80);
        const name = String(msg.name || 'Guest').slice(0, 40) || 'Guest';
        const room = getRoom(roomId);
        joinedRoomId = roomId;

        const color = PALETTE[room.clients.size % PALETTE.length];
        room.clients.set(clientId, { ws, name, color, id: clientId });

        // Send the newcomer the current state of the room.
        safeSend({
          type: 'welcome',
          id: clientId,
          color,
          room: roomId,
          xml: room.xml,
          users: roster(room),
        });

        // Tell everyone (including newcomer) about the updated roster.
        sendPresence(room);
        broadcast(
          room,
          { type: 'system', text: `${name} joined the board`, at: Date.now() },
          clientId,
        );
        break;
      }

      case 'diagram': {
        // A participant changed the board. Persist + fan out to others.
        if (!joinedRoomId) return;
        const room = rooms.get(joinedRoomId);
        if (!room) return;
        room.xml = typeof msg.xml === 'string' ? msg.xml : room.xml;
        broadcast(room, { type: 'diagram', xml: room.xml, from: clientId }, clientId);
        break;
      }

      case 'cursor': {
        if (!joinedRoomId) return;
        const room = rooms.get(joinedRoomId);
        if (!room) return;
        const me = room.clients.get(clientId);
        if (!me) return;
        // Coordinates are fractional (0..1) so they map across window sizes.
        broadcast(
          room,
          { type: 'cursor', id: clientId, name: me.name, color: me.color, x: msg.x, y: msg.y },
          clientId,
        );
        break;
      }

      case 'chat': {
        if (!joinedRoomId) return;
        const room = rooms.get(joinedRoomId);
        if (!room) return;
        const me = room.clients.get(clientId);
        if (!me) return;
        const text = String(msg.text || '').slice(0, 500);
        if (!text.trim()) return;
        broadcast(room, {
          type: 'chat',
          id: clientId,
          name: me.name,
          color: me.color,
          text,
          at: Date.now(),
        });
        break;
      }

      default:
        break;
    }
  });

  const handleLeave = () => {
    if (!joinedRoomId) return;
    const room = rooms.get(joinedRoomId);
    if (!room) return;
    const me = room.clients.get(clientId);
    room.clients.delete(clientId);
    if (me) {
      broadcast(room, { type: 'left', id: clientId });
      broadcast(room, {
        type: 'system',
        text: `${me.name} left the board`,
        at: Date.now(),
      });
    }
    if (room.clients.size === 0) {
      // Keep the room's XML around briefly? For simplicity we drop empty rooms.
      rooms.delete(joinedRoomId);
    } else {
      sendPresence(room);
    }
  };

  ws.on('close', handleLeave);
  ws.on('error', handleLeave);
});

server.listen(PORT, () => {
  console.log(`\n  🖊️  Multiplayer draw.io whiteboard running`);
  console.log(`  → http://localhost:${PORT}\n`);
});

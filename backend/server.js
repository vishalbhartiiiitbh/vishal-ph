require('dotenv').config();

const express = require('express');
const http = require('http');
const { randomUUID } = require('crypto');
const { MongoClient } = require('mongodb');
const { WebSocket, WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 8080);
const MONGODB_URI =
  process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/vishal_ph';
const DATABASE_NAME = process.env.MONGODB_DB_NAME || 'vishal_ph';
const ROOM_TTL_MS = 10 * 60 * 1000;
const ROOM_CODE_CHARACTERS = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const mongoClient = new MongoClient(MONGODB_URI);
const socketMetadata = new Map();
const liveRooms = new Map();

let rooms;
let mongoConnected = false;

function send(socket, message) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function sendError(socket, message) {
  send(socket, { type: 'error', payload: { message } });
}

function generateRoomCode() {
  let code = '';
  for (let index = 0; index < 6; index += 1) {
    code += ROOM_CODE_CHARACTERS[
      Math.floor(Math.random() * ROOM_CODE_CHARACTERS.length)
    ];
  }
  return code;
}

function addLivePeer(roomCode, peerId, socket) {
  let peers = liveRooms.get(roomCode);
  if (!peers) {
    peers = new Map();
    liveRooms.set(roomCode, peers);
  }
  peers.set(peerId, socket);
  socketMetadata.set(socket, { roomCode, peerId });
}

async function createRoom(socket) {
  const peerId = randomUUID();
  const peer = { id: peerId, joinedAt: new Date() };

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const roomCode = generateRoomCode();
    try {
      const now = new Date();
      await rooms.insertOne({
        roomCode,
        peers: [peer],
        status: 'waiting',
        createdAt: now,
        updatedAt: now,
        expiresAt: new Date(now.getTime() + ROOM_TTL_MS),
      });
      addLivePeer(roomCode, peerId, socket);
      return { roomCode, peerId };
    } catch (error) {
      if (error?.code !== 11000) throw error;
    }
  }

  throw new Error('Could not allocate a unique room code.');
}

async function joinRoom(roomCode, socket) {
  const code = String(roomCode || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) {
    return { success: false, error: 'Enter a valid 6-character room code' };
  }

  const peerId = randomUUID();
  const now = new Date();
  const room = await rooms.findOneAndUpdate(
    {
      roomCode: code,
      status: 'waiting',
      expiresAt: { $gt: now },
      $expr: { $lt: [{ $size: '$peers' }, 2] },
    },
    {
      $push: { peers: { id: peerId, joinedAt: now } },
      $set: {
        status: 'full',
        updatedAt: now,
        expiresAt: new Date(now.getTime() + ROOM_TTL_MS),
      },
    },
    { returnDocument: 'after', includeResultMetadata: false },
  );

  if (!room) {
    const existingRoom = await rooms.findOne(
      { roomCode: code },
      { projection: { status: 1, expiresAt: 1 } },
    );
    if (!existingRoom || existingRoom.expiresAt <= now) {
      return {
        success: false,
        error: 'Requested room not found or the room expired',
      };
    }
    return { success: false, error: 'Only 2 peers can join the room' };
  }

  const host = room.peers.find((peer) => peer.id !== peerId);
  addLivePeer(code, peerId, socket);
  return {
    success: true,
    roomCode: code,
    peerId,
    hostPeerId: host?.id,
  };
}

async function handleDisconnect(socket) {
  const metadata = socketMetadata.get(socket);
  if (!metadata) return;

  socketMetadata.delete(socket);
  const { roomCode, peerId } = metadata;
  const peers = liveRooms.get(roomCode);
  peers?.delete(peerId);
  if (peers?.size === 0) liveRooms.delete(roomCode);

  const now = new Date();
  await rooms.updateOne(
    { roomCode },
    {
      $pull: { peers: { id: peerId } },
      $set: {
        status: 'waiting',
        updatedAt: now,
        expiresAt: new Date(now.getTime() + ROOM_TTL_MS),
      },
    },
  );

  const remainingPeers = liveRooms.get(roomCode);
  if (remainingPeers) {
    for (const remainingSocket of remainingPeers.values()) {
      send(remainingSocket, { type: 'peer-left', payload: { peerId } });
    }
  }
}

async function handleMessage(socket, message) {
  if (!message || typeof message.type !== 'string') {
    sendError(socket, 'Message type not specified');
    return;
  }

  switch (message.type) {
    case 'create-room': {
      const currentRoom = socketMetadata.get(socket);
      if (currentRoom) await handleDisconnect(socket);
      const { roomCode, peerId } = await createRoom(socket);
      send(socket, { type: 'room-created', payload: { roomCode, peerId } });
      break;
    }

    case 'join-room': {
      const code = message.payload?.roomCode;
      if (typeof code !== 'string' || !code.trim()) {
        sendError(socket, 'Missing roomCode parameter in the message');
        return;
      }

      const currentRoom = socketMetadata.get(socket);
      if (currentRoom) await handleDisconnect(socket);

      const result = await joinRoom(code, socket);
      if (!result.success) {
        sendError(socket, result.error);
        return;
      }

      send(socket, {
        type: 'room-joined',
        payload: { roomCode: result.roomCode, peerId: result.peerId },
      });

      const hostSocket = liveRooms
        .get(result.roomCode)
        ?.get(result.hostPeerId);
      if (hostSocket) {
        send(hostSocket, {
          type: 'peer-joined',
          payload: { peerId: result.peerId },
        });
      }
      break;
    }

    case 'offer':
    case 'answer':
    case 'ice-candidate': {
      const metadata = socketMetadata.get(socket);
      if (!metadata) {
        sendError(socket, 'Join a room before sending signaling messages');
        return;
      }

      const peers = liveRooms.get(metadata.roomCode);
      const target = peers
        ? [...peers.entries()].find(([peerId]) => peerId !== metadata.peerId)
        : undefined;
      if (target) {
        send(target[1], {
          type: message.type,
          payload: {
            ...(message.payload && typeof message.payload === 'object'
              ? message.payload
              : {}),
            senderId: metadata.peerId,
          },
        });
      }
      break;
    }

    default:
      sendError(socket, `Action ${message.type} is unsupported`);
  }
}

app.get('/', (_request, response) => {
  response.status(200).json({
    status: 'healthy',
    service: 'vishal-ph-signaling',
    database: mongoConnected ? 'connected' : 'disconnected',
  });
});

wss.on('connection', (socket) => {
  socket.on('message', (rawData) => {
    let message;
    try {
      message = JSON.parse(rawData.toString());
    } catch {
      sendError(socket, 'Invalid JSON message');
      return;
    }

    void handleMessage(socket, message).catch((error) => {
      console.error('Signaling message failed:', error);
      sendError(socket, 'The signaling server could not complete that request');
    });
  });

  socket.on('close', () => {
    void handleDisconnect(socket).catch((error) => {
      console.error('Could not update room after peer disconnect:', error);
    });
  });

  socket.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

async function start() {
  await mongoClient.connect();
  mongoConnected = true;
  const database = mongoClient.db(DATABASE_NAME);
  rooms = database.collection('rooms');
  await rooms.createIndex({ roomCode: 1 }, { unique: true });
  await rooms.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });

  server.listen(PORT, () => {
    console.log(`Vishal PH signaling server listening on port ${PORT}`);
    console.log(`MongoDB connected to database "${DATABASE_NAME}"`);
  });
}

async function shutdown() {
  mongoConnected = false;
  wss.close();
  server.close();
  await mongoClient.close();
}

process.on('SIGINT', () => {
  void shutdown().finally(() => process.exit(0));
});
process.on('SIGTERM', () => {
  void shutdown().finally(() => process.exit(0));
});

start().catch((error) => {
  console.error('Could not start the signaling server:', error);
  process.exit(1);
});

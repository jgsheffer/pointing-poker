// server.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Add middleware to parse JSON bodies
app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));

// Data stores
const pointingRooms = new Map();
const retroRooms = new Map();
const sessions = new Map();

function logRoomState(roomId, action, roomType = 'retro') {
  const rooms = roomType === 'retro' ? retroRooms : pointingRooms;
  const room = rooms.get(roomId);
  console.log(`[${action}] ${roomType} room ${roomId}:`, {
    participants: room
      ? roomType === 'retro'
        ? Array.from(room.participants)
        : Array.from(room.values()).map((p) => p.name)
      : [],
    cardCount: room && roomType === 'retro' ? room.cards.length : 'N/A',
    timestamp: new Date().toISOString(),
  });
}

function getOrCreateRetroRoom(roomId) {
  if (!retroRooms.has(roomId)) {
    retroRooms.set(roomId, {
      cards: [],
      participants: new Set(),
      lastActivity: Date.now(),
    });
    console.log(`Created new retro room: ${roomId}`);
  }
  return retroRooms.get(roomId);
}

io.on('connection', (socket) => {
  console.log('New client connected', socket.id);
  let currentRoom = null;
  let currentUser = null;
  let socketSessionId = null;

  // Agile Pointing handlers
  socket.on('joinRoom', ({ room, name, avatar, avatarType, sessionId }) => {
    let userSessionId = sessionId;
    if (!userSessionId || !sessions.has(userSessionId)) {
      userSessionId = uuidv4();
    } else {
      // Reconnection - reuse existing session
      const existingSession = sessions.get(userSessionId);
      if (existingSession.room === room) {
        // Update the socket ID for the existing session
        existingSession.socketId = socket.id;
        existingSession.disconnectedAt = null;
        sessions.set(userSessionId, existingSession);
      }
    }

    sessions.set(userSessionId, {
      room,
      name,
      avatar,
      avatarType,
      socketId: socket.id,
    });
    socketSessionId = userSessionId;
    socket.join(room);

    if (!pointingRooms.has(room)) {
      pointingRooms.set(room, new Map());
    }
    pointingRooms
      .get(room)
      .set(userSessionId, { name, avatar, avatarType, vote: null });

    socket.emit('sessionCreated', userSessionId);
    io.to(room).emit(
      'updateParticipants',
      Array.from(pointingRooms.get(room).values())
    );
    logRoomState(room, 'join', 'pointing');
  });

  socket.on('vote', ({ room, vote, sessionId }) => {
    if (pointingRooms.has(room) && pointingRooms.get(room).has(sessionId)) {
      pointingRooms.get(room).get(sessionId).vote = vote;
      io.to(room).emit(
        'updateVotes',
        Array.from(pointingRooms.get(room).values())
      );
    }
  });

  socket.on('revealVotes', (room) => {
    io.to(room).emit(
      'votesRevealed',
      Array.from(pointingRooms.get(room).values())
    );
  });

  socket.on('resetVotes', (room) => {
    if (pointingRooms.has(room)) {
      for (let participant of pointingRooms.get(room).values()) {
        participant.vote = null;
      }
      io.to(room).emit(
        'votesReset',
        Array.from(pointingRooms.get(room).values())
      );
    }
  });

  // Retro handlers
  socket.on('joinRetro', ({ room, name }) => {
    console.log(`${name} joining retro room ${room}`);
    currentRoom = room;
    currentUser = name;
    socket.join(room);

    const roomData = getOrCreateRetroRoom(room);
    roomData.participants.add(name);
    roomData.lastActivity = Date.now();

    // Send existing cards to the new participant
    socket.emit('loadCards', { cards: roomData.cards });

    io.to(room).emit('participantJoined', { name });
    io.to(room).emit('updateParticipants', {
      participants: Array.from(roomData.participants),
    });

    logRoomState(room, 'join');
  });

  socket.on('addCard', ({ room, card }) => {
    const roomData = getOrCreateRetroRoom(room);
    roomData.cards.push({
      ...card,
      isSubmitted: false,
      voters: [],
      votes: 0,
    });
    roomData.lastActivity = Date.now();

    io.to(room).emit('loadCards', { cards: roomData.cards });
    logRoomState(room, 'addCard');
  });

  socket.on('submitCard', ({ room, cardId, content }) => {
    const roomData = getOrCreateRetroRoom(room);
    const card = roomData.cards.find((c) => c.id === cardId);

    if (card) {
      card.content = content;
      card.isSubmitted = true;
      if (!Array.isArray(card.voters)) {
        card.voters = [];
        card.votes = 0;
      }
      roomData.lastActivity = Date.now();

      io.to(room).emit('loadCards', { cards: roomData.cards });
      logRoomState(room, 'submitCard');
    }
  });

  socket.on('deleteCard', ({ room, cardId }) => {
    const roomData = getOrCreateRetroRoom(room);
    roomData.cards = roomData.cards.filter((card) => card.id !== cardId);
    roomData.lastActivity = Date.now();

    io.to(room).emit('loadCards', { cards: roomData.cards });
    logRoomState(room, 'deleteCard');
  });

  socket.on('voteCard', ({ room, cardId, voter }) => {
    const roomData = getOrCreateRetroRoom(room);
    const card = roomData.cards.find((c) => c.id === cardId);

    if (card && card.isSubmitted) {
      if (!Array.isArray(card.voters)) {
        card.voters = [];
        card.votes = 0;
      }

      const voterIndex = card.voters.indexOf(voter);
      if (voterIndex === -1) {
        card.voters.push(voter);
        card.votes++;
      } else {
        card.voters.splice(voterIndex, 1);
        card.votes--;
      }

      roomData.lastActivity = Date.now();
      io.to(room).emit('loadCards', { cards: roomData.cards });
      logRoomState(room, 'vote');
    }
  });

  socket.on('moveCard', ({ room, cardId, newColumn }) => {
    const roomData = getOrCreateRetroRoom(room);
    const card = roomData.cards.find((c) => c.id === cardId);

    if (card) {
      card.column = newColumn;
      roomData.lastActivity = Date.now();

      io.to(room).emit('loadCards', { cards: roomData.cards });
      logRoomState(room, 'moveCard');
    }
  });

  socket.on('resetRetro', ({ room }) => {
    const roomData = getOrCreateRetroRoom(room);
    roomData.cards = [];
    roomData.lastActivity = Date.now();

    io.to(room).emit('loadCards', { cards: [] });
    logRoomState(room, 'reset');
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected', socket.id);

    // Mark session as disconnected but don't remove from room
    if (socketSessionId && sessions.has(socketSessionId)) {
      const session = sessions.get(socketSessionId);
      session.disconnectedAt = Date.now();
      session.socketId = null;
      sessions.set(socketSessionId, session);
      console.log(`Session ${socketSessionId} marked as disconnected`);
    }
  });
});

// Clean up inactive rooms and sessions periodically
setInterval(() => {
  const now = Date.now();
  const INACTIVE_THRESHOLD = 24 * 60 * 60 * 1000; // 24 hours
  const DISCONNECTED_THRESHOLD = 30 * 60 * 1000; // 30 minutes

  // Clean up disconnected sessions
  sessions.forEach((session, sessionId) => {
    if (
      session.disconnectedAt &&
      now - session.disconnectedAt > DISCONNECTED_THRESHOLD
    ) {
      const room = session.room;
      if (pointingRooms.has(room)) {
        pointingRooms.get(room).delete(sessionId);
        io.to(room).emit(
          'updateParticipants',
          Array.from(pointingRooms.get(room).values())
        );
        if (pointingRooms.get(room).size === 0) {
          pointingRooms.delete(room);
        }
      }
      sessions.delete(sessionId);
      console.log(`Cleaned up inactive session ${sessionId}`);
    }
  });

  retroRooms.forEach((room, roomId) => {
    if (
      room.participants.size === 0 &&
      now - room.lastActivity > INACTIVE_THRESHOLD
    ) {
      retroRooms.delete(roomId);
      console.log(`Cleaned up inactive retro room: ${roomId}`);
    }
  });

  pointingRooms.forEach((room, roomId) => {
    if (room.size === 0) {
      pointingRooms.delete(roomId);
      console.log(`Cleaned up empty pointing room: ${roomId}`);
    }
  });
}, 60 * 60 * 1000); // Check every hour

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Add near the top with other Express middleware
app.get('/:room', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/validate-access', (req, res) => {
  try {
    const { accessCode } = req.body;

    // Add some logging to debug
    console.log('Received access code validation request');
    console.log('Expected:', process.env.ACCESS_CODE);
    console.log('Received:', accessCode);

    if (accessCode === process.env.ACCESS_CODE) {
      res.json({ valid: true });
    } else {
      res.json({ valid: false });
    }
  } catch (error) {
    console.error('Error in validate-access endpoint:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

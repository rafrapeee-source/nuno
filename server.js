'use strict';

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const { Game, MAX_PLAYERS } = require('./src/game');
const { botAction } = require('./src/bot');

const PORT = process.env.PORT || 3000;
const MAX_SEATS = MAX_PLAYERS;
const MIN_SEATS = 2;
const TURN_MS = 10_000; // time each human gets to make a move
const LOBBY_DROP_MS = 60_000; // disconnected players are removed from the lobby after this
const EMPTY_ROOM_TTL_MS = 10 * 60_000;
const DEAL_ANIMATION_MS = 4000;
const BOT_NAMES = ['Ava (bot)', 'Ben (bot)', 'Cleo (bot)', 'Dex (bot)', 'Eli (bot)', 'Fay (bot)', 'Gus (bot)', 'Hana (bot)'];

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_req, res) => res.send('ok'));

const server = http.createServer(app);
const io = new Server(server);

// Rough length of the client animations for a batch of events, so a turn clock starts once
// the cards have landed rather than while they're still flying.
function animationMs(events) {
  let ms = 300;
  for (const e of events) {
    if (e.type === 'play') ms += 450;
    else if (e.type === 'color') ms += 650;
    else if (e.type === 'swap' || e.type === 'rotate') ms += 1600;
    else if (e.type === 'stack') ms += 600;
    else if (e.type === 'draw') ms += 420 + 130 * (e.count - 1) + (e.reason === 'stack' || e.reason === 'draw2' ? 600 : 0);
    else if (['skip', 'reverse', 'uno', 'catch', 'timeout'].includes(e.type)) ms += 700;
  }
  return ms;
}

/** @type {Map<string, Room>} */
const rooms = new Map();

function cleanName(name) {
  const s = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 16);
  return s || 'Player';
}

function newCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    code = Array.from({ length: 4 }, () => letters[crypto.randomInt(letters.length)]).join('');
  } while (rooms.has(code));
  return code;
}

class Room {
  constructor(code, sevenZero = false) {
    this.code = code;
    this.sevenZero = sevenZero; // table rules: standard UNO or the 7-0 rule
    this.hostId = null;
    this.seats = []; // { playerId, name, socketId, connected, isBot, disconnectedAt }
    this.game = null;
    this.dealtAt = 0;
    this.lastEventId = 0;
    this.turnKey = null; // identifies the turn the clock is running for
    this.turnDeadline = 0;
    this.turnTimer = null;
    this.aiTimer = null;
    this.catchTimer = null;
    this.dropTimers = new Map();
    this.emptySince = null;
  }

  seatOf(playerId) {
    return this.seats.findIndex((s) => s.playerId === playerId);
  }

  humans() {
    return this.seats.filter((s) => !s.isBot);
  }

  ensureHost() {
    const current = this.seats[this.seatOf(this.hostId)];
    if (current && !current.isBot && current.connected) return;
    const next = this.seats.find((s) => !s.isBot && s.connected) || (current && !current.isBot ? current : null) ||
      this.seats.find((s) => !s.isBot);
    this.hostId = next ? next.playerId : null;
  }

  view(idx) {
    return {
      code: this.code,
      you: idx,
      hostIndex: this.seatOf(this.hostId),
      maxSeats: MAX_SEATS,
      sevenZero: this.sevenZero,
      seats: this.seats.map((s) => ({ name: s.name, isBot: s.isBot, connected: s.isBot || s.connected })),
      game: this.game
        ? {
            ...this.game.view(idx),
            turnMs: TURN_MS,
            turnMsLeft: this.turnKey ? Math.max(0, this.turnDeadline - Date.now()) : null,
          }
        : null,
    };
  }

  broadcast() {
    this.seats.forEach((s, i) => {
      if (s.socketId) io.to(s.socketId).emit('state', this.view(i));
    });
  }

  update() {
    this.armTurnTimer();
    this.broadcast();
    this.scheduleAutomation();
  }

  // Human turns get TURN_MS once the update's animations have played. When it runs out, a
  // connected player automatically draws (see Game.timeout); a disconnected one is played by a bot.
  armTurnTimer() {
    const g = this.game;
    clearTimeout(this.turnTimer);
    const fresh = g ? g.events.filter((e) => e.id > this.lastEventId) : [];
    if (g && g.events.length) this.lastEventId = g.events[g.events.length - 1].id;
    if (!g || g.phase === 'gameOver' || this.seats[g.turn].isBot) {
      this.turnKey = null;
      return;
    }
    const key = `${g.turnId}:${g.phase}`;
    if (key !== this.turnKey) {
      this.turnKey = key;
      const now = Date.now();
      const settle = Math.max(animationMs(fresh), DEAL_ANIMATION_MS - (now - this.dealtAt));
      this.turnDeadline = now + settle + TURN_MS;
    }
    const actor = g.turn;
    this.turnTimer = setTimeout(() => {
      if (this.game !== g || this.turnKey !== key) return;
      if (!this.seats[actor].connected && this.apply(actor, botAction(g, actor)).ok) return;
      if (g.timeout(actor).ok) this.update();
    }, this.turnDeadline - Date.now());
  }

  apply(idx, action) {
    const g = this.game;
    if (!g || !action) return { ok: false, error: 'No game in progress.' };
    let r;
    switch (action.type) {
      case 'play':
        if (action.uno) g.callUno(idx);
        r = g.playCard(idx, Number(action.cardId), action.color);
        break;
      case 'draw':
        r = g.drawCard(idx);
        break;
      case 'pass':
        r = g.pass(idx);
        break;
      case 'uno':
        r = g.callUno(idx);
        break;
      case 'catch':
        r = g.catchUno(idx, Number(action.target));
        break;
      case 'chooseColor':
        r = g.chooseColor(idx, action.color);
        break;
      case 'swap':
        r = g.swapHands(idx, Number(action.target));
        break;
      default:
        r = { ok: false, error: 'Unknown action.' };
    }
    if (r.ok) this.update();
    return r;
  }

  // Drives bot seats and bot UNO catches. Human turns run on the turn clock (armTurnTimer).
  scheduleAutomation() {
    clearTimeout(this.aiTimer);
    clearTimeout(this.catchTimer);
    const g = this.game;
    if (!g || g.phase === 'gameOver') return;

    const vulnerable = g.unoVulnerable;
    if (vulnerable !== null) {
      const catchers = this.seats.map((s, i) => i).filter((i) => i !== vulnerable && this.seats[i].isBot);
      if (catchers.length) {
        const catcher = catchers[crypto.randomInt(catchers.length)];
        this.catchTimer = setTimeout(() => {
          if (this.game === g && g.unoVulnerable === vulnerable) this.apply(catcher, { type: 'catch', target: vulnerable });
        }, 1500 + crypto.randomInt(1500));
      }
    }

    const actor = g.turn;
    const seat = this.seats[actor];
    if (!seat.isBot) return; // humans are on the turn clock
    let delay = 1100 + crypto.randomInt(700);
    // Let clients finish the opening deal animation first.
    delay = Math.max(delay, DEAL_ANIMATION_MS - (Date.now() - this.dealtAt));
    // Leave humans a window to catch a bot that forgot to yell UNO.
    if (vulnerable !== null && vulnerable !== actor) delay += 2500;

    this.aiTimer = setTimeout(() => {
      if (this.game !== g) return;
      const r = this.apply(actor, botAction(g, actor));
      if (!r.ok) this.scheduleAutomation();
    }, delay);
  }

  startGame() {
    this.game = new Game(this.seats.map((s) => s.name), { sevenZero: this.sevenZero });
    this.dealtAt = Date.now();
    this.lastEventId = 0;
    this.turnKey = null;
    this.update();
  }

  removeSeat(idx) {
    const [seat] = this.seats.splice(idx, 1);
    if (seat && seat.socketId) {
      const sock = io.sockets.sockets.get(seat.socketId);
      if (sock) {
        sock.leave(this.code);
        sock.data.code = null;
        sock.emit('left');
      }
    }
    this.ensureHost();
  }

  // A player leaving mid-game hands their seat to a bot so the game can go on.
  convertToBot(idx) {
    const seat = this.seats[idx];
    seat.isBot = true;
    seat.playerId = `bot-${crypto.randomUUID()}`;
    seat.socketId = null;
    seat.connected = true;
    seat.name = `${seat.name.replace(/ \(bot\)$/, '')} (bot)`;
    if (this.game) this.game.players[idx].name = seat.name;
    this.ensureHost();
  }

  destroyIfEmpty() {
    if (this.humans().length === 0) {
      clearTimeout(this.aiTimer);
      clearTimeout(this.catchTimer);
      clearTimeout(this.turnTimer);
      rooms.delete(this.code);
      return true;
    }
    return false;
  }
}

function roomOf(socket) {
  const code = socket.data.code;
  const room = code && rooms.get(code);
  if (!room) return null;
  const idx = room.seatOf(socket.data.playerId);
  if (idx === -1) return null;
  return { room, idx };
}

function attach(socket, room, idx) {
  const seat = room.seats[idx];
  if (seat.socketId && seat.socketId !== socket.id) {
    const old = io.sockets.sockets.get(seat.socketId);
    if (old) {
      old.data.code = null;
      old.emit('left', 'You joined from another tab.');
    }
  }
  seat.socketId = socket.id;
  seat.connected = true;
  seat.disconnectedAt = null;
  clearTimeout(room.dropTimers.get(seat.playerId));
  room.dropTimers.delete(seat.playerId);
  socket.data.code = room.code;
  socket.join(room.code);
}

io.on('connection', (socket) => {
  const playerId = String(socket.handshake.auth?.playerId || '').slice(0, 64) || crypto.randomUUID();
  socket.data.playerId = playerId;

  socket.on('room:create', ({ name, sevenZero } = {}, cb = () => {}) => {
    const room = new Room(newCode(), sevenZero === true);
    rooms.set(room.code, room);
    room.seats.push({ playerId, name: cleanName(name), socketId: null, connected: true, isBot: false });
    room.hostId = playerId;
    attach(socket, room, 0);
    cb({ ok: true, code: room.code });
    room.update();
  });

  socket.on('room:join', ({ code, name } = {}, cb = () => {}) => {
    const room = rooms.get(String(code || '').toUpperCase().trim());
    if (!room) return cb({ ok: false, error: 'Room not found.' });
    let idx = room.seatOf(playerId);
    if (idx === -1) {
      if (room.game) return cb({ ok: false, error: 'That game has already started.' });
      if (room.seats.length >= MAX_SEATS) return cb({ ok: false, error: `That room is full (${MAX_SEATS} players).` });
      room.seats.push({ playerId, name: cleanName(name), socketId: null, connected: true, isBot: false });
      idx = room.seats.length - 1;
    }
    attach(socket, room, idx);
    room.ensureHost();
    cb({ ok: true, code: room.code });
    room.update();
  });

  socket.on('room:leave', (_ = {}, cb = () => {}) => {
    const ctx = roomOf(socket);
    socket.data.code = null;
    cb({ ok: true });
    if (!ctx) return;
    const { room, idx } = ctx;
    socket.leave(room.code);
    if (room.game) room.convertToBot(idx);
    else room.removeSeat(idx);
    if (!room.destroyIfEmpty()) room.update();
  });

  socket.on('room:addBot', (_ = {}, cb = () => {}) => {
    const ctx = roomOf(socket);
    if (!ctx) return cb({ ok: false, error: 'Not in a room.' });
    const { room } = ctx;
    if (room.hostId !== playerId) return cb({ ok: false, error: 'Only the host can add bots.' });
    if (room.game) return cb({ ok: false, error: 'The game has started.' });
    if (room.seats.length >= MAX_SEATS) return cb({ ok: false, error: 'The table is full.' });
    const used = new Set(room.seats.map((s) => s.name));
    const name = BOT_NAMES.find((n) => !used.has(n)) || 'Bot';
    room.seats.push({ playerId: `bot-${crypto.randomUUID()}`, name, socketId: null, connected: true, isBot: true });
    cb({ ok: true });
    room.update();
  });

  socket.on('room:setRules', ({ sevenZero } = {}, cb = () => {}) => {
    const ctx = roomOf(socket);
    if (!ctx) return cb({ ok: false, error: 'Not in a room.' });
    const { room } = ctx;
    if (room.hostId !== playerId) return cb({ ok: false, error: 'Only the host can change the rules.' });
    if (room.game) return cb({ ok: false, error: 'The game has started.' });
    room.sevenZero = sevenZero === true;
    cb({ ok: true });
    room.update();
  });

  socket.on('room:kick', ({ seat } = {}, cb = () => {}) => {
    const ctx = roomOf(socket);
    if (!ctx) return cb({ ok: false, error: 'Not in a room.' });
    const { room, idx } = ctx;
    if (room.hostId !== playerId) return cb({ ok: false, error: 'Only the host can remove players.' });
    if (room.game) return cb({ ok: false, error: 'The game has started.' });
    const target = Number(seat);
    if (!room.seats[target] || target === idx) return cb({ ok: false, error: 'Invalid seat.' });
    room.removeSeat(target);
    cb({ ok: true });
    room.update();
  });

  socket.on('room:start', (_ = {}, cb = () => {}) => {
    const ctx = roomOf(socket);
    if (!ctx) return cb({ ok: false, error: 'Not in a room.' });
    const { room } = ctx;
    if (room.hostId !== playerId) return cb({ ok: false, error: 'Only the host can start the game.' });
    if (room.game) return cb({ ok: false, error: 'Already started.' });
    if (room.seats.length < MIN_SEATS) return cb({ ok: false, error: 'You need at least 2 players (add a bot).' });
    cb({ ok: true });
    room.startGame();
  });

  socket.on('game:action', (action = {}, cb = () => {}) => {
    const ctx = roomOf(socket);
    if (!ctx) return cb({ ok: false, error: 'Not in a room.' });
    cb(ctx.room.apply(ctx.idx, action));
  });

  socket.on('game:rematch', (_ = {}, cb = () => {}) => {
    const ctx = roomOf(socket);
    if (!ctx || !ctx.room.game) return cb({ ok: false, error: 'No game in progress.' });
    const { room } = ctx;
    if (room.hostId !== playerId) return cb({ ok: false, error: 'Only the host can start a rematch.' });
    if (room.game.phase !== 'gameOver') return cb({ ok: false, error: 'The game isn’t over yet.' });
    cb({ ok: true });
    room.startGame();
  });

  socket.on('game:backToLobby', (_ = {}, cb = () => {}) => {
    const ctx = roomOf(socket);
    if (!ctx || !ctx.room.game) return cb({ ok: false, error: 'No game in progress.' });
    const { room } = ctx;
    if (room.hostId !== playerId) return cb({ ok: false, error: 'Only the host can do that.' });
    if (room.game.phase !== 'gameOver') return cb({ ok: false, error: 'The game isn’t over yet.' });
    room.game = null;
    cb({ ok: true });
    room.update();
  });

  socket.on('disconnect', () => {
    const ctx = roomOf(socket);
    if (!ctx) return;
    const { room, idx } = ctx;
    const seat = room.seats[idx];
    if (seat.socketId !== socket.id) return;
    seat.socketId = null;
    seat.connected = false;
    seat.disconnectedAt = Date.now();
    if (!room.game) {
      room.dropTimers.set(
        seat.playerId,
        setTimeout(() => {
          const i = room.seatOf(seat.playerId);
          if (i !== -1 && !room.seats[i].connected && !room.game) {
            room.removeSeat(i);
            if (!room.destroyIfEmpty()) room.update();
          }
        }, LOBBY_DROP_MS)
      );
    }
    room.ensureHost();
    room.update();
  });
});

// Sweep rooms where every human has been gone for a while.
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    const anyone = room.seats.some((s) => !s.isBot && s.connected);
    if (anyone) room.emptySince = null;
    else if (!room.emptySince) room.emptySince = now;
    else if (now - room.emptySince > EMPTY_ROOM_TTL_MS) {
      clearTimeout(room.aiTimer);
      clearTimeout(room.catchTimer);
      clearTimeout(room.turnTimer);
      rooms.delete(room.code);
    }
  }
}, 60_000).unref();

server.listen(PORT, () => console.log(`NUNO listening on http://localhost:${PORT}`));

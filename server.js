const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const rooms = new Map();

function makeRoomCode() {
  let code = "";
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let i = 0; i < 5; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function getRoomBySocket(socketId) {
  for (const room of rooms.values()) {
    if (room.players.some(p => p.id === socketId)) return room;
    if (room.spectators.includes(socketId)) return room;
  }
  return null;
}

function publicRoom(room) {
  return {
    code: room.code,
    status: room.status,
    players: room.players.map(p => ({
      name: p.name,
      side: p.side,
      ready: p.ready
    })),
    spectators: room.spectators.length
  };
}

function createInitialGame(room) {
  const firstTurn = Math.random() < 0.5 ? "p1" : "p2";

  return {
    turn: firstTurn,
    winner: null,
    round: 1,
    log: [`Moeda lançada. ${firstTurn === "p1" ? "Jogador 1" : "Jogador 2"} começa.`],

    p1: {
      energy: 1,
      active: {
        name: "Carta P1",
        hp: 120,
        maxHp: 120,
        attached: 0
      },
      bench: [],
      hand: []
    },

    p2: {
      energy: 1,
      active: {
        name: "Carta P2",
        hp: 120,
        maxHp: 120,
        attached: 0
      },
      bench: [],
      hand: []
    }
  };
}

function emitRoom(room) {
  io.to(room.code).emit("room:update", publicRoom(room));

  if (room.game) {
    io.to(room.code).emit("game:state", room.game);
  }
}

io.on("connection", (socket) => {
  console.log("Jogador conectado:", socket.id);

  socket.on("room:create", ({ name }, callback) => {
    let code;

    do {
      code = makeRoomCode();
    } while (rooms.has(code));

    const room = {
      code,
      status: "waiting",
      players: [
        {
          id: socket.id,
          name: name || "Jogador 1",
          side: "p1",
          ready: false
        }
      ],
      spectators: [],
      game: null
    };

    rooms.set(code, room);
    socket.join(code);

    callback({ ok: true, room: publicRoom(room), side: "p1" });
    emitRoom(room);
  });

  socket.on("room:join", ({ code, name }, callback) => {
    code = String(code || "").trim().toUpperCase();

    const room = rooms.get(code);

    if (!room) {
      return callback({ ok: false, error: "Sala não encontrada." });
    }

    socket.join(code);

    if (room.players.length >= 2) {
      room.spectators.push(socket.id);
      callback({ ok: true, room: publicRoom(room), side: "spectator" });
      emitRoom(room);
      return;
    }

    room.players.push({
      id: socket.id,
      name: name || "Jogador 2",
      side: "p2",
      ready: false
    });

    callback({ ok: true, room: publicRoom(room), side: "p2" });
    emitRoom(room);
  });

socket.on("room:ready", (payload, callback) => {
    if (typeof payload === "function") {
        callback = payload;
        payload = {};
    }

    const room = getRoomBySocket(socket.id);

    if (!room) {
        if (typeof callback === "function") {
            callback({ ok: false, error: "Você não está em uma sala." });
        }
        return;
    }

    const player = room.players.find(p => p.id === socket.id);

    if (!player) {
        if (typeof callback === "function") {
            callback({ ok: false, error: "Espectadores não podem ficar prontos." });
        }
        return;
    }

    const receivedDeck = Array.isArray(payload?.deck) ? payload.deck : [];

    if (receivedDeck.length < 5) {
        if (typeof callback === "function") {
            callback({ ok: false, error: "Seu deck precisa ter pelo menos 5 cartas." });
        }
        return;
    }

    player.ready = true;
    player.deck = sanitizeDeck(receivedDeck);

    room.gameLog = room.gameLog || [];
    room.gameLog.push(${player.name} está pronto.);

    if (room.players.length === 2 && room.players.every(p => p.ready && p.deck && p.deck.length >= 5)) {
        room.status = "playing";
        room.game = createInitialGame(room);
    }

    if (typeof callback === "function") {
        callback({ ok: true });
    }

    emitRoom(room);
});

  socket.on("game:action", ({ action }, callback) => {
    const room = getRoomBySocket(socket.id);

    if (!room || !room.game) {
      return callback({ ok: false, error: "Partida não encontrada." });
    }

    if (room.status !== "playing") {
      return callback({ ok: false, error: "A partida não está ativa." });
    }

    const player = room.players.find(p => p.id === socket.id);

    if (!player) {
      return callback({ ok: false, error: "Espectador não pode jogar." });
    }

    const side = player.side;
    const enemySide = side === "p1" ? "p2" : "p1";

    if (room.game.turn !== side) {
      return callback({ ok: false, error: "Não é seu turno." });
    }

    if (!action || !action.type) {
      return callback({ ok: false, error: "Ação inválida." });
    }

    if (action.type === "attack") {
      const damage = Math.max(0, Number(action.damage || 30));

      room.game[enemySide].active.hp -= damage;
      room.game.log.push(`${player.name} atacou causando ${damage} de dano.`);

      if (room.game[enemySide].active.hp <= 0) {
        room.game[enemySide].active.hp = 0;
        room.game.winner = side;
        room.status = "ended";
        room.game.log.push(`${player.name} venceu a partida.`);
      } else {
        room.game.turn = enemySide;
        room.game[enemySide].energy += 1;
        room.game.round += 1;
      }

      callback({ ok: true });
      emitRoom(room);
      return;
    }

    if (action.type === "pass") {
      room.game.log.push(`${player.name} passou o turno.`);
      room.game.turn = enemySide;
      room.game[enemySide].energy += 1;
      room.game.round += 1;

      callback({ ok: true });
      emitRoom(room);
      return;
    }

    if (action.type === "surrender") {
      room.game.winner = enemySide;
      room.status = "ended";
      room.game.log.push(`${player.name} desistiu da partida.`);

      callback({ ok: true });
      emitRoom(room);
      return;
    }

    callback({ ok: false, error: "Tipo de ação não reconhecido." });
  });

  socket.on("chat:quick", ({ message }) => {
    const room = getRoomBySocket(socket.id);
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    const name = player ? player.name : "Espectador";

    io.to(room.code).emit("chat:quick", {
      name,
      message: String(message || "").slice(0, 120)
    });
  });

  socket.on("disconnect", () => {
    const room = getRoomBySocket(socket.id);

    if (!room) return;

    const leavingPlayer = room.players.find(p => p.id === socket.id);

    room.players = room.players.filter(p => p.id !== socket.id);
    room.spectators = room.spectators.filter(id => id !== socket.id);

    if (room.players.length === 0) {
      rooms.delete(room.code);
      return;
    }

    if (room.status === "playing" && room.game && leavingPlayer) {
      const winner = room.players[0].side;
      room.status = "ended";
      room.game.winner = winner;
      room.game.log.push("Um jogador saiu. O adversário venceu automaticamente.");
    }

    emitRoom(room);
  });
});

server.listen(PORT, () => {
  console.log(`Servidor UTCG rodando na porta ${PORT}`);
});

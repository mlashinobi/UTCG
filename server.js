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

app.get("/health", (req, res) => {
  res.status(200).send("UTCG server online");
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const rooms = new Map();

function safeCallback(callback, payload) {
  if (typeof callback === "function") callback(payload);
}

function makeRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
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

function sanitizeDeck(deck) {
  if (!Array.isArray(deck)) return [];

  return deck
    .filter(card => card && card.name)
    .slice(0, 20)
    .map(card => ({
      id: String(card.id || card.name),
      name: String(card.name || "Carta"),
      type: String(card.type || "Neutro"),
      hp: Math.max(10, Number(card.hp || 100)),
      maxHp: Math.max(10, Number(card.hp || 100)),
      curHP: Math.max(10, Number(card.hp || 100)),
      img: String(card.img || ""),
      isEx: !!card.isEx,
      evolvesFrom: card.evolvesFrom || null,
      attached: 0,
      statuses: [],
      skills: Array.isArray(card.skills)
        ? card.skills.slice(0, 3).map(skill => ({
            n: String(skill.n || skill.name || "Ataque"),
            d: Math.max(0, Number(skill.d || skill.dmg || 0)),
            c: Math.max(0, Number(skill.c || skill.cost || 0)),
            desc: String(skill.desc || ""),
            status: skill.status || null,
            special: skill.special || null,
            vid: skill.vid || null
          }))
        : [
            {
              n: "Ataque Básico",
              d: 30,
              c: 1,
              desc: "Ataque padrão.",
              status: null,
              special: null,
              vid: null
            }
          ]
    }));
}

function shuffleDeck(deck) {
  const copy = [...deck];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function drawCard(side) {
  if (!side.deck || side.deck.length === 0) return null;
  const card = side.deck.pop();
  side.hand.push(card);
  return card;
}

function setupPlayerSide(player) {
  const deck = shuffleDeck(player.deck || []);
  const side = {
    name: player.name,
    energy: 1,
    deck,
    hand: [],
    bench: [],
    active: null,
    discard: [],
    points: 0
  };

  for (let i = 0; i < 4; i++) drawCard(side);

  let activeIndex = side.hand.findIndex(card => !card.evolvesFrom);
  if (activeIndex === -1) activeIndex = 0;

  if (side.hand[activeIndex]) {
    side.active = side.hand.splice(activeIndex, 1)[0];
    side.active.curHP = side.active.hp;
    side.active.attached = side.active.attached || 0;
    side.active.statuses = side.active.statuses || [];
  }

  while (side.bench.length < 3) {
    const idx = side.hand.findIndex(card => !card.evolvesFrom);
    if (idx === -1) break;

    const benchCard = side.hand.splice(idx, 1)[0];
    benchCard.curHP = benchCard.hp;
    benchCard.attached = benchCard.attached || 0;
    benchCard.statuses = benchCard.statuses || [];
    side.bench.push(benchCard);
  }

  if (!side.active) {
    side.active = {
      id: "fallback",
      name: "Carta Inicial",
      type: "Neutro",
      hp: 100,
      maxHp: 100,
      curHP: 100,
      img: "",
      isEx: false,
      evolvesFrom: null,
      attached: 0,
      statuses: [],
      skills: [
        {
          n: "Ataque Básico",
          d: 30,
          c: 1,
          desc: "Ataque padrão.",
          status: null,
          special: null,
          vid: null
        }
      ]
    };
  }

  return side;
}

function createInitialGame(room) {
  const firstTurn = Math.random() < 0.5 ? "p1" : "p2";
  const p1 = room.players.find(p => p.side === "p1");
  const p2 = room.players.find(p => p.side === "p2");

  return {
    mode: "online",
    turn: firstTurn,
    winner: null,
    round: 1,
    log: [
      "Partida online criada.",
      `Moeda lançada: ${firstTurn === "p1" ? p1.name : p2.name} começa.`
    ],
    p1: setupPlayerSide(p1),
    p2: setupPlayerSide(p2)
  };
}

function emitRoom(room) {
  io.to(room.code).emit("room:update", publicRoom(room));
  if (room.game) io.to(room.code).emit("game:state", room.game);
}

function advanceTurn(room, nextSide) {
  const game = room.game;
  if (!game || game.winner) return;

  game.turn = nextSide;
  game.round += 1;

  const side = game[nextSide];
  side.energy += 1;
  drawCard(side);

  game.log.push(`Turno de ${side.name}.`);
}

function checkKO(room, defeatedSideName, attackerSideName) {
  const game = room.game;
  const defeatedSide = game[defeatedSideName];
  const attackerSide = game[attackerSideName];

  if (!defeatedSide.active || defeatedSide.active.curHP > 0) return false;

  game.log.push(`${defeatedSide.active.name} foi derrotado.`);
  defeatedSide.discard.push(defeatedSide.active);

  if (defeatedSide.bench.length > 0) {
    defeatedSide.active = defeatedSide.bench.shift();
    game.log.push(`${defeatedSide.active.name} entrou como novo ativo.`);
    return false;
  }

  game.winner = attackerSideName;
  room.status = "ended";
  game.log.push(`${attackerSide.name} venceu a partida.`);
  return true;
}

function applySkillStatus(targetCard, status) {
  if (!targetCard || !status || !status.type) return;
  if (!Array.isArray(targetCard.statuses)) targetCard.statuses = [];

  const existing = targetCard.statuses.find(s => s.type === status.type);
  if (existing) {
    existing.turns = Math.max(existing.turns, Number(status.turns || 1));
  } else {
    targetCard.statuses.push({
      type: status.type,
      turns: Number(status.turns || 1)
    });
  }
}

function playCardFromHand(side, handIndex) {
  const index = Number(handIndex);

  if (!Number.isInteger(index) || index < 0 || index >= side.hand.length) {
    return { ok: false, error: "Carta inválida." };
  }

  const card = side.hand[index];

  if (card.evolvesFrom) {
    if (side.active && side.active.name === card.evolvesFrom) {
      const damageTaken = side.active.hp - side.active.curHP;

      card.curHP = Math.max(10, card.hp - damageTaken);
      card.attached = side.active.attached || 0;
      card.statuses = side.active.statuses || [];

      side.discard.push(side.active);
      side.active = card;
      side.hand.splice(index, 1);

      return { ok: true, message: `${card.name} evoluiu no ativo.` };
    }

    const benchIndex = side.bench.findIndex(c => c.name === card.evolvesFrom);

    if (benchIndex >= 0) {
      const oldCard = side.bench[benchIndex];
      const damageTaken = oldCard.hp - oldCard.curHP;

      card.curHP = Math.max(10, card.hp - damageTaken);
      card.attached = oldCard.attached || 0;
      card.statuses = oldCard.statuses || [];

      side.discard.push(oldCard);
      side.bench[benchIndex] = card;
      side.hand.splice(index, 1);

      return { ok: true, message: `${card.name} evoluiu no banco.` };
    }

    return { ok: false, error: "Você não tem a forma anterior dessa evolução em campo." };
  }

  if (!side.active) {
    card.curHP = card.hp;
    card.attached = 0;
    card.statuses = [];
    side.active = card;
    side.hand.splice(index, 1);

    return { ok: true, message: `${card.name} entrou como ativo.` };
  }

  if (side.bench.length >= 3) {
    return { ok: false, error: "Banco cheio." };
  }

  card.curHP = card.hp;
  card.attached = 0;
  card.statuses = [];
  side.bench.push(card);
  side.hand.splice(index, 1);

  return { ok: true, message: `${card.name} foi colocado no banco.` };
}

function attachEnergyToTarget(side, target, benchIndex) {
  if (side.energy <= 0) {
    return { ok: false, error: "Sem energia disponível." };
  }

  let card = null;

  if (target === "bench") {
    const idx = Number(benchIndex);
    card = side.bench[idx];
  } else {
    card = side.active;
  }

  if (!card) return { ok: false, error: "Alvo inválido." };

  card.attached = (card.attached || 0) + 1;
  side.energy -= 1;

  return { ok: true, message: `Energia anexada em ${card.name}.` };
}

function switchActive(side, benchIndex) {
  const idx = Number(benchIndex);

  if (!Number.isInteger(idx) || idx < 0 || idx >= side.bench.length) {
    return { ok: false, error: "Banco inválido." };
  }

  const oldActive = side.active;
  side.active = side.bench[idx];
  side.bench[idx] = oldActive;

  return { ok: true, message: `${side.active.name} virou o ativo.` };
}

io.on("connection", (socket) => {
  console.log("Jogador conectado:", socket.id);

  socket.on("room:create", (payload = {}, callback) => {
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
          name: payload.name || "Jogador 1",
          side: "p1",
          ready: false,
          deck: []
        }
      ],
      spectators: [],
      game: null
    };

    rooms.set(code, room);
    socket.join(code);

    safeCallback(callback, {
      ok: true,
      room: publicRoom(room),
      side: "p1"
    });

    emitRoom(room);
  });

  socket.on("room:join", (payload = {}, callback) => {
    const code = String(payload.code || "").trim().toUpperCase();
    const room = rooms.get(code);

    if (!room) {
      safeCallback(callback, { ok: false, error: "Sala não encontrada." });
      return;
    }

    socket.join(code);

    if (room.players.length >= 2) {
      room.spectators.push(socket.id);
      safeCallback(callback, {
        ok: true,
        room: publicRoom(room),
        side: "spectator"
      });
      emitRoom(room);
      return;
    }

    room.players.push({
      id: socket.id,
      name: payload.name || "Jogador 2",
      side: "p2",
      ready: false,
      deck: []
    });

    safeCallback(callback, {
      ok: true,
      room: publicRoom(room),
      side: "p2"
    });

    emitRoom(room);
  });

  socket.on("room:ready", (payload = {}, callback) => {
    if (typeof payload === "function") {
      callback = payload;
      payload = {};
    }

    const room = getRoomBySocket(socket.id);

    if (!room) {
      safeCallback(callback, { ok: false, error: "Você não está em uma sala." });
      return;
    }

    const player = room.players.find(p => p.id === socket.id);

    if (!player) {
      safeCallback(callback, { ok: false, error: "Espectadores não podem ficar prontos." });
      return;
    }

    const deck = sanitizeDeck(payload.deck || payload.userDeck || []);

    if (deck.length < 5) {
      safeCallback(callback, {
        ok: false,
        error: "Seu deck online precisa ter pelo menos 5 cartas. O index.html precisa enviar user.deck no botão Estou Pronto."
      });
      return;
    }

    player.deck = deck;
    player.ready = true;

    if (!room.gameLog) room.gameLog = [];
    room.gameLog.push(`${player.name} está pronto.`);

    if (room.players.length === 2 && room.players.every(p => p.ready && p.deck.length >= 5)) {
      room.status = "playing";
      room.game = createInitialGame(room);
    }

    safeCallback(callback, { ok: true });
    emitRoom(room);
  });

  socket.on("game:action", (payload = {}, callback) => {
    const room = getRoomBySocket(socket.id);

    if (!room || !room.game) {
      safeCallback(callback, { ok: false, error: "Partida não encontrada." });
      return;
    }

    if (room.status !== "playing") {
      safeCallback(callback, { ok: false, error: "A partida não está ativa." });
      return;
    }

    const player = room.players.find(p => p.id === socket.id);

    if (!player) {
      safeCallback(callback, { ok: false, error: "Espectador não pode jogar." });
      return;
    }

    const action = payload.action || payload;
    const sideName = player.side;
    const enemySideName = sideName === "p1" ? "p2" : "p1";
    const side = room.game[sideName];
    const enemySide = room.game[enemySideName];

    if (room.game.turn !== sideName) {
      safeCallback(callback, { ok: false, error: "Não é seu turno." });
      return;
    }

    if (!action || !action.type) {
      safeCallback(callback, { ok: false, error: "Ação inválida." });
      return;
    }

    if (action.type === "playCard" || action.type === "play-card" || action.type === "play_card") {
      const result = playCardFromHand(side, action.handIndex);
      if (result.ok) room.game.log.push(`${player.name}: ${result.message}`);
      safeCallback(callback, result);
      emitRoom(room);
      return;
    }

    if (action.type === "attachEnergy" || action.type === "attach-energy" || action.type === "attach_energy") {
      const result = attachEnergyToTarget(side, action.target || "active", action.benchIndex);
      if (result.ok) room.game.log.push(`${player.name}: ${result.message}`);
      safeCallback(callback, result);
      emitRoom(room);
      return;
    }

    if (action.type === "switchActive" || action.type === "switch-active" || action.type === "switch_active") {
      const result = switchActive(side, action.benchIndex);
      if (result.ok) room.game.log.push(`${player.name}: ${result.message}`);
      safeCallback(callback, result);
      emitRoom(room);
      return;
    }

    if (action.type === "attack") {
      if (!side.active || !enemySide.active) {
        safeCallback(callback, { ok: false, error: "Não há carta ativa para atacar." });
        return;
      }

      const skillIndex = Number(action.skillIndex || 0);
      const skill = side.active.skills[skillIndex];

      if (!skill) {
        safeCallback(callback, { ok: false, error: "Ataque inválido." });
        return;
      }

      if ((side.active.attached || 0) < skill.c) {
        safeCallback(callback, { ok: false, error: "Energia anexada insuficiente." });
        return;
      }

      const damage = Math.max(0, Number(skill.d || action.damage || 0));
      enemySide.active.curHP -= damage;

      room.game.log.push(`${player.name} usou ${skill.n} causando ${damage} de dano.`);

      if (skill.status) {
        const target = skill.status.target === "self" ? side.active : enemySide.active;
        applySkillStatus(target, skill.status);
        room.game.log.push(`${target.name} recebeu status ${skill.status.type}.`);
      }

      checkKO(room, enemySideName, sideName);

      if (!room.game.winner) {
        advanceTurn(room, enemySideName);
      }

      safeCallback(callback, { ok: true });
      emitRoom(room);
      return;
    }

    if (action.type === "pass") {
      room.game.log.push(`${player.name} passou o turno.`);
      advanceTurn(room, enemySideName);
      safeCallback(callback, { ok: true });
      emitRoom(room);
      return;
    }

    if (action.type === "surrender") {
      room.game.winner = enemySideName;
      room.status = "ended";
      room.game.log.push(`${player.name} desistiu da partida.`);
      safeCallback(callback, { ok: true });
      emitRoom(room);
      return;
    }

    safeCallback(callback, { ok: false, error: "Tipo de ação não reconhecido." });
  });

  socket.on("chat:quick", (payload = {}) => {
    const room = getRoomBySocket(socket.id);
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    const name = player ? player.name : "Espectador";

    io.to(room.code).emit("chat:quick", {
      name,
      message: String(payload.message || "").slice(0, 120)
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

process.on("uncaughtException", (err) => {
  console.error("ERRO FATAL:", err);
});

process.on("unhandledRejection", (err) => {
  console.error("PROMISE REJEITADA:", err);
});

server.listen(PORT, () => {
  console.log(`Servidor UTCG rodando na porta ${PORT}`);
});

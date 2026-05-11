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
  res.status(200).send("UTCG multiplayer online");
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

function getPlayerBySocket(room, socketId) {
  if (!room) return null;
  return room.players.find(p => p.id === socketId) || null;
}

function publicRoom(room) {
  return {
    code: room.code,
    status: room.status,
    players: room.players.map(p => ({
      name: p.name,
      side: p.side,
      ready: p.ready,
      connected: true
    })),
    spectatorCount: room.spectators.length,
    spectators: room.spectators.length
  };
}

function normalizeStatus(status) {
  if (!status) return null;

  if (typeof status === "string") {
    return { type: status, target: "enemy", turns: 2 };
  }

  if (typeof status === "object") {
    return {
      type: String(status.type || status.name || "status"),
      target: String(status.target || "enemy"),
      turns: Math.max(1, Number(status.turns || 2))
    };
  }

  return null;
}

function sanitizeDeck(deck) {
  if (!Array.isArray(deck)) return [];

  return deck
    .filter(card => card && card.name)
    .slice(0, 20)
    .map(card => {
      const hp = Math.max(10, Number(card.hp || card.maxHp || 100));
      const skills = Array.isArray(card.skills)
        ? card.skills.slice(0, 3).map(skill => ({
            n: String(skill.n || skill.name || "Ataque"),
            d: Math.max(0, Number(skill.d || skill.dmg || 0)),
            c: Math.max(0, Number(skill.c || skill.cost || 0)),
            desc: String(skill.desc || ""),
            status: normalizeStatus(skill.status),
            special: skill.special || null,
            vid: String(skill.vid || "")
          }))
        : [
            {
              n: "Ataque Básico",
              d: 30,
              c: 1,
              desc: "Ataque padrão.",
              status: null,
              special: null,
              vid: ""
            }
          ];

      return {
        id: String(card.id || card.name),
        name: String(card.name || "Carta"),
        type: String(card.type || "Neutro"),
        hp,
        maxHp: hp,
        curHP: hp,
        img: String(card.img || ""),
        isEx: !!card.isEx,
        isSupport: !!card.isSupport,
        evolvesFrom: card.evolvesFrom || null,
        desc: String(card.desc || ""),
        effect: card.effect || null,
        attached: 0,
        statuses: [],
        skills: skills.length ? skills : [
          {
            n: "Ataque Básico",
            d: 30,
            c: 1,
            desc: "Ataque padrão.",
            status: null,
            special: null,
            vid: ""
          }
        ]
      };
    });
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function shuffleDeck(deck) {
  const copy = deck.map(clone);

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

function prepareCard(card) {
  const prepared = clone(card);
  prepared.curHP = Math.max(1, Number(prepared.curHP || prepared.hp || 100));
  prepared.attached = Number(prepared.attached || 0);
  prepared.statuses = Array.isArray(prepared.statuses) ? prepared.statuses : [];
  return prepared;
}

function setupPlayerSide(player) {
  const deck = shuffleDeck(player.deck || []);

  const side = {
    name: player.name,
    energyPool: 1,
    energy: 1,
    energies: {},
    deck,
    hand: [],
    bench: [],
    active: null,
    discard: [],
    points: 0
  };

  for (let i = 0; i < 4; i++) drawCard(side);

  let activeIndex = side.hand.findIndex(card => !card.evolvesFrom && !card.isSupport);
  if (activeIndex === -1) activeIndex = side.hand.findIndex(card => !card.isSupport);
  if (activeIndex === -1) activeIndex = 0;

  if (side.hand[activeIndex]) {
    side.active = prepareCard(side.hand.splice(activeIndex, 1)[0]);
  }

  while (side.bench.length < 3) {
    const idx = side.hand.findIndex(card => !card.evolvesFrom && !card.isSupport);
    if (idx === -1) break;
    side.bench.push(prepareCard(side.hand.splice(idx, 1)[0]));
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
      isSupport: false,
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
          vid: ""
        }
      ]
    };
  }

  return side;
}

function addLog(game, text, color = "#4ade80") {
  game.log.push({ text, color });
  if (game.log.length > 80) game.log = game.log.slice(-80);
}

function createInitialGame(room) {
  const p1 = room.players.find(p => p.side === "p1");
  const p2 = room.players.find(p => p.side === "p2");
  const firstTurn = Math.random() < 0.5 ? "p1" : "p2";

  const game = {
    mode: "online",
    roomCode: room.code,
    turn: firstTurn,
    winner: null,
    round: 1,
    lastEvent: null,
    log: [],
    p1: setupPlayerSide(p1),
    p2: setupPlayerSide(p2)
  };

  addLog(game, "Partida online criada.", "#38bdf8");
  addLog(game, `Moeda lançada: ${firstTurn === "p1" ? p1.name : p2.name} começa.`, "#fbbf24");

  return game;
}

function sideFor(room, sideName) {
  return room.game[sideName];
}

function enemySideName(sideName) {
  return sideName === "p1" ? "p2" : "p1";
}

function publicCard(card, hideDetails = false) {
  if (!card) return null;

  const data = {
    id: card.id,
    name: card.name,
    type: card.type,
    hp: card.hp,
    maxHp: card.maxHp || card.hp,
    curHP: Math.max(0, Number(card.curHP || 0)),
    img: card.img,
    isEx: !!card.isEx,
    isSupport: !!card.isSupport,
    evolvesFrom: card.evolvesFrom || null,
    attached: Number(card.attached || 0),
    statuses: Array.isArray(card.statuses) ? card.statuses : [],
    skills: Array.isArray(card.skills) ? card.skills : []
  };

  if (hideDetails) {
    data.name = "Carta Oculta";
    data.type = "Oculto";
    data.hp = 0;
    data.maxHp = 0;
    data.curHP = 0;
    data.img = "";
    data.skills = [];
  }

  return data;
}

function publicSide(side, hideHand = false) {
  return {
    name: side.name,
    energyPool: Number(side.energyPool || side.energy || 0),
    energy: Number(side.energyPool || side.energy || 0),
    energies: side.energies || {},
    active: publicCard(side.active),
    bench: (side.bench || []).map(c => publicCard(c)),
    hand: hideHand
      ? (side.hand || []).map(() => ({ hidden: true, name: "Carta Oculta" }))
      : (side.hand || []).map(c => publicCard(c)),
    deckCount: (side.deck || []).length,
    discardCount: (side.discard || []).length,
    points: side.points || 0
  };
}

function buildGameStateFor(room, viewerSide) {
  const game = room.game;
  const enemy = viewerSide === "p1" ? "p2" : "p1";

  if (viewerSide !== "p1" && viewerSide !== "p2") {
    return {
      mode: "online",
      roomCode: room.code,
      youSide: "spectator",
      isYourTurn: false,
      turn: game.turn,
      winner: game.winner,
      round: game.round,
      log: game.log,
      lastEvent: game.lastEvent,
      you: publicSide(game.p1, true),
      enemy: publicSide(game.p2, true)
    };
  }

  return {
    mode: "online",
    roomCode: room.code,
    youSide: viewerSide,
    isYourTurn: game.turn === viewerSide && !game.winner,
    turn: game.turn,
    winner: game.winner,
    round: game.round,
    log: game.log,
    lastEvent: game.lastEvent,
    you: publicSide(game[viewerSide], false),
    enemy: publicSide(game[enemy], true)
  };
}

function emitGameState(room) {
  if (!room || !room.game) return;

  for (const player of room.players) {
    io.to(player.id).emit("game:state", buildGameStateFor(room, player.side));
  }

  for (const spectatorId of room.spectators) {
    io.to(spectatorId).emit("game:state", buildGameStateFor(room, "spectator"));
  }
}

function emitRoom(room) {
  io.to(room.code).emit("room:update", publicRoom(room));
  emitGameState(room);
}

function nextEvent(game, type, source, payload = {}) {
  game.lastEvent = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    type,
    source,
    ...payload
  };
}

function advanceTurn(room, nextSide) {
  const game = room.game;
  if (!game || game.winner) return;

  game.turn = nextSide;
  game.round += 1;

  const side = sideFor(room, nextSide);
  side.energyPool = Number(side.energyPool || 0) + 1;
  side.energy = side.energyPool;

  drawCard(side);
  applyStartTurnStatuses(room, nextSide);

  addLog(game, `Turno de ${side.name}.`, "#38bdf8");
}

function applyStartTurnStatuses(room, sideName) {
  const game = room.game;
  const side = sideFor(room, sideName);
  const card = side.active;

  if (!card || !Array.isArray(card.statuses)) return;

  const kept = [];

  for (const status of card.statuses) {
    if (status.type === "burn") {
      card.curHP -= 10;
      addLog(game, `${card.name} sofreu 10 de queimadura.`, "#fb923c");
    }

    if (status.type === "poison") {
      card.curHP -= 10;
      addLog(game, `${card.name} sofreu 10 de veneno.`, "#a3e635");
    }

    status.turns = Number(status.turns || 1) - 1;
    if (status.turns > 0) kept.push(status);
  }

  card.statuses = kept;

  checkKO(room, sideName, enemySideName(sideName));
}

function checkKO(room, defeatedSideName, attackerSideName) {
  const game = room.game;
  const defeatedSide = sideFor(room, defeatedSideName);
  const attackerSide = sideFor(room, attackerSideName);

  if (!defeatedSide.active || defeatedSide.active.curHP > 0) return false;

  addLog(game, `${defeatedSide.active.name} foi derrotado.`, "#ef4444");

  defeatedSide.discard.push(defeatedSide.active);
  attackerSide.points += defeatedSide.active.isEx ? 2 : 1;

  if (defeatedSide.bench.length > 0) {
    defeatedSide.active = defeatedSide.bench.shift();
    addLog(game, `${defeatedSide.active.name} entrou como novo ativo.`, "#fbbf24");
    return false;
  }

  game.winner = attackerSideName;
  room.status = "ended";
  addLog(game, `${attackerSide.name} venceu a partida.`, "#fbbf24");

  return true;
}

function applySkillStatus(targetCard, status) {
  if (!targetCard || !status || !status.type) return;

  if (!Array.isArray(targetCard.statuses)) {
    targetCard.statuses = [];
  }

  const existing = targetCard.statuses.find(s => s.type === status.type);

  if (existing) {
    existing.turns = Math.max(existing.turns, Number(status.turns || 1));
  } else {
    targetCard.statuses.push({
      type: String(status.type),
      turns: Number(status.turns || 1)
    });
  }
}

function playSupport(side, card) {
  if (!side.active) return "Suporte usado.";

  const effect = card.effect;

  if (effect === "heal" || effect?.type === "heal") {
    const amount = Number(effect.amount || card.amount || 30);
    side.active.curHP = Math.min(side.active.hp, side.active.curHP + amount);
    return `${card.name} curou ${amount} de HP.`;
  }

  if (effect === "draw" || effect?.type === "draw") {
    const amount = Number(effect.amount || 2);
    for (let i = 0; i < amount; i++) drawCard(side);
    return `${card.name} comprou ${amount} carta(s).`;
  }

  side.active.curHP = Math.min(side.active.hp, side.active.curHP + 20);
  return `${card.name} curou 20 de HP.`;
}

function playCardFromHand(side, handIndex) {
  const index = Number(handIndex);

  if (!Number.isInteger(index) || index < 0 || index >= side.hand.length) {
    return { ok: false, error: "Carta inválida." };
  }

  const card = side.hand[index];

  if (card.isSupport) {
    const message = playSupport(side, card);
    side.discard.push(card);
    side.hand.splice(index, 1);
    return { ok: true, message };
  }

  if (card.evolvesFrom) {
    if (side.active && side.active.name === card.evolvesFrom) {
      const old = side.active;
      const damageTaken = Math.max(0, Number(old.hp || 0) - Number(old.curHP || 0));

      const evolved = prepareCard(card);
      evolved.curHP = Math.max(10, evolved.hp - damageTaken);
      evolved.attached = old.attached || 0;
      evolved.statuses = old.statuses || [];

      side.discard.push(old);
      side.active = evolved;
      side.hand.splice(index, 1);

      return { ok: true, message: `${evolved.name} evoluiu no ativo.` };
    }

    const benchIndex = side.bench.findIndex(c => c.name === card.evolvesFrom);

    if (benchIndex >= 0) {
      const old = side.bench[benchIndex];
      const damageTaken = Math.max(0, Number(old.hp || 0) - Number(old.curHP || 0));

      const evolved = prepareCard(card);
      evolved.curHP = Math.max(10, evolved.hp - damageTaken);
      evolved.attached = old.attached || 0;
      evolved.statuses = old.statuses || [];

      side.discard.push(old);
      side.bench[benchIndex] = evolved;
      side.hand.splice(index, 1);

      return { ok: true, message: `${evolved.name} evoluiu no banco.` };
    }

    return { ok: false, error: "Você não tem a forma anterior dessa evolução em campo." };
  }

  if (!side.active) {
    side.active = prepareCard(card);
    side.hand.splice(index, 1);
    return { ok: true, message: `${card.name} entrou como ativo.` };
  }

  if (side.bench.length >= 3) {
    return { ok: false, error: "Banco cheio." };
  }

  side.bench.push(prepareCard(card));
  side.hand.splice(index, 1);

  return { ok: true, message: `${card.name} foi colocado no banco.` };
}

function readTarget(action) {
  const target = action.target;

  if (typeof target === "object" && target) {
    return {
      zone: target.zone || "active",
      index: Number(target.index || 0)
    };
  }

  return {
    zone: String(target || "active"),
    index: Number(action.benchIndex || action.index || 0)
  };
}

function attachEnergyToTarget(side, action) {
  if (Number(side.energyPool || side.energy || 0) <= 0) {
    return { ok: false, error: "Sem energia disponível." };
  }

  const target = readTarget(action);
  let card = null;

  if (target.zone === "bench") {
    card = side.bench[target.index];
  } else {
    card = side.active;
  }

  if (!card) return { ok: false, error: "Alvo inválido." };

  card.attached = Number(card.attached || 0) + 1;
  side.energyPool = Number(side.energyPool || side.energy || 0) - 1;
  side.energy = side.energyPool;

  return {
    ok: true,
    message: `Energia anexada em ${card.name}.`,
    event: {
      zone: target.zone,
      index: target.index
    }
  };
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

function handleAction(room, player, action) {
  const game = room.game;
  const sideName = player.side;
  const enemyName = enemySideName(sideName);
  const side = sideFor(room, sideName);
  const enemy = sideFor(room, enemyName);

  if (game.turn !== sideName) {
    return { ok: false, error: "Não é seu turno." };
  }

  if (!action || !action.type) {
    return { ok: false, error: "Ação inválida." };
  }

  const type = String(action.type);

  if (type === "playCard" || type === "play-card" || type === "play_card") {
    const result = playCardFromHand(side, action.handIndex);
    if (result.ok) addLog(game, `${player.name}: ${result.message}`, "#a7f3d0");
    return result;
  }

  if (type === "attachEnergy" || type === "attach-energy" || type === "attach_energy") {
    const result = attachEnergyToTarget(side, action);
    if (result.ok) {
      addLog(game, `${player.name}: ${result.message}`, "#38bdf8");
      nextEvent(game, "energy", sideName, result.event || {});
    }
    return result;
  }

  if (type === "promote" || type === "switchActive" || type === "switch-active" || type === "switch_active") {
    const result = switchActive(side, action.benchIndex);
    if (result.ok) addLog(game, `${player.name}: ${result.message}`, "#fbbf24");
    return result;
  }

  if (type === "attack") {
    if (!side.active || !enemy.active) {
      return { ok: false, error: "Não há carta ativa para atacar." };
    }

    const skillIndex = Number(action.skillIndex || 0);
    const skill = side.active.skills[skillIndex];

    if (!skill) {
      return { ok: false, error: "Ataque inválido." };
    }

    if (side.active.statuses?.some(s => s.type === "stun" || s.type === "freeze")) {
      side.active.statuses = side.active.statuses.filter(s => s.type !== "stun" && s.type !== "freeze");
      addLog(game, `${side.active.name} estava impedido e perdeu a ação.`, "#94a3b8");
      advanceTurn(room, enemyName);
      return { ok: true };
    }

    if (Number(side.active.attached || 0) < Number(skill.c || 0)) {
      return { ok: false, error: "Energia anexada insuficiente." };
    }

    const damage = Math.max(0, Number(skill.d || action.damage || 0));
    enemy.active.curHP -= damage;

    addLog(game, `${player.name} usou ${skill.n} causando ${damage} de dano.`, "#ef4444");

    if (skill.status) {
      const target = skill.status.target === "self" ? side.active : enemy.active;
      applySkillStatus(target, skill.status);
      addLog(game, `${target.name} recebeu status ${skill.status.type}.`, "#fb923c");
    }

    nextEvent(game, "attack", sideName, {
      skill,
      damage,
      target: enemyName
    });

    checkKO(room, enemyName, sideName);

    if (!game.winner) {
      advanceTurn(room, enemyName);
    }

    return { ok: true };
  }

  if (type === "pass") {
    addLog(game, `${player.name} passou o turno.`, "#94a3b8");
    advanceTurn(room, enemyName);
    return { ok: true };
  }

  if (type === "concede" || type === "surrender") {
    game.winner = enemyName;
    room.status = "ended";
    addLog(game, `${player.name} desistiu da partida.`, "#ef4444");
    return { ok: true };
  }

  return { ok: false, error: "Tipo de ação não reconhecido." };
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
          name: String(payload.name || "Jogador 1").slice(0, 18),
          side: "p1",
          ready: false,
          deck: []
        }
      ],
      spectators: [],
      game: null,
      createdAt: Date.now()
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
        side: "spectator",
        spectator: true
      });
      emitRoom(room);
      return;
    }

    room.players.push({
      id: socket.id,
      name: String(payload.name || "Jogador 2").slice(0, 18),
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

  socket.on("room:leave", (payload = {}, callback) => {
    const room = getRoomBySocket(socket.id);
    if (!room) {
      safeCallback(callback, { ok: true });
      return;
    }

    room.players = room.players.filter(p => p.id !== socket.id);
    room.spectators = room.spectators.filter(id => id !== socket.id);
    socket.leave(room.code);

    if (room.players.length === 0) {
      rooms.delete(room.code);
    } else {
      emitRoom(room);
    }

    safeCallback(callback, { ok: true });
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

    const player = getPlayerBySocket(room, socket.id);

    if (!player) {
      safeCallback(callback, { ok: false, error: "Espectadores não podem ficar prontos." });
      return;
    }

    const deck = sanitizeDeck(payload.deck || payload.userDeck || []);

    if (deck.length < 5) {
      safeCallback(callback, {
        ok: false,
        error: "Seu deck online precisa ter pelo menos 5 cartas."
      });
      return;
    }

    player.deck = deck;
    player.ready = true;

    if (room.players.length === 2 && room.players.every(p => p.ready && p.deck.length >= 5)) {
      room.status = "playing";
      room.game = createInitialGame(room);
      console.log(`Partida iniciada na sala ${room.code}`);
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

    const player = getPlayerBySocket(room, socket.id);

    if (!player) {
      safeCallback(callback, { ok: false, error: "Espectador não pode jogar." });
      return;
    }

    const action = payload.action || payload;
    const result = handleAction(room, player, action);

    safeCallback(callback, result);
    emitRoom(room);
  });

  socket.on("chat:quick", (payload = {}) => {
    const room = getRoomBySocket(socket.id);
    if (!room) return;

    const player = getPlayerBySocket(room, socket.id);
    const name = player ? player.name : "Espectador";

    io.to(room.code).emit("chat:quick", {
      name,
      message: String(payload.message || "").slice(0, 120)
    });
  });

  socket.on("disconnect", () => {
    const room = getRoomBySocket(socket.id);
    if (!room) return;

    const leavingPlayer = getPlayerBySocket(room, socket.id);

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
      addLog(room.game, "Um jogador saiu. O adversário venceu automaticamente.", "#ef4444");
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

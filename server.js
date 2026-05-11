const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (req, res) => res.status(200).send("UTCG multiplayer online"));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const rooms = new Map();

function cb(callback, payload){ if(typeof callback === "function") callback(payload); }

function makeCode(){
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for(let i=0;i<5;i++) out += chars[Math.floor(Math.random()*chars.length)];
  return out;
}

function roomBySocket(id){
  for(const room of rooms.values()){
    if(room.players.some(p => p.id === id)) return room;
    if(room.spectators.includes(id)) return room;
  }
  return null;
}

function playerBySocket(room,id){ return room.players.find(p => p.id === id) || null; }

function publicRoom(room){
  return {
    code: room.code,
    status: room.status,
    players: room.players.map(p => ({ name:p.name, side:p.side, ready:p.ready })),
    spectatorCount: room.spectators.length
  };
}

function normalizeStatus(status){
  if(!status) return null;
  if(typeof status === "string") return { type:status, target:"enemy", turns:2 };
  if(typeof status === "object"){
    return {
      type: String(status.type || status.name || "status"),
      target: String(status.target || "enemy"),
      turns: Math.max(1, Number(status.turns || 2))
    };
  }
  return null;
}

function sanitizeDeck(deck){
  if(!Array.isArray(deck)) return [];
  return deck
    .filter(c => c && c.name)
    .slice(0,20)
    .map(c => {
      const hp = Math.max(10, Number(c.hp || c.maxHp || 100));
      const skills = Array.isArray(c.skills) && c.skills.length
        ? c.skills.slice(0,3).map(s => ({
            n: String(s.n || s.name || "Ataque"),
            d: Math.max(0, Number(s.d || s.dmg || 0)),
            c: Math.max(0, Number(s.c || s.cost || 0)),
            desc: String(s.desc || ""),
            status: normalizeStatus(s.status),
            special: s.special || null,
            vid: String(s.vid || "")
          }))
        : [{ n:"Ataque Básico", d:30, c:1, desc:"Ataque padrão.", status:null, special:null, vid:"" }];

      return {
        id: String(c.id || c.name),
        name: String(c.name || "Carta"),
        type: String(c.type || "Neutro"),
        hp, maxHp: hp, curHP: hp,
        img: String(c.img || ""),
        isEx: !!c.isEx,
        isSupport: !!c.isSupport,
        evolvesFrom: c.evolvesFrom || null,
        desc: String(c.desc || ""),
        effect: c.effect || null,
        attached: 0,
        statuses: [],
        skills
      };
    });
}

function clone(x){ return JSON.parse(JSON.stringify(x)); }

function shuffle(deck){
  const copy = deck.map(clone);
  for(let i=copy.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function prepCard(c){
  const card = clone(c);
  card.curHP = Math.max(1, Number(card.curHP || card.hp || 100));
  card.attached = Number(card.attached || 0);
  card.statuses = Array.isArray(card.statuses) ? card.statuses : [];
  return card;
}

function draw(side){
  if(!side.deck.length) return null;
  const c = side.deck.pop();
  side.hand.push(c);
  return c;
}

function setupSide(player){
  const side = {
    name: player.name,
    energyPool: 1,
    energy: 1,
    energies: {},
    deck: shuffle(player.deck),
    hand: [],
    bench: [],
    active: null,
    discard: [],
    points: 0
  };

  for(let i=0;i<4;i++) draw(side);

  let idx = side.hand.findIndex(c => !c.evolvesFrom && !c.isSupport);
  if(idx < 0) idx = side.hand.findIndex(c => !c.isSupport);
  if(idx < 0) idx = 0;

  if(side.hand[idx]) side.active = prepCard(side.hand.splice(idx,1)[0]);

  while(side.bench.length < 3){
    const bi = side.hand.findIndex(c => !c.evolvesFrom && !c.isSupport);
    if(bi < 0) break;
    side.bench.push(prepCard(side.hand.splice(bi,1)[0]));
  }

  if(!side.active){
    side.active = prepCard({
      id:"fallback",
      name:"Lutador Online",
      type:"Neutro",
      hp:100,
      img:"",
      skills:[{ n:"Ataque Básico", d:30, c:1, desc:"Ataque padrão." }]
    });
  }

  return side;
}

function addLog(game,text,color="#4ade80"){
  game.log.push({ text, color });
  if(game.log.length > 80) game.log = game.log.slice(-80);
}

function createGame(room){
  const p1 = room.players.find(p => p.side === "p1");
  const p2 = room.players.find(p => p.side === "p2");
  const first = Math.random() < 0.5 ? "p1" : "p2";

  const game = {
    mode:"online",
    roomCode:room.code,
    turn:first,
    winner:null,
    round:1,
    lastEvent:null,
    log:[],
    p1:setupSide(p1),
    p2:setupSide(p2)
  };

  addLog(game, "Partida online criada.", "#38bdf8");
  addLog(game, `Moeda lançada: ${first === "p1" ? p1.name : p2.name} começa.`, "#fbbf24");
  return game;
}

function pubCard(c, hidden=false){
  if(!c) return null;
  if(hidden) return { hidden:true, name:"Carta Oculta" };
  return {
    id:c.id, name:c.name, type:c.type, hp:c.hp, maxHp:c.maxHp || c.hp, curHP:Math.max(0, Number(c.curHP || 0)),
    img:c.img, isEx:!!c.isEx, isSupport:!!c.isSupport, evolvesFrom:c.evolvesFrom || null,
    attached:Number(c.attached || 0), statuses:Array.isArray(c.statuses)?c.statuses:[], skills:Array.isArray(c.skills)?c.skills:[]
  };
}

function pubSide(side, hideHand){
  return {
    name:side.name,
    energyPool:Number(side.energyPool || side.energy || 0),
    energy:Number(side.energyPool || side.energy || 0),
    energies:side.energies || {},
    active:pubCard(side.active),
    bench:(side.bench || []).map(c => pubCard(c)),
    hand:hideHand ? (side.hand || []).map(() => pubCard({}, true)) : (side.hand || []).map(c => pubCard(c)),
    deckCount:(side.deck || []).length,
    discardCount:(side.discard || []).length,
    points:side.points || 0
  };
}

function gameFor(room, side){
  const g = room.game;
  if(side !== "p1" && side !== "p2"){
    return {
      mode:"online", roomCode:room.code, youSide:"spectator", isYourTurn:false, turn:g.turn,
      winner:g.winner, round:g.round, log:g.log, lastEvent:g.lastEvent,
      you:pubSide(g.p1,true), enemy:pubSide(g.p2,true)
    };
  }
  const enemy = side === "p1" ? "p2" : "p1";
  return {
    mode:"online", roomCode:room.code, youSide:side, isYourTurn:g.turn === side && !g.winner,
    turn:g.turn, winner:g.winner, round:g.round, log:g.log, lastEvent:g.lastEvent,
    you:pubSide(g[side],false), enemy:pubSide(g[enemy],true)
  };
}

function emitRoom(room){
  io.to(room.code).emit("room:update", publicRoom(room));
  if(room.game){
    for(const p of room.players) io.to(p.id).emit("game:state", gameFor(room, p.side));
    for(const sid of room.spectators) io.to(sid).emit("game:state", gameFor(room, "spectator"));
  }
}

function nextEvent(game,type,source,payload={}){
  game.lastEvent = { id:`${Date.now()}-${Math.random().toString(36).slice(2)}`, type, source, ...payload };
}

function enemyOf(side){ return side === "p1" ? "p2" : "p1"; }

function startTurn(room, sideName){
  const g = room.game;
  if(!g || g.winner) return;
  g.turn = sideName;
  g.round += 1;
  const side = g[sideName];
  side.energyPool = Number(side.energyPool || 0) + 1;
  side.energy = side.energyPool;
  draw(side);
  applyStartStatuses(room, sideName);
  addLog(g, `Turno de ${side.name}.`, "#38bdf8");
}

function applyStartStatuses(room, sideName){
  const side = room.game[sideName];
  const card = side.active;
  if(!card || !Array.isArray(card.statuses)) return;

  const kept = [];
  for(const s of card.statuses){
    if(s.type === "burn"){
      card.curHP -= 10;
      addLog(room.game, `${card.name} sofreu 10 de queimadura.`, "#fb923c");
    }
    if(s.type === "poison"){
      card.curHP -= 10;
      addLog(room.game, `${card.name} sofreu 10 de veneno.`, "#a3e635");
    }
    s.turns = Number(s.turns || 1) - 1;
    if(s.turns > 0) kept.push(s);
  }
  card.statuses = kept;
  checkKO(room, sideName, enemyOf(sideName));
}

function applyStatus(card, status){
  if(!card || !status || !status.type) return;
  if(!Array.isArray(card.statuses)) card.statuses = [];
  const old = card.statuses.find(s => s.type === status.type);
  if(old) old.turns = Math.max(Number(old.turns || 1), Number(status.turns || 1));
  else card.statuses.push({ type:String(status.type), turns:Number(status.turns || 1) });
}

function checkKO(room, deadSide, atkSide){
  const g = room.game;
  const dead = g[deadSide];
  const atk = g[atkSide];

  if(!dead.active || dead.active.curHP > 0) return false;

  addLog(g, `${dead.active.name} foi derrotado.`, "#ef4444");
  dead.discard.push(dead.active);
  atk.points += dead.active.isEx ? 2 : 1;

  if(dead.bench.length){
    dead.active = dead.bench.shift();
    addLog(g, `${dead.active.name} entrou como novo ativo.`, "#fbbf24");
    return false;
  }

  g.winner = atkSide;
  room.status = "ended";
  addLog(g, `${atk.name} venceu a partida.`, "#fbbf24");
  return true;
}

function playSupport(side, card){
  const effect = card.effect || {};
  const type = typeof effect === "string" ? effect : effect.type;
  const value = Number(effect.value || effect.amount || card.amount || 30);

  if(type === "draw"){
    for(let i=0;i<(value || 2);i++) draw(side);
    return `${card.name} comprou ${value || 2} carta(s).`;
  }

  if(type === "energyBoost"){
    side.energyPool += value || 2;
    side.energy = side.energyPool;
    return `${card.name} gerou +${value || 2} energia.`;
  }

  if(side.active){
    side.active.curHP = Math.min(side.active.hp, side.active.curHP + (value || 30));
    return `${card.name} curou ${value || 30} HP.`;
  }

  return `${card.name} foi usado.`;
}

function playCard(side, idx){
  idx = Number(idx);
  if(!Number.isInteger(idx) || idx < 0 || idx >= side.hand.length) return { ok:false, error:"Carta inválida." };

  const card = side.hand[idx];

  if(card.isSupport){
    const msg = playSupport(side, card);
    side.discard.push(card);
    side.hand.splice(idx,1);
    return { ok:true, message:msg };
  }

  if(card.evolvesFrom){
    if(side.active && side.active.name === card.evolvesFrom){
      const old = side.active;
      const dmg = Math.max(0, old.hp - old.curHP);
      const evo = prepCard(card);
      evo.curHP = Math.max(10, evo.hp - dmg);
      evo.attached = old.attached || 0;
      evo.statuses = old.statuses || [];
      side.discard.push(old);
      side.active = evo;
      side.hand.splice(idx,1);
      return { ok:true, message:`${evo.name} evoluiu no ativo.` };
    }
    const bi = side.bench.findIndex(c => c.name === card.evolvesFrom);
    if(bi >= 0){
      const old = side.bench[bi];
      const dmg = Math.max(0, old.hp - old.curHP);
      const evo = prepCard(card);
      evo.curHP = Math.max(10, evo.hp - dmg);
      evo.attached = old.attached || 0;
      evo.statuses = old.statuses || [];
      side.discard.push(old);
      side.bench[bi] = evo;
      side.hand.splice(idx,1);
      return { ok:true, message:`${evo.name} evoluiu no banco.` };
    }
    return { ok:false, error:"Você não tem a forma anterior dessa evolução em campo." };
  }

  if(!side.active){
    side.active = prepCard(card);
    side.hand.splice(idx,1);
    return { ok:true, message:`${card.name} entrou como ativo.` };
  }

  if(side.bench.length >= 3) return { ok:false, error:"Banco cheio." };

  side.bench.push(prepCard(card));
  side.hand.splice(idx,1);
  return { ok:true, message:`${card.name} foi colocado no banco.` };
}

function attachEnergy(side, action){
  if(Number(side.energyPool || 0) <= 0) return { ok:false, error:"Sem energia disponível." };

  const target = action.target || {};
  const zone = target.zone || action.zone || "active";
  const index = Number(target.index || action.index || 0);
  const card = zone === "bench" ? side.bench[index] : side.active;

  if(!card) return { ok:false, error:"Alvo inválido." };

  card.attached = Number(card.attached || 0) + 1;
  side.energyPool -= 1;
  side.energy = side.energyPool;
  return { ok:true, message:`Energia anexada em ${card.name}.`, event:{ zone, index } };
}

function promote(side, idx){
  idx = Number(idx);
  if(!Number.isInteger(idx) || idx < 0 || idx >= side.bench.length) return { ok:false, error:"Banco inválido." };
  const old = side.active;
  side.active = side.bench[idx];
  side.bench[idx] = old;
  return { ok:true, message:`${side.active.name} virou o ativo.` };
}

function handleAction(room, player, action){
  const g = room.game;
  const sideName = player.side;
  const enemyName = enemyOf(sideName);
  const side = g[sideName];
  const enemy = g[enemyName];

  if(g.turn !== sideName) return { ok:false, error:"Não é seu turno." };
  if(!action || !action.type) return { ok:false, error:"Ação inválida." };

  const type = String(action.type);

  if(["playCard","play-card","play_card"].includes(type)){
    const r = playCard(side, action.handIndex);
    if(r.ok) addLog(g, `${player.name}: ${r.message}`, "#a7f3d0");
    return r;
  }

  if(["attachEnergy","attach-energy","attach_energy"].includes(type)){
    const r = attachEnergy(side, action);
    if(r.ok){
      addLog(g, `${player.name}: ${r.message}`, "#38bdf8");
      nextEvent(g, "energy", sideName, r.event);
    }
    return r;
  }

  if(["promote","switchActive","switch-active","switch_active"].includes(type)){
    const r = promote(side, action.benchIndex);
    if(r.ok) addLog(g, `${player.name}: ${r.message}`, "#fbbf24");
    return r;
  }

  if(type === "attack"){
    if(!side.active || !enemy.active) return { ok:false, error:"Não há carta ativa para atacar." };

    const skillIndex = Number(action.skillIndex || 0);
    const skill = side.active.skills[skillIndex];
    if(!skill) return { ok:false, error:"Ataque inválido." };

    if(side.active.statuses && side.active.statuses.some(s => s.type === "stun" || s.type === "freeze")){
      side.active.statuses = side.active.statuses.filter(s => s.type !== "stun" && s.type !== "freeze");
      addLog(g, `${side.active.name} estava impedido e perdeu a ação.`, "#94a3b8");
      startTurn(room, enemyName);
      return { ok:true };
    }

    if(Number(side.active.attached || 0) < Number(skill.c || 0)){
      return { ok:false, error:"Energia anexada insuficiente." };
    }

    const damage = Math.max(0, Number(skill.d || 0));
    enemy.active.curHP -= damage;
    addLog(g, `${player.name} usou ${skill.n} causando ${damage} de dano.`, "#ef4444");

    if(skill.status){
      const target = skill.status.target === "self" ? side.active : enemy.active;
      applyStatus(target, skill.status);
      addLog(g, `${target.name} recebeu status ${skill.status.type}.`, "#fb923c");
    }

    nextEvent(g, "attack", sideName, { skill, damage, target:enemyName });
    checkKO(room, enemyName, sideName);

    if(!g.winner) startTurn(room, enemyName);
    return { ok:true };
  }

  if(type === "pass"){
    addLog(g, `${player.name} passou o turno.`, "#94a3b8");
    startTurn(room, enemyName);
    return { ok:true };
  }

  if(type === "concede" || type === "surrender"){
    g.winner = enemyName;
    room.status = "ended";
    addLog(g, `${player.name} desistiu da partida.`, "#ef4444");
    return { ok:true };
  }

  return { ok:false, error:"Tipo de ação não reconhecido." };
}

io.on("connection", socket => {
  console.log("Jogador conectado:", socket.id);

  socket.on("room:create", (payload={}, callback) => {
    let code;
    do { code = makeCode(); } while(rooms.has(code));

    const room = {
      code,
      status:"waiting",
      players:[{ id:socket.id, name:String(payload.name || "Jogador 1").slice(0,18), side:"p1", ready:false, deck:[] }],
      spectators:[],
      game:null,
      createdAt:Date.now()
    };

    rooms.set(code, room);
    socket.join(code);
    cb(callback, { ok:true, room:publicRoom(room), side:"p1" });
    emitRoom(room);
  });

  socket.on("room:join", (payload={}, callback) => {
    const code = String(payload.code || "").trim().toUpperCase();
    const room = rooms.get(code);

    if(!room) return cb(callback, { ok:false, error:"Sala não encontrada." });

    socket.join(code);

    if(room.players.length >= 2){
      room.spectators.push(socket.id);
      cb(callback, { ok:true, room:publicRoom(room), side:"spectator", spectator:true });
      emitRoom(room);
      return;
    }

    room.players.push({ id:socket.id, name:String(payload.name || "Jogador 2").slice(0,18), side:"p2", ready:false, deck:[] });
    cb(callback, { ok:true, room:publicRoom(room), side:"p2" });
    emitRoom(room);
  });

  socket.on("room:leave", (payload={}, callback) => {
    const room = roomBySocket(socket.id);
    if(!room) return cb(callback, { ok:true });
    room.players = room.players.filter(p => p.id !== socket.id);
    room.spectators = room.spectators.filter(id => id !== socket.id);
    socket.leave(room.code);
    if(!room.players.length) rooms.delete(room.code);
    else emitRoom(room);
    cb(callback, { ok:true });
  });

  socket.on("room:ready", (payload={}, callback) => {
    if(typeof payload === "function"){ callback = payload; payload = {}; }

    const room = roomBySocket(socket.id);
    if(!room) return cb(callback, { ok:false, error:"Você não está em uma sala." });

    const player = playerBySocket(room, socket.id);
    if(!player) return cb(callback, { ok:false, error:"Espectadores não podem ficar prontos." });

    const deck = sanitizeDeck(payload.deck || payload.userDeck || []);
    if(deck.length < 5) return cb(callback, { ok:false, error:"Seu deck online precisa ter pelo menos 5 cartas." });

    player.deck = deck;
    player.ready = true;

    if(room.players.length === 2 && room.players.every(p => p.ready && p.deck.length >= 5)){
      room.status = "playing";
      room.game = createGame(room);
      console.log(`Partida iniciada na sala ${room.code}`);
    }

    cb(callback, { ok:true });
    emitRoom(room);
  });

  socket.on("game:action", (payload={}, callback) => {
    const room = roomBySocket(socket.id);
    if(!room || !room.game) return cb(callback, { ok:false, error:"Partida não encontrada." });
    if(room.status !== "playing") return cb(callback, { ok:false, error:"A partida não está ativa." });

    const player = playerBySocket(room, socket.id);
    if(!player) return cb(callback, { ok:false, error:"Espectador não pode jogar." });

    const result = handleAction(room, player, payload.action || payload);
    cb(callback, result);
    emitRoom(room);
  });

  socket.on("chat:quick", (payload={}) => {
    const room = roomBySocket(socket.id);
    if(!room) return;
    const player = playerBySocket(room, socket.id);
    const name = player ? player.name : "Espectador";
    io.to(room.code).emit("chat:quick", { name, message:String(payload.message || "").slice(0,120) });
  });

  socket.on("disconnect", () => {
    const room = roomBySocket(socket.id);
    if(!room) return;

    const leaving = playerBySocket(room, socket.id);
    room.players = room.players.filter(p => p.id !== socket.id);
    room.spectators = room.spectators.filter(id => id !== socket.id);

    if(!room.players.length){
      rooms.delete(room.code);
      return;
    }

    if(room.status === "playing" && room.game && leaving){
      const winner = room.players[0].side;
      room.status = "ended";
      room.game.winner = winner;
      addLog(room.game, "Um jogador saiu. O adversário venceu automaticamente.", "#ef4444");
    }

    emitRoom(room);
  });
});

process.on("uncaughtException", err => console.error("ERRO FATAL:", err));
process.on("unhandledRejection", err => console.error("PROMISE REJEITADA:", err));

server.listen(PORT, () => console.log(`Servidor UTCG rodando na porta ${PORT}`));

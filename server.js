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
const ENERGY_TYPES = ["Chakra", "Ki", "Amaldiçoada", "Stand", "Haki", "Reiatsu", "Nen"];

app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (req, res) => res.status(200).send("UTCG multiplayer online"));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const rooms = new Map();

function cb(callback, payload){ if(typeof callback === "function") callback(payload); }
function clone(x){ return JSON.parse(JSON.stringify(x)); }

function makeCode(){
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for(let i=0;i<5;i++) out += chars[Math.floor(Math.random()*chars.length)];
  return out;
}

function emptyEnergies(){
  return ENERGY_TYPES.reduce((acc, t) => { acc[t] = 0; return acc; }, {});
}

function inferDeckTypes(deck){
  const types = [];
  for(const c of deck || []){
    const t = c && c.type;
    if(t && ENERGY_TYPES.includes(t) && !types.includes(t)) types.push(t);
  }
  return types;
}

function roomBySocket(id){
  for(const room of rooms.values()){
    if(room.players.some(p => p.id === id)) return room;
    if(room.spectators.includes(id)) return room;
  }
  return null;
}

function playerBySocket(room,id){ return room.players.find(p => p.id === id) || null; }
function enemyOf(side){ return side === "p1" ? "p2" : "p1"; }

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
    .map((c, idx) => {
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
        id: String(c.id || `${c.name}_${idx}`),
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
        _damageDealt: 0,
        skills
      };
    });
}

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
  card.maxHp = Number(card.maxHp || card.hp || card.curHP || 100);
  card.attached = Number(card.attached || 0);
  card.statuses = Array.isArray(card.statuses) ? card.statuses : [];
  card._damageDealt = Number(card._damageDealt || 0);
  return card;
}

function draw(side){
  if(!side.deck.length) return null;
  const c = side.deck.pop();
  side.hand.push(c);
  return c;
}

function resetTurnFlags(side){
  side.energyUsed = false;
  side.hasSwapped = false;
  side.hasAttacked = false;
  side.evolutionsThisTurn = 0;
}

function setupSide(player){
  const side = {
    name: player.name,
    energyPool: 0,
    energy: 0,
    energies: emptyEnergies(),
    deckTypes: inferDeckTypes(player.deck),
    deck: shuffle(player.deck),
    hand: [],
    bench: [],
    active: null,
    discard: [],
    points: 0,
    energyUsed: false,
    hasSwapped: false,
    hasAttacked: false,
    evolutionsThisTurn: 0
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
  if(game.log.length > 100) game.log = game.log.slice(-100);
}

function addPublicEvent(game,type,source,payload={}){
  const ev = { id:`${Date.now()}-${Math.random().toString(36).slice(2)}`, type, source, ...payload };
  game.lastEvent = ev;
  if(!Array.isArray(game.recentEvents)) game.recentEvents = [];
  game.recentEvents.push(ev);
  if(game.recentEvents.length > 30) game.recentEvents = game.recentEvents.slice(-30);
  return ev;
}

function gainEnergy(side){
  side.energyPool = Number(side.energyPool || 0) + 1;
  side.energy = side.energyPool;
  let chosen = null;

  // Prioriza a energia do ativo para evitar turno morto no online/raid.
  // Se a carta for Neutro ou um tipo fora da lista, a energia fica genérica no pool.
  const activeType = side && side.active ? side.active.type : null;
  if(activeType && side.energies && side.energies[activeType] !== undefined){
    chosen = activeType;
  }else if(side.deckTypes && side.deckTypes.length){
    chosen = side.deckTypes[Math.floor(Math.random() * side.deckTypes.length)];
  }

  if(chosen && side.energies && side.energies[chosen] !== undefined) side.energies[chosen] += 1;
  return chosen;
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
    round:0,
    lastEvent:null,
    recentEvents:[],
    log:[],
    p1:setupSide(p1),
    p2:setupSide(p2)
  };

  room.game = game;
  addLog(game, "Partida online criada.", "#38bdf8");
  addLog(game, `Moeda lançada: ${first === "p1" ? p1.name : p2.name} começa.`, "#fbbf24");
  startTurn(room, first, true);
  return game;
}

function pubCard(c, hidden=false){
  if(!c) return null;
  if(hidden) return { hidden:true, name:"Carta Oculta" };
  return {
    id:c.id,
    name:c.name,
    type:c.type,
    hp:c.hp,
    maxHp:c.maxHp || c.hp,
    curHP:Math.max(0, Number(c.curHP || 0)),
    img:c.img,
    isEx:!!c.isEx,
    isSupport:!!c.isSupport,
    evolvesFrom:c.evolvesFrom || null,
    desc:c.desc || "",
    effect:c.effect || null,
    attached:Number(c.attached || 0),
    statuses:Array.isArray(c.statuses)?c.statuses:[],
    skills:Array.isArray(c.skills)?c.skills:[],
    _damageDealt:Number(c._damageDealt || 0)
  };
}

function pubSide(side, hideHand){
  return {
    name:side.name,
    energyPool:Number(side.energyPool || 0),
    energy:Number(side.energyPool || 0),
    energies:side.energies || emptyEnergies(),
    deckTypes:side.deckTypes || [],
    active:pubCard(side.active),
    bench:(side.bench || []).map(c => pubCard(c)),
    hand:hideHand ? (side.hand || []).map(() => pubCard({}, true)) : (side.hand || []).map(c => pubCard(c)),
    deckCount:(side.deck || []).length,
    discardCount:(side.discard || []).length,
    discard:(side.discard || []).map(c => pubCard(c)),
    points:side.points || 0,
    energyUsed:!!side.energyUsed,
    hasSwapped:!!side.hasSwapped,
    hasAttacked:!!side.hasAttacked,
    evolutionsThisTurn:Number(side.evolutionsThisTurn || 0)
  };
}

function gameFor(room, side){
  const g = room.game;
  if(side !== "p1" && side !== "p2"){
    return {
      mode:"online", roomCode:room.code, youSide:"spectator", isYourTurn:false, turn:g.turn,
      winner:g.winner, round:g.round, log:g.log, lastEvent:g.lastEvent, recentEvents:g.recentEvents || [],
      you:pubSide(g.p1,true), enemy:pubSide(g.p2,true)
    };
  }
  const enemy = enemyOf(side);
  return {
    mode:"online", roomCode:room.code, youSide:side, isYourTurn:g.turn === side && !g.winner,
    turn:g.turn, winner:g.winner, round:g.round, log:g.log, lastEvent:g.lastEvent, recentEvents:g.recentEvents || [],
    you:pubSide(g[side],false), enemy:pubSide(g[enemy],true)
  };
}

function emitRoom(room){
  io.to(room.code).emit("room:update", publicRoom(room));
  if(room.game){
    for(const p of room.players){
      const state = gameFor(room, p.side);
      io.to(p.id).emit("game:state", state);
      if(room.game.winner){
        io.to(p.id).emit("game:ended", state);
        io.to(p.id).emit("battle:ended", state);
        io.to(p.id).emit("match:ended", state);
        io.to(p.id).emit("game:forceEnded", state);
      }
    }
    for(const sid of room.spectators){
      const state = gameFor(room, "spectator");
      io.to(sid).emit("game:state", state);
      if(room.game.winner){
        io.to(sid).emit("game:ended", state);
        io.to(sid).emit("battle:ended", state);
        io.to(sid).emit("match:ended", state);
        io.to(sid).emit("game:forceEnded", state);
      }
    }
  }
}

function startTurn(room, sideName, initial=false){
  const g = room.game;
  if(!g || g.winner) return;
  g.turn = sideName;
  g.round = Math.max(1, Number(g.round || 0) + (initial ? 1 : 1));
  const side = g[sideName];
  resetTurnFlags(side);
  const energyType = gainEnergy(side);
  const drawn = draw(side);
  applyStartStatuses(room, sideName);
  addLog(g, `Turno de ${side.name}.`, "#38bdf8");
  addPublicEvent(g, "turn", sideName, { round:g.round, energyType, drew:!!drawn });
}

function applyStartStatuses(room, sideName){
  const side = room.game[sideName];
  const card = side.active;
  if(!card || !Array.isArray(card.statuses)) return;

  const kept = [];
  for(const s of card.statuses){
    const type = String(s.type || "").toLowerCase();
    if(type === "burn"){
      card.curHP -= 20;
      addLog(room.game, `${card.name} sofreu 20 de queimadura.`, "#fb923c");
    }
    if(type === "poison"){
      card.curHP -= 15;
      addLog(room.game, `${card.name} sofreu 15 de veneno.`, "#a3e635");
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
  const normalized = { type:String(status.type), turns:Math.max(1, Number(status.turns || 1)) };
  const old = card.statuses.find(s => s.type === normalized.type);
  if(old) old.turns = Math.max(Number(old.turns || 1), normalized.turns);
  else card.statuses.push(normalized);
}

function removeStatus(card, type){
  if(!card || !Array.isArray(card.statuses)) return;
  card.statuses = card.statuses.filter(s => s.type !== type);
}

function hasStatus(card, type){
  return !!(card && Array.isArray(card.statuses) && card.statuses.some(s => s.type === type && Number(s.turns || 0) > 0));
}

function checkKO(room, deadSide, atkSide){
  const g = room.game;
  const dead = g[deadSide];
  const atk = g[atkSide];

  if(!dead.active || dead.active.curHP > 0) return { ko:false };

  const defeated = clone(dead.active);
  addLog(g, `${dead.active.name} foi derrotado.`, "#ef4444");
  dead.discard.push(dead.active);
  atk.points += dead.active.isEx ? 2 : 1;

  if(dead.bench.length){
    dead.active = dead.bench.shift();
    addLog(g, `${dead.active.name} entrou como novo ativo.`, "#fbbf24");
    return { ko:true, defeated:pubCard(defeated), promoted:pubCard(dead.active), winner:null };
  }

  dead.active = null;
  g.winner = atkSide;
  room.status = "ended";
  addLog(g, `${atk.name} venceu a partida.`, "#fbbf24");
  return { ko:true, defeated:pubCard(defeated), promoted:null, winner:atkSide };
}

function playSupport(side, card){
  const effect = card.effect || {};
  const type = typeof effect === "string" ? effect : effect.type;
  const value = Number(effect.value || effect.amount || card.amount || 30);

  if(type === "draw"){
    const qty = value || 2;
    for(let i=0;i<qty;i++) draw(side);
    return `${card.name} comprou ${qty} carta(s).`;
  }

  if(type === "energyBoost"){
    const qty = value || 2;
    side.energyPool += qty;
    side.energy = side.energyPool;
    return `${card.name} gerou +${qty} energia.`;
  }

  if(side.active){
    const heal = value || 30;
    side.active.curHP = Math.min(side.active.hp, side.active.curHP + heal);
    return `${card.name} curou ${heal} HP.`;
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
    return { ok:true, message:msg, event:{ handIndex:idx, card:pubCard(card) } };
  }

  if(card.evolvesFrom){
    if(side.evolutionsThisTurn >= 1) return { ok:false, error:"Só é permitido 1 evolução por turno." };

    if(side.active && side.active.name === card.evolvesFrom){
      const old = side.active;
      const dmg = Math.max(0, old.hp - old.curHP);
      const evo = prepCard(card);
      evo.curHP = Math.max(10, evo.hp - dmg);
      evo.attached = old.attached || 0;
      evo.statuses = old.statuses || [];
      evo._damageDealt = old._damageDealt || 0;
      side.discard.push(old);
      side.active = evo;
      side.hand.splice(idx,1);
      side.evolutionsThisTurn += 1;
      return { ok:true, message:`${evo.name} evoluiu no ativo.`, event:{ zone:"active", card:pubCard(evo) } };
    }
    const bi = side.bench.findIndex(c => c.name === card.evolvesFrom);
    if(bi >= 0){
      const old = side.bench[bi];
      const dmg = Math.max(0, old.hp - old.curHP);
      const evo = prepCard(card);
      evo.curHP = Math.max(10, evo.hp - dmg);
      evo.attached = old.attached || 0;
      evo.statuses = old.statuses || [];
      evo._damageDealt = old._damageDealt || 0;
      side.discard.push(old);
      side.bench[bi] = evo;
      side.hand.splice(idx,1);
      side.evolutionsThisTurn += 1;
      return { ok:true, message:`${evo.name} evoluiu no banco.`, event:{ zone:"bench", index:bi, card:pubCard(evo) } };
    }
    return { ok:false, error:"Você não tem a forma anterior dessa evolução em campo." };
  }

  if(!side.active){
    side.active = prepCard(card);
    side.hand.splice(idx,1);
    return { ok:true, message:`${card.name} entrou como ativo.`, event:{ zone:"active", card:pubCard(card) } };
  }

  if(side.bench.length >= 3) return { ok:false, error:"Banco cheio." };

  side.bench.push(prepCard(card));
  side.hand.splice(idx,1);
  return { ok:true, message:`${card.name} foi colocado no banco.`, event:{ zone:"bench", index:side.bench.length-1, card:pubCard(card) } };
}

function attachEnergy(side, action){
  if(side.energyUsed) return { ok:false, error:"Você já anexou energia neste turno." };
  if(Number(side.energyPool || 0) <= 0) return { ok:false, error:"Sem energia disponível." };

  const target = action.target || {};
  const zone = target.zone || action.zone || "active";
  const index = Number(target.index || action.index || 0);
  const card = zone === "bench" ? side.bench[index] : side.active;

  if(!card) return { ok:false, error:"Alvo inválido." };

  const type = card.type;
  let energyType = null;
  if(type && side.energies && side.energies[type] !== undefined){
    if(Number(side.energies[type] || 0) <= 0) return { ok:false, error:`Sem ${type} disponível.` };
    side.energies[type] -= 1;
    energyType = type;
  }

  card.attached = Number(card.attached || 0) + 1;
  side.energyPool -= 1;
  side.energy = side.energyPool;
  side.energyUsed = true;
  return { ok:true, message:`Energia anexada em ${card.name}.`, event:{ zone, index, energyType } };
}

function promote(side, idx){
  idx = Number(idx);
  if(side.hasSwapped) return { ok:false, error:"Você já trocou neste turno." };
  if(!Number.isInteger(idx) || idx < 0 || idx >= side.bench.length) return { ok:false, error:"Banco inválido." };
  const old = side.active;
  side.active = side.bench[idx];
  side.bench[idx] = old;
  side.hasSwapped = true;
  return { ok:true, message:`${side.active.name} virou o ativo.`, event:{ benchIndex:idx } };
}

function handleAction(room, player, action){
  const g = room.game;
  const sideName = player.side;
  const enemyName = enemyOf(sideName);
  const side = g[sideName];
  const enemy = g[enemyName];

  if(!action || !action.type) return { ok:false, error:"Ação inválida." };
  const type = String(action.type);

  if(type === "concede" || type === "surrender"){
    if(g.winner) return { ok:true, alreadyEnded:true };
    g.winner = enemyName;
    room.status = "ended";
    addLog(g, `${player.name} desistiu da partida.`, "#ef4444");
    addLog(g, `${enemy.name} venceu por desistência.`, "#fbbf24");
    addPublicEvent(g, "concede", sideName, { winner:enemyName });
    return { ok:true, winner:enemyName };
  }

  if(g.winner) return { ok:false, error:"A partida já terminou." };
  if(g.turn !== sideName) return { ok:false, error:"Não é seu turno." };

  if(["playCard","play-card","play_card"].includes(type)){
    const r = playCard(side, action.handIndex);
    if(r.ok){
      addLog(g, `${player.name}: ${r.message}`, "#a7f3d0");
      addPublicEvent(g, "playCard", sideName, r.event || {});
    }
    return r;
  }

  if(["attachEnergy","attach-energy","attach_energy"].includes(type)){
    const r = attachEnergy(side, action);
    if(r.ok){
      addLog(g, `${player.name}: ${r.message}`, "#38bdf8");
      addPublicEvent(g, "energy", sideName, r.event);
    }
    return r;
  }

  if(["promote","switchActive","switch-active","switch_active"].includes(type)){
    const r = promote(side, action.benchIndex);
    if(r.ok){
      addLog(g, `${player.name}: ${r.message}`, "#fbbf24");
      addPublicEvent(g, "promote", sideName, r.event || {});
    }
    return r;
  }

  if(type === "attack"){
    if(!side.active || !enemy.active) return { ok:false, error:"Não há carta ativa para atacar." };
    if(side.hasSwapped) return { ok:false, error:"Troca recente: não pode atacar neste turno." };
    if(side.hasAttacked) return { ok:false, error:"Você já atacou neste turno." };

    const skillIndex = Number(action.skillIndex || 0);
    const skill = side.active.skills[skillIndex];
    if(!skill) return { ok:false, error:"Ataque inválido." };

    if(hasStatus(side.active, "stun") || hasStatus(side.active, "freeze")){
      removeStatus(side.active, "stun");
      removeStatus(side.active, "freeze");
      side.hasAttacked = true;
      addLog(g, `${side.active.name} estava impedido e perdeu a ação.`, "#94a3b8");
      startTurn(room, enemyName);
      addPublicEvent(g, "skip", sideName, { reason:"status", nextTurn:enemyName });
      return { ok:true };
    }

    if(Number(side.active.attached || 0) < Number(skill.c || 0)){
      return { ok:false, error:"Energia anexada insuficiente." };
    }

    side.hasAttacked = true;

    if(hasStatus(enemy.active, "shield")){
      removeStatus(enemy.active, "shield");
      addLog(g, `${enemy.active.name} bloqueou o ataque com Escudo.`, "#38bdf8");
      startTurn(room, enemyName);
      addPublicEvent(g, "attack", sideName, { skill, damage:0, target:enemyName, blocked:true, nextTurn:enemyName });
      return { ok:true };
    }

    if(hasStatus(enemy.active, "dodge")){
      removeStatus(enemy.active, "dodge");
      addLog(g, `${enemy.active.name} esquivou do ataque.`, "#4ade80");
      startTurn(room, enemyName);
      addPublicEvent(g, "attack", sideName, { skill, damage:0, target:enemyName, dodged:true, nextTurn:enemyName });
      return { ok:true };
    }

    let damage = Math.max(0, Number(skill.d || 0));
    if(hasStatus(side.active, "rage")) damage = Math.ceil(damage * 1.35);

    enemy.active.curHP -= damage;
    side.active._damageDealt = Number(side.active._damageDealt || 0) + damage;
    addLog(g, `${player.name} usou ${skill.n} causando ${damage} de dano.`, "#ef4444");

    if(skill.status){
      const target = skill.status.target === "self" ? side.active : enemy.active;
      applyStatus(target, skill.status);
      addLog(g, `${target.name} recebeu status ${skill.status.type}.`, "#fb923c");
    }

    const ko = checkKO(room, enemyName, sideName);
    const eventPayload = { skill, damage, target:enemyName, ko, winner:g.winner || null, nextTurn:g.winner ? null : enemyName };
    if(!g.winner) startTurn(room, enemyName);
    addPublicEvent(g, "attack", sideName, eventPayload);
    return { ok:true };
  }

  if(type === "pass"){
    addLog(g, `${player.name} passou o turno.`, "#94a3b8");
    startTurn(room, enemyName);
    addPublicEvent(g, "pass", sideName, { nextTurn:enemyName });
    return { ok:true };
  }


  return { ok:false, error:"Tipo de ação não reconhecido." };
}



/* =========================================================
   UTCG V11 — ONLINE EVENT RAID / CO-OP BOSS
   Mantém o X1 existente e adiciona salas de evento 1-4 jogadores.
========================================================= */
const eventRooms = new Map();

const EVENT_DIFFICULTIES = {
  facil:  { label:"Fácil",  hp: 850,  bossEnergyGain:1, bossDamage:25, rareChance:0.25, itemChance:18, extraChance:34 },
  medio:  { label:"Médio",  hp:1150,  bossEnergyGain:2, bossDamage:35, rareChance:0.50, itemChance:24, extraChance:42 },
  normal: { label:"Normal", hp:1450,  bossEnergyGain:2, bossDamage:45, rareChance:0.75, itemChance:32, extraChance:52 },
  dificil:{ label:"Difícil",hp:1850,  bossEnergyGain:3, bossDamage:60, rareChance:1.25, itemChance:45, extraChance:66 }
};

const EVENT_YUTA = {
  id:"yuta_mega_x",
  name:"Evento do Yuta",
  title:"Raid: Yuta Mega X",
  boosterName:"Booster do Evento Yuta",
  boss:{
    id:"event_boss_yuta_mega_x",
    name:"Yuta Mega X",
    type:"Amaldiçoada",
    hp:1000,
    img:"https://i.imgur.com/HWERuem.png",
    isEx:true,
    isEventBoss:true,
    skills:[
      { n:"Corte da Rika", d:45, c:0, desc:"Dano em todos os jogadores." },
      { n:"Energia Amaldiçoada Infinita", d:70, c:0, desc:"Ataque carregado pela energia do boss." }
    ]
  },
  rewards:{
    item:{ id:"event_item_rika_pendant", name:"Pingente da Rika", type:"Amaldiçoada", hp:0, img:"https://i.imgur.com/HWERuem.png", isSupport:true, eventItem:true, rarity:"Evento", price:0, effect:{type:"energyBoost", value:2}, desc:"Item exclusivo do Evento Yuta. Gera +2 energia." },
    extras:[
      { id:"event_yuta_student", name:"Yuta — Estudante Especial", type:"Amaldiçoada", hp:120, img:"https://i.imgur.com/HWERuem.png", isEx:true, rarity:"Evento", price:0, skills:[{n:"Katana Reversa", d:55, c:2, desc:"Golpe de energia amaldiçoada."},{n:"Vínculo Parcial", d:75, c:3, desc:"Ataque com Rika parcial."}] },
      { id:"event_rika_fragment", name:"Rika Fragmentada", type:"Amaldiçoada", hp:110, img:"https://i.imgur.com/HWERuem.png", isEx:true, rarity:"Evento", price:0, skills:[{n:"Garra Protetora", d:45, c:2, desc:"Ataque de suporte."},{n:"Maldição Presente", d:70, c:3, desc:"Pode aplicar medo."}] }
    ],
    mega:{ id:"event_yuta_mega_x", name:"Yuta Mega X", type:"Amaldiçoada", hp:180, img:"https://i.imgur.com/HWERuem.png", isEx:true, isMegaEvent:true, rarity:"Mega Evento", price:0, skills:[{n:"Cópia Absoluta", d:90, c:3, desc:"Ataque premium do evento."},{n:"Rika Total", d:140, c:5, desc:"Ultimate raríssima do Evento Yuta."}] }
  }
};

function eventRoomBySocket(id){
  for(const room of eventRooms.values()){
    if(room.players.some(p => p.id === id)) return room;
    if(room.spectators.includes(id)) return room;
  }
  return null;
}

function eventPlayerBySocket(room,id){ return room.players.find(p => p.id === id) || null; }

function publicEventRoom(room){
  return {
    code:room.code,
    status:room.status,
    eventId:room.eventId,
    eventTitle:EVENT_YUTA.title,
    difficulty:room.difficulty,
    difficultyLabel:(EVENT_DIFFICULTIES[room.difficulty] || EVENT_DIFFICULTIES.normal).label,
    hostId:room.hostId,
    maxPlayers:4,
    players:room.players.map(p => ({ name:p.name, side:p.side, ready:p.ready, connected:p.connected !== false })),
    spectatorCount:room.spectators.length
  };
}

function raidPubPlayer(game, playerSide, viewerSide){
  const side = game.sides[playerSide];
  if(!side) return null;
  return {
    side:playerSide,
    name:side.name,
    eliminated:!!side.eliminated,
    isYou:playerSide === viewerSide,
    energyPool:Number(side.energyPool || 0),
    energy:Number(side.energyPool || 0),
    energies:side.energies || emptyEnergies(),
    active:pubCard(side.active),
    bench:(side.bench || []).map(c => pubCard(c)),
    hand:playerSide === viewerSide ? (side.hand || []).map(c => pubCard(c)) : (side.hand || []).map(() => pubCard({}, true)),
    deckCount:(side.deck || []).length,
    discardCount:(side.discard || []).length,
    energyUsed:!!side.energyUsed,
    hasSwapped:!!side.hasSwapped,
    hasAttacked:!!side.hasAttacked,
    actedThisRound:(game.acted || []).includes(playerSide)
  };
}

function raidGameFor(room, viewerSide){
  const g = room.game;
  const sides = g.playersOrder.map(side => raidPubPlayer(g, side, viewerSide)).filter(Boolean);
  return {
    mode:"eventRaid",
    eventId:room.eventId,
    eventTitle:EVENT_YUTA.title,
    roomCode:room.code,
    difficulty:room.difficulty,
    difficultyLabel:(EVENT_DIFFICULTIES[room.difficulty] || EVENT_DIFFICULTIES.normal).label,
    youSide:viewerSide || "spectator",
    turn:g.turn,
    turnName:(g.turn === "boss" ? (g.boss && g.boss.name) : (g.sides[g.turn] && g.sides[g.turn].name)) || g.turn || "—",
    turnOrder:g.playersOrder.map(side => ({ side, name:(g.sides[side] && g.sides[side].name) || side, eliminated:!!(g.sides[side] && g.sides[side].eliminated), acted:(g.acted || []).includes(side) })).concat([{ side:"boss", name:(g.boss && g.boss.name) || "Boss", eliminated:false, acted:false }]),
    isYourTurn:g.turn === viewerSide && !g.winner,
    winner:g.winner,
    round:g.round,
    log:g.log,
    lastEvent:g.lastEvent,
    recentEvents:g.recentEvents || [],
    boss:pubCard(g.boss),
    bossEnergy:g.bossEnergy || 0,
    players:sides,
    reward: g.winner && viewerSide && room.rewards ? room.rewards[viewerSide] || null : null
  };
}

function emitEventRoom(room){
  io.to(room.code).emit("event:room:update", publicEventRoom(room));
  if(room.game){
    for(const p of room.players){
      const state = raidGameFor(room, p.side);
      io.to(p.id).emit("event:state", state);
      if(room.game.winner){
        io.to(p.id).emit("event:ended", state);
        if(state.reward) io.to(p.id).emit("event:reward", state.reward);
      }
    }
    for(const sid of room.spectators){
      io.to(sid).emit("event:state", raidGameFor(room, "spectator"));
    }
  }
}

function rollRaidReward(room, won){
  const diff = EVENT_DIFFICULTIES[room.difficulty] || EVENT_DIFFICULTIES.normal;
  if(!won){
    return { won:false, eventId:EVENT_YUTA.id, boosterName:EVENT_YUTA.boosterName, coins:100, items:[], cards:[], message:"Derrota na raid: recompensa de participação." };
  }
  const out = { won:true, eventId:EVENT_YUTA.id, boosterName:EVENT_YUTA.boosterName, coins:500, items:[], cards:[], rolls:{ rareChance:diff.rareChance } };
  const pct = () => Math.random() * 100;
  if(pct() < diff.itemChance) out.items.push(clone(EVENT_YUTA.rewards.item));
  for(const c of EVENT_YUTA.rewards.extras){ if(pct() < diff.extraChance) out.cards.push(clone(c)); }
  if(pct() < diff.rareChance) out.cards.push(clone(EVENT_YUTA.rewards.mega));
  if(!out.cards.length && !out.items.length){
    out.cards.push(clone(EVENT_YUTA.rewards.extras[Math.floor(Math.random() * EVENT_YUTA.rewards.extras.length)]));
  }
  return out;
}

function finishRaid(room, winner){
  const g = room.game;
  if(!g || g.winner) return;
  g.winner = winner;
  room.status = "ended";
  const won = winner === "players";
  addLog(g, won ? "Raid vencida! Boosters liberados para todos." : "O boss venceu a raid.", won ? "#fbbf24" : "#ef4444");
  addPublicEvent(g, "raidEnd", winner, { winner });
  room.rewards = room.rewards || {};
  for(const p of room.players){
    if(!room.rewards[p.side]){
      const reward = rollRaidReward(room, won);
      reward.claimId = `${room.code}:${p.side}:${winner}`;
      room.rewards[p.side] = reward;
    }
  }

  // Empurra o encerramento imediatamente para todos os clientes conectados.
  // O emitRoom normal ainda roda depois das ações, mas esse reforço evita tela presa.
  for(const p of room.players){
    const state = raidGameFor(room, p.side);
    io.to(p.id).emit("event:state", state);
    io.to(p.id).emit("event:ended", state);
    if(room.rewards[p.side]) io.to(p.id).emit("event:reward", room.rewards[p.side]);
  }
}

function createRaidGame(room){
  const diff = EVENT_DIFFICULTIES[room.difficulty] || EVENT_DIFFICULTIES.normal;
  const order = room.players.map(p => p.side);
  const sides = {};
  for(const p of room.players){ sides[p.side] = setupSide(p); }
  const boss = clone(EVENT_YUTA.boss);
  boss.maxHp = diff.hp * Math.max(1, room.players.length);
  boss.hp = boss.maxHp;
  boss.curHP = boss.maxHp;
  boss.attached = 0;
  boss.statuses = [];
  boss._damageDealt = 0;
  const game = {
    mode:"eventRaid",
    eventId:EVENT_YUTA.id,
    roomCode:room.code,
    difficulty:room.difficulty,
    playersOrder:order,
    turn:order[0],
    round:0,
    acted:[],
    sides,
    boss,
    bossEnergy:0,
    winner:null,
    lastEvent:null,
    recentEvents:[],
    log:[]
  };
  room.game = game;
  addLog(game, `${EVENT_YUTA.title} iniciado em ${diff.label}.`, "#38bdf8");
  startRaidRound(room);
  return game;
}

function aliveRaidSides(game){
  return game.playersOrder.filter(side => {
    const s = game.sides[side];
    return s && !s.eliminated && s.active;
  });
}

function startRaidRound(room){
  const g = room.game;
  const diff = EVENT_DIFFICULTIES[room.difficulty] || EVENT_DIFFICULTIES.normal;
  if(!g || g.winner) return;
  g.round += 1;
  g.acted = [];
  g.bossEnergy = Number(g.bossEnergy || 0) + diff.bossEnergyGain;
  const energyGains = [];
  for(const sideName of g.playersOrder){
    const side = g.sides[sideName];
    if(!side || side.eliminated) continue;
    resetTurnFlags(side);
    const gainedType = gainEnergy(side);
    energyGains.push({ side:sideName, name:side.name, type:gainedType || "Genérica", pool:Number(side.energyPool || 0), activeAttached:side.active ? Number(side.active.attached || 0) : 0 });
    draw(side);
  }
  const alive = aliveRaidSides(g);
  g.turn = alive[0] || null;
  addLog(g, `Rodada ${g.round}: boss recebeu +${diff.bossEnergyGain} energia.`, "#fbbf24");
  if(energyGains.length){
    addLog(g, `Energia dos jogadores: ${energyGains.map(e => `${e.name} +1 ${e.type}`).join(" • ")}.`, "#38bdf8");
  }
  addPublicEvent(g, "raidRound", "boss", { round:g.round, bossEnergy:g.bossEnergy, energyGains });
}

function raidCheckPlayerKO(room, sideName){
  const g = room.game;
  const side = g.sides[sideName];
  if(!side || !side.active || side.active.curHP > 0) return false;
  addLog(g, `${side.active.name} de ${side.name} caiu.`, "#ef4444");
  side.discard.push(side.active);
  if(side.bench.length){
    side.active = side.bench.shift();
    addLog(g, `${side.active.name} entrou como novo ativo de ${side.name}.`, "#fbbf24");
  }else{
    side.active = null;
    side.eliminated = true;
    addLog(g, `${side.name} foi eliminado da raid.`, "#ef4444");
  }
  if(!aliveRaidSides(g).length) finishRaid(room, "boss");
  return true;
}

function raidBossTurn(room){
  const g = room.game;
  const diff = EVENT_DIFFICULTIES[room.difficulty] || EVENT_DIFFICULTIES.normal;
  if(!g || g.winner) return;
  const targets = aliveRaidSides(g);
  if(!targets.length) return finishRaid(room, "boss");
  const damage = diff.bossDamage + Math.floor(Number(g.bossEnergy || 0) * 8);
  addLog(g, `${g.boss.name} atacou todos os jogadores causando ${damage} de dano.`, "#ef4444");
  for(const sideName of targets){
    const side = g.sides[sideName];
    if(side && side.active){
      side.active.curHP -= damage;
      g.boss._damageDealt = Number(g.boss._damageDealt || 0) + damage;
      raidCheckPlayerKO(room, sideName);
    }
  }
  addPublicEvent(g, "bossAttack", "boss", { damage, targets });
  if(!g.winner) startRaidRound(room);
}

function advanceRaidTurn(room, sideName){
  const g = room.game;
  if(!g || g.winner) return;
  if(!g.acted.includes(sideName)) g.acted.push(sideName);
  const alive = aliveRaidSides(g);
  const next = alive.find(side => !g.acted.includes(side));
  if(next){
    g.turn = next;
    addLog(g, `Turno de ${g.sides[next].name}.`, "#38bdf8");
    addPublicEvent(g, "raidTurn", next, { round:g.round });
  }else{
    g.turn = "boss";
    raidBossTurn(room);
  }
}

function handleRaidAction(room, player, action){
  const g = room.game;
  const sideName = player.side;
  const side = g.sides[sideName];
  if(!action || !action.type) return { ok:false, error:"Ação inválida." };
  const type = String(action.type);
  if(type === "concede" || type === "surrender"){
    if(side && !side.eliminated){ side.eliminated = true; side.active = null; }
    room.rewards = room.rewards || {};
    if(!room.rewards[sideName]){
      const reward = rollRaidReward(room, false);
      reward.claimId = `${room.code}:${sideName}:concede:${Date.now()}`;
      room.rewards[sideName] = reward;
    }
    addLog(g, `${player.name} desistiu da raid.`, "#ef4444");
    addPublicEvent(g, "raidConcede", sideName, { reward:room.rewards[sideName] });
    if(!aliveRaidSides(g).length) finishRaid(room, "boss");
    else if(g.turn === sideName) advanceRaidTurn(room, sideName);
    return { ok:true, personalEnded:true, reward:room.rewards[sideName] };
  }
  if(g.winner) return { ok:false, error:"A raid já terminou." };
  if(!side || side.eliminated) return { ok:false, error:"Você está eliminado." };
  if(g.turn !== sideName) return { ok:false, error:"Não é seu turno." };

  if(["playCard","play-card","play_card"].includes(type)){
    const r = playCard(side, action.handIndex);
    if(r.ok){ addLog(g, `${player.name}: ${r.message}`, "#a7f3d0"); addPublicEvent(g, "raidPlayCard", sideName, r.event || {}); }
    return r;
  }
  if(["attachEnergy","attach-energy","attach_energy"].includes(type)){
    const r = attachEnergy(side, action);
    if(r.ok){ addLog(g, `${player.name}: ${r.message}`, "#38bdf8"); addPublicEvent(g, "raidEnergy", sideName, r.event || {}); }
    return r;
  }
  if(["promote","switchActive","switch-active","switch_active"].includes(type)){
    const r = promote(side, action.benchIndex);
    if(r.ok){ addLog(g, `${player.name}: ${r.message}`, "#fbbf24"); addPublicEvent(g, "raidPromote", sideName, r.event || {}); }
    return r;
  }
  if(type === "attack"){
    if(!side.active || !g.boss) return { ok:false, error:"Sem atacante ou boss." };
    if(side.hasSwapped) return { ok:false, error:"Troca recente: não pode atacar neste turno." };
    if(side.hasAttacked) return { ok:false, error:"Você já atacou neste turno." };
    const skillIndex = Number(action.skillIndex || 0);
    const skill = side.active.skills[skillIndex];
    if(!skill) return { ok:false, error:"Ataque inválido." };
    if(Number(side.active.attached || 0) < Number(skill.c || 0)) return { ok:false, error:"Energia anexada insuficiente." };
    side.hasAttacked = true;
    let damage = Math.max(0, Number(skill.d || 0));
    if(hasStatus(side.active, "rage")) damage = Math.ceil(damage * 1.35);
    g.boss.curHP -= damage;
    side.active._damageDealt = Number(side.active._damageDealt || 0) + damage;
    addLog(g, `${player.name} causou ${damage} no boss com ${skill.n}.`, "#ef4444");
    if(g.boss.curHP <= 0){
      g.boss.curHP = 0;
      addPublicEvent(g, "raidAttack", sideName, { skill, damage, boss:true, winner:"players" });
      finishRaid(room, "players");
      return { ok:true };
    }
    addPublicEvent(g, "raidAttack", sideName, { skill, damage, boss:true });
    advanceRaidTurn(room, sideName);
    return { ok:true };
  }
  if(type === "pass"){
    addLog(g, `${player.name} passou a vez na raid.`, "#94a3b8");
    advanceRaidTurn(room, sideName);
    return { ok:true };
  }
  return { ok:false, error:"Tipo de ação não reconhecido." };
}

function handleEventDisconnect(socket){
  const room = eventRoomBySocket(socket.id);
  if(!room) return false;
  const leaving = eventPlayerBySocket(room, socket.id);
  if(leaving) leaving.connected = false;
  room.players = room.players.filter(p => p.id !== socket.id);
  room.spectators = room.spectators.filter(id => id !== socket.id);
  socket.leave(room.code);
  if(!room.players.length){ eventRooms.delete(room.code); return true; }
  if(room.status === "playing" && room.game && leaving && !room.game.winner){
    const side = room.game.sides[leaving.side];
    if(side){ side.eliminated = true; side.active = null; }
    addLog(room.game, `${leaving.name} saiu da raid.`, "#ef4444");
    if(!aliveRaidSides(room.game).length) finishRaid(room, "boss");
  }
  emitEventRoom(room);
  return true;
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
      if(!room.spectators.includes(socket.id)) room.spectators.push(socket.id);
      cb(callback, { ok:true, room:publicRoom(room), side:"spectator", spectator:true, state:room.game ? gameFor(room, "spectator") : null });
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
    const leaving = playerBySocket(room, socket.id);

    if(room.status === "playing" && room.game && leaving && !room.game.winner){
      const remaining = room.players.find(p => p.id !== socket.id);
      if(remaining){
        room.status = "ended";
        room.game.winner = remaining.side;
        addLog(room.game, `${leaving.name} saiu da sala e perdeu por desistência.`, "#ef4444");
        addLog(room.game, `${remaining.name} venceu a partida.`, "#fbbf24");
        addPublicEvent(room.game, "concede", leaving.side, { winner:remaining.side });
        emitRoom(room);
      }
    }

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
    if(room.status === "playing") return cb(callback, { ok:false, error:"A partida já começou." });

    const deck = sanitizeDeck(payload.deck || payload.userDeck || []);
    if(deck.length < 5) return cb(callback, { ok:false, error:"Seu deck online precisa ter pelo menos 5 cartas." });

    player.deck = deck;
    player.ready = true;

    if(room.players.length === 2 && room.players.every(p => p.ready && p.deck.length >= 5)){
      room.status = "playing";
      room.game = createGame(room);
      console.log(`Partida iniciada na sala ${room.code}`);
    }

    cb(callback, { ok:true, room:publicRoom(room), state:room.game ? gameFor(room, player.side) : null });
    emitRoom(room);
  });

  socket.on("game:action", (payload={}, callback) => {
    const room = roomBySocket(socket.id);
    if(!room || !room.game) return cb(callback, { ok:false, error:"Partida não encontrada." });

    const player = playerBySocket(room, socket.id);
    if(!player) return cb(callback, { ok:false, error:"Espectador não pode jogar." });

    if(room.status !== "playing"){
      const endedState = gameFor(room, player.side);
      cb(callback, { ok:false, error:"A partida não está ativa.", state:endedState, ended:!!(room.game && room.game.winner) });
      emitRoom(room);
      return;
    }

    const result = handleAction(room, player, payload.action || payload);
    if(result && result.ok){
      result.state = room.game ? gameFor(room, player.side) : null;
      if(room.game && room.game.winner) result.ended = true;
    }
    cb(callback, result);
    emitRoom(room);
  });



  /* ===================== EVENTO ONLINE — RAID CO-OP ===================== */
  socket.on("event:info", (payload={}, callback) => {
    cb(callback, { ok:true, event:EVENT_YUTA, difficulties:EVENT_DIFFICULTIES });
  });

  socket.on("event:create", (payload={}, callback) => {
    let code;
    do { code = makeCode(); } while(eventRooms.has(code) || rooms.has(code));
    const diffKey = String(payload.difficulty || "normal").toLowerCase();
    const difficulty = EVENT_DIFFICULTIES[diffKey] ? diffKey : "normal";
    const room = {
      code,
      type:"eventRaid",
      eventId:EVENT_YUTA.id,
      difficulty,
      status:"waiting",
      hostId:socket.id,
      players:[{ id:socket.id, name:String(payload.name || "Jogador 1").slice(0,18), side:"r1", ready:false, deck:[], connected:true }],
      spectators:[],
      game:null,
      rewards:{},
      createdAt:Date.now()
    };
    eventRooms.set(code, room);
    socket.join(code);
    cb(callback, { ok:true, room:publicEventRoom(room), side:"r1" });
    emitEventRoom(room);
  });

  socket.on("event:join", (payload={}, callback) => {
    const code = String(payload.code || "").trim().toUpperCase();
    const room = eventRooms.get(code);
    if(!room) return cb(callback, { ok:false, error:"Sala de evento não encontrada." });
    socket.join(code);
    if(room.status !== "waiting" || room.players.length >= 4){
      if(!room.spectators.includes(socket.id)) room.spectators.push(socket.id);
      return cb(callback, { ok:true, room:publicEventRoom(room), side:"spectator", spectator:true, state:room.game ? raidGameFor(room, "spectator") : null });
    }
    const side = `r${room.players.length + 1}`;
    room.players.push({ id:socket.id, name:String(payload.name || `Jogador ${room.players.length + 1}`).slice(0,18), side, ready:false, deck:[], connected:true });
    cb(callback, { ok:true, room:publicEventRoom(room), side });
    emitEventRoom(room);
  });

  socket.on("event:leave", (payload={}, callback) => {
    const room = eventRoomBySocket(socket.id);
    if(!room) return cb(callback, { ok:true });
    const leaving = eventPlayerBySocket(room, socket.id);
    let leavingReward = null;

    if(room.game && leaving){
      room.rewards = room.rewards || {};

      // Se a raid já terminou, o jogador ainda precisa conseguir coletar a recompensa
      // antes de ser removido da sala.
      if(room.game.winner){
        const won = room.game.winner === "players";
        if(!room.rewards[leaving.side]){
          leavingReward = rollRaidReward(room, won);
          leavingReward.claimId = `${room.code}:${leaving.side}:leave-after-end:${room.game.winner}`;
          room.rewards[leaving.side] = leavingReward;
        }else leavingReward = room.rewards[leaving.side];
        io.to(socket.id).emit("event:reward", leavingReward);
      }

      // Se sair durante a raid, conta como desistência individual e dá recompensa de derrota.
      if(room.status === "playing" && !room.game.winner){
        const side = room.game.sides[leaving.side];
        if(side){ side.eliminated = true; side.active = null; }
        if(!room.rewards[leaving.side]){
          leavingReward = rollRaidReward(room, false);
          leavingReward.claimId = `${room.code}:${leaving.side}:leave:${Date.now()}`;
          room.rewards[leaving.side] = leavingReward;
        }else leavingReward = room.rewards[leaving.side];
        addLog(room.game, `${leaving.name} saiu da raid.`, "#ef4444");
        addPublicEvent(room.game, "raidConcede", leaving.side, { reward:leavingReward });
        if(!aliveRaidSides(room.game).length) finishRaid(room, "boss");
        io.to(socket.id).emit("event:reward", leavingReward);
      }
    }

    room.players = room.players.filter(p => p.id !== socket.id);
    room.spectators = room.spectators.filter(id => id !== socket.id);
    socket.leave(room.code);
    if(!room.players.length) eventRooms.delete(room.code);
    else emitEventRoom(room);
    cb(callback, { ok:true, reward:leavingReward });
  });

  socket.on("event:ready", (payload={}, callback) => {
    if(typeof payload === "function"){ callback = payload; payload = {}; }
    const room = eventRoomBySocket(socket.id);
    if(!room) return cb(callback, { ok:false, error:"Você não está em uma sala de evento." });
    const player = eventPlayerBySocket(room, socket.id);
    if(!player) return cb(callback, { ok:false, error:"Espectadores não podem ficar prontos." });
    if(room.status !== "waiting") return cb(callback, { ok:false, error:"A raid já começou." });
    const deck = sanitizeDeck(payload.deck || payload.userDeck || []);
    if(deck.length < 5) return cb(callback, { ok:false, error:"Seu deck online precisa ter pelo menos 5 cartas." });
    player.deck = deck;
    player.ready = true;
    if(room.players.length >= 1 && room.players.every(p => p.ready && p.deck.length >= 5)){
      room.status = "playing";
      createRaidGame(room);
      console.log(`Raid de evento iniciada na sala ${room.code}`);
    }
    cb(callback, { ok:true, room:publicEventRoom(room), state:room.game ? raidGameFor(room, player.side) : null });
    emitEventRoom(room);
  });

  socket.on("event:action", (payload={}, callback) => {
    const room = eventRoomBySocket(socket.id);
    if(!room || !room.game) return cb(callback, { ok:false, error:"Raid não encontrada." });
    const player = eventPlayerBySocket(room, socket.id);
    if(!player) return cb(callback, { ok:false, error:"Espectador não pode jogar." });

    // Se o cliente clicar em algo depois do fim, não deixa ele preso em erro:
    // reenvia o estado final e a recompensa correta.
    if(room.status !== "playing"){
      const state = raidGameFor(room, player.side);
      const reward = room.rewards ? room.rewards[player.side] || null : null;
      if(reward) io.to(socket.id).emit("event:reward", reward);
      cb(callback, { ok:true, ended:!!(room.game && room.game.winner), state, reward });
      emitEventRoom(room);
      return;
    }

    const result = handleRaidAction(room, player, payload.action || payload);
    if(result && result.ok){
      if(result.reward) io.to(socket.id).emit("event:reward", result.reward);
      result.state = room.game ? raidGameFor(room, player.side) : null;
      if(room.game && room.game.winner){
        result.ended = true;
        result.reward = room.rewards ? room.rewards[player.side] || result.reward || null : result.reward || null;
      }
    }
    cb(callback, result);
    emitEventRoom(room);
  });

  socket.on("chat:quick", (payload={}) => {
    const room = roomBySocket(socket.id);
    if(!room) return;
    const player = playerBySocket(room, socket.id);
    const name = player ? player.name : "Espectador";
    io.to(room.code).emit("chat:quick", { name, message:String(payload.message || "").slice(0,120) });
  });

  socket.on("disconnect", () => {
    if(handleEventDisconnect(socket)) return;
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
      addPublicEvent(room.game, "disconnect", leaving.side, { winner });
    }

    emitRoom(room);
  });
});

process.on("uncaughtException", err => console.error("ERRO FATAL:", err));
process.on("unhandledRejection", err => console.error("PROMISE REJEITADA:", err));

server.listen(PORT, () => console.log(`Servidor UTCG rodando na porta ${PORT}`));

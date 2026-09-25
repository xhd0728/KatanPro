// 卡坦岛规则引擎（服务端权威，加密随机）
import { randomInt, randomUUID } from 'crypto';
import { MAP_LAYOUTS, layoutCells } from './map-layouts.js';

export const RES = ['wood', 'brick', 'sheep', 'wheat', 'ore'];
export const RES_CN = { wood: '木材', brick: '砖块', sheep: '羊毛', wheat: '小麦', ore: '矿石', desert: '沙漠' };
const ri = (n) => randomInt(n);
const pick = (arr) => arr[ri(arr.length)];
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = ri(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// ---------- 地图生成 ----------
const AX = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
const hexXY = (q, r) => [Math.sqrt(3) * (q + r / 2), 1.5 * r];
const cornerXY = (x, y, i) => {
  const a = (Math.PI / 180) * (60 * i - 30);
  return [x + Math.cos(a), y + Math.sin(a)];
};

export function generateMap(sizeKey) {
  const layout = MAP_LAYOUTS[sizeKey] || MAP_LAYOUTS.small;
  const R = layout.radius;
  const hexes = []; const hexAt = new Map();
  for (const [q, r] of layoutCells(layout)) {
    const [x, y] = hexXY(q, r);
    const h = { id: `h${hexes.length}`, q, r, x, y, resource: null, number: null };
    hexes.push(h); hexAt.set(`${q},${r}`, h);
  }
  const neighborsOf = (h) => AX.map(([dq, dr]) => hexAt.get(`${h.q + dq},${h.r + dr}`)).filter(Boolean);

  const vkey = new Map(); const vertices = [];
  const ekey = new Map(); const edges = [];
  const getVertex = (x, y) => {
    const k = `${Math.round(x * 1000)},${Math.round(y * 1000)}`;
    if (!vkey.has(k)) { const v = { id: `v${vertices.length}`, x, y, port: null, hexes: [] }; vkey.set(k, v); vertices.push(v); }
    return vkey.get(k);
  };
  for (const h of hexes) {
    const cs = [];
    for (let i = 0; i < 6; i++) { const [cx, cy] = cornerXY(h.x, h.y, i); cs.push(getVertex(cx, cy)); }
    for (const v of cs) v.hexes.push(h.id);
    for (let i = 0; i < 6; i++) {
      const a = cs[i], b = cs[(i + 1) % 6];
      const k = [a.id, b.id].sort().join('-');
      if (!ekey.has(k)) { const e = { id: `e${edges.length}`, a: a.id, b: b.id, hexes: [] }; ekey.set(k, e); edges.push(e); }
      ekey.get(k).hexes.push(h.id);
    }
  }
  const vById = Object.fromEntries(vertices.map(v => [v.id, v]));
  const eById = Object.fromEntries(edges.map(e => [e.id, e]));
  const vAdj = new Map();
  for (const v of vertices) vAdj.set(v.id, new Set());
  for (const e of edges) { vAdj.get(e.a).add(e.b); vAdj.get(e.b).add(e.a); }

  // 资源地块
  const deserts = Math.max(1, Math.round(hexes.length / 19));
  const land = hexes.length - deserts;
  const base = Math.floor(land / 5), rem = land % 5;
  const counts = {}; RES.forEach(r => counts[r] = base);
  ['wood', 'sheep', 'wheat', 'brick', 'ore'].slice(0, rem).forEach(r => counts[r]++);
  const resList = [];
  for (const r of RES) for (let i = 0; i < counts[r]; i++) resList.push(r);
  for (let i = 0; i < deserts; i++) resList.push('desert');
  const rs = shuffle(resList); hexes.forEach((h, i) => h.resource = rs[i]);

  // 数字棋子：6/8 互不相邻、2/12 互不相邻
  const STD = [2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12];
  const landHexes = hexes.filter(h => h.resource !== 'desert');
  let tokens = [];
  while (tokens.length < landHexes.length) tokens = tokens.concat(STD);
  tokens = shuffle(tokens.slice(0, landHexes.length));
  const isHigh = (n) => n === 6 || n === 8;
  const isLow = (n) => n === 2 || n === 12;
  let numPlaced = false;
  for (let t = 0; t < 500 && !numPlaced; t++) {
    const ts = shuffle(tokens); const map = new Map();
    numPlaced = true;
    for (let i = 0; i < landHexes.length; i++) {
      const h = landHexes[i];
      let done = false;
      for (let j = i; j < ts.length; j++) {
        const bad = neighborsOf(h).some(n => {
          const m = map.get(n.id); if (m == null) return false;
          return (isHigh(ts[j]) && isHigh(m)) || (isLow(ts[j]) && isLow(m));
        });
        if (!bad) { map.set(h.id, ts[j]); [ts[i], ts[j]] = [ts[j], ts[i]]; done = true; break; }
      }
      if (!done) { numPlaced = false; break; }
    }
    if (numPlaced) landHexes.forEach((h, i) => h.number = map.get(h.id));
  }
  if (!numPlaced) landHexes.forEach((h, i) => h.number = tokens[i]); // 兜底

  // 固定海上六边形的中心与朝岸方向；只随机港口类型，不轮转连接点。
  const coastEdges = edges.filter(e => e.hexes.length === 1);
  const anchors = layout.ports ? layout.ports.map(([q, r, side]) => {
    const [x, y] = hexXY(q, r);
    const c1 = cornerXY(x, y, (side + 3) % 6), c2 = cornerXY(x, y, (side + 4) % 6);
    const near = (v, c) => Math.hypot(v.x - c[0], v.y - c[1]) < 0.001;
    const e = coastEdges.find(e => near(vById[e.a], c1) && near(vById[e.b], c2) || near(vById[e.a], c2) && near(vById[e.b], c1));
    if (!e) throw new Error(`Invalid port in ${sizeKey}: ${q},${r},${side}`);
    return { a:e.a, b:e.b, hex:e.hexes[0], x, y };
  }) : largeMapPorts(coastEdges, vById, hexes, layout.portCount);
  const specialCopies = layout.portCount ? 2 : 1;
  const types = shuffle([...Array.from({length:specialCopies},()=>RES.map(r=>`2:${r}`)).flat(), ...Array(anchors.length-RES.length*specialCopies).fill('3')]);
  const ports = anchors.map((anchor, i) => {
    const e = anchor, type = types[i];
    vById[e.a].port = type; vById[e.b].port = type;
    return { ...anchor, type };
  });

  const robber = (hexes.find(h => h.resource === 'desert') || hexes[0]).id;
  return { size: sizeKey, radius: R, hexes, vertices, edges, ports, robber, vAdj, vById, eById, neighborsOf };
}

// Deterministic, evenly spaced harbors on custom coastlines. Keep separate
// endpoints and sea centers so a concave bay never receives overlapping ports.
function largeMapPorts(coastEdges, vertices, hexes, count) {
  const candidates = coastEdges.map(e=>{
    const a=vertices[e.a],b=vertices[e.b],h=hexes.find(h=>h.id===e.hexes[0]);
    return {a:e.a,b:e.b,hex:h.id,x:a.x+b.x-h.x,y:a.y+b.y-h.y};
  }).sort((a,b)=>Math.atan2(a.y,a.x)-Math.atan2(b.y,b.x));
  const chosen=[],used=new Set();
  for(let i=0;i<count;i++) {
    const target=Math.floor(i*candidates.length/count);
    const order=candidates.map((p,j)=>({p,d:Math.min(Math.abs(j-target),candidates.length-Math.abs(j-target))})).sort((a,b)=>a.d-b.d);
    const hit=order.find(({p})=>!used.has(p.a)&&!used.has(p.b)&&chosen.every(c=>Math.hypot(p.x-c.x,p.y-c.y)>1));
    if(!hit) throw new Error('Unable to place all custom map ports');
    chosen.push(hit.p);used.add(hit.p.a);used.add(hit.p.b);
  }
  return chosen;
}

// ---------- 游戏状态 ----------
export const DEV_TYPES = {
  knight: { name: '骑士', icon: '🛡️', total: 14 },
  vp: { name: '胜利点', icon: '⭐', total: 5 },
  road: { name: '筑路工', icon: '🛤️', total: 2 },
  year: { name: '丰收之年', icon: '🌻', total: 2 },
  mono: { name: '垄断之年', icon: '🏦', total: 2 },
};
export const COLORS = ['#c05f4f', '#3f7b9b', '#568361', '#b5843e', '#896699', '#a69836', '#378c85', '#b45f85'];
export const COST = {
  road: { wood: 1, brick: 1 },
  settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 },
  city: { wheat: 2, ore: 3 },
  dev: { sheep: 1, wheat: 1, ore: 1 },
};
export const PIECES = { road: 15, settlement: 5, city: 4 };
export const BANK_SIZE = 29;

export function createGame(settings) {
  const { mapSize, targetVP, startBonus, playerNames, playerKinds = [] } = settings;
  const map = generateMap(mapSize);
  const deck = [];
  for (const [t, d] of Object.entries(DEV_TYPES)) for (let i = 0; i < d.total; i++) deck.push(t);
  const players = playerNames.map((name, i) => ({
    id: randomUUID().slice(0, 8), name, kind: playerKinds[i] || 'human', color: COLORS[i % COLORS.length],
    res: { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 },
    dev: { knight: 0, vp: 0, road: 0, year: 0, mono: 0 },
    devFresh: [], knightsPlayed: 0, robberMoves: 0,
    roads: [], settlements: [], cities: [],
  }));
  const n = players.length;
  const order = [...Array(n).keys(), ...[...Array(n).keys()].reverse()];
  const setupSteps = [];
  for (const pi of order) setupSteps.push({ p: pi, kind: 'settlement' }, { p: pi, kind: 'road' });
  if (startBonus && startBonus !== 'none') {
    const k = startBonus === 'random2' ? 4 : 2;
    const remaining = Object.fromEntries(RES.map(r => [r, BANK_SIZE]));
    for (const p of players) for (let i = 0; i < k; i++) {
      const r = pick(RES.filter(type => remaining[type] > 0));
      p.res[r]++; remaining[r]--;
    }
  }
  const g = {
    id: randomUUID(), settings: { mapSize, targetVP, startBonus },
    map, players, deck: shuffle(deck), bank: Object.fromEntries(RES.map(r => [r, BANK_SIZE])),
    setupSteps, phase: 'setup', setupStep: 0, setupAnchor: {},
    current: order[0], firstPlayer: order[0], rolled: false,
    dice: null, tally: {}, discardQueue: [], needMoveRobber: false,
    stealFrom: [], pendingStealer: null,
    roadBuildLeft: 0, devPlayedTurn: null, longest: { holder: null, len: 0 }, army: { holder: null, count: 0 },
    offer: null, winner: null, log: [], turn: 1,
  };
  for (const p of players) for (const r of RES) g.bank[r] -= p.res[r];
  addLog(g, null, `游戏开始：${({ small: '小地图', medium: '中地图', large: '大地图', epic: '超大大陆', twin: '双岛地峡' })[mapSize] || '小地图'} ${map.hexes.length} 块 · ${targetVP} 分获胜`);
  addLog(g, players[g.current], `${players[g.current].name} 先手，请依次摆放初始定居点和道路`);
  return g;
}

export function addLog(g, player, text, kind = 'event') {
  g.log.push({ t: Date.now(), color: player ? player.color : null, name: player ? player.name : '系统', text, kind });
  if (g.log.length > 300) g.log.splice(0, g.log.length - 300);
}

const total = (p) => Object.values(p.res).reduce((a, b) => a + b, 0);
const canAfford = (p, cost) => RES.every(r => p.res[r] >= (cost[r] || 0));
function pay(g, p, cost) { for (const r in cost) { p.res[r] -= cost[r]; g.bank[r] += cost[r]; } }

// ---------- 合法性 ----------
export function legalSetup(g) {
  if (g.phase !== 'setup') return null;
  const step = g.setupSteps[g.setupStep];
  if (!step) return null;
  if (step.kind === 'settlement') {
    const busy = new Set();
    for (const p of g.players) for (const v of p.settlements.concat(p.cities)) { busy.add(v); for (const a of g.map.vAdj.get(v)) busy.add(a); }
    return g.map.vertices.filter(v => !busy.has(v.id)).map(v => v.id);
  }
  const anchor = g.setupAnchor[step.p];
  return g.map.edges.filter(e => !edgeOwner(g, e.id) && (e.a === anchor || e.b === anchor)).map(e => e.id);
}
const edgeOwner = (g, id) => g.players.find(p => p.roads.includes(id));

function roadNetwork(g, p) {
  const occupied = new Map();
  for (const q of g.players) for (const v of q.settlements) occupied.set(v, q === p ? 's' : 'x');
  for (const q of g.players) for (const v of q.cities) occupied.set(v, q === p ? 'c' : 'x');
  const available = new Set([...p.settlements, ...p.cities]);
  for (const eid of p.roads) {
    const e = g.map.eById[eid];
    if (occupied.get(e.a) !== 'x') available.add(e.a);
    if (occupied.get(e.b) !== 'x') available.add(e.b);
  }
  return available;
}

export function legalBuild(g, p, freeMode = false) {
  const out = { road: [], settlement: [], city: [], dev: false };
  if (g.phase !== 'play' || g.winner != null) return out;
  const net = roadNetwork(g, p);
  const busy = new Set();
  for (const q of g.players) for (const v of q.settlements.concat(q.cities)) { busy.add(v); for (const a of g.map.vAdj.get(v)) busy.add(a); }
  if (p.roads.length < PIECES.road && (canAfford(p, COST.road) || g.roadBuildLeft > 0 || freeMode)) {
    for (const e of g.map.edges) if (!edgeOwner(g, e.id) && (net.has(e.a) || net.has(e.b))) out.road.push(e.id);
  }
  const freeSettle = canAfford(p, COST.settlement);
  for (const v of g.map.vertices) {
    if (p.settlements.length < PIECES.settlement && freeSettle && !busy.has(v.id) && p.roads.some(eid => { const e = g.map.eById[eid]; return e.a === v.id || e.b === v.id; })) out.settlement.push(v.id);
    if (p.cities.length < PIECES.city && canAfford(p, COST.city) && p.settlements.includes(v.id)) out.city.push(v.id);
  }
  if (canAfford(p, COST.dev) && g.deck.length) out.dev = true;
  return out;
}

// ---------- 动作入口 ----------
export function playerAct(g, playerId, act) {
  if (!act || typeof act !== 'object') return '无效操作';
  const idx = g.players.findIndex(p => p.id === playerId);
  if (idx < 0) return '你不在本局游戏中';
  if (g.winner != null) return '游戏已结束';
  if (act.type === 'acceptOffer' || act.type === 'rejectOffer') {
    if (g.discardQueue.length || g.needMoveRobber || g.stealFrom.length || g.phase !== 'play') return '请先完成当前事件';
    return act.type === 'acceptOffer' ? acceptOffer(g, idx) : rejectOffer(g, idx);
  }
  if (act.type === 'cancelOffer') {
    if (g.offer && g.offer.from === idx) { addLog(g, g.players[idx], '取消了交易提案'); g.offer = null; }
    return null;
  }
  if (act.type === 'discard') {
    if (!g.discardQueue.includes(idx)) return '你不需要弃牌';
    return discardHalf(g, idx, act.res);
  }
  if (g.discardQueue.length) return '等所有玩家弃牌完毕';
  if (g.phase === 'setup') return setupAct(g, idx, act);
  if (g.needMoveRobber) {
    if (idx !== g.current) return '等待当前玩家移动强盗';
    if (act.type === 'moveRobber') return moveRobber(g, idx, act.hex);
    return '必须先移动强盗';
  }
  if (g.stealFrom.length) {
    if (g.pendingStealer === idx && act.type === 'steal') return doSteal(g, idx, act.from);
    return '先等待当前玩家完成抢劫';
  }
  if (idx !== g.current) return '还没到你的回合';
  if (g.roadBuildLeft > 0) {
    // 无路可放时自动结束筑路，避免卡死
    if (!legalBuild(g, g.players[idx]).road.length) g.roadBuildLeft = 0;
    else if (act.type === 'buildRoad') return freeRoad(g, idx, act.edge);
    else return `筑路工还有 ${g.roadBuildLeft} 条路没放`;
  }
  if (!g.rolled && !['roll', 'playKnight', 'playYear', 'playMono', 'playRoad'].includes(act.type)) return '请先掷骰子';
  switch (act.type) {
    case 'roll': return doRoll(g, idx);
    case 'buildRoad': return buyRoad(g, idx, act.edge);
    case 'buildSettlement': return buySettlement(g, idx, act.vertex);
    case 'buildCity': return buyCity(g, idx, act.vertex);
    case 'buyDev': return buyDev(g, idx);
    case 'playKnight': return playKnight(g, idx);
    case 'playYear': return playYear(g, idx, act.r1, act.r2);
    case 'playMono': return playMono(g, idx, act.res);
    case 'playRoad': return playRoad(g, idx);
    case 'bankTrade': return bankTrade(g, idx, act.give, act.want);
    case 'offerTrade': return offerTrade(g, idx, act.give, act.want, act.targets);
    case 'endTurn': return endTurn(g, idx);
    default: return '未知操作';
  }
}

function setupAct(g, pi, act) {
  const step = g.setupSteps[g.setupStep];
  if (!step || step.p !== pi) return '等待其他玩家摆放';
  const player = g.players[pi];
  const legal = legalSetup(g);
  if (step.kind === 'settlement') {
    if (act.type !== 'placeSettlement' || !legal.includes(act.vertex)) return '这里不能放定居点';
    player.settlements.push(act.vertex);
    g.setupAnchor[pi] = act.vertex;
    const isSecond = Math.floor(g.setupStep / 2) >= g.players.length;
    addLog(g, player, `摆放第 ${isSecond ? '2' : '1'} 个定居点`);
    if (isSecond) {
      const vertex = g.map.vById[act.vertex];
      for (const hid of vertex.hexes) {
        const hex = g.map.hexes.find(h => h.id === hid);
        if (hex && hex.resource !== 'desert' && g.bank[hex.resource] > 0) { player.res[hex.resource]++; g.bank[hex.resource]--; }
      }
      addLog(g, player, '获得第二个定居点周围地块的初始资源');
    }
  } else {
    if (act.type !== 'placeRoad' || !legal.includes(act.edge)) return '道路必须贴着刚放的定居点';
    g.map.eById[act.edge].owner = player.id; player.roads.push(act.edge);
    addLog(g, player, '摆放道路');
  }
  g.setupStep++;
  if (g.setupStep >= g.setupSteps.length) {
    g.phase = 'play'; g.current = g.firstPlayer; g.turn = 1;
    addLog(g, null, `摆放完成，${g.players[g.current].name} 先掷骰子`);
  }
  return null;
}

// ---------- 掷骰与生产 ----------
function doRoll(g, pi) {
  const p = g.players[pi];
  if (g.rolled) return '本回合已经掷过骰子了';
  const a = ri(6) + 1, b = ri(6) + 1;
  g.dice = { a, b, when: Date.now() };
  const s = a + b; g.tally[s] = (g.tally[s] || 0) + 1;
  g.rolled = true;
  if (s === 7) {
    addLog(g, p, `掷出 ${a} + ${b} = 7，强盗出动！`);
    g.discardQueue = g.players.map((q, i) => [q, i]).filter(([q]) => total(q) > 7).map(([, i]) => i);
    g.needMoveRobber = true;
    if (g.discardQueue.length) addLog(g, null, g.discardQueue.map(i => g.players[i].name).join('、') + ' 手牌超过 7 张，需弃掉一半');
  } else {
    addLog(g, p, `掷出 ${a} + ${b} = ${s}`);
    produce(g, s);
  }
  checkWin(g);
  return null;
}
export function produce(g, n) {
  // Compute everyone's entitlement before mutating the shared bank.
  const payouts = g.players.map(() => Object.fromEntries(RES.map(r => [r, 0])));
  for (const h of g.map.hexes) {
    if (h.number !== n || h.id === g.map.robber || h.resource === 'desert') continue;
    for (const v of g.map.vertices) if (v.hexes.includes(h.id)) g.players.forEach((p, i) => {
      payouts[i][h.resource] += p.settlements.includes(v.id) ? 1 : p.cities.includes(v.id) ? 2 : 0;
    });
  }
  const notes = [];
  for (const r of RES) {
    const recipients = payouts.map((p, i) => ({ i, amount: p[r] })).filter(p => p.amount);
    const needed = recipients.reduce((n, p) => n + p.amount, 0);
    if (g.bank[r] < needed && recipients.length > 1) {
      addLog(g, null, `银行的${RES_CN[r]}不足，本次所有人均未获得该资源`);
      continue;
    }
    let distributed = 0;
    for (const { i, amount } of recipients) {
      const paid = Math.min(amount, g.bank[r]);
      g.players[i].res[r] += paid; g.bank[r] -= paid; distributed += paid;
    }
    if (distributed) notes.push(`${RES_CN[r]}×${distributed}`);
  }
  if (notes.length) addLog(g, null, `产出：${notes.join('、')}`);
}
function stealRandomOne(g, to, from) {
  const hand = [];
  for (const r of RES) for (let i = 0; i < from.res[r]; i++) hand.push(r);
  if (!hand.length) return null;
  const r = pick(hand); from.res[r]--; to.res[r]++;
  return r;
}

// ---------- 弃牌与强盗 ----------
function discardHalf(g, pi, resObj) {
  const p = g.players[pi];
  const need = Math.floor(total(p) / 2);
  if (!resObj || typeof resObj !== 'object') return '弃牌无效';
  let cnt = 0;
  for (const r of RES) {
    const v = resObj[r] || 0;
    if (!Number.isInteger(v) || v < 0 || v > p.res[r]) return '弃牌无效';
    cnt += v;
  }
  if (cnt !== need) return `需要恰好弃掉 ${need} 张`;
  for (const r of RES) { p.res[r] -= resObj[r] || 0; g.bank[r] += resObj[r] || 0; }
  g.discardQueue = g.discardQueue.filter(i => i !== pi);
  addLog(g, p, `弃掉了 ${cnt} 张手牌`);
  return null;
}
function moveRobber(g, pi, hexId) {
  const p = g.players[pi];
  const h = g.map.hexes.find(x => x.id === hexId);
  if (!h) return '地块无效';
  if (hexId === g.map.robber) return '强盗必须换一块地';
  g.map.robber = hexId;
  p.robberMoves = (p.robberMoves || 0) + 1;
  g.needMoveRobber = false;
  addLog(g, p, `把强盗移到了 ${RES_CN[h.resource]}${h.number ? `(${h.number})` : ''} 上`);
  const victims = g.players.filter((q, qi) => qi !== pi && total(q) > 0 &&
    g.map.vertices.some(v => v.hexes.includes(hexId) && (q.settlements.includes(v.id) || q.cities.includes(v.id))));
  const vi = victims.map(q => g.players.indexOf(q));
  if (vi.length === 1) return doStealFrom(g, pi, vi[0]);
  if (vi.length > 1) { g.stealFrom = vi; g.pendingStealer = pi; }
  checkWin(g);
  return null;
}
function doSteal(g, pi, fromIdx) {
  if (g.pendingStealer !== pi || !g.stealFrom.includes(fromIdx)) return '不能抢这个目标';
  return doStealFrom(g, pi, fromIdx);
}
function doStealFrom(g, pi, fi) {
  g.stealFrom = []; g.pendingStealer = null;
  const from = g.players[fi];
  const r = stealRandomOne(g, g.players[pi], from);
  if (r) addLog(g, g.players[pi], `抢走了 ${from.name} 的 1 张资源卡`);
  checkWin(g);
  return null;
}

// ---------- 发展卡 ----------
const freshCount = (p, t, turn) => p.devFresh.filter(d => d.type === t && d.turn === turn).length;
const canPlayDev = (g, p, t) => {
  if (g.devPlayedTurn === g.turn) return '每回合只能打出一张发展卡';
  if (p.dev[t] <= 0) return '没有这张发展卡';
  if (p.dev[t] <= freshCount(p, t, g.turn)) return '本回合刚摸的发展卡不能打出';
  return null;
};
function playKnight(g, pi) {
  const p = g.players[pi];
  const invalid = canPlayDev(g, p, 'knight'); if (invalid) return invalid;
  g.devPlayedTurn = g.turn;
  p.dev.knight--; p.knightsPlayed++;
  addLog(g, p, `打出骑士卡（累计 ${p.knightsPlayed} 张），强盗出动`);
  if (p.knightsPlayed >= 3 && (g.army.holder == null || p.knightsPlayed > g.army.count)) {
    g.army = { holder: pi, count: p.knightsPlayed };
    addLog(g, p, `获得最大骑士团！`);
  } else if (g.army.holder === pi) g.army.count = p.knightsPlayed;
  g.needMoveRobber = true;
  checkWin(g);
  return null;
}
function playYear(g, pi, r1, r2) {
  const p = g.players[pi];
  const invalid = canPlayDev(g, p, 'year'); if (invalid) return invalid;
  if (!RES.includes(r1) || !RES.includes(r2)) return '资源无效';
  if (g.bank[r1] < (r1 === r2 ? 2 : 1) || g.bank[r2] < 1) return '银行资源不足';
  g.devPlayedTurn = g.turn;
  p.dev.year--; p.res[r1]++; p.res[r2]++; g.bank[r1]--; g.bank[r2]--;
  addLog(g, p, `丰收之年：从银行获得 1 ${RES_CN[r1]} + 1 ${RES_CN[r2]}`);
  return null;
}
function playMono(g, pi, res) {
  const p = g.players[pi];
  const invalid = canPlayDev(g, p, 'mono'); if (invalid) return invalid;
  if (!RES.includes(res)) return '资源无效';
  g.devPlayedTurn = g.turn;
  let n = 0;
  for (const q of g.players) if (q !== p) { n += q.res[res]; p.res[res] += q.res[res]; q.res[res] = 0; }
  p.dev.mono--;
  addLog(g, p, `垄断之年：从所有人手中收走 ${n} 张${RES_CN[res]}`);
  return null;
}
function playRoad(g, pi) {
  const p = g.players[pi];
  const invalid = canPlayDev(g, p, 'road'); if (invalid) return invalid;
  if (!legalBuild(g, p, true).road.length) return '没有可修路的位置';
  g.devPlayedTurn = g.turn;
  p.dev.road--; g.roadBuildLeft = Math.min(2, PIECES.road - p.roads.length);
  addLog(g, p, '筑路工：本回合可免费修建 2 条路');
  return null;
}
function freeRoad(g, pi, edgeId) {
  const p = g.players[pi];
  if (!legalBuild(g, p).road.includes(edgeId)) return '这条路的位置无效';
  g.map.eById[edgeId].owner = p.id; p.roads.push(edgeId);
  g.roadBuildLeft--;
  if (g.roadBuildLeft && !legalBuild(g, p).road.length) g.roadBuildLeft = 0;
  addLog(g, p, g.roadBuildLeft ? '免费修了 1 条路' : '免费修完了第 2 条路');
  updateLongest(g);
  checkWin(g);
  return null;
}

// ---------- 建造 ----------
function buyRoad(g, pi, edgeId) {
  const p = g.players[pi];
  if (!canAfford(p, COST.road)) return '资源不足（路 = 木1+砖1）';
  if (!legalBuild(g, p).road.includes(edgeId)) return '这条路位置无效：必须连接你的路网，且不能穿过他人建筑';
  pay(g, p, COST.road);
  g.map.eById[edgeId].owner = p.id; p.roads.push(edgeId);
  addLog(g, p, '修了一条路');
  updateLongest(g); checkWin(g);
  return null;
}
function buySettlement(g, pi, vId) {
  const p = g.players[pi];
  if (!canAfford(p, COST.settlement)) return '资源不足（定居点 = 木1+砖1+羊1+麦1）';
  if (!legalBuild(g, p).settlement.includes(vId)) return '这里不能建定居点';
  pay(g, p, COST.settlement);
  p.settlements.push(vId);
  addLog(g, p, '建成了新定居点');
  updateLongest(g); checkWin(g);
  return null;
}
function buyCity(g, pi, vId) {
  const p = g.players[pi];
  if (!canAfford(p, COST.city)) return '资源不足（城市 = 麦2+矿3）';
  if (!legalBuild(g, p).city.includes(vId)) return '这里不能升级城市';
  pay(g, p, COST.city);
  p.settlements = p.settlements.filter(v => v !== vId);
  p.cities.push(vId);
  addLog(g, p, '定居点升级为城市！');
  updateLongest(g); checkWin(g);
  return null;
}
function buyDev(g, pi) {
  const p = g.players[pi];
  if (!canAfford(p, COST.dev)) return '资源不足（发展卡 = 羊1+麦1+矿1）';
  if (!g.deck.length) return '发展卡牌堆已空';
  pay(g, p, COST.dev);
  const t = g.deck.pop();
  p.dev[t]++; p.devFresh.push({ type: t, turn: g.turn });
  addLog(g, p, '购买了 1 张发展卡');
  checkWin(g);
  return null;
}

// ---------- 交易 ----------
function portRate(g, p, giveRes) {
  let rate = 4;
  for (const v of g.map.vertices) {
    if (!(p.settlements.includes(v.id) || p.cities.includes(v.id)) || !v.port) continue;
    if (v.port === '3') rate = Math.min(rate, 3);
    if (v.port === `2:${giveRes}`) rate = Math.min(rate, 2);
  }
  return rate;
}
export const portRatesFor = (g, p) => Object.fromEntries(RES.map(r => [r, portRate(g, p, r)]));
function bankTrade(g, pi, give, want) {
  const p = g.players[pi];
  if (!RES.includes(give) || !RES.includes(want) || give === want) return '交易无效';
  const rate = portRate(g, p, give);
  if (p.res[give] < rate) return `需要 ${rate} 张${RES_CN[give]}（当前比例 ${rate}:1）`;
  if (g.bank[want] < 1) return `银行已没有${RES_CN[want]}`;
  p.res[give] -= rate; g.bank[give] += rate; p.res[want]++; g.bank[want]--;
  addLog(g, p, `银行交易 ${rate}:${1}：${rate} ${RES_CN[give]} → 1 ${RES_CN[want]}`);
  return null;
}
function tradeBundle(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.res !== undefined && typeof value.res !== 'string') return null;
  const input = value.res ? { [value.res]: value.n } : value;
  if (Object.keys(input).some(r => !RES.includes(r))) return null;
  const out = Object.fromEntries(RES.map(r => [r, input[r] ?? 0]));
  if (RES.some(r => !Number.isInteger(out[r]) || out[r] < 0 || out[r] > BANK_SIZE)) return null;
  return RES.some(r => out[r] > 0) ? out : null;
}
const bundleText = bundle => RES.filter(r => bundle[r]).map(r => `${bundle[r]} ${RES_CN[r]}`).join('、');
function offerTrade(g, pi, give, want, rawTargets) {
  const p = g.players[pi];
  if (g.offer) return '场上已有待处理的交易提案';
  const given = tradeBundle(give), wanted = tradeBundle(want);
  if (!given || !wanted || RES.every(r => given[r] === wanted[r])) return '交易资源无效';
  if (!canAfford(p, given)) return '你没有这么多资源';
  const targets = [...new Set(Array.isArray(rawTargets) ? rawTargets : g.players.map((_, i) => i).filter(i => i !== pi))];
  if (!targets.length || targets.some(i => !Number.isInteger(i) || i < 0 || i >= g.players.length || i === pi)) return '请选择有效的交易对象';
  g.offer = { from: pi, give: given, want: wanted, targets };
  addLog(g, p, `发起交易：出 ${bundleText(given)}，求 ${bundleText(wanted)}（等待响应）`);
  return null;
}
function acceptOffer(g, qi) {
  const o = g.offer; if (!o) return '当前没有交易提案';
  const from = g.players[o.from], me = g.players[qi];
  if (o.from === qi) return '不能响应自己的提案';
  if (!o.targets.includes(qi)) return '这份交易没有邀请你';
  if (!canAfford(me, o.want)) return '你给不出所需资源';
  if (!canAfford(from, o.give)) { g.offer = null; return '对方资源不足，交易作废'; }
  for (const r of RES) {
    me.res[r] += o.give[r] - o.want[r];
    from.res[r] += o.want[r] - o.give[r];
  }
  addLog(g, me, `与 ${from.name} 成交：${bundleText(o.want)} ⇄ ${bundleText(o.give)}`);
  g.offer = null;
  return null;
}
function rejectOffer(g, qi) {
  const o = g.offer; if (!o) return '当前没有交易提案';
  if (o.from === qi || !o.targets.includes(qi)) return '这份交易没有邀请你';
  o.targets = o.targets.filter(i => i !== qi);
  addLog(g, g.players[qi], `拒绝了 ${g.players[o.from].name} 的交易提案`);
  if (!o.targets.length) {
    g.offer = null;
    addLog(g, null, '交易提案已结束：所有受邀玩家均已拒绝');
  }
  return null;
}

// ---------- 回合与胜负 ----------
function endTurn(g, pi) {
  if (!g.rolled) return '请先掷骰子再结束回合';
  if (g.offer?.from === pi) return '请等待交易回复或取消提案';
  g.offer = null; g.rolled = false; g.dice = null;
  g.current = (g.current + 1) % g.players.length;
  g.turn++;
  addLog(g, null, `▶ ${g.players[g.current].name} 的回合`);
  checkWin(g);
  return null;
}
function longestRoadFor(g, p) {
  const adj = new Map();
  const push = (v, w, eid) => { if (!adj.has(v)) adj.set(v, []); adj.get(v).push([w, eid]); };
  for (const eid of p.roads) { const e = g.map.eById[eid]; push(e.a, e.b, eid); push(e.b, e.a, eid); }
  const blocked = new Set();
  for (const q of g.players) {
    for (const v of q.settlements) if (q !== p) blocked.add(v);
    for (const v of q.cities) if (q !== p) blocked.add(v);
  }
  let best = 0;
  const dfs = (v, used, len) => {
    if (len > best) best = len;
    for (const [w, eid] of (adj.get(v) || [])) {
      if (used.has(eid)) continue;
      if (blocked.has(w)) { best = Math.max(best, len + 1); continue; }
      used.add(eid); dfs(w, used, len + 1); used.delete(eid);
    }
  };
  for (const v of adj.keys()) if (!blocked.has(v)) dfs(v, new Set(), 0);
  return best;
}
export function updateLongest(g) {
  const lens = g.players.map(p => longestRoadFor(g, p));
  const max = Math.max(0, ...lens);
  const leaders = lens.flatMap((len, i) => len === max ? [i] : []);
  const previous = g.longest.holder;
  const holder = max < 5 ? null : leaders.includes(previous) ? previous : leaders.length === 1 ? leaders[0] : null;
  if (holder !== previous) {
    if (holder == null) addLog(g, null, '最长贸易之路暂时无人持有');
    else addLog(g, g.players[holder], `夺得最长贸易之路（${max} 条，+2 分）`);
  }
  g.longest = { holder, len: holder == null ? 0 : max };
}
export function vpOf(g, p, withHidden = false) {
  const i = g.players.indexOf(p);
  let vp = p.cities.length * 2 + p.settlements.length + (p.dev.vp && withHidden ? p.dev.vp : 0);
  if (g.longest.holder === i) vp += 2;
  if (g.army.holder === i) vp += 2;
  return vp;
}
function checkWin(g) {
  if (g.winner != null || g.phase !== 'play') return;
  const p = g.players[g.current];
  const vp = vpOf(g, p, true);
  if (vp >= g.settings.targetVP) {
    g.winner = g.current; g.phase = 'over';
    addLog(g, p, `达到 ${vp} 分，赢得本局！`);
  }
}

// ---------- 序列化（按视角脱敏）----------
export function serialize(g, viewerId) {
  const vi = g.players.findIndex(p => p.id === viewerId);
  const setupStep = g.phase === 'setup' ? g.setupSteps[g.setupStep] : null;
  const players = g.players.map((p, i) => {
    const me = i === vi;
    return {
      id: p.id, name: p.name, kind: p.kind || 'human', color: p.color, total: total(p),
      res: me ? p.res : null,
      devCount: Object.values(p.dev).reduce((a, b) => a + b, 0),
      dev: me ? p.dev : null,
      knightsPlayed: p.knightsPlayed, robberMoves: p.robberMoves || 0,
      settlements: p.settlements.length, cities: p.cities.length, roads: p.roads.length,
      roadLength: longestRoadFor(g, p),
      cityVerts: p.cities, settleVerts: p.settlements, roadEdges: p.roads,
      vp: vpOf(g, p, me || g.phase === 'over'),
      current: i === g.current,
      needDiscard: g.discardQueue.includes(i),
      ports: me ? portRatesFor(g, p) : null,
    };
  });
  let legal = null;
  if (setupStep) legal = { setup: legalSetup(g), kind: setupStep.kind, setupPlayer: setupStep.p };
  else if (vi === g.current && g.winner == null && g.phase === 'play') {
    legal = legalBuild(g, g.players[vi]);
    legal.canPlayRoad = legalBuild(g, g.players[vi], true).road.length > 0;
    if (g.roadBuildLeft) legal.freeRoads = g.roadBuildLeft;
  }
  return {
    id: g.id, settings: g.settings, phase: g.phase, turn: g.turn, winner: g.winner,
    bank: g.bank,
    devPlayed: g.devPlayedTurn === g.turn,
    map: {
      hexes: g.map.hexes,
      vertices: g.map.vertices.map(v => ({ id: v.id, x: v.x, y: v.y, port: v.port, hexes: v.hexes })),
      edges: g.map.edges.map(e => ({ id: e.id, a: e.a, b: e.b, owner: e.owner || null })),
      ports: g.map.ports,
      robber: g.map.robber,
    },
    players, viewer: vi, current: g.current, rolled: g.rolled,
    eventPending: !!(g.discardQueue.length || g.needMoveRobber || g.stealFrom.length),
    dice: g.dice, tally: g.tally, deckLeft: g.deck.length,
    offer: g.offer ? { from: g.offer.from, fromName: g.players[g.offer.from].name, fromColor: g.players[g.offer.from].color, give: g.offer.give, want: g.offer.want, targets: g.offer.targets } : null,
    longest: { ...g.longest, name: g.longest.holder != null ? g.players[g.longest.holder].name : null },
    army: { ...g.army, name: g.army.holder != null ? g.players[g.army.holder].name : null },
    roadBuildLeft: g.roadBuildLeft,
    discardCount: g.discardQueue.length, robberPending: g.needMoveRobber, stealPending: g.stealFrom.length > 0,
    needMoveRobber: !g.discardQueue.length && g.needMoveRobber && vi === g.current,
    stealFrom: g.pendingStealer === vi ? g.stealFrom : [],
    log: g.log.slice(-80),
    cards: vi >= 0 ? {
      knight: g.players[vi].dev.knight, year: g.players[vi].dev.year,
      mono: g.players[vi].dev.mono, road: g.players[vi].dev.road,
      fresh: g.players[vi].devFresh.some(d => d.turn === g.turn) ? g.players[vi].devFresh.filter(d => d.turn === g.turn).map(d => d.type) : [],
    } : null,
    legal,
  };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, generateMap, legalSetup, legalBuild, playerAct, serialize, portRatesFor, RES, BANK_SIZE } from '../game/engine.js';
import { normalizeAIAction, isUsefulAIAction, ruleBotAction, usefulBankTrade, usefulYearAction, compactStateForAI } from '../bot.js';
import { getBotProfile, listBotProfiles } from '../bots/profiles.js';

function game(n = 3) {
  return createGame({ mapSize: 'small', targetVP: 15, startBonus: 'none', playerNames: Array.from({ length: n }, (_, i) => `P${i}`) });
}
function setup(g) {
  while (g.phase === 'setup') {
    const step = g.setupSteps[g.setupStep];
    const action = step.kind === 'settlement'
      ? { type: 'placeSettlement', vertex: legalSetup(g)[0] }
      : { type: 'placeRoad', edge: legalSetup(g)[0] };
    assert.equal(playerAct(g, g.players[step.p].id, action), null);
  }
}

test('机器人发起交易后等待回复，不继续建造或反复结束回合', () => {
  const g = game(2); setup(g); g.rolled = true;
  g.offer = { from: 0, give: { wood: 1 }, want: { brick: 1 }, targets: [1] };
  const state = serialize(g, g.players[0].id);
  assert.equal(ruleBotAction(state), null);
  assert.equal(isUsefulAIAction(state, { type: 'endTurn' }), false);
  assert.equal(isUsefulAIAction(state, { type: 'cancelOffer' }), true);
});

test('蛇形摆放只在第二个定居点发资源，银行总量守恒', () => {
  const g = game(3);
  for (let i = 0; i < 6; i++) {
    const step = g.setupSteps[g.setupStep];
    const action = step.kind === 'settlement'
      ? { type: 'placeSettlement', vertex: legalSetup(g)[0] }
      : { type: 'placeRoad', edge: legalSetup(g)[0] };
    assert.equal(playerAct(g, g.players[step.p].id, action), null);
  }
  assert.equal(g.players.reduce((n, p) => n + Object.values(p.res).reduce((a, b) => a + b, 0), 0), 0);
  setup(g);
  for (const r of RES) assert.equal(g.bank[r] + g.players.reduce((n, p) => n + p.res[r], 0), BANK_SIZE);
  assert.equal(g.players.every(p => p.settlements.length === 2 && p.roads.length === 2), true);
});

test('港口覆盖两个海岸顶点，建造件数有上限', () => {
  const g = game(2); setup(g);
  assert.equal(g.map.ports.length, 9);
  for (const port of g.map.ports) {
    assert.equal(g.map.vById[port.a].port, port.type);
    assert.equal(g.map.vById[port.b].port, port.type);
  }
  const p = g.players[0];
  p.res = Object.fromEntries(RES.map(r => [r, 20]));
  g.rolled = true;
  p.roads = g.map.edges.slice(0, 15).map(e => e.id);
  assert.equal(legalBuild(g, p).road.length, 0);
  p.settlements = g.map.vertices.slice(0, 5).map(v => v.id);
  assert.equal(legalBuild(g, p).settlement.length, 0);
});

test('每个港口对称连接同一条海岸边的两个端点，互不占用顶点', () => {
  for (const size of ['small', 'medium', 'large', 'epic', 'twin']) for (let run = 0; run < 20; run++) {
    const map = generateMap(size);
    const used = new Set();
    for (const p of map.ports) {
      const edge = map.edges.find(e => e.hexes.length === 1 && e.hexes[0] === p.hex &&
        [e.a, e.b].sort().join() === [p.a, p.b].sort().join());
      assert.ok(edge, `${size} 港口必须连接一条海岸边`);
      assert.equal(used.has(p.a) || used.has(p.b), false, `${size} 港口不能共用交点`);
      used.add(p.a); used.add(p.b);
      assert.equal(map.vById[p.a].port, p.type);
      assert.equal(map.vById[p.b].port, p.type);
      for (const id of [p.a, p.b]) {
        const v = map.vById[id];
        assert.ok(Math.abs(Math.hypot(v.x-p.x,v.y-p.y)-1)<1e-8, '码头沿海上六边形的半径延伸');
      }
      const land = map.hexes.find(h=>h.id===p.hex);
      assert.ok(Math.abs(Math.hypot(land.x-p.x,land.y-p.y)-Math.sqrt(3))<1e-8, '港口在相邻海格中心');
    }
  }
});

test('参考站三种地图的行列轮廓、固定港位与数量保持一致', () => {
  const expected = {
    small: { rows: [3,4,5,4,3], count: 19, ports: 9, right: 3 },
    medium: { rows: [3,4,5,6,5,4,3], count: 30, ports: 11, right: 4 },
    large: { rows: [4,5,6,7,6,5,4], count: 37, ports: 12, right: 4 },
  };
  for (const [size, want] of Object.entries(expected)) {
    const m = generateMap(size), again = generateMap(size);
    const rows = [...new Set(m.hexes.map(h=>h.r))].sort((a,b)=>a-b).map(r=>m.hexes.filter(h=>h.r===r).length);
    assert.deepEqual(rows,want.rows);assert.equal(m.hexes.length,want.count);assert.equal(m.ports.length,want.ports);
    assert.deepEqual(m.ports.map(({a,b,x,y})=>[a,b,x,y]),again.ports.map(({a,b,x,y})=>[a,b,x,y]),'重开地图不会随机轮转港位');
    assert.ok(m.ports.some(p=>Math.abs(p.x-want.right*Math.sqrt(3))<1e-8 && p.y===0),'最右港口与参考站坐标一致');
    for(const res of RES) assert.equal(m.ports.filter(p=>p.type===`2:${res}`).length,1);
    assert.equal(m.ports.filter(p=>p.type==='3').length,want.ports-5);
  }
});

test('港口兑换权限只授予画面所连的两个岸边交点', () => {
  for(const mapSize of ['small','medium','large','epic','twin']) {
    const g=createGame({mapSize,targetVP:10,startBonus:'none',playerNames:['A','B']});
    const p=g.players[0];
    for(const port of g.map.ports) for(const id of [port.a,port.b]) {
      p.settlements=[id];
      for(const res of RES) assert.equal(portRatesFor(g,p)[res],port.type==='3'?3:port.type===`2:${res}`?2:4);
    }
    p.settlements=[g.map.vertices.find(v=>!v.port).id];
    assert.deepEqual(Object.values(portRatesFor(g,p)),[4,4,4,4,4]);
  }
});

test('两种超大地图完整连通、港口不重叠且双岛可经中央地峡通行', () => {
  for(const [size,tiles,ports] of [['epic',61,18],['twin',73,20]]) {
    const map=generateMap(size),seen=new Set(),queue=[map.hexes[0]];
    while(queue.length){const h=queue.pop();if(seen.has(h.id))continue;seen.add(h.id);queue.push(...map.neighborsOf(h).filter(h=>!seen.has(h.id)));}
    assert.equal(seen.size,tiles);assert.equal(map.hexes.length,tiles);assert.equal(map.ports.length,ports);
    for(const p of map.ports) for(const q of map.ports) if(p!==q) assert.ok(Math.hypot(p.x-q.x,p.y-q.y)>1);
    for(const r of RES) assert.equal(map.ports.filter(p=>p.type===`2:${r}`).length,2);
    if(size==='twin') {
      const bridge=map.hexes.find(h=>h.q===0&&h.r===0);
      assert.ok(bridge);assert.ok(map.neighborsOf(bridge).some(h=>h.q<0));assert.ok(map.neighborsOf(bridge).some(h=>h.q>0));
    }
    const g=createGame({mapSize:size,targetVP:10,startBonus:'none',playerNames:['A','B']});
    assert.deepEqual(Object.values(g.bank),[29,29,29,29,29]);
  }
});

test('发展卡本回合限打一张，摸到的卡对其他玩家隐藏', () => {
  const g = game(2); setup(g);
  const p = g.players[0]; g.rolled = true;
  p.dev.knight = 2;
  assert.equal(playerAct(g, p.id, { type: 'playKnight' }), null);
  const hex = g.map.hexes.find(h => h.resource !== 'desert' && h.id !== g.map.robber);
  assert.equal(playerAct(g, p.id, { type: 'moveRobber', hex: hex.id }), null);
  assert.match(playerAct(g, p.id, { type: 'playKnight' }), /每回合只能/);
  g.deck = ['road']; p.res.sheep = 1; p.res.wheat = 1; p.res.ore = 1;
  assert.equal(playerAct(g, p.id, { type: 'buyDev' }), null);
  const other = serialize(g, g.players[1].id);
  assert.equal(other.players[0].dev, null);
  assert.equal(other.log.at(-1).text, '购买了 1 张发展卡');
});

test('筑路工期间其他玩家不能替当前玩家免费修路', () => {
  const g = game(2); setup(g); g.rolled = true; g.roadBuildLeft = 2;
  const other = g.players[1];
  const edge = legalBuild(g, other, true).road[0];
  assert.ok(edge);
  const roadsBefore = other.roads.length;
  assert.match(playerAct(g, other.id, { type: 'buildRoad', edge }), /还没到你的回合/);
  assert.equal(other.roads.length, roadsBefore);
  assert.equal(g.roadBuildLeft, 2);
});

test('最长路可在对手建筑处结束，不能从该点继续穿过', () => {
  const g = game(2); setup(g);
  const adj = new Map();
  for (const e of g.map.edges) for (const [v, w] of [[e.a, e.b], [e.b, e.a]]) {
    if (!adj.has(v)) adj.set(v, []);
    adj.get(v).push({ id: e.id, to: w });
  }
  function path(v, used = new Set(), edges = [], start = v) {
    if (edges.length === 5) return { start, end: v, edges };
    for (const e of adj.get(v)) if (!used.has(e.to)) {
      const found = path(e.to, new Set([...used, e.to]), [...edges, e.id], start);
      if (found) return found;
    }
    return null;
  }
  const route = [...adj.keys()].map(v => path(v, new Set([v]))).find(Boolean);
  assert.ok(route);
  const [p, q] = g.players;
  q.roads = [];
  p.roads = route.edges.slice(0, 4);
  p.settlements = [route.start]; q.settlements = [route.end];
  p.res.wood = 1; p.res.brick = 1; g.rolled = true;
  assert.equal(playerAct(g, p.id, { type: 'buildRoad', edge: route.edges[4] }), null);
  assert.equal(g.longest.holder, 0);
  assert.equal(g.longest.len, 5);
  assert.equal(serialize(g, p.id).players[0].roadLength, 5);
});

test('强盗移动只统计骑士卡触发的成功移动', () => {
  const g = game(2); setup(g);
  const p = g.players[g.current], original = g.map.robber;
  g.needMoveRobber = true;
  assert.match(playerAct(g, p.id, { type: 'moveRobber', hex: original }), /必须换/);
  assert.equal(p.robberMoves, 0);
  const first = g.map.hexes.find(h => h.id !== original).id;
  assert.equal(playerAct(g, p.id, { type: 'moveRobber', hex: first }), null);
  assert.equal(serialize(g, null).players[g.current].robberMoves, 0);
  g.stealFrom = []; g.pendingStealer = null;
  p.dev.knight = 1;
  assert.equal(playerAct(g, p.id, { type: 'playKnight' }), null);
  assert.equal(p.knightsPlayed, 1);
  assert.match(playerAct(g, p.id, { type: 'moveRobber', hex: first }), /必须换/);
  assert.equal(p.robberMoves, 0);
  const second = g.map.hexes.find(h => h.id !== first).id;
  assert.equal(playerAct(g, p.id, { type: 'moveRobber', hex: second }), null);
  assert.equal(serialize(g, null).players[g.current].robberMoves, 1);
  g.stealFrom = []; g.pendingStealer = null; g.needMoveRobber = true;
  assert.equal(playerAct(g, p.id, { type: 'moveRobber', hex: first }), null);
  assert.equal(p.robberMoves, 1);
});

test('AI 动作解析与阶段校验', () => {
  const g = game(2);
  const state = serialize(g, g.players[0].id);
  const action = normalizeAIAction('```json\n{"type":"placeSettlement","vertex":"' + state.legal.setup[0] + '"}\n```');
  assert.equal(isUsefulAIAction(state, action), true);
  assert.equal(isUsefulAIAction(state, { type: 'endTurn' }), false);
  assert.equal(ruleBotAction(state).type, 'placeSettlement');
});

test('五档 AI 难度使用不同的模型调用策略', async () => {
  const g = game(2);
  const state = serialize(g, g.players[0].id);
  const fallback = { type: 'placeSettlement', vertex: state.legal.setup[0] };
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return { ok: true, async json() { return { choices: [{ message: { content: JSON.stringify(fallback) } }] }; } };
  };
  try {
    assert.deepEqual(listBotProfiles().map(p => p.id), ['low', 'medium', 'high', 'very-high', 'highest']);
    assert.equal(await getBotProfile('low').decide({ state, fallback }), fallback);
    assert.equal(requests.length, 0);
    for (const id of ['medium', 'high', 'very-high']) {
      const before = requests.length;
      assert.deepEqual(await getBotProfile(id).decide({ state, config: { baseUrl: 'http://mock/v1', model: 'mock', apiKey: 'x' }, fallback }), fallback);
      assert.equal(requests.length - before, 1);
    }
    const beforeHighest = requests.length;
    assert.deepEqual(await getBotProfile('highest').decide({ state, config: { baseUrl: 'http://mock/v1', model: 'mock', apiKey: 'x' }, fallback }), fallback);
    assert.equal(requests.length - beforeHighest, 2);
    assert.deepEqual(requests.map(r => r.temperature), [0.85, 0.55, 0.3, 0.15, 0.15]);
    assert.ok(requests[2].messages[0].content.length > requests[0].messages[0].content.length);
    assert.ok(requests.every(r => r.response_format?.type === 'json_object'));
    setup(g);
    assert.deepEqual(await getBotProfile('highest').decide({ state: serialize(g, g.players[0].id), config: { baseUrl: 'http://mock/v1', model: 'mock', apiKey: 'x' }, fallback: { type: 'roll' } }), { type: 'roll' });
    assert.equal(requests.length, 5, '只有掷骰这一种选择时不消耗模型调用');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('模型动作在提交前检查资源、发展卡和弃牌数量', () => {
  const g = game(2); setup(g);
  const p = g.players[0];
  let state = serialize(g, p.id);
  assert.equal(isUsefulAIAction(state, { type: 'buyDev' }), false, '掷骰前不能买卡');
  assert.equal(isUsefulAIAction(state, { type: 'playKnight' }), false, '没有骑士卡不能打出');
  g.rolled = true;
  state = serialize(g, p.id);
  assert.equal(isUsefulAIAction(state, { type: 'roll' }), false, '已掷骰不能重掷');
  assert.equal(isUsefulAIAction(state, { type: 'bankTrade', give: 'wood', want: 'ore' }), false, '银行交易需要付得起');
  assert.equal(isUsefulAIAction(state, { type: 'playYear', r1: 'wood', r2: 'ore' }), false, '没有丰收卡不能打出');
  assert.equal(isUsefulAIAction(state, { type: 'offerTrade', give: { wood: 99 }, want: { ore: 1 } }), false, '交易资源必须合法');
  p.res = Object.fromEntries(RES.map(r => [r, r === 'wood' ? 8 : 0])); g.discardQueue = [0];
  state = serialize(g, p.id);
  assert.equal(isUsefulAIAction(state, { type: 'discard', res: { wood: 1 } }), false, '弃牌必须恰好一半');
  assert.equal(isUsefulAIAction(state, { type: 'discard', res: { wood: Math.floor(p.res.wood / 2) } }), true);
});

test('强盗决策给模型公开的产出和目标信息，不泄露对手手牌种类', () => {
  const g = game(2); setup(g);
  g.needMoveRobber = true;
  const state = serialize(g, g.players[0].id);
  const choices = compactStateForAI(state, 'rich').choices.robber;
  assert.ok(choices.some(h => h.opponents.length), '模型可辨别被阻断的对手建筑');
  assert.equal(choices.some(h => h.opponents.some(p => 'res' in p)), false, '候选不含对手手牌种类');
  assert.equal(state.players[1].res, null);
});

test('最高档有限循环修正非法动作并保留最后一个合法候选', async () => {
  const g = game(2);
  const state = serialize(g, g.players[0].id);
  const fallback = { type: 'placeSettlement', vertex: state.legal.setup[0] };
  const other = { type: 'placeSettlement', vertex: state.legal.setup[1] };
  const originalFetch = globalThis.fetch;
  const calls = [];
  const replies = [
    { type: 'placeSettlement', vertex: 'invalid' }, fallback, other, other,
  ];
  globalThis.fetch = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return { ok: true, async json() { return { choices: [{ message: { content: JSON.stringify(replies.shift()) } }] }; } };
  };
  try {
    const reasons = [];
    const config = { baseUrl: 'http://mock/v1', model: 'mock', apiKey: 'x' };
    assert.deepEqual(await getBotProfile('highest').decide({ state, config, fallback, onFallback: reason => reasons.push(reason) }), other);
    assert.equal(calls.length, 4);
    assert.match(calls[1].messages.at(-1).content, /不符合当前阶段/);
    assert.match(calls[2].messages.at(-1).content, /复核/);
    assert.deepEqual(reasons, []);
    calls.length = 0;
    replies.push(fallback, ...Array.from({ length: 4 }, () => ({ type: 'placeSettlement', vertex: 'invalid' })));
    assert.deepEqual(await getBotProfile('highest').decide({ state, config, fallback, onFallback: reason => reasons.push(reason) }), fallback);
    assert.equal(calls.length, 5);
    assert.deepEqual(reasons, [], '已有合法候选时不记录规则 Bot 接管');
    calls.length = 0;
    replies.push(...Array.from({ length: 5 }, () => ({ type: 'placeSettlement', vertex: 'invalid' })));
    assert.deepEqual(await getBotProfile('highest').decide({ state, config, fallback, onFallback: reason => reasons.push(reason) }), fallback);
    assert.equal(calls.length, 5, '反复非法输出也不会无限调用模型');
    assert.match(reasons.at(-1), /无效/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('AI 上游返回超大响应时安全回退，不解析完整内容', async () => {
  const g = game(2);
  const state = serialize(g, g.players[0].id);
  const fallback = { type: 'placeSettlement', vertex: state.legal.setup[0] };
  const originalFetch = globalThis.fetch;
  const oversized = new Uint8Array(128 * 1024 + 1);
  globalThis.fetch = async () => ({
    ok: true,
    headers: new Headers(),
    body: { getReader() {
      let sent = false;
      return { read: async () => sent ? { done: true } : (sent = true, { done: false, value: oversized }), releaseLock() {} };
    } },
  });
  try {
    const reasons = [];
    assert.deepEqual(await getBotProfile('high').decide({
      state, config: { baseUrl: 'http://mock/v1', model: 'mock', apiKey: 'x' }, fallback,
      onFallback: reason => reasons.push(reason),
    }), fallback);
    assert.deepEqual(reasons, ['模型请求失败']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('玩家交易支持多种资源和指定接收者', () => {
  const g = game(3); setup(g); g.rolled = true;
  const [a, b, c] = g.players;
  a.res.wood = 2; a.res.sheep = 1;
  c.res.brick = 1; c.res.wheat = 2;
  const beforeA = { ...a.res }, beforeC = { ...c.res };
  const beforeBank = { ...g.bank };
  assert.equal(playerAct(g, a.id, { type: 'offerTrade', give: { wood: 2, sheep: 1 }, want: { brick: 1, wheat: 2 }, targets: [2] }), null);
  assert.match(playerAct(g, b.id, { type: 'acceptOffer' }), /没有邀请/);
  assert.equal(playerAct(g, c.id, { type: 'acceptOffer' }), null);
  assert.equal(a.res.wood, beforeA.wood - 2); assert.equal(a.res.brick, beforeA.brick + 1);
  assert.equal(c.res.wood, beforeC.wood + 2); assert.equal(c.res.wheat, beforeC.wheat - 2);
  assert.deepEqual(g.bank, beforeBank);
  assert.equal(g.offer, null);
});

test('AI 对不划算的玩家报价明确拒绝，逐一回应后提案结束', () => {
  const g = game(3); setup(g); g.rolled = true;
  const [a, b, c] = g.players;
  a.res.wood = 1; b.res.brick = 1; c.res.brick = 1;
  assert.equal(playerAct(g, a.id, { type: 'offerTrade', give: { wood: 1 }, want: { brick: 1 }, targets: [1, 2] }), null);
  assert.match(playerAct(g, a.id, { type: 'endTurn' }), /等待交易回复/);
  for (const bot of [b, c]) {
    const state = serialize(g, bot.id);
    const response = ruleBotAction(state);
    assert.deepEqual(response, { type: 'acceptOffer' });
    assert.equal(isUsefulAIAction(state, response), true);
  }
  assert.equal(playerAct(g, b.id, { type: 'rejectOffer' }), null);
  assert.deepEqual(g.offer.targets, [2]);
  assert.equal(playerAct(g, c.id, { type: 'rejectOffer' }), null);
  assert.equal(g.offer, null);
  assert.match(g.log.at(-1).text, /均已拒绝/);
  assert.equal(playerAct(g, a.id, { type: 'offerTrade', give: { wood: 1 }, want: { brick: 2 }, targets: [1] }), null);
  const rejected = ruleBotAction(serialize(g, b.id));
  assert.deepEqual(rejected, { type: 'rejectOffer' });
  assert.equal(isUsefulAIAction(serialize(g, b.id), rejected), true);
  assert.equal(playerAct(g, b.id, rejected), null);
  assert.equal(g.offer, null);
});

test('银行按整次掷骰发放资源，不因先发一块地而漏发下一块', async () => {
  const { produce } = await import('../game/engine.js');
  const g = game(2); setup(g);
  g.map.hexes.forEach(h => { h.number = 0; });
  g.players.forEach(p => { p.settlements=[]; p.cities=[]; });
  const hs = g.map.hexes.filter(h=>h.id!==g.map.robber).slice(0,2);
  hs.forEach((h,i)=>{ h.resource='wood';h.number=6;g.players[i].settlements=[g.map.vertices.find(v=>v.hexes.includes(h.id)&&!v.hexes.includes(hs[1-i].id)).id]; });
  const before=g.players.map(p=>p.res.wood);g.bank.wood=2;
  produce(g,6);
  assert.equal(g.bank.wood,0);
  g.players.forEach((p,i)=>assert.equal(p.res.wood,before[i]+1));
  g.bank.wood=1;const after=g.players.map(p=>p.res.wood);produce(g,6);
  assert.deepEqual(g.players.map(p=>p.res.wood),after);
  g.players[1].settlements=[];g.players[0].cities=g.players[0].settlements;g.players[0].settlements=[];
  produce(g,6);assert.equal(g.bank.wood,0);assert.equal(g.players[0].res.wood,after[0]+1);
});

test('抢牌日志不向旁观者公开资源种类', () => {
  const g=game(2);setup(g);g.needMoveRobber=true;
  const h=g.map.hexes.find(h=>h.id!==g.map.robber);
  g.players[1].settlements=[g.map.vertices.find(v=>v.hexes.includes(h.id)).id];
  g.players[1].res=Object.fromEntries(RES.map(r=>[r,r==='ore'?1:0]));
  assert.equal(playerAct(g,g.players[0].id,{type:'moveRobber',hex:h.id}),null);
  assert.equal(serialize(g,null).log.at(-1).text,'抢走了 P1 的 1 张资源卡');
});

test('只能在自己的回合获胜，结算向所有玩家展示真实分数', () => {
  const g=game(2);setup(g);g.settings.targetVP=3;g.rolled=true;
  g.players[1].dev.vp=1;
  assert.equal(playerAct(g,g.players[0].id,{type:'bankTrade',give:'wood',want:'ore'}),'需要 4 张木材（当前比例 4:1）');
  assert.equal(g.winner,null);
  assert.equal(playerAct(g,g.players[0].id,{type:'endTurn'}),null);
  assert.equal(g.winner,1);
  assert.equal(serialize(g,g.players[0].id).players[1].vp,3);
});

test('掷骰前打筑路工，机器人先完成免费道路再掷骰', () => {
  const g=game(2);setup(g);g.players[0].dev.road=1;
  assert.equal(playerAct(g,g.players[0].id,{type:'playRoad'}),null);
  for(let i=0;i<2;i++){
    const s=serialize(g,g.players[0].id),action=ruleBotAction(s);
    assert.equal(action.type,'buildRoad');assert.equal(isUsefulAIAction(s,action),true);
    assert.equal(playerAct(g,g.players[0].id,action),null);
  }
  assert.equal(g.roadBuildLeft,0);assert.equal(ruleBotAction(serialize(g,g.players[0].id)).type,'roll');
});

test('规则 Bot 建路优先选择高产出或可扩张的道路', () => {
  const g = game(2); setup(g); const p = g.players[0];
  g.rolled = true; p.res.wood = 3; p.res.brick = 3;
  const state = serialize(g, p.id);
  const first = ruleBotAction(state), second = ruleBotAction(state);
  assert.equal(first.type, 'buildRoad');
  assert.deepEqual(first, second);
  assert.ok(state.legal.road.includes(first.edge));
});

test('规则 Bot 银行交易优先完成城市，并尊重专属港口比例', () => {
  const state = { rolled: true, bank: Object.fromEntries(RES.map(r => [r, 10])) };
  const me = {
    res: { wood: 4, brick: 0, sheep: 0, wheat: 2, ore: 2 },
    ports: { wood: 4, brick: 4, sheep: 4, wheat: 4, ore: 4 },
  };
  assert.deepEqual(usefulBankTrade(state, me), { type: 'bankTrade', give: 'wood', want: 'ore' });

  me.ports.wood = 2;
  me.res.wood = 2;
  assert.deepEqual(usefulBankTrade(state, me), { type: 'bankTrade', give: 'wood', want: 'ore' });
});

test('规则 Bot 银行交易在目标资源耗尽时保持谨慎', () => {
  const state = { rolled: true, bank: Object.fromEntries(RES.map(r => [r, 10])) };
  state.bank.ore = 0;
  const me = {
    res: { wood: 4, brick: 1, sheep: 1, wheat: 1, ore: 2 },
    ports: Object.fromEntries(RES.map(r => [r, 4])),
  };
  assert.equal(usefulBankTrade(state, me), null);
});

test('规则 Bot 高库存时用富余资源逐步补齐目标，低库存不盲目兑换', () => {
  const state = { rolled: true, bank: { wood: 10, brick: 0, sheep: 10, wheat: 10, ore: 10 } };
  const me = { res: { wood: 8, brick: 0, sheep: 0, wheat: 0, ore: 0 }, total: 8 };
  const action = usefulBankTrade(state, me);
  assert.equal(action.type, 'bankTrade');
  assert.equal(action.give, 'wood');
  assert.ok(['wheat', 'ore'].includes(action.want));
  me.res[action.give] -= 4;
  me.res[action.want]++;
  me.total -= 3;
  assert.equal(me.total, 5);
  assert.equal(usefulBankTrade(state, me), null);
  state.bank.wheat = state.bank.ore = state.bank.sheep = 0;
  me.res = { wood: 8, brick: 0, sheep: 0, wheat: 0, ore: 0 };
  me.total = 8;
  assert.equal(usefulBankTrade(state, me), null);
});

test('规则 Bot 丰收之年优先补齐城市所需资源', () => {
  const state = { rolled: true, bank: Object.fromEntries(RES.map(r => [r, 10])) };
  const me = { res: { wood: 0, brick: 0, sheep: 0, wheat: 1, ore: 2 } };
  assert.deepEqual(usefulYearAction(state, me), { type: 'playYear', r1: 'wheat', r2: 'ore' });
});

test('规则 Bot 丰收之年在银行无法提供两张资源时不误触发', () => {
  const state = { rolled: true, bank: { wood: 1, brick: 0, sheep: 0, wheat: 0, ore: 0 } };
  const me = { res: { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 } };
  assert.equal(usefulYearAction(state, me), null);
});

test('免费道路无法继续连接时立即结束筑路，UI 不会卡在剩余一次', () => {
  const g=game(2);setup(g);const p=g.players[0];
  g.players.forEach(q=>{q.roads=[];q.settlements=[];q.cities=[];});
  const start=g.map.vertices.find(v=>g.map.vAdj.get(v.id).size===2);
  const next=g.map.edges.find(e=>e.a===start.id||e.b===start.id);
  p.settlements=[start.id];
  const end=next.a===start.id?next.b:next.a;
  for(const e of g.map.edges)if(e!==next&&(e.a===start.id||e.b===start.id))g.players[1].roads.push(e.id);
  g.players[1].settlements=[end];
  p.dev.road=1;
  assert.equal(playerAct(g,p.id,{type:'playRoad'}),null);
  assert.equal(playerAct(g,p.id,{type:'buildRoad',edge:next.id}),null);
  assert.equal(g.roadBuildLeft,0);
});

test('观察者不会收到可移动强盗状态，所有人仍可看到待办事件', () => {
  const g=game(3);setup(g);g.needMoveRobber=true;
  assert.equal(serialize(g,g.players[0].id).needMoveRobber,true);
  assert.equal(serialize(g,g.players[1].id).needMoveRobber,false);
  assert.equal(serialize(g,null).robberPending,true);
});

test('最长路被截短后，两位对手并列最长时旧持有者失去加分', async () => {
  const {updateLongest}=await import('../game/engine.js');
  const g=game(3),used=new Set();
  function pathFrom(v,vertices,edges){
    if(edges.length===7)return {vertices,edges};
    for(const e of g.map.edges){
      const next=e.a===v?e.b:e.b===v?e.a:null;
      if(!next||used.has(next)||vertices.includes(next))continue;
      const found=pathFrom(next,[...vertices,next],[...edges,e.id]);if(found)return found;
    }
  }
  const routes=[];
  for(let i=0;i<3;i++){
    const route=g.map.vertices.filter(v=>!used.has(v.id)).map(v=>pathFrom(v.id,[v.id],[])).find(Boolean);
    assert.ok(route);route.vertices.forEach(v=>used.add(v));routes.push(route.edges);
  }
  g.players[0].roads=routes[0].slice(0,5);g.players[1].roads=routes[1].slice(0,6);g.players[2].roads=routes[2].slice(0,6);
  g.longest={holder:0,len:7};updateLongest(g);assert.equal(g.longest.holder,null);
  g.longest={holder:1,len:6};updateLongest(g);assert.equal(g.longest.holder,1);
  g.players[2].roads=routes[2];updateLongest(g);assert.equal(g.longest.holder,2);
});

import { RES, BANK_SIZE } from './game/engine.js';

const pick = (items) => items[Math.floor(Math.random() * items.length)];
export const canAffordBundle = (res, bundle) => !!res && !!bundle && RES.every(r => res[r] >= (bundle[r] || 0));
const bundleTotal = bundle => RES.reduce((n, r) => n + (bundle?.[r] || 0), 0);
const weight = (n) => 6 - Math.abs(7 - n);
const COSTS = [
  { wood: 1, brick: 1, sheep: 1, wheat: 1 },
  { wheat: 2, ore: 3 },
  { wood: 1, brick: 1 },
  { sheep: 1, wheat: 1, ore: 1 }
];
const MAX_AI_RESPONSE_BYTES = 128 * 1024;
function bestVertex(state, ids) {
  const byId = Object.fromEntries(state.map.vertices.map(v => [v.id, v]));
  const hex = Object.fromEntries(state.map.hexes.map(h => [h.id, h]));
  const score = id => {
    const v = byId[id];
    const resources = (v?.hexes || []).map(hid => hex[hid]).filter(h => h?.number);
    return resources.reduce((sum, h) => sum + weight(h.number), 0) + new Set(resources.map(h => h.resource)).size * 1.5 + (v?.port ? 2 : 0);
  };
  return [...ids].sort((a, b) => score(b) - score(a) || String(a).localeCompare(String(b)))[0];
}

function bestRoad(state, ids) {
  const vertices = Object.fromEntries(state.map.vertices.map(v => [v.id, v]));
  const edges = Object.fromEntries(state.map.edges.map(e => [e.id, e]));
  const occupied = new Map();
  for (const player of state.players) {
    for (const id of player.settleVerts || []) occupied.set(id, player.id === state.viewer ? 'mine' : 'opponent');
    for (const id of player.cityVerts || []) occupied.set(id, player.id === state.viewer ? 'mine' : 'opponent');
  }
  const settlementChoices = new Set(state.legal?.settlement || []);
  const hexes = Object.fromEntries(state.map.hexes.map(h => [h.id, h]));
  const vertexScore = id => {
    const vertex = vertices[id];
    const tiles = (vertex?.hexes || []).map(hid => hexes[hid]).filter(h => h?.number);
    const production = tiles.reduce((sum, h) => sum + weight(h.number), 0);
    const diversity = new Set(tiles.map(h => h.resource)).size * 1.5;
    return production + diversity + (vertex?.port ? 2 : 0) + (settlementChoices.has(id) ? 6 : 0)
      + (occupied.get(id) === 'mine' ? 1 : 0) - (occupied.get(id) === 'opponent' ? 6 : 0);
  };
  return [...ids].sort((a, b) => {
    const ea = edges[a], eb = edges[b];
    const score = edge => vertexScore(edge.a) + vertexScore(edge.b);
    return score(eb) - score(ea) || String(a).localeCompare(String(b));
  })[0];
}
function usefulBankTrade(state, me) {
  if (!state.rolled) return null;
  for (const cost of COSTS) {
    const missing = RES.filter(r => (me.res[r] || 0) < (cost[r] || 0));
    if (missing.length !== 1) continue;
    const want = missing[0];
    if (state.bank?.[want] < 1) continue;
    const give = RES.find(r => r !== want && me.res[r] - (cost[r] || 0) >= (me.ports?.[r] || 4));
    if (give) return { type: 'bankTrade', give, want };
  }
  return null;
}

function discardAction(state, me) {
  const need = Math.floor(me.total / 2);
  const left = { ...(me.res || {}) };
  const order = [...RES].sort((a, b) => (left[b] || 0) - (left[a] || 0));
  const out = Object.fromEntries(RES.map((r) => [r, 0]));
  let remaining = need;
  for (const r of order) {
    const n = Math.min(left[r] || 0, remaining);
    out[r] = n;
    remaining -= n;
    if (!remaining) break;
  }
  return { type: 'discard', res: out };
}

function chooseRobber(state) {
  const candidates = [];
  const me = state.players[state.viewer];
  for (const h of state.map.hexes) {
    if (h.id === state.map.robber) continue;
    const probability = [6, 8].includes(h.number) ? 4 : [5, 9].includes(h.number) ? 3 : 1;
    for (let i = 0; i < state.players.length; i++) {
      const p = state.players[i];
      if (i === state.viewer || p.total <= 0) continue;
      const touches = state.map.vertices.some((v) => v.hexes?.includes(h.id) &&
        (p.settleVerts?.includes(v.id) || p.cityVerts?.includes(v.id)));
      if (touches) {
        const mine = state.map.vertices.some(v => v.hexes?.includes(h.id) &&
          (me.settleVerts?.includes(v.id) || me.cityVerts?.includes(v.id)));
        candidates.push({ id: h.id, score: probability + p.vp * 2 + p.total / 10 - (mine ? 8 : 0) });
      }
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  if (candidates.length) return { type: 'moveRobber', hex: candidates[0].id };
  const options = state.map.hexes.filter((h) => h.id !== state.map.robber);
  return options.length ? { type: 'moveRobber', hex: pick(options).id } : null;
}

export function ruleBotAction(state) {
  const me = state.players[state.viewer];
  if (!me) return null;
  if (me.needDiscard) return discardAction(state, me);
  if (state.offer && !state.eventPending && state.offer.targets?.includes(state.viewer))
    return { type: canAffordBundle(me.res, state.offer.want) && bundleTotal(state.offer.give) >= bundleTotal(state.offer.want) ? 'acceptOffer' : 'rejectOffer' };
  if (state.stealFrom?.length) {
    const target = [...state.stealFrom].sort((a, b) => (state.players[b]?.vp || 0) - (state.players[a]?.vp || 0))[0];
    return { type: 'steal', from: target };
  }
  if (state.needMoveRobber && state.viewer === state.current) return chooseRobber(state);
  if (state.phase === 'setup') {
    if (state.legal?.setupPlayer !== state.viewer || !state.legal.setup?.length) return null;
    return state.legal.kind === 'settlement'
      ? { type: 'placeSettlement', vertex: bestVertex(state, state.legal.setup) }
      : { type: 'placeRoad', edge: bestRoad(state, state.legal.setup) };
  }
  if (state.viewer !== state.current) return null;
  const legal = state.legal || {};
  const cards = state.cards || {};
  if (state.eventPending) return null;
  if (state.offer?.from === state.viewer) return null;
  if (state.roadBuildLeft && legal.road?.length) return { type: 'buildRoad', edge: bestRoad(state, legal.road) };
  if (!state.rolled) return { type: 'roll' };
  if (legal.city?.length) return { type: 'buildCity', vertex: bestVertex(state, legal.city) };
  if (legal.settlement?.length) return { type: 'buildSettlement', vertex: bestVertex(state, legal.settlement) };
  if (!state.devPlayed && cards.year > (cards.fresh || []).filter(t => t === 'year').length) {
    const want = RES.slice().sort((a, b) => (me.res[a] || 0) - (me.res[b] || 0)).filter(r => state.bank?.[r] > 0);
    if (want.length && (state.bank[want[0]] > 1 || want.length > 1)) return { type: 'playYear', r1: want[0], r2: state.bank[want[0]] > 1 ? want[0] : want[1] };
  }
  if (!state.devPlayed && cards.mono > (cards.fresh || []).filter(t => t === 'mono').length) {
    const res = RES.slice().sort((a, b) => (state.bank?.[a] ?? BANK_SIZE) - (state.bank?.[b] ?? BANK_SIZE))[0];
    if ((state.bank?.[res] ?? BANK_SIZE) < BANK_SIZE - 4) return { type: 'playMono', res };
  }
  if (!state.devPlayed && cards.knight > (cards.fresh || []).filter(t => t === 'knight').length) return { type: 'playKnight' };
  if (!state.devPlayed && cards.road > (cards.fresh || []).filter(t => t === 'road').length && legal.canPlayRoad) return { type: 'playRoad' };
  const trade = usefulBankTrade(state, me); if (trade) return trade;
  if (legal.road?.length && me.roads < 15 && me.settlements + me.cities < 5) return { type: 'buildRoad', edge: bestRoad(state, legal.road) };
  if (legal.dev) return { type: 'buyDev' };
  return { type: 'endTurn' };
}

export function normalizeAIAction(value) {
  let action = value;
  if (typeof value === 'string') {
    const clean = value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try { action = JSON.parse(clean); } catch { return null; }
  }
  if (action?.action && typeof action.action === 'object') action = action.action;
  if (!action || typeof action !== 'object' || typeof action.type !== 'string') return null;
  const allowed = new Set([
    'placeSettlement', 'placeRoad', 'roll', 'buildRoad', 'buildSettlement', 'buildCity',
    'buyDev', 'playKnight', 'playYear', 'playMono', 'playRoad', 'bankTrade',
    'offerTrade', 'acceptOffer', 'rejectOffer', 'cancelOffer', 'discard', 'moveRobber', 'steal', 'endTurn'
  ]);
  return allowed.has(action.type) ? action : null;
}

export function isUsefulAIAction(state, action) {
  if (!action) return false;
  const me = state.players[state.viewer];
  if (me?.needDiscard) return action.type === 'discard';
  if (state.phase === 'setup') return state.legal?.setupPlayer === state.viewer &&
    (action.type === 'placeSettlement' && state.legal.kind === 'settlement' && state.legal.setup.includes(action.vertex) ||
     action.type === 'placeRoad' && state.legal.kind === 'road' && state.legal.setup.includes(action.edge));
  if (state.stealFrom?.length) return action.type === 'steal' && state.stealFrom.includes(action.from);
  if (state.needMoveRobber) return action.type === 'moveRobber' && state.map.hexes.some(h => h.id === action.hex && h.id !== state.map.robber);
  if (state.offer && !state.eventPending && state.offer.targets?.includes(state.viewer) && ['acceptOffer', 'rejectOffer'].includes(action.type))
    return action.type === 'rejectOffer' || canAffordBundle(me.res, state.offer.want);
  if (state.viewer !== state.current || state.phase !== 'play') return false;
  if (state.eventPending) return false;
  if (state.offer?.from === state.viewer) return action.type === 'cancelOffer';
  if (state.roadBuildLeft) return action.type === 'buildRoad' && !!state.legal?.road?.includes(action.edge);
  if (!state.rolled) return ['roll', 'playKnight', 'playYear', 'playMono', 'playRoad'].includes(action.type);
  if (action.type === 'buildRoad') return state.legal?.road?.includes(action.edge);
  if (action.type === 'buildSettlement') return state.legal?.settlement?.includes(action.vertex);
  if (action.type === 'buildCity') return state.legal?.city?.includes(action.vertex);
  if (action.type === 'buyDev') return !!state.legal?.dev;
  if (action.type === 'cancelOffer') return state.offer?.from === state.viewer;
  return ['roll', 'playKnight', 'playYear', 'playMono', 'playRoad', 'bankTrade', 'offerTrade', 'endTurn'].includes(action.type);
}

export function compactStateForAI(state, detail = 'compact') {
  const hexes = Object.fromEntries(state.map.hexes.map(h => [h.id, h]));
  const vertices = Object.fromEntries(state.map.vertices.map(v => [v.id, v]));
  const edges = Object.fromEntries(state.map.edges.map(e => [e.id, e]));
  const kind = state.legal?.kind;
  const settlementIds = kind === 'settlement' ? state.legal.setup : state.legal?.settlement || [];
  const describeVertex = id => {
    const v = vertices[id];
    const tiles = (v?.hexes || []).map(hid => hexes[hid]).filter(Boolean);
    return { id, tiles: tiles.map(h => `${h.resource}:${h.number || '-'}`), port: v?.port || null,
      score: tiles.reduce((n, h) => n + (h.number ? weight(h.number) : 0), 0) };
  };
  const limit = detail === 'rich' ? 8 : 3;
  const setupLimit = detail === 'rich' ? 24 : 12;
  const roadLimit = detail === 'rich' ? 24 : 10;
  const spots = settlementIds.map(describeVertex).sort((a, b) => b.score - a.score).slice(0, limit);
  const setup = kind === 'settlement' ? spots.map(v => v.id) : (state.legal?.setup || []).slice(0, setupLimit);
  const roadIds = kind === 'road' ? setup : (state.legal?.road || []).slice(0, roadLimit);
  const me = state.players[state.viewer];
  const roads = roadIds.map(id => ({ id, a: edges[id]?.a, b: edges[id]?.b }));
  const roadScores = roads.map(road => {
    const endpointScore = id => {
      const vertex = vertices[id];
      const tiles = (vertex?.hexes || []).map(hid => hexes[hid]).filter(h => h?.number);
      return tiles.reduce((sum, h) => sum + weight(h.number), 0) + (vertex?.port ? 2 : 0)
        + (settlementIds.includes(id) ? 6 : 0);
    };
    return { id: road.id, score: endpointScore(road.a) + endpointScore(road.b) };
  }).sort((a, b) => b.score - a.score).slice(0, detail === 'rich' ? 12 : 5);
  if (me?.needDiscard) return { needDiscard: Math.floor(me.total / 2), resources: me.res };
  if (state.phase === 'setup') return { phase: 'setup', kind,
    choices: kind === 'settlement' ? { settlement: spots } : { road: roads } };
  if (state.needMoveRobber) return { robberNow: state.map.robber,
    choices: { robber: state.map.hexes.filter(h => h.id !== state.map.robber)
      .map(h => ({ id: h.id, resource: h.resource, number: h.number })) } };
  if (state.stealFrom?.length) return { stealFrom: state.stealFrom,
    opponents: state.players.map((p, id) => ({ id, vp: p.vp, cards: p.total })) };
  if (!state.rolled && !state.offer && !state.roadBuildLeft) return { rolled: false };
  return {
    rolled: state.rolled, devPlayed: state.devPlayed, freeRoads: state.roadBuildLeft,
    me: { res: me?.res, vp: me?.vp, ports: me?.ports },
    opponents: state.players.map((p, i) => ({ id: i, vp: p.vp, cards: p.total })).filter(p => p.id !== state.viewer),
    bank: state.bank, offer: state.offer, canBuyDev: state.legal?.dev, cards: state.cards,
    goals: {
      targetVP: state.settings?.targetVP,
      vpGap: Math.max(0, (state.settings?.targetVP || 10) - (me?.vp || 0)),
      settlementCount: me?.settleVerts?.length || 0,
      cityCount: me?.cityVerts?.length || 0,
      roadCount: me?.roadEdges?.length || 0,
      strongestOpponent: Math.max(0, ...state.players.filter((_, i) => i !== state.viewer).map(p => p.vp || 0)),
    },
    choices: { settlement: spots, city: (state.legal?.city || []).map(describeVertex).slice(0, detail === 'rich' ? 16 : 8), road: roads, roadScores }
  };
}

export async function aiBotAction(state, config, fallback, onFallback = () => {}, strategy = {}) {
  if (!config?.baseUrl || !config?.model || !config?.apiKey) { onFallback('模型配置不完整'); return fallback; }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1000, Math.min(20000, Number(config.timeout) || 9000)));
  try {
    const endpoint = String(config.baseUrl).replace(/\/+$/, '') + '/chat/completions';
    let task;
    if (state.players[state.viewer]?.needDiscard) task = '弃掉自己资源的一半（向下取整）。只返回 JSON，例如 {"type":"discard","res":{"wood":1,"brick":0,"sheep":0,"wheat":0,"ore":0}}。';
    else if (state.phase === 'setup') task = state.legal?.kind === 'settlement'
      ? '从 choices.settlement 选一个初始定居点；不确定就用建议动作。只返回 JSON，例如 {"type":"placeSettlement","vertex":"v1"}。'
      : '卡坦岛初始道路。从 choices.road 中选一条合法道路。只返回 JSON，例如 {"type":"placeRoad","edge":"e1"}。';
    else if (state.needMoveRobber) task = '从 choices.robber 中选一块不是当前位置的地块移动强盗。只返回 JSON，例如 {"type":"moveRobber","hex":"h1"}。';
    else if (state.stealFrom?.length) task = '从 stealFrom 中选一位玩家抢牌。只返回 JSON，例如 {"type":"steal","from":1}。';
    else if (state.offer && state.offer.targets?.includes(state.viewer) && !state.eventPending) task = '现在必须响应收到的交易：愿意且付得起返回 {"type":"acceptOffer"}，否则返回 {"type":"rejectOffer"}。只返回一个 JSON 动作。';
    else if (state.roadBuildLeft) task = '先完成筑路工：从 choices.road 中选择一条免费道路。只返回 JSON，例如 {"type":"buildRoad","edge":"e1"}。';
    else if (!state.rolled) task = '现在应先掷骰。只返回 JSON：{"type":"roll"}。';
    else task = '卡坦岛当前回合。从 choices 中选合法位置，可建造、银行交易、买发展卡或结束回合。只返回一个 JSON 动作；不确定时返回建议动作。';
    const prompt = `${task}\n建议动作：${JSON.stringify(fallback)}\n状态：${JSON.stringify(compactStateForAI(state, strategy.stateDetail || 'compact'))}`;
    const request = async (messages, temperature) => fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        temperature: temperature ?? strategy.temperature ?? 0.7,
        top_p: 0.8,
        max_tokens: 512,
        enable_thinking: false,
        chat_template_kwargs: { enable_thinking: false },
        messages,
      })
    });
    const response = await request([{ role: 'user', content: prompt }], strategy.temperature);
    if (!response.ok) { onFallback(`模型服务返回 ${response.status}`); return fallback; }
    const readJson = async responseValue => {
      const length = Number(responseValue.headers?.get?.('content-length'));
      if (Number.isFinite(length) && length > MAX_AI_RESPONSE_BYTES) throw new Error('模型响应过大');
      if (typeof responseValue.text !== 'function') return responseValue.json();
      const text = await responseValue.text();
      if (new TextEncoder().encode(text).byteLength > MAX_AI_RESPONSE_BYTES) throw new Error('模型响应过大');
      return JSON.parse(text);
    };
    const data = await readJson(response);
    const content = data?.choices?.[0]?.message?.content;
    let action = normalizeAIAction(content);
    if (strategy.review && action && isUsefulAIAction(state, action)) {
      const reviewPrompt = `复核候选动作是否适合当前卡坦岛局面。若合法且合理，原样返回；否则从状态中的合法选择中改正。只返回一个 JSON 动作。候选动作：${JSON.stringify(action)}\n状态：${JSON.stringify(compactStateForAI(state, strategy.stateDetail || 'rich'))}`;
      const reviewResponse = await request([{ role: 'user', content: reviewPrompt }], Math.min(0.2, strategy.temperature ?? 0.2));
      if (!reviewResponse.ok) { onFallback(`模型复核服务返回 ${reviewResponse.status}`); return fallback; }
      const reviewData = await readJson(reviewResponse);
      action = normalizeAIAction(reviewData?.choices?.[0]?.message?.content);
    }
    if (isUsefulAIAction(state, action)) return action;
    onFallback('模型返回了当前阶段无效的操作');
    return fallback;
  } catch {
    onFallback(controller.signal.aborted ? '模型响应超时' : '模型请求失败');
    return fallback;
  } finally {
    clearTimeout(timeout);
  }
}

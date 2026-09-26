import { RES, COST, BANK_SIZE } from '../game/engine.js';
import { rankRoadChoices } from './road-planner.js';

const pips = number => number ? 6 - Math.abs(7 - number) : 0;
const total = bundle => RES.reduce((sum, r) => sum + (bundle?.[r] || 0), 0);
const missingFor = (hand, cost) => Object.fromEntries(RES.map(r => [r, Math.max(0, (cost[r] || 0) - (hand[r] || 0))]));
const validBundle = bundle => bundle && typeof bundle === 'object' && !Array.isArray(bundle) &&
  Object.keys(bundle).every(r => RES.includes(r)) &&
  RES.every(r => Number.isInteger(bundle[r] ?? 0) && (bundle[r] ?? 0) >= 0 && (bundle[r] ?? 0) <= BANK_SIZE);
const limitOf = value => Number.isInteger(value) ? Math.max(1, Math.min(8, value)) : 5;

export const AGENT_TOOLS = Object.freeze({
  inspectBuilds: '比较当前合法的定居点、城市或道路位置；参数 {"kind":"settlement|city|road","limit":5}',
  inspectResources: '查看一种建造目标的资源缺口和可用银行兑换；参数 {"goal":"road|settlement|city|dev"}',
  evaluateTrade: '试算交易对自己的影响；参数 {"mode":"bank|player|offer","give":...,"want":...}。player 中 give 是自己支付，want 是自己收到；offer 自动试算收到的当前报价，无需 give/want。',
  inspectRobber: '按公开建筑产出和分数比较强盗落点；参数 {"limit":5}',
  inspectHistory: '查看最近已执行的公开动作，了解交易、扩张和强盗走向；参数 {"limit":8,"actor":玩家编号可选}',
});

export function runAgentTool(state, name, args = {}) {
  if (!Object.hasOwn(AGENT_TOOLS, name) || !args || typeof args !== 'object' || Array.isArray(args))
    return { ok: false, error: '未知工具或参数无效' };
  const me = state.players[state.viewer];
  if (!me) return { ok: false, error: '没有当前玩家视图' };
  const canTradeNow = state.phase === 'play' && state.viewer === state.current && state.rolled &&
    !state.eventPending && !state.offer && !state.roadBuildLeft && !state.needMoveRobber &&
    !state.stealFrom?.length && !me.needDiscard;
  if (name === 'inspectHistory') {
    if (args.actor !== undefined && (!Number.isInteger(args.actor) || args.actor < 0 || args.actor >= state.players.length))
      return { ok: false, error: '玩家编号无效' };
    const events = (state.history || []).filter(e => args.actor === undefined || e.actor === args.actor);
    return { ok: true, events: events.slice(-Math.max(1, Math.min(12, Number.isInteger(args.limit) ? args.limit : 8))) };
  }
  if (name === 'inspectBuilds') {
    const kind = args.kind;
    if (!['settlement', 'city', 'road'].includes(kind)) return { ok: false, error: '建造类型无效' };
    const ids = state.phase === 'setup' && state.legal?.kind === kind ? state.legal.setup : state.legal?.[kind] || [];
    if (kind === 'road') return { ok: true, kind, totalChoices: ids.length,
      candidates: rankRoadChoices(state, ids).slice(0, limitOf(args.limit)) };
    const vertices = Object.fromEntries(state.map.vertices.map(v => [v.id, v]));
    const hexes = Object.fromEntries(state.map.hexes.map(h => [h.id, h]));
    const vertexInfo = id => {
      const v = vertices[id];
      const tiles = (v?.hexes || []).map(hid => hexes[hid]).filter(h => h?.number);
      return { id, production: tiles.reduce((sum, h) => sum + pips(h.number), 0),
        resources: [...new Set(tiles.map(h => h.resource))], port: v?.port || null };
    };
    const candidates = ids.map(vertexInfo).sort((a, b) => b.production - a.production || b.resources.length - a.resources.length || String(a.id).localeCompare(String(b.id)));
    return { ok: true, kind, totalChoices: ids.length, candidates: candidates.slice(0, limitOf(args.limit)) };
  }
  if (name === 'inspectResources') {
    const cost = COST[args.goal];
    if (!cost) return { ok: false, error: '建造目标无效' };
    const missing = missingFor(me.res, cost);
    const bankTrades = [];
    for (const want of RES) if (missing[want] > 0 && (state.bank?.[want] || 0) > 0) {
      for (const give of RES) {
        const rate = me.ports?.[give] || 4;
        if (give !== want && me.res[give] >= rate) bankTrades.push({ give, want, rate });
      }
    }
    return { ok: true, goal: args.goal, cost, missing, affordable: total(missing) === 0,
      bankTradesAvailableNow: canTradeNow, bankTrades: bankTrades.slice(0, 10) };
  }
  if (name === 'evaluateTrade') {
    const { mode } = args;
    const incoming = mode === 'offer' && state.offer?.targets?.includes(state.viewer);
    const give = incoming ? state.offer.want : args.give;
    const want = incoming ? state.offer.give : args.want;
    if (mode === 'offer' && !incoming) return { ok: false, error: '没有发给自己的当前报价' };
    let after;
    if (mode === 'bank' && RES.includes(give) && RES.includes(want) && give !== want) {
      const rate = me.ports?.[give] || 4;
      if (me.res[give] < rate || (state.bank?.[want] || 0) < 1) return { ok: true, possibleForMe: false, reason: '资源或银行库存不足' };
      after = { ...me.res, [give]: me.res[give] - rate, [want]: me.res[want] + 1 };
    } else if (['player', 'offer'].includes(mode) && validBundle(give) && validBundle(want) && total(give) && total(want) &&
      RES.some(r => (give[r] || 0) !== (want[r] || 0))) {
      if (RES.some(r => me.res[r] < (give[r] || 0))) return { ok: true, possibleForMe: false, reason: '自己给不出报价' };
      after = Object.fromEntries(RES.map(r => [r, me.res[r] - (give[r] || 0) + (want[r] || 0)]));
    } else return { ok: false, error: '交易参数无效' };
    const goals = Object.fromEntries(Object.entries(COST).map(([goal, cost]) => [goal, {
      missingBefore: total(missingFor(me.res, cost)), missingAfter: total(missingFor(after, cost)),
    }]));
    return { ok: true, possibleForMe: true, actionAvailableNow: incoming ? !state.eventPending && !me.needDiscard : canTradeNow,
      after, goals, perspective: '自己的支付与收入',
      handRisk: { before: total(me.res), after: total(after), exposedToDiscard: total(after) > 7 },
      opponentAcceptance: mode === 'player' ? '未知' : undefined };
  }
  if (!state.needMoveRobber) return { ok: false, error: '当前无需移动强盗' };
  const candidates = state.map.hexes.filter(h => h.id !== state.map.robber).map(h => {
    const nearby = state.map.vertices.filter(v => v.hexes?.includes(h.id));
    const affected = state.players.map((p, i) => ({ id: i, vp: p.vp, cards: p.total,
      production: nearby.reduce((n, v) => n + (p.settleVerts?.includes(v.id) ? 1 : p.cityVerts?.includes(v.id) ? 2 : 0), 0),
    })).filter(p => p.production);
    const own = affected.find(p => p.id === state.viewer)?.production || 0;
    const opponents = affected.filter(p => p.id !== state.viewer);
    const score = pips(h.number) * (opponents.reduce((n, p) => n + p.production * (1 + p.vp / 10), 0) - own * 2);
    return { id: h.id, resource: h.resource, number: h.number, ownProduction: own, opponents, score: Math.round(score * 10) / 10 };
  }).sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));
  return { ok: true, candidates: candidates.slice(0, limitOf(args.limit)) };
}

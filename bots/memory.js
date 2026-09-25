import { RES } from '../game/engine.js';

const GOALS = new Set(['road', 'settlement', 'city', 'development', 'longestRoad', 'army', 'trade']);

export function freshBotMemory(state) {
  return { gameId: state.id, playerId: state.players[state.viewer]?.id, plan: null };
}

function validTarget(state, goal, target) {
  if (typeof target !== 'string' || target.length > 12) return null;
  const me = state.players[state.viewer];
  if (goal === 'city') return me?.settleVerts?.includes(target) ? target : null;
  if (goal === 'road') return state.map.edges.some(e => e.id === target && !e.owner) ? target : null;
  if (goal === 'settlement') return state.map.vertices.some(v => v.id === target) &&
    state.players.every(p => !p.settleVerts?.includes(target) && !p.cityVerts?.includes(target)) ? target : null;
  return null;
}

export function normalizeBotPlan(value, state) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !GOALS.has(value.goal)) return null;
  const target = validTarget(state, value.goal, value.target);
  const resource = RES.includes(value.resource) ? value.resource : null;
  // turn advances for every player; keep a plan for roughly three of this bot's turns.
  return { goal: value.goal, target, resource, sinceTurn: state.turn,
    expiresTurn: state.turn + Math.max(2, state.players.length) * 3 };
}

export function reconcileBotMemory(memory, state) {
  if (memory?.gameId !== state.id || memory?.playerId !== state.players[state.viewer]?.id)
    return freshBotMemory(state);
  const plan = memory.plan;
  if (!plan || state.turn > plan.expiresTurn) return { ...memory, plan: null };
  if (plan.target && !validTarget(state, plan.goal, plan.target)) return { ...memory, plan: null };
  return memory;
}

export function botMemoryContext(state, memory, eventLimit = 6) {
  const current = reconcileBotMemory(memory, state);
  const limit = Math.max(0, Math.min(16, Number.isInteger(eventLimit) ? eventLimit : 6));
  const recentEvents = (state.history || []).filter(e => e.type !== 'endTurn').slice(-limit);
  return { turn: state.turn, self: state.viewer, recentEvents, plan: current.plan };
}

export function rememberBotDecision(memory, before, after, decision) {
  const current = reconcileBotMemory(memory, before);
  const proposed = normalizeBotPlan(decision?.plan, before);
  return reconcileBotMemory({ ...current, plan: proposed || current.plan }, after);
}

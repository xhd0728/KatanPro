import test from 'node:test';
import assert from 'node:assert/strict';
import { compactStateForAI, isUsefulAIAction, ruleBotAction } from '../bot.js';
import { rankRoadChoices } from '../bots/road-planner.js';
import { botMemoryContext, freshBotMemory, reflectBotMemory } from '../bots/memory.js';
import { formatBotCommentary } from '../bots/narration.js';
import { getBotProfile } from '../bots/profiles.js';

function forkState(phase = 'setup') {
  const vertices = [
    { id: 'A', hexes: [] }, { id: 'B', hexes: [] },
    { id: 'C', hexes: [] }, { id: 'D', hexes: [] },
    { id: 'E', hexes: ['h0'] },
  ];
  const edges = [
    { id: 'e0', a: 'A', b: 'B', owner: null },
    { id: 'e1', a: 'A', b: 'D', owner: null },
    { id: 'e2', a: 'B', b: 'C', owner: null },
    { id: 'e3', a: 'D', b: 'E', owner: null },
  ];
  const me = { id: 'me', res: { wood: 1, brick: 1, sheep: 0, wheat: 0, ore: 0 },
    ports: {}, vp: 1, total: 2, roads: 0, roadLength: 0, settlements: 1, cities: 0,
    settleVerts: ['A'], cityVerts: [], roadEdges: [] };
  const opponent = { id: 'other', vp: 1, total: 0, roadLength: 0,
    settleVerts: ['C'], cityVerts: [], roadEdges: [] };
  return { id: 'game', viewer: 0, current: 0, phase, turn: 1,
    rolled: phase === 'play', devPlayed: false, roadBuildLeft: 0,
    map: { hexes: [{ id: 'h0', resource: 'wheat', number: 8 }], vertices, edges, robber: 'h0' },
    players: [me, opponent], legal: phase === 'setup'
      ? { kind: 'road', setupPlayer: 0, setup: ['e0', 'e1'] }
      : { road: ['e0', 'e1'], settlement: [], city: [], dev: false },
    bank: { wood: 20, brick: 20, sheep: 20, wheat: 20, ore: 20 },
    cards: {}, settings: { targetVP: 10 }, longest: { holder: null, len: 0 }, history: [] };
}

test('开局路优先指向符合间隔规则的高产落点，模型也收到路线目标', () => {
  const state = forkState();
  const ranked = rankRoadChoices(state, state.legal.setup);
  assert.equal(ranked[0].id, 'e1');
  assert.equal(ranked[0].target, 'E');
  assert.equal(ranked[0].remainingRoads, 1);
  assert.equal(ranked[1].target, null, '对手建筑封住的分支没有可达落点');
  assert.deepEqual(ruleBotAction(state), { type: 'placeRoad', edge: 'e1' });
  assert.equal(isUsefulAIAction(state, { type: 'placeRoad', edge: 'e0' }), false);
  const choices = compactStateForAI(state).choices.road;
  assert.equal(choices[0].id, 'e1');
  assert.deepEqual(choices[0].targetTiles, ['wheat:8']);
  assert.match(formatBotCommentary({ action: { type: 'placeRoad', edge: 'e1' }, state }), /小麦 8 附近.*还需 1 段路/);
});

test('开局候选路先全部排名，再截取发送模型的数量', () => {
  const state = forkState();
  state.players[1].settleVerts = [];
  state.map.vertices = [{ id: 'A', hexes: [] }];
  state.map.edges = [];
  state.legal.setup = [];
  for (let i = 0; i < 14; i++) {
    state.map.vertices.push({ id: `B${i}`, hexes: [] },
      { id: `C${i}`, hexes: i === 13 ? ['h0'] : [] });
    state.map.edges.push({ id: `r${i}`, a: 'A', b: `B${i}`, owner: null },
      { id: `c${i}`, a: `B${i}`, b: `C${i}`, owner: null });
    state.legal.setup.push(`r${i}`);
  }
  assert.equal(ruleBotAction(state).edge, 'r13');
  assert.equal(compactStateForAI(state).choices.road[0].id, 'r13');
  assert.equal(compactStateForAI(state).choices.road.length, 10);
});

test('付费修路避开死路；已有可建落点时优先攒定居点资源', () => {
  const state = forkState('play');
  assert.deepEqual(ruleBotAction(state), { type: 'buildRoad', edge: 'e1' });
  assert.equal(isUsefulAIAction(state, { type: 'buildRoad', edge: 'e0' }), false);
  state.map.edges[1].owner = 'me'; state.map.edges[3].owner = 'me';
  state.players[0].roadEdges = ['e1', 'e3'];
  state.players[0].roads = 2; state.players[0].roadLength = 2;
  state.legal.road = ['e0'];
  assert.equal(rankRoadChoices(state, state.legal.road)[0].worthwhile, false);
  assert.deepEqual(ruleBotAction(state), { type: 'endTurn' });
  assert.equal(isUsefulAIAction(state, { type: 'buildRoad', edge: 'e0' }), false);
});

test('定居点棋子用尽时不再为假想的新定居点付费修路', () => {
  const state = forkState('play');
  state.players[0].settlements = 5;
  const choice = rankRoadChoices(state, state.legal.road)[0];
  assert.equal(choice.target, null);
  assert.equal(choice.worthwhile, false);
  assert.deepEqual(ruleBotAction(state), { type: 'endTurn' });
});

test('连续第五段道路可以争取最长路奖励', () => {
  const state = forkState('play');
  state.map.vertices = Array.from({ length: 6 }, (_, i) => ({ id: `v${i}`, hexes: [] }));
  state.map.edges = Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, a: `v${i}`, b: `v${i + 1}`,
    owner: i < 4 ? 'me' : null }));
  state.players[0].settleVerts = ['v0'];
  state.players[1].settleVerts = [];
  state.players[0].roadEdges = ['r0', 'r1', 'r2', 'r3'];
  state.players[0].roads = 4; state.players[0].roadLength = 4;
  state.legal.road = ['r4'];
  const choice = rankRoadChoices(state, state.legal.road)[0];
  assert.equal(choice.claimsLongest, true);
  assert.equal(choice.worthwhile, true);
  assert.deepEqual(ruleBotAction(state), { type: 'buildRoad', edge: 'r4' });
});

test('后台路线记忆只对同一玩家和未变更的公开局面生效', () => {
  const state = forkState();
  state.history = [{ seq: 7, actor: 0, type: 'placeSettlement', data: { vertex: 'A' } }];
  const memory = reflectBotMemory(freshBotMemory(state), state);
  assert.equal(botMemoryContext(state, memory).roadIntent.target, 'E');
  assert.equal(botMemoryContext(state, memory).roadIntent.nextEdge, 'e1');
  assert.equal(botMemoryContext({ ...state, history: [...state.history, { seq: 8, actor: 1, type: 'placeRoad', data: { edge: 'e2' } }] }, memory).roadIntent, null);
  assert.equal(botMemoryContext({ ...state, viewer: 1 }, memory).roadIntent, null);
  assert.equal(botMemoryContext({ ...state, id: 'new-game' }, memory).roadIntent, null);
});

test('模型提出死路后收到具体修正反馈，再选择可扩张路线', async () => {
  const state = forkState(), fallback = ruleBotAction(state);
  const originalFetch = globalThis.fetch, requests = [];
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    const action = requests.length === 1 ? { type: 'placeRoad', edge: 'e0' } : fallback;
    return { ok: true, async json() { return { choices: [{ message: { content: JSON.stringify(action) } }] }; } };
  };
  try {
    const actual = await getBotProfile('high').decide({ state, fallback,
      config: { baseUrl: 'http://road-repair/v1', model: 'mock', apiKey: 'x' } });
    assert.deepEqual(actual, fallback);
    assert.equal(requests.length, 2);
    assert.match(requests[1].messages.at(-1).content, /道路可能是死路/);
    assert.match(requests[0].messages[0].content, /最长连续道路至少5段/);
  } finally { globalThis.fetch = originalFetch; }
});

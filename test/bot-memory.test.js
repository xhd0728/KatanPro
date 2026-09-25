import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, playerAct, serialize } from '../game/engine.js';
import { ruleBotAction } from '../bot.js';
import { getBotProfile } from '../bots/profiles.js';
import { botMemoryContext, freshBotMemory, normalizeBotPlan, reconcileBotMemory, rememberBotDecision } from '../bots/memory.js';
import { nextBot } from '../game/bot-scheduling.js';

function game() {
  return createGame({ mapSize: 'small', targetVP: 10, startBonus: 'none', playerNames: ['AI A', 'AI B'] });
}

test('公开事件记录成功动作，但不记录弃牌组成、被偷资源或新购发展卡种类', () => {
  const g = game();
  while (g.phase === 'setup') {
    const i = g.setupSteps[g.setupStep].p, p = g.players[i];
    assert.equal(playerAct(g, p.id, ruleBotAction(serialize(g, p.id))), null);
  }
  const p = g.players[g.current];
  p.res = { wood: 8, brick: 0, sheep: 0, wheat: 0, ore: 0 };
  g.discardQueue = [g.current];
  assert.equal(playerAct(g, p.id, { type: 'discard', res: { wood: 4 } }), null);
  assert.deepEqual(g.events.at(-1).data, { count: 4 });
  g.rolled = true;
  p.res = { wood: 4, brick: 0, sheep: 1, wheat: 1, ore: 1 };
  g.deck = ['vp'];
  assert.equal(playerAct(g, p.id, { type: 'buyDev' }), null);
  assert.deepEqual(g.events.at(-1).data, {});
  const victim = 1 - g.current;
  g.players[victim].res = { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 2 };
  g.stealFrom = [victim]; g.pendingStealer = g.current;
  assert.equal(playerAct(g, p.id, { type: 'steal', from: victim }), null);
  assert.deepEqual(g.events.at(-1).data, { from: victim });
  const other = serialize(g, g.players[1 - g.current].id);
  assert.equal(other.players[g.current].res, null);
  assert.equal(other.players[g.current].dev, null);
  assert.deepEqual(other.history.at(-1).data, { from: victim });
  const count = g.events.length;
  assert.match(playerAct(g, p.id, { type: 'buildCity', vertex: 'not-a-vertex' }), /无效|不能|资源不足/);
  assert.equal(g.events.length, count, 'rejected actions must not become facts');
  assert.equal(g.events.every((e, i) => i === 0 || e.seq > g.events[i - 1].seq), true);
});

test('自动抢牌的历史先记强盗移动，再记不含牌种的抢牌事件', () => {
  const g = game();
  while (g.phase === 'setup') {
    const i = g.setupSteps[g.setupStep].p, p = g.players[i];
    assert.equal(playerAct(g, p.id, ruleBotAction(serialize(g, p.id))), null);
  }
  const actor = g.current, victim = 1 - actor;
  const hex = g.map.hexes.find(h => h.id !== g.map.robber && h.resource !== 'desert');
  const vertex = g.map.vertices.find(v => v.hexes.includes(hex.id));
  g.players[actor].settlements = []; g.players[actor].cities = [];
  g.players[victim].settlements = [vertex.id]; g.players[victim].cities = [];
  g.players[victim].res = { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 1 };
  g.needMoveRobber = true;
  assert.equal(playerAct(g, g.players[actor].id, { type: 'moveRobber', hex: hex.id }), null);
  assert.deepEqual(g.events.slice(-2).map(e => e.type), ['moveRobber', 'steal']);
  assert.deepEqual(g.events.at(-1).data, { from: victim });
});

test('每个 AI 的计划隔离、受限、会过期并在目标失效或换局时清空', () => {
  const g = game(), a = serialize(g, g.players[0].id), b = serialize(g, g.players[1].id);
  const plan = normalizeBotPlan({ goal: 'settlement', target: a.legal.setup[0], resource: 'ore',
    text: '对手有 99 张矿石' }, a);
  assert.deepEqual(Object.keys(plan), ['goal', 'target', 'resource', 'sinceTurn', 'expiresTurn']);
  assert.equal(JSON.stringify(plan).includes('99'), false);
  const memoryA = rememberBotDecision(freshBotMemory(a), a, a, { plan });
  assert.equal(botMemoryContext(a, memoryA).plan.target, plan.target);
  assert.equal(botMemoryContext(b, memoryA).plan, null, 'another AI cannot inherit the plan');
  assert.equal(reconcileBotMemory(memoryA, { ...a, turn: a.turn + a.players.length * 3 + 1 }).plan, null);
  const occupied = structuredClone(a);
  occupied.players[1].settleVerts.push(plan.target);
  assert.equal(reconcileBotMemory(memoryA, occupied).plan, null);
  assert.equal(reconcileBotMemory(memoryA, { ...a, id: 'another-game' }).plan, null);
});

test('模型的下一次决策读到已执行动作的历史与自己的短期计划', async () => {
  const g = game(), p = g.players[0], state = serialize(g, p.id), fallback = ruleBotAction(state);
  const originalFetch = globalThis.fetch, prompts = [], decisions = [];
  globalThis.fetch = async (_url, options) => {
    const prompt = JSON.parse(options.body).messages[0].content;
    prompts.push(prompt);
    const action = JSON.parse(prompt.match(/建议动作：([^\n]+)\n状态：/)[1]);
    return { ok: true, async json() { return { choices: [{ message: { content: JSON.stringify({ action,
      plan: { goal: 'city', resource: 'ore', text: '不可传播的自由文本' } }) } }] }; } };
  };
  try {
    const config = { baseUrl: 'http://mock/v1', model: 'mock', apiKey: 'x' };
    assert.deepEqual(await getBotProfile('medium').decide({ state, config, fallback, onDecision: d => decisions.push(d) }), fallback);
    assert.equal(playerAct(g, p.id, fallback), null);
    const after = serialize(g, p.id);
    const memory = rememberBotDecision(freshBotMemory(state), state, after, decisions[0]);
    const nextFallback = ruleBotAction(after);
    assert.equal(nextFallback.type, 'placeRoad');
    await getBotProfile('medium').decide({ state: after, config, fallback: nextFallback, memory });
    const context = JSON.parse(prompts[1].split('\n历史与计划：')[1]);
    assert.equal(context.plan.goal, 'city');
    assert.equal(context.plan.resource, 'ore');
    assert.equal(context.recentEvents.at(-1).type, 'placeSettlement');
    assert.doesNotMatch(JSON.stringify(context), /不可传播/);
  } finally { globalThis.fetch = originalFetch; }
});

test('档位预算用完时无模型调用，剩余一次时只提交一步动作', async () => {
  const g = game(), state = serialize(g, g.players[0].id), fallback = ruleBotAction(state);
  const originalFetch = globalThis.fetch;
  let calls = 0, usage = 0;
  globalThis.fetch = async () => {
    calls++;
    return { ok: true, async json() { return { choices: [{ message: { content: JSON.stringify(fallback) } }] }; } };
  };
  try {
    const args = { state, fallback, config: { baseUrl: 'http://mock/v1', model: 'mock', apiKey: 'x' },
      onUsage: count => { usage += count; } };
    assert.deepEqual(await getBotProfile('highest').decide({ ...args, remainingCalls: 0 }), fallback);
    assert.equal(calls, 0);
    assert.deepEqual(await getBotProfile('highest').decide({ ...args, remainingCalls: 1 }), fallback);
    assert.equal(calls, 1); assert.equal(usage, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test('高档可用一次历史工具查询，并选择单独配置的模型', async () => {
  const g = game(), state = serialize(g, g.players[0].id), fallback = ruleBotAction(state);
  const originalFetch = globalThis.fetch, requests = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    const answer = requests.length === 1 ? { tool: 'inspectHistory', args: { limit: 4 } } : fallback;
    return { ok: true, async json() { return { choices: [{ message: { content: JSON.stringify(answer) } }] }; } };
  };
  try {
    const action = await getBotProfile('high').decide({ state, fallback,
      config: { baseUrl: 'http://mock/v1', model: 'base', models: { high: 'high-model' }, apiKey: 'x' } });
    assert.deepEqual(action, fallback);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests.map(r => r.model), ['high-model', 'high-model']);
    assert.match(requests[1].messages.at(-1).content, /events/);
  } finally { globalThis.fetch = originalFetch; }
});

for (const difficulty of ['medium', 'high', 'very-high', 'highest']) {
  test(`${difficulty} 带独立记忆和每回合预算完成双人对局`, { timeout: 20000 }, async () => {
    const g = createGame({ mapSize: 'small', targetVP: 7, startBonus: 'none', playerNames: ['AI A', 'AI B'] });
    const roster = g.players.map(p => ({ kind: 'bot', gamePlayerId: p.id, memory: null, budget: null }));
    const profile = getBotProfile(difficulty), originalFetch = globalThis.fetch;
    let calls = 0, actions = 0, retainedPlans = 0;
    globalThis.fetch = async (_url, options) => {
      calls++;
      const prompt = JSON.parse(options.body).messages[0].content;
      const action = JSON.parse(prompt.match(/建议动作：([^\n]+)\n状态：/)[1]);
      return { ok: true, async json() { return { choices: [{ message: { content: JSON.stringify({ action,
        plan: { goal: 'development', resource: 'ore' } }) } }] }; } };
    };
    try {
      for (; actions < 6000 && g.winner == null; actions++) {
        const bot = nextBot(g, roster);
        assert.ok(bot);
        const before = serialize(g, bot.gamePlayerId), fallback = ruleBotAction(before);
        bot.memory = reconcileBotMemory(bot.memory, before);
        if (bot.budget?.turn !== g.turn) bot.budget = { turn: g.turn, calls: 0 };
        const remainingCalls = Math.max(0, profile.ai.maxTurnCalls - bot.budget.calls);
        let decision = null;
        const action = await profile.decide({ state: before, fallback, memory: bot.memory, remainingCalls,
          config: { baseUrl: 'http://mock/v1', model: 'mock', apiKey: 'x' },
          onDecision: summary => { decision = summary; }, onUsage: count => { bot.budget.calls += count; } });
        assert.equal(playerAct(g, bot.gamePlayerId, action), null, JSON.stringify(action));
        const after = serialize(g, bot.gamePlayerId);
        bot.memory = decision ? rememberBotDecision(bot.memory, before, after, decision) : reconcileBotMemory(bot.memory, after);
        if (bot.memory.plan) retainedPlans++;
        assert.ok(bot.budget.calls <= profile.ai.maxTurnCalls);
        assert.equal(roster.every(entry => !entry.memory?.plan || entry.memory.playerId === entry.gamePlayerId), true);
      }
      assert.notEqual(g.winner, null, `${actions} 次动作后仍无胜者`);
      assert.ok(calls > 0 && retainedPlans > 0);
    } finally { globalThis.fetch = originalFetch; }
  });
}

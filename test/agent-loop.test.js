import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, playerAct, serialize, RES } from '../game/engine.js';
import { ruleBotAction, normalizeAgentStep, usefulPlayerTrade } from '../bot.js';
import { getBotProfile } from '../bots/profiles.js';
import { runAgentTool } from '../bots/agent-tools.js';
import { formatBotCommentary, normalizeBotCommentary } from '../bots/narration.js';
import { nextBot } from '../game/bot-scheduling.js';

function readyGame() {
  const g = createGame({ mapSize: 'small', targetVP: 10, startBonus: 'none', playerNames: ['Bot', 'Other'] });
  while (g.phase === 'setup') {
    const i = g.setupSteps[g.setupStep].p;
    const p = g.players[i];
    assert.equal(playerAct(g, p.id, ruleBotAction(serialize(g, p.id))), null);
  }
  return g;
}

test('只读工具返回合法候选和资源缺口，不读取或修改对手私有手牌', () => {
  const g = readyGame(), p = g.players[g.current], other = g.players[1 - g.current];
  p.res = { wood: 4, brick: 1, sheep: 1, wheat: 2, ore: 2 };
  other.res = { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 17 };
  g.rolled = true;
  const state = serialize(g, p.id), original = JSON.stringify(state);
  const builds = runAgentTool(state, 'inspectBuilds', { kind: 'road', limit: 3 });
  assert.equal(builds.ok, true);
  assert.ok(builds.candidates.length > 0 && builds.candidates.every(c => state.legal.road.includes(c.id)));
  assert.ok(builds.candidates.every(c => 'target' in c && 'remainingRoads' in c && 'claimsLongest' in c));
  const resources = runAgentTool(state, 'inspectResources', { goal: 'city' });
  assert.equal(resources.ok, true);
  assert.equal(resources.missing.ore, 1);
  assert.equal(resources.bankTradesAvailableNow, true);
  const bankTrade = runAgentTool(state, 'evaluateTrade', { mode: 'bank', give: 'wood', want: 'ore' });
  assert.equal(bankTrade.possibleForMe, true);
  assert.equal(bankTrade.actionAvailableNow, true);
  assert.equal(bankTrade.goals.city.missingAfter, 0);
  const playerTrade = runAgentTool(state, 'evaluateTrade', { mode: 'player', give: { wood: 1 }, want: { ore: 1 } });
  assert.equal(playerTrade.opponentAcceptance, '未知');
  assert.equal(runAgentTool(state, 'readSecretHands', {}).ok, false);
  assert.equal(JSON.stringify(state), original, 'tools must not mutate the serialized view');
  assert.equal(state.players[1 - g.current].res, null);
  g.needMoveRobber = true;
  const robber = runAgentTool(serialize(g, p.id), 'inspectRobber', { limit: 4 });
  assert.equal(robber.ok, true);
  assert.ok(robber.candidates.every(h => h.id !== g.map.robber && h.opponents.every(q => !('res' in q))));
  assert.equal(runAgentTool(serialize(g, p.id), 'evaluateTrade', { mode: 'bank', give: 'wood', want: 'ore' }).actionAvailableNow, false,
    'the tool distinguishes a feasible trade from one available during the robber event');
});

test('结构化盘算只接受标签，公共日志不使用模型自由文本', () => {
  const step = normalizeAgentStep(JSON.stringify({ action: { type: 'buildCity', vertex: 'v1' },
    commentary: { avoid: 'road', reason: 'urgentScore', text: '我有 9 张矿石 <img src=x>' } }));
  assert.deepEqual(step.commentary, { avoid: 'road', reason: 'urgentScore' });
  const text = formatBotCommentary({ action: step.action, commentary: step.commentary, tools: ['inspectBuilds'] });
  assert.match(text, /觉得继续修路先等等/);
  assert.match(text, /升级城市/);
  assert.doesNotMatch(text, /矿石|<img|v1/);
  assert.equal(normalizeBotCommentary({ avoid: '<script>', reason: '<script>' }), null);
  assert.deepEqual(normalizeAgentStep('{"tool":"inspectResources","args":{"goal":"city"}}'),
    { tool: 'inspectResources', args: { goal: 'city' } });
  assert.deepEqual(normalizeAgentStep([{ type: 'text', text: '{"action":{"type":"endTurn"}}' }]).action,
    { type: 'endTurn' });
});

test('agent 公开短评受长度与字符约束，默认仍可回退结构化摘要', () => {
  const step = normalizeAgentStep(JSON.stringify({ action: { type: 'endTurn' }, thought: '选择结束回合 <script>\u0007' }));
  assert.equal(step.thought, '选择结束回合 script');
  assert.equal(formatBotCommentary({ action: step.action, thought: step.thought }), '选择结束回合 script');
  assert.equal(formatBotCommentary({ action: step.action, thought: '' }), '选择结束回合，让下一位开拓者行动。');
});

test('规则 AI 在银行无法补齐目标资源时主动发起玩家交易', () => {
  const g = readyGame(), p = g.players[g.current];
  g.rolled = true;
  g.bank.brick = 0;
  p.res = { wood: 2, brick: 0, sheep: 0, wheat: 0, ore: 0 };
  const state = serialize(g, p.id);
  state.legal = { road: [], settlement: [], city: [], dev: false, canPlayRoad: false };
  const trade = usefulPlayerTrade(state, state.players[state.viewer]);
  assert.equal(trade.type, 'offerTrade');
  assert.deepEqual(trade.give, { wood: 1 });
  assert.deepEqual(trade.targets, [1]);
  assert.deepEqual(trade.want, { brick: 1 });
  assert.deepEqual(ruleBotAction(state), trade);
  assert.equal(playerAct(g, p.id, trade), null);
  const other = g.players[1];
  assert.equal(playerAct(g, other.id, { type: 'rejectOffer' }), null);
  const afterRejection = serialize(g, p.id);
  assert.equal(usefulPlayerTrade(afterRejection, afterRejection.players[afterRejection.viewer]), null);
  assert.notEqual(ruleBotAction(afterRejection)?.type, 'offerTrade');
  state.players[1].total = 0;
  assert.equal(usefulPlayerTrade(state, state.players[state.viewer]), null);
});

test('最高档可查询两种工具，再提交和复核动作，调用数受限', async () => {
  const g = readyGame(), p = g.players[g.current];
  p.res = Object.fromEntries(RES.map(r => [r, r === 'wheat' ? 2 : r === 'ore' ? 3 : 0]));
  g.rolled = true;
  const state = serialize(g, p.id), fallback = ruleBotAction(state);
  assert.equal(fallback.type, 'buildCity');
  const originalFetch = globalThis.fetch, calls = [], summaries = [];
  const replies = [
    { tool: 'inspectBuilds', args: { kind: 'city' } },
    { tool: 'inspectResources', args: { goal: 'city' } },
    { action: fallback, commentary: { avoid: 'road', reason: 'urgentScore', text: '私有信息' } },
    { action: fallback, commentary: { avoid: 'road', reason: 'urgentScore' } },
  ];
  globalThis.fetch = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return { ok: true, async json() { return { choices: [{ message: { content: JSON.stringify(replies.shift()) } }] }; } };
  };
  try {
    const action = await getBotProfile('highest').decide({ state, config: { baseUrl: 'http://mock/v1', model: 'mock', apiKey: 'x' },
      fallback, onDecision: summary => summaries.push(summary) });
    assert.deepEqual(action, fallback);
    assert.equal(calls.length, 4);
    assert.match(calls[1].messages.at(-1).content, /totalChoices/);
    assert.match(calls[2].messages.at(-1).content, /missing/);
    assert.deepEqual(summaries[0].tools, ['inspectBuilds', 'inspectResources']);
    assert.deepEqual(summaries[0].commentary, { avoid: 'road', reason: 'urgentScore' });
    assert.equal(playerAct(g, p.id, action), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('重复工具请求不能造成无限循环，也不会公开未执行的盘算', async () => {
  const g = readyGame(), p = g.players[g.current], state = serialize(g, p.id);
  const fallback = { type: 'roll' };
  // Roll is deterministic and deliberately bypasses the model.
  let calls = 0, decisions = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls++; throw new Error('should not call'); };
  try {
    assert.deepEqual(await getBotProfile('highest').decide({ state, fallback, config: {}, onDecision: () => decisions++ }), fallback);
    assert.equal(calls, 0); assert.equal(decisions, 0);
  } finally { globalThis.fetch = originalFetch; }
  g.rolled = true;
  const active = serialize(g, p.id), legalFallback = ruleBotAction(active);
  globalThis.fetch = async () => {
    calls++;
    return { ok: true, async json() { return { choices: [{ message: { content: '{"tool":"inspectResources","args":{"goal":"city"}}' } }] }; } };
  };
  try {
    const reasons = [];
    assert.deepEqual(await getBotProfile('highest').decide({ state: active, fallback: legalFallback,
      config: { baseUrl: 'http://mock/v1', model: 'mock', apiKey: 'x' }, onFallback: r => reasons.push(r), onDecision: () => decisions++ }), legalFallback);
    assert.equal(calls, 5);
    assert.equal(decisions, 0);
    assert.match(reasons.at(-1), /无效/);
  } finally { globalThis.fetch = originalFetch; }
});

test('不同回合共用固定 system 前缀，动态状态与合法动作位于后缀', async () => {
  const game = readyGame(), player = game.players[game.current];
  game.rolled = true;
  const originalFetch = globalThis.fetch, requests = [];
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return { ok: true, async json() { return { choices: [{ message: { content: '{"type":"endTurn"}' } }] }; } };
  };
  try {
    for (const turn of [31, 32]) {
      const state = serialize(game, player.id);
      state.turn = turn;
      await getBotProfile('high').decide({ state, fallback: { type: 'endTurn' },
        config: { baseUrl: 'http://prefix/v1', model: 'mock', apiKey: 'x' } });
    }
    assert.equal(requests.length, 2);
    assert.equal(requests[0].messages[0].role, 'system');
    assert.deepEqual(requests[0].messages[0], requests[1].messages[0]);
    assert.match(requests[0].messages[0].content, /多换多/);
    assert.notEqual(requests[0].messages[1].content, requests[1].messages[1].content);
    assert.match(requests[0].messages[1].content, /"turn":31/);
    assert.match(requests[0].messages[1].content, /"actions":/);
  } finally { globalThis.fetch = originalFetch; }
});

test('超长工具参数不会原样回灌模型上下文', async () => {
  const g = readyGame(), p = g.players[g.current];
  g.rolled = true;
  const state = serialize(g, p.id), fallback = { type: 'endTurn' };
  const originalFetch = globalThis.fetch, calls = [];
  globalThis.fetch = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    const reply = calls.length === 1
      ? { tool: 'inspectResources', args: { goal: 'city', padding: 'x'.repeat(2000) } }
      : fallback;
    return { ok: true, async json() { return { choices: [{ message: { content: JSON.stringify(reply) } }] }; } };
  };
  try {
    assert.deepEqual(await getBotProfile('highest').decide({ state, fallback,
      config: { baseUrl: 'http://mock/v1', model: 'mock', apiKey: 'x' } }), fallback);
    assert.equal(calls.length, 2, 'ordinary legal actions skip the extra review');
    assert.ok(calls[1].messages.find(message => message.role === 'assistant').content.length < 100);
    assert.match(calls[1].messages.at(-1).content, /参数过长/);
  } finally { globalThis.fetch = originalFetch; }
});

test('JSON 输出模式不兼容时仅协商一次，并保留动作合法性检查', async () => {
  const g = readyGame(), p = g.players[g.current];
  g.rolled = true;
  const state = serialize(g, p.id), fallback = ruleBotAction(state);
  const originalFetch = globalThis.fetch, requests = [], usage = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    if (body.response_format) return { ok: false, status: 400 };
    return { ok: true, async json() { return { choices: [{ message: { content: JSON.stringify({ action: fallback }) } }] }; } };
  };
  try {
    const args = { state, fallback, config: { baseUrl: 'http://json-mode-unsupported/v1', model: 'mock', apiKey: 'x' }, onUsage: n => usage.push(n) };
    assert.deepEqual(await getBotProfile('high').decide(args), fallback);
    assert.deepEqual(await getBotProfile('high').decide(args), fallback);
    assert.equal(requests.length, 3);
    assert.equal(requests[0].response_format.type, 'json_object');
    assert.equal(requests[1].response_format, undefined);
    assert.equal(requests[2].response_format, undefined);
    assert.deepEqual(usage, [2, 1]);
  } finally { globalThis.fetch = originalFetch; }
});

test('鉴权类 400 错误不会被误判为 JSON 模式不兼容', async () => {
  const g = readyGame(), p = g.players[g.current];
  g.rolled = true;
  const state = serialize(g, p.id), fallback = ruleBotAction(state);
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; return { ok: false, status: 400, async text() { return 'invalid api key'; } }; };
  try {
    const args = { state, fallback, config: { baseUrl: 'http://auth-error/v1', model: 'mock', apiKey: 'x' } };
    await getBotProfile('high').decide(args);
    await getBotProfile('high').decide(args);
    assert.equal(requests, 2);
  } finally { globalThis.fetch = originalFetch; }
});

test('普通合法动作只调用一次，非法模型动作在上限内修正', async () => {
  const g = readyGame(), p = g.players[g.current];
  g.rolled = true;
  const state = serialize(g, p.id), fallback = ruleBotAction(state);
  const originalFetch = globalThis.fetch, requests = [], phases = [];
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    const value = requests.length === 1 ? { type: 'buildCity', vertex: 'impossible' } : fallback;
    return { ok: true, async json() { return { choices: [{ message: { content: JSON.stringify(value) } }] }; } };
  };
  try {
    assert.deepEqual(await getBotProfile('high').decide({ state, fallback,
      config: { baseUrl: 'http://repair-test/v1', model: 'mock', apiKey: 'x' },
      onProgress: status => phases.push(status.phase) }), fallback);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].response_format.type, 'json_object');
    assert.deepEqual(phases, ['thinking', 'repair', 'continue']);
  } finally { globalThis.fetch = originalFetch; }
});

test('最高档按真实调度完成一局并保持所有动作合法', { timeout: 20000 }, async () => {
  const g = createGame({ mapSize: 'small', targetVP: 7, startBonus: 'none', playerNames: ['A', 'B'] });
  const roster = g.players.map(p => ({ kind: 'bot', gamePlayerId: p.id }));
  const originalFetch = globalThis.fetch;
  let calls = 0, decisions = 0, actions = 0;
  globalThis.fetch = async (_url, options) => {
    calls++;
    const prompt = JSON.parse(options.body).messages.find(message => message.role === 'user').content;
    const fallback = JSON.parse(prompt.match(/建议动作：([^\n]+)\n状态：/)[1]);
    return { ok: true, async json() { return { choices: [{ message: { content: JSON.stringify({ action: fallback,
      commentary: { avoid: 'endTurn', reason: 'timing' } }) } }] }; } };
  };
  try {
    for (; actions < 6000 && g.winner == null; actions++) {
      const bot = nextBot(g, roster);
      assert.ok(bot, `第 ${g.turn} 回合有可行动的机器人`);
      const state = serialize(g, bot.gamePlayerId), fallback = ruleBotAction(state);
      const action = await getBotProfile('highest').decide({ state, fallback,
        config: { baseUrl: 'http://mock/v1', model: 'mock', apiKey: 'x' }, onDecision: () => decisions++ });
      assert.equal(playerAct(g, bot.gamePlayerId, action), null, JSON.stringify(action));
    }
    assert.notEqual(g.winner, null, `${actions} 次动作后仍无胜者`);
    assert.ok(calls > 0 && decisions > 0);
  } finally { globalThis.fetch = originalFetch; }
});

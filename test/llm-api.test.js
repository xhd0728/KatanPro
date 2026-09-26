import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, serialize } from '../game/engine.js';
import { ruleBotAction } from '../bot.js';
import { getBotProfile } from '../bots/profiles.js';

function setupDecision() {
  const game = createGame({ mapSize: 'small', playerNames: ['AI', 'Other'] });
  const player = game.players[game.setupSteps[game.setupStep].p];
  const state = serialize(game, player.id);
  return { state, fallback: ruleBotAction(state) };
}

for (const mode of ['responses', 'anthropic']) {
  test(`${mode} 接口完成只读工具查询后执行合法动作`, async () => {
    const { state, fallback } = setupDecision();
    const originalFetch = globalThis.fetch, requests = [], decisions = [], usage = [];
    globalThis.fetch = async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push({ url, headers: options.headers, body });
      const result = requests.length === 1
        ? { tool: 'inspectBuilds', args: { kind: 'settlement' } }
        : { action: fallback, commentary: { avoid: 'road', reason: 'weakProduction' } };
      const content = JSON.stringify(result);
      const response = mode === 'responses'
        ? { output: [{ type: 'reasoning', summary: [{ text: 'private' }] },
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: content }] }] }
        : { content: [{ type: 'thinking', thinking: '{"type":"endTurn"}' }, { type: 'text', text: content }] };
      return { ok: true, async json() { return response; } };
    };
    try {
      const action = await getBotProfile('high').decide({ state, fallback,
        config: { apiMode: mode, baseUrl: 'http://mock/v1', model: 'mock', apiKey: 'secret' },
        onDecision: decision => decisions.push(decision), onUsage: count => usage.push(count) });
      assert.deepEqual(action, fallback);
      assert.equal(requests.length, 2);
      assert.equal(requests[0].url, `http://mock/v1/${mode === 'responses' ? 'responses' : 'messages'}`);
      assert.equal(requests[0].body.model, 'mock');
      assert.equal(requests[0].body.response_format, undefined);
      assert.equal(requests[0].body.enable_thinking, undefined);
      assert.equal(requests[0].body.temperature, undefined);
      const messages = mode === 'responses' ? requests[1].body.input : requests[1].body.messages;
      assert.match(messages.at(-1).content, /totalChoices/);
      assert.deepEqual(decisions[0].tools, ['inspectBuilds']);
      assert.deepEqual(usage, [2]);
      if (mode === 'responses') {
        assert.equal(requests[0].headers.Authorization, 'Bearer secret');
        assert.equal(requests[0].body.text.format.type, 'json_object');
        assert.equal(requests[0].body.store, false);
        assert.equal(requests[0].body.messages, undefined);
      } else {
        assert.equal(requests[0].headers['x-api-key'], 'secret');
        assert.equal(requests[0].headers['anthropic-version'], '2023-06-01');
        assert.ok(requests[0].body.max_tokens >= 1024);
        assert.equal(requests[0].body.text, undefined);
        assert.equal(requests[0].headers.Authorization, undefined);
      }
    } finally { globalThis.fetch = originalFetch; }
  });
}

test('Responses JSON 格式被拒绝后协商一次，后续沿用普通格式', async () => {
  const { state, fallback } = setupDecision();
  const originalFetch = globalThis.fetch, requests = [], usage = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    if (body.text?.format) return { ok: false, status: 400, async text() { return 'unsupported text.format'; } };
    return { ok: true, async json() { return { output: [{ type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: JSON.stringify(fallback) }] }] }; } };
  };
  try {
    const args = { state, fallback, config: { apiMode: 'responses', baseUrl: 'http://fallback/v1', model: 'mock', apiKey: 'x' },
      onUsage: count => usage.push(count) };
    assert.deepEqual(await getBotProfile('medium').decide(args), fallback);
    assert.deepEqual(await getBotProfile('medium').decide(args), fallback);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].text.format.type, 'json_object');
    assert.equal(requests[1].text, undefined);
    assert.deepEqual(usage, [1, 1]);
  } finally { globalThis.fetch = originalFetch; }
});

test('Responses 鉴权失败不重试，Anthropic 思考块不能冒充最终动作', async () => {
  const { state, fallback } = setupDecision();
  const originalFetch = globalThis.fetch, reasons = [];
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls++;
      return { ok: false, status: 400, async text() { return 'invalid api key'; } };
    };
    assert.deepEqual(await getBotProfile('medium').decide({ state, fallback,
      config: { apiMode: 'responses', baseUrl: 'http://auth/v1', model: 'mock', apiKey: 'bad' },
      onFallback: reason => reasons.push(reason) }), fallback);
    assert.equal(calls, 1);
    globalThis.fetch = async () => {
      calls++;
      return { ok: true, async json() { return { content: [{ type: 'thinking', thinking: JSON.stringify(fallback) }] }; } };
    };
    assert.deepEqual(await getBotProfile('medium').decide({ state, fallback,
      config: { apiMode: 'anthropic', baseUrl: 'http://thinking/v1', model: 'mock', apiKey: 'x' },
      onFallback: reason => reasons.push(reason) }), fallback);
    assert.equal(calls, 2);
    assert.match(reasons.at(-1), /无效/);
  } finally { globalThis.fetch = originalFetch; }
});

test('无效 API 模式直接回退，未发送模型请求', async () => {
  const { state, fallback } = setupDecision();
  const originalFetch = globalThis.fetch, reasons = [];
  globalThis.fetch = async () => { throw new Error('unexpected request'); };
  try {
    for (const apiMode of ['unknown', 'constructor']) {
      assert.deepEqual(await getBotProfile('medium').decide({ state, fallback,
        config: { apiMode, baseUrl: 'http://mock/v1', model: 'mock', apiKey: 'x' },
        onFallback: reason => reasons.push(reason) }), fallback);
    }
    assert.equal(reasons.length, 2);
    assert.ok(reasons.every(reason => /API 模式无效/.test(reason)));
  } finally { globalThis.fetch = originalFetch; }
});

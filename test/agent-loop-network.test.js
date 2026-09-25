import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import WebSocket from 'ws';

test('最高档跨动作记忆、工具进度和结构化盘算进入真实对局，私有文字不外泄', { timeout: 15000 }, async () => {
  let calls = 0, sawToolResult = false, sawPlan = false, sawPublicHistory = false, sawJsonMode = false;
  const mock = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      calls++;
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (body.response_format?.type === 'json_object') sawJsonMode = true;
      const messages = body.messages;
      const context = JSON.parse(messages[0].content.split('\n历史与计划：')[1]);
      if (context.plan?.goal === 'city') sawPlan = true;
      if (context.recentEvents.some(e => e.type === 'placeSettlement')) sawPublicHistory = true;
      const match = messages[0].content.match(/建议动作：([^\n]+)\n状态：/);
      assert.ok(match);
      const fallback = JSON.parse(match[1]);
      if (messages.some(m => m.content.includes('totalChoices'))) sawToolResult = true;
      const reply = calls === 1
        ? { tool: 'inspectBuilds', args: { kind: 'settlement' } }
        : { action: fallback, plan: { goal: 'city', resource: 'ore', text: '秘密手牌 99 矿石' },
          commentary: { avoid: 'road', reason: 'urgentScore', text: '秘密手牌 99 矿石 <script>' } };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }));
    });
  });
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
  const port = 30000 + Math.floor(Math.random() * 20000);
  const server = spawn(process.execPath, ['server.js'], { cwd: process.cwd(), env: {
    ...process.env, PORT: String(port), CATAN_AI_BASE_URL: `http://127.0.0.1:${mock.address().port}/v1`,
    CATAN_AI_MODEL: 'mock', CATAN_AI_KEY: 'dummy',
  }, stdio: 'ignore' });
  const sockets = [];
  const inbox = new WeakMap();
  const connect = async url => {
    const ws = new WebSocket(url), box = { queue: [], waiters: [] };
    sockets.push(ws); inbox.set(ws, box);
    ws.on('message', raw => {
      const message = JSON.parse(raw), index = box.waiters.findIndex(w => w.type === message.type);
      if (index >= 0) box.waiters.splice(index, 1)[0].resolve(message);
      else box.queue.push(message);
    });
    await once(ws, 'open'); return ws;
  };
  const next = (ws, type) => {
    const box = inbox.get(ws), index = box.queue.findIndex(m => m.type === type);
    if (index >= 0) return Promise.resolve(box.queue.splice(index, 1)[0]);
    return new Promise(resolve => box.waiters.push({ type, resolve }));
  };
  try {
    let ready = false;
    for (let i = 0; i < 80 && !ready; i++) {
      try { ready = (await fetch(`http://127.0.0.1:${port}/api/rooms`)).ok; }
      catch { await new Promise(resolve => setTimeout(resolve, 30)); }
    }
    assert.equal(ready, true);
    const creator = await connect(`ws://127.0.0.1:${port}/ws?mode=ai-only`);
    const created = await next(creator, 'created');
    creator.close();
    const viewer = await connect(`ws://127.0.0.1:${port}/ws?room=${created.code}&name=Watcher`);
    assert.equal((await next(viewer, 'joined')).room.isHost, true);
    viewer.send(JSON.stringify({ type: 'settings', settings: { botCount: 2, botDifficulty: 'highest' } }));
    let updated;
    do { updated = await next(viewer, 'room'); } while (updated.room.settings.botDifficulty !== 'highest');
    assert.equal(updated.room.settings.botDifficulty, 'highest');
    const progressEvents = [];
    viewer.on('message', raw => {
      const msg = JSON.parse(raw);
      if (msg.type === 'bot-progress') progressEvents.push(msg);
    });
    const thought = new Promise(resolve => {
      const handler = raw => {
        const msg = JSON.parse(raw);
        const item = msg.type === 'state' && msg.state.log.find(l => l.kind === 'bot-thought');
        if (item && sawPlan && sawPublicHistory) { viewer.off('message', handler); resolve({ item, state: msg.state }); }
      };
      viewer.on('message', handler);
    });
    viewer.send(JSON.stringify({ type: 'start' }));
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('thought log timeout')), 10000); });
    const { item, state } = await Promise.race([thought, timeout]);
    clearTimeout(timer);
    assert.ok(calls >= 4 && sawToolResult && sawPlan && sawPublicHistory && sawJsonMode,
      'the model receives tool output and its own plan plus executed public events on its next action');
    assert.ok(progressEvents.some(e => e.phase === 'thinking') && progressEvents.some(e => e.phase === 'tool' && e.tool === 'inspectBuilds') && progressEvents.some(e => e.phase === 'done'));
    assert.equal(progressEvents.every(e => !JSON.stringify(e).includes('秘密手牌')), true);
    assert.match(item.text, /觉得继续修路先等等/);
    assert.deepEqual(item.detail.tools, ['inspectBuilds']);
    assert.doesNotMatch(JSON.stringify(state.log), /秘密手牌|99 矿石|<script>/);
    assert.equal(state.players.every(p => p.res === null), true, 'spectators still cannot see hidden hands');
    assert.doesNotMatch(JSON.stringify(state.history), /秘密手牌|99 矿石|<script>/);
    assert.ok(state.players.some(p => p.settlements > 0), 'the validated action was executed');
  } finally {
    for (const ws of sockets) ws.terminate();
    server.kill();
    await new Promise(resolve => mock.close(resolve));
  }
});

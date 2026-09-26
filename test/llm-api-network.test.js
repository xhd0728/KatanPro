import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import WebSocket from 'ws';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

for (const mode of ['responses', 'anthropic']) {
  test(`服务端用 ${mode} 模式发起并执行真实对局的模型请求`, { timeout: 15000 }, async () => {
    let firstRequest;
    const requested = new Promise(resolve => { firstRequest = resolve; });
    const mock = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        firstRequest({ path: req.url, headers: req.headers, body });
        const prompt = (mode === 'responses' ? body.input : body.messages).find(message => message.role === 'user').content;
        const fallback = JSON.parse(prompt.match(/建议动作：([^\n]+)\n状态：/)[1]);
        const content = JSON.stringify(fallback);
        const output = mode === 'responses'
          ? { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: content }] }] }
          : { content: [{ type: 'text', text: content }] };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(output));
      });
    });
    mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
    const port = 30000 + Math.floor(Math.random() * 20000);
    const server = spawn(process.execPath, ['server.js'], { cwd: process.cwd(), env: {
      ...process.env, HOST: '127.0.0.1', PORT: String(port),
      CATAN_AI_API_MODE: mode, CATAN_AI_BASE_URL: `http://127.0.0.1:${mock.address().port}/v1`,
      CATAN_AI_MODEL: 'mock', CATAN_AI_KEY: 'network-secret',
    }, stdio: 'ignore' });
    const sockets = [];
    try {
      let ready = false;
      for (let i = 0; i < 80 && !ready; i++) {
        try { ready = (await fetch(`http://127.0.0.1:${port}/api/rooms`)).ok; }
        catch { await pause(30); }
      }
      assert.equal(ready, true);
      const creator = new WebSocket(`ws://127.0.0.1:${port}/ws?mode=ai-only`);
      sockets.push(creator);
      const created = new Promise(resolve => creator.on('message', raw => {
        const msg = JSON.parse(raw); if (msg.type === 'created') resolve(msg);
      }));
      await once(creator, 'open');
      const { code } = await created;
      creator.close();
      const viewer = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${code}&name=Watcher`);
      sockets.push(viewer);
      const joined = new Promise(resolve => viewer.on('message', raw => {
        const msg = JSON.parse(raw); if (msg.type === 'joined') resolve(msg);
      }));
      await once(viewer, 'open');
      assert.equal((await joined).room.isHost, true);
      const settings = new Promise(resolve => viewer.on('message', raw => {
        const msg = JSON.parse(raw);
        if (msg.type === 'room' && msg.room.settings.botCount === 2) resolve();
      }));
      viewer.send(JSON.stringify({ type: 'settings', settings: { botCount: 2, botDifficulty: 'medium' } }));
      await settings;
      const acted = new Promise(resolve => viewer.on('message', raw => {
        const msg = JSON.parse(raw);
        if (msg.type === 'state' && msg.state.history?.some(event => event.type === 'placeSettlement')) resolve(msg.state);
      }));
      viewer.send(JSON.stringify({ type: 'start' }));
      let timer;
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('model action timeout')), 10000); });
      const [request, state] = await Promise.race([Promise.all([requested, acted]), timeout]).finally(() => clearTimeout(timer));
      assert.equal(request.path, `/v1/${mode === 'responses' ? 'responses' : 'messages'}`);
      assert.equal(request.body.model, 'mock');
      assert.ok(state.history.some(event => event.type === 'placeSettlement'));
      assert.equal(mode === 'responses' ? request.headers.authorization : request.headers['x-api-key'],
        mode === 'responses' ? 'Bearer network-secret' : 'network-secret');
    } finally {
      for (const socket of sockets) socket.terminate();
      server.kill();
      await new Promise(resolve => mock.close(resolve));
    }
  });
}

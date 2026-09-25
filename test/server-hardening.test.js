import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import WebSocket from 'ws';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function startServer(env = {}) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', CATAN_AI_BASE_URL: '', CATAN_AI_MODEL: '', CATAN_AI_KEY: '', ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', d => { stderr += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${base}/api/rooms`); break; } catch { await sleep(30); }
  }
  return { port, base, ws: `ws://127.0.0.1:${port}/ws`, stderr: () => stderr, stop: () => child.kill() };
}

function connect(url) {
  const ws = new WebSocket(url);
  const queue = [], waiters = [];
  ws.on('message', raw => {
    const msg = JSON.parse(raw);
    const i = waiters.findIndex(w => w.type === msg.type);
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg); else queue.push(msg);
  });
  return {
    ws,
    send: msg => ws.send(JSON.stringify(msg)),
    next(type, timeout = 3000) {
      const i = queue.findIndex(m => m.type === type);
      if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeout);
        waiters.push({ type, resolve: m => { clearTimeout(timer); resolve(m); } });
      });
    },
    close: () => ws.close(),
  };
}

async function createRoom(srv, mode) {
  const c = connect(srv.ws + (mode ? `?mode=${mode}` : ''));
  const { code } = await c.next('created');
  c.close();
  return code;
}

test('未被认领的房间会被清理，房间总数有上限', { timeout: 10000 }, async () => {
  const srv = await startServer({ CATAN_UNCLAIMED_ROOM_MS: '200', CATAN_MAX_ROOMS: '3' });
  const clients = [];
  try {
    const orphan = await createRoom(srv);
    const claimed = await createRoom(srv);
    const host = connect(`${srv.ws}?room=${claimed}&name=A`); clients.push(host);
    await host.next('joined');
    const aiCode = await createRoom(srv, 'ai-only');
    const viewer = connect(`${srv.ws}?room=${aiCode}&name=V`); clients.push(viewer);
    await viewer.next('joined');

    const extra = connect(srv.ws); clients.push(extra);
    assert.match((await extra.next('error')).msg, /上限/);

    await sleep(500);
    const codes = (await fetch(`${srv.base}/api/rooms`).then(r => r.json())).map(r => r.code);
    assert.equal(codes.includes(orphan), false, 'orphan room removed');
    assert.equal(codes.includes(claimed), true, 'joined room kept');
    assert.equal(codes.includes(aiCode), true, 'spectated ai room kept');
    const late = connect(`${srv.ws}?room=${orphan}&name=B`); clients.push(late);
    assert.match((await late.next('error')).msg, /不存在/);

    const again = connect(srv.ws); clients.push(again);
    assert.ok((await again.next('created')).code, 'capacity freed after cleanup');
  } finally {
    clients.forEach(c => c.close());
    srv.stop();
  }
});

test('静态资源请求：非法路径立即返回错误且不越出 public/', { timeout: 10000 }, async () => {
  const srv = await startServer();
  try {
    // Raw requests: fetch would normalise dot segments before they reach the server.
    const status = path => new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: srv.port, path, timeout: 2000 }, r => { r.resume(); resolve(r.statusCode); });
      req.on('timeout', () => req.destroy(new Error(`timeout: ${path}`))).on('error', reject);
    });
    assert.equal(await status('/a%00b'), 400);
    assert.equal(await status('/index.html%00.js'), 400);
    assert.equal(await status('/%E0%A4%A'), 400);
    assert.equal(await status('/..%2fserver.js'), 403);
    assert.equal(await status('/%2e%2e/.env'), 403);
    assert.equal(await status('/index.html'), 200);
    assert.equal(srv.stderr().includes('UNCAUGHT'), false);
  } finally {
    srv.stop();
  }
});

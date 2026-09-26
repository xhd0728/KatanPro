import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import WebSocket from 'ws';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
  const probe = net.createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
}

async function startServer(env = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', CATAN_AI_BASE_URL: '', CATAN_AI_MODEL: '', CATAN_AI_KEY: '', ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', d => { stderr += d; });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    try { ready = Array.isArray(await fetch(`${base}/api/rooms`).then(r => r.json())); } catch { await sleep(30); }
  }
  assert.equal(ready, true, 'server started');
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
    const request = path => new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: srv.port, path, timeout: 2000 }, r => { r.resume(); resolve(r); });
      req.on('timeout', () => req.destroy(new Error(`timeout: ${path}`))).on('error', reject);
    });
    assert.equal((await request('/a%00b')).statusCode, 400);
    assert.equal((await request('/index.html%00.js')).statusCode, 400);
    assert.equal((await request('/%E0%A4%A')).statusCode, 400);
    assert.equal((await request('/..%2fserver.js')).statusCode, 403);
    assert.equal((await request('/%2e%2e/.env')).statusCode, 403);
    const index = await request('/index.html');
    assert.equal(index.statusCode, 200);
    assert.equal(index.headers['x-content-type-options'], 'nosniff');
    assert.equal(index.headers['x-frame-options'], 'DENY');
    assert.equal(index.headers['referrer-policy'], 'no-referrer');
    assert.equal(srv.stderr().includes('UNCAUGHT'), false);
  } finally {
    srv.stop();
  }
});

test('只有大厅中的真人玩家可以改名', { timeout: 10000 }, async () => {
  const srv = await startServer();
  const clients = [];
  try {
    const code = await createRoom(srv);
    const host = connect(`${srv.ws}?room=${code}&name=Host`); clients.push(host);
    await host.next('joined'); await host.next('room');
    host.send({ type: 'rename', name: '  新名字很长很长很长很长很长  ' });
    assert.equal((await host.next('room')).room.players[0].name, '新名字很长很长很长很长很长'.slice(0, 12));

    host.send({ type: 'start', bots: [{ difficulty: 'rule', name: 'Bot' }] });
    await host.next('state');
    host.send({ type: 'rename', name: 'Other' });
    assert.match((await host.next('error')).msg, /对局开始后/);

    const spectator = connect(`${srv.ws}?room=${code}&name=Viewer`); clients.push(spectator);
    await spectator.next('joined');
    spectator.send({ type: 'rename', name: 'Host' });
    assert.match((await spectator.next('error')).msg, /观战者/);

    const aiCode = await createRoom(srv, 'ai-only');
    const director = connect(`${srv.ws}?room=${aiCode}&name=Director`); clients.push(director);
    await director.next('joined');
    director.send({ type: 'rename', name: 'X' });
    assert.match((await director.next('error')).msg, /观战者/);
  } finally {
    clients.forEach(c => c.close());
    srv.stop();
  }
});

test('畸形消息字段被拒绝，不会抛错或留下半加入的机器人', { timeout: 10000 }, async () => {
  const srv = await startServer();
  const clients = [];
  try {
    const code = await createRoom(srv);
    const host = connect(`${srv.ws}?room=${code}&name=Host`); clients.push(host);
    await host.next('joined'); await host.next('room');
    const expectError = async (msg, pattern) => { host.send(msg); assert.match((await host.next('error')).msg, pattern); };

    await expectError({ type: 'rename', name: 42 }, /名字无效/);
    await expectError({ type: 'rename', name: { toString: null } }, /名字无效/);
    await expectError({ type: 'settings', settings: { password: { a: 1 } } }, /密码无效/);
    await expectError({ type: 'settings', settings: { botDifficulty: ['rule'] } }, /未知/);
    await expectError({ type: 'start', bots: [{ difficulty: 'rule' }, { difficulty: 'rule', name: { toString: 1 } }] }, /机器人配置无效/);
    await expectError({ type: 'start', bots: [{ difficulty: 'rule' }, null] }, /机器人配置无效/);
    await expectError({ type: 'start', bots: [{ difficulty: { valueOf: 1 } }] }, /机器人配置无效/);
    host.send({ type: 'settings', settings: { mapSize: ['small'], targetVP: '10' } });
    const lobby = (await host.next('room')).room;
    assert.equal(lobby.players.length, 1, 'no partial bots were added');
    assert.equal(lobby.settings.mapSize, 'small');
    assert.equal(lobby.settings.targetVP, 10);

    host.send({ type: 'start', bots: [{ difficulty: 'rule', name: 'Bot' }] });
    const state = (await host.next('state')).state;
    assert.equal(state.players.length, 2);
    for (const action of [
      null, [], 'roll', { type: 42 }, { type: 'offerTrade', give: { wood: 0 }, want: { res: 'toString', n: 1 } },
      { type: 'offerTrade', give: { res: { toString: 1 }, n: 1 }, want: { wood: 1 } },
      { type: 'bankTrade', give: '__proto__', want: 'wood' }, { type: 'discard', res: { wood: '1' } },
      { type: 'placeSettlement', vertex: { toString: 1 } }, { type: 'moveRobber', hex: ['h1'] },
    ]) {
      host.send({ type: 'action', action });
      await host.next('state');
    }
    host.send({ type: 'unknown' }); host.send([1, 2]); host.ws.send('not json'); host.ws.send('null');
    const alive = connect(`${srv.ws}?room=${code}&name=Late`); clients.push(alive);
    await alive.next('joined');
    assert.equal(/MSG ERROR|UNCAUGHT/.test(srv.stderr()), false, srv.stderr());
  } finally {
    clients.forEach(c => c.close());
    srv.stop();
  }
});

test('WebSocket 消息速率受限，避免单连接耗尽服务端 CPU', { timeout: 10000 }, async () => {
  const srv = await startServer();
  const clients = [];
  try {
    const code = await createRoom(srv);
    const host = connect(`${srv.ws}?room=${code}&name=Host`); clients.push(host);
    await host.next('joined');
    for (let i = 0; i < 125; i++) host.send({ type: 'unknown' });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('rate-limited socket did not close')), 2000);
      host.ws.once('close', (codeValue) => { clearTimeout(timer); assert.equal(codeValue, 1008); resolve(); });
    });
    assert.equal(srv.stderr().includes('UNCAUGHT'), false);
  } finally {
    clients.forEach(c => c.close());
    srv.stop();
  }
});

test('混合难度席位：容量、权限、身份切换、大厅与观战隐私', { timeout: 15000 }, async () => {
  const srv = await startServer();
  const clients = [];
  const join = async (code, query = '') => {
    const c = connect(`${srv.ws}?room=${code}&name=Visitor${query}`); clients.push(c);
    c.identity = await c.next('me'); c.room = (await c.next('joined')).room;
    return c;
  };
  const roomAfter = async (c, predicate) => {
    for (let i = 0; i < 40; i++) { const r = (await c.next('room')).room; if (predicate(r)) return r; }
    assert.fail('room update not found');
  };
  const listing = async code => (await fetch(`${srv.base}/api/rooms`).then(r => r.json())).find(r => r.code === code);
  try {
    const code = await createRoom(srv);
    const host = await join(code), guest = await join(code);
    assert.equal(host.room.players.length, 1);
    assert.equal(host.room.rosterVersion, 1);
    for (const type of ['addBot','updateBot','removeBot']) {
      guest.send({type,difficulty:'high',seatId:host.room.viewerSeatId});
      assert.match((await guest.next('error')).msg, /房主/);
    }
    host.send({type:'addBot',difficulty:'bogus'});
    assert.match((await host.next('error')).msg, /难度/);
    host.send({type:'settings',settings:{botCount:8,mapSize:'large'}});
    assert.match((await host.next('error')).msg, /8/);
    assert.equal((await listing(code)).settings.mapSize, 'small', 'invalid batch settings are atomic');
    const levels = ['low','medium','high','very-high','highest','high'];
    let roster;
    for (let i = 0; i < levels.length; i++) {
      host.send({type:'addBot',difficulty:levels[i]});
      roster = await roomAfter(host, r => r.players.length === i + 3);
    }
    assert.deepEqual(roster.players.slice(2).map(p => p.difficulty), levels);
    assert.ok(roster.players.slice(2).every(p => p.name === 'AI' && p.connected));
    assert.equal(new Set(roster.players.map(p => p.seatId)).size, 8);
    assert.ok(roster.players.every(p => !('token' in p)), 'public seat IDs are not resume credentials');
    host.send({type:'addBot',difficulty:'low'});
    assert.match((await host.next('error')).msg, /已满/);
    let entry = await listing(code);
    assert.deepEqual([entry.players,entry.humans,entry.bots,entry.canJoin,entry.status], [8,2,6,false,'waiting']);
    const fullVisitor = await join(code);
    assert.equal(fullVisitor.identity.spectator, true, 'full rooms admit spectators');
    fullVisitor.send({type:'setRole',role:'player'});
    assert.match((await fullVisitor.next('error')).msg, /已满/);
    host.send({type:'setRole',role:'spectator'});
    assert.equal((await host.next('me')).spectator, true);
    roster = await roomAfter(host, r => r.viewerKind === 'spectator');
    assert.equal(roster.isHost,true); assert.equal(roster.players.length,7);
    fullVisitor.send({type:'setRole',role:'player'});
    assert.equal((await fullVisitor.next('me')).spectator,false);
    await roomAfter(host,r=>r.players.length===8);
    const bot = roster.players.find(p=>p.kind==='bot');
    host.send({type:'updateBot',seatId:bot.seatId,difficulty:'highest'});
    roster = await roomAfter(host,r=>r.players.find(p=>p.seatId===bot.seatId)?.difficulty==='highest');
    host.send({type:'removeBot',seatId:roster.players.find(p=>p.kind==='human').seatId});
    assert.match((await host.next('error')).msg,/不存在/);
    host.send({type:'removeBot',seatId:bot.seatId});
    await roomAfter(host,r=>r.players.length===7);
    const watcher = await join(code,'&spectate=1');
    assert.equal(watcher.room.viewerKind,'spectator');
    assert.equal(watcher.room.players.length,7,'explicit watching does not consume an available seat');
    host.send({type:'addBot',difficulty:'low'});
    roster = await roomAfter(host,r=>r.players.length===8);
    host.send({type:'start'});
    const state = (await host.next('state')).state;
    assert.equal(state.viewer,-1);
    assert.ok(state.players.every(p=>p.res===null));
    assert.deepEqual(state.players.map(p=>p.difficulty), roster.players.map(p=>p.difficulty));
    assert.ok(state.players.filter(p=>p.kind==='bot').every(p=>p.name==='AI'));
    host.send({type:'updateBot',seatId:roster.players.find(p=>p.kind==='bot').seatId,difficulty:'low'});
    assert.match((await host.next('error')).msg,/开始后/);
    watcher.send({type:'action',action:{type:'roll'}});
    assert.match((await watcher.next('error')).msg,/观战/);
    watcher.send({type:'setRole',role:'player'});
    assert.match((await watcher.next('error')).msg,/开始后/);
    entry = await listing(code);
    assert.equal(entry.status,'playing'); assert.equal(entry.canJoin,false);
    const late = await join(code);
    assert.equal((await late.next('state')).state.viewer,-1);
    const restored = await join(code,`&spectate=1&token=${host.identity.token}`);
    assert.equal(restored.room.isHost,true);
    assert.equal((await restored.next('state')).state.viewer,-1);
    assert.equal(srv.stderr(),'');
  } finally { clients.forEach(c=>c.close()); srv.stop(); }
});

test('纯 AI 准备房间支持逐席编辑和最低人数校验', { timeout: 10000 }, async () => {
  const srv = await startServer(); const clients=[];
  try {
    const code=await createRoom(srv,'ai-only');
    const host=connect(`${srv.ws}?room=${code}`);clients.push(host);
    const r=(await host.next('joined')).room;
    assert.equal(r.players.length,4);assert.equal(r.viewerKind,'spectator');
    assert.equal(r.isHost,true);assert.ok(r.players.every(p=>p.name==='AI'&&p.difficulty==='medium'));
    for(const p of r.players.slice(1))host.send({type:'removeBot',seatId:p.seatId});
    host.send({type:'start'});assert.match((await host.next('error')).msg,/至少/);
    host.send({type:'setRole',role:'player'});assert.match((await host.next('error')).msg,/只能观战/);
    host.send({type:'updateBot',seatId:r.players[0].seatId,difficulty:'low'});
    host.send({type:'addBot',difficulty:'high'});host.send({type:'start'});
    const s=(await host.next('state')).state;
    assert.equal(s.viewer,-1);assert.deepEqual(s.players.map(p=>p.difficulty),['low','high']);
  } finally {clients.forEach(c=>c.close());srv.stop();}
});

test('主动离开立即释放席位，房主移交给真人或观众而非 AI', {timeout:10000}, async()=>{
  const srv=await startServer();const clients=[];
  try{
    const code=await createRoom(srv);
    const host=connect(`${srv.ws}?room=${code}`);clients.push(host);await host.next('joined');
    host.send({type:'addBot',difficulty:'low'});
    const watcher=connect(`${srv.ws}?room=${code}&spectate=1`);clients.push(watcher);
    await watcher.next('joined');
    host.send({type:'leaveRoom'});await host.next('left');
    let room;do{room=(await watcher.next('room')).room;}while(!room.isHost);
    assert.equal(room.players.length,1);assert.equal(room.players[0].kind,'bot');
    watcher.send({type:'addBot',difficulty:'highest'});
    do{room=(await watcher.next('room')).room;}while(room.players.length!==2);
    assert.deepEqual(room.players.map(p=>p.difficulty),['low','highest']);
    watcher.send({type:'setRole',role:'player'});await watcher.next('me');
    watcher.send({type:'start'});
    const state=(await watcher.next('state')).state;
    assert.equal(state.viewer,2,'promoted spectator receives a real player seat');
    assert.notEqual(state.players[2].res,null);
    watcher.send({type:'leaveRoom'});assert.match((await watcher.next('error')).msg,/已开始/);
  }finally{clients.forEach(c=>c.close());srv.stop();}
});

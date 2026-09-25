import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import WebSocket from 'ws';

class Client {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.queue = [];
    this.waiters = [];
    this.ws.on('message', raw => {
      const msg = JSON.parse(raw);
      const waiter = this.waiters.find(w => w.type === msg.type);
      if (waiter) { this.waiters.splice(this.waiters.indexOf(waiter), 1); waiter.resolve(msg); }
      else this.queue.push(msg);
      this.onMessage?.(msg);
    });
  }
  async open() { await once(this.ws, 'open'); return this; }
  next(type) {
    const i = this.queue.findIndex(m => m.type === type);
    if (i >= 0) return Promise.resolve(this.queue.splice(i, 1)[0]);
    return new Promise(resolve => this.waiters.push({ type, resolve }));
  }
  send(msg) { this.ws.send(JSON.stringify(msg)); }
  close() { this.ws.close(); }
}

test('联机与纯 AI 对局：模型回退、观战权限及房主恢复', { timeout: 15000 }, async () => {
  let aiCalls = 0;
  const mock = http.createServer((req, res) => {
    aiCalls++;
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '{"type":"endTurn"}' } }] }));
  });
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
  const mockPort = mock.address().port;
  const port = 20000 + Math.floor(Math.random() * 20000);
  const server = spawn(process.execPath, ['server.js'], { cwd: process.cwd(), env: {
    ...process.env, PORT: String(port), CATAN_AI_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
    CATAN_AI_MODEL: 'mock', CATAN_AI_KEY: 'dummy'
  }, stdio: 'ignore' });
  const clients = [];
  try {
    let ready = false;
    for (let i = 0; i < 50 && !ready; i++) {
      try { await new Promise((resolve, reject) => http.get(`http://127.0.0.1:${port}/api/rooms`, r => { r.resume(); resolve(); }).on('error', reject)); ready = true; }
      catch { await new Promise(resolve => setTimeout(resolve, 30)); }
    }
    assert.equal(ready, true, 'server started');
    const creator = await new Client(`ws://127.0.0.1:${port}/ws`).open(); clients.push(creator);
    const { code } = await creator.next('created'); creator.close();
    const a = await new Client(`ws://127.0.0.1:${port}/ws?room=${code}&name=A`).open(); clients.push(a);
    await a.next('joined');
    const b = await new Client(`ws://127.0.0.1:${port}/ws?room=${code}&name=B`).open(); clients.push(b);
    const room = await b.next('joined');
    assert.equal(room.room.isHost, false);
    assert.equal('hostToken' in room.room, false);
    const finished = new Promise(resolve => {
      for (const client of [a, b]) client.onMessage = m => {
        if (m.type !== 'state') return;
        if (m.state.phase === 'play') { resolve(m.state); return; }
        if (m.state.phase === 'setup' && m.state.legal.setupPlayer === m.state.viewer) {
          const { kind, setup } = m.state.legal;
          client.send({ type: 'action', action: kind === 'settlement'
            ? { type: 'placeSettlement', vertex: setup[0] }
            : { type: 'placeRoad', edge: setup[0] } });
        }
      };
    });
    a.send({ type: 'start', bots: [{ name: '模型对手', type: 'ai' }] });
    let setupTimer;
    const state = await Promise.race([finished, new Promise((_, reject) => { setupTimer = setTimeout(() => reject(new Error('setup timeout')), 10000); })]);
    clearTimeout(setupTimer);
    assert.equal(state.players.length, 3);
    assert.equal(state.players.every(p => p.settlements === 2 && p.roads === 2), true);
    assert.ok(aiCalls >= 2, 'AI endpoint was called during setup');
    assert.equal(JSON.stringify(state).includes('dummy'), false);
    const spectator = await new Client(`ws://127.0.0.1:${port}/ws?room=${code}&name=viewer`).open(); clients.push(spectator);
    const view = await spectator.next('state');
    assert.equal(view.state.viewer, -1);
    spectator.send({ type: 'action', action: { type: 'roll' } });
    assert.match((await spectator.next('error')).msg, /观战者不能操作/);
    // Reload while the old socket is still alive: authenticated seat takeover.
    const {token}=await a.next('me');
    const resumed=await new Client(`ws://127.0.0.1:${port}/ws?room=${code}&name=A&token=${token}`).open();clients.push(resumed);
    const joined=await resumed.next('joined');
    assert.equal(joined.room.isHost,true);
    const restored=(await resumed.next('state')).state;
    assert.equal(restored.viewer,0);assert.equal(restored.players.length,3);
    assert.ok(restored.players[0].res);

    const creator2=await new Client(`ws://127.0.0.1:${port}/ws`).open();clients.push(creator2);
    const code2=(await creator2.next('created')).code;
    const host=await new Client(`ws://127.0.0.1:${port}/ws?room=${code2}&name=Host`).open();clients.push(host);
    const hostToken=(await host.next('me')).token;await host.next('joined');
    const closed=once(host.ws,'close');host.close();await closed;
    const reload=await new Client(`ws://127.0.0.1:${port}/ws?room=${code2}&name=Host&token=${hostToken}`).open();clients.push(reload);
    const lobby=(await reload.next('joined')).room;
    assert.equal(lobby.isHost,true);assert.equal(lobby.players.length,1);
    reload.send({type:'settings',settings:{password:'table-secret'}});
    reload.send({type:'start',bots:[{name:'Bot',type:'rule'}]});
    await reload.next('state');
    const intruder=await new Client(`ws://127.0.0.1:${port}/ws?room=${code2}&name=viewer`).open();clients.push(intruder);
    assert.match((await intruder.next('error')).msg,/密码/);

    const catalog=await fetch(`http://127.0.0.1:${port}/api/bot-profiles`).then(r=>r.json());
    assert.equal(catalog.defaultDifficulty,'medium');
    assert.deepEqual(catalog.profiles.map(p=>p.id),['low','medium','high','very-high','highest']);
    assert.equal(JSON.stringify(catalog).includes('dummy'),false);
    const aiCreator=await new Client(`ws://127.0.0.1:${port}/ws?mode=ai-only`).open();clients.push(aiCreator);
    const aiCode=(await aiCreator.next('created')).code;aiCreator.close();
    const observer=await new Client(`ws://127.0.0.1:${port}/ws?room=${aiCode}&name=Director`).open();clients.push(observer);
    const observerToken=(await observer.next('me')).token;
    const aiRoom=(await observer.next('joined')).room;
    assert.equal(aiRoom.isHost,true);assert.equal(aiRoom.players.length,0);assert.equal(aiRoom.settings.botDifficulty,'medium');
    const guest=await new Client(`ws://127.0.0.1:${port}/ws?room=${aiCode}&name=Guest`).open();clients.push(guest);
    assert.equal((await guest.next('joined')).room.isHost,false);
    guest.send({type:'settings',settings:{botCount:8}});assert.match((await guest.next('error')).msg,/房主/);
    observer.send({type:'settings',settings:{botDifficulty:'unknown'}});assert.match((await observer.next('error')).msg,/未知/);
    const director=await new Client(`ws://127.0.0.1:${port}/ws?room=${aiCode}&token=${observerToken}`).open();clients.push(director);
    assert.equal((await director.next('joined')).room.isHost,true);
    director.send({type:'settings',settings:{botCount:2}});
    const playing=new Promise(resolve=>{director.onMessage=m=>{if(m.type==='state'&&m.state.phase==='play')resolve(m.state);};});
    const callsBefore=aiCalls;
    director.send({type:'start',bots:[{type:'rule'}]});
    const aiState=await playing;
    assert.equal(aiState.viewer,-1);assert.equal(aiState.players.length,2);
    assert.equal(aiState.players.every(p=>p.kind==='bot'&&p.res===null),true);
    assert.equal(aiState.cards,null);assert.ok(aiCalls>callsBefore,'default difficulty calls the model');
    director.send({type:'action',action:{type:'roll'}});assert.match((await director.next('error')).msg,/观战者/);
    const directorReload=await new Client(`ws://127.0.0.1:${port}/ws?room=${aiCode}&token=${observerToken}`).open();clients.push(directorReload);
    assert.equal((await directorReload.next('joined')).room.isHost,true);
    assert.equal((await directorReload.next('state')).state.viewer,-1);
    const fullCreator=await new Client(`ws://127.0.0.1:${port}/ws?mode=ai-only`).open();clients.push(fullCreator);
    const fullCode=(await fullCreator.next('created')).code;
    const fullHost=await new Client(`ws://127.0.0.1:${port}/ws?room=${fullCode}`).open();clients.push(fullHost);await fullHost.next('joined');
    fullHost.send({type:'settings',settings:{botCount:8,botDifficulty:'rule'}});fullHost.send({type:'start'});
    assert.equal((await fullHost.next('state')).state.players.length,8,'all eight seats can be AI');

  } finally {
    clients.forEach(c => c.close());
    server.kill();
    mock.close();
  }
});

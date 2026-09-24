// 卡坦岛房间服务器：HTTP 静态 + WebSocket 权威状态
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { WebSocketServer } from 'ws';
import { randomBytes } from 'crypto';
import { createGame, playerAct, serialize, addLog } from './game/engine.js';
import { ruleBotAction } from './bot.js';
import { DEFAULT_AI_CONFIG } from './config.js';
import { MAP_LAYOUTS } from './game/map-layouts.js';
import { nextBot } from './game/bot-scheduling.js';
import { DEFAULT_BOT_DIFFICULTY, getBotProfile, listBotProfiles } from './bots/profiles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('PORT 必须是 1–65535 的整数');
const AI_CONFIG = { ...DEFAULT_AI_CONFIG };
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

const rooms = new Map(); // code -> { players: [{ws,name,color}], game, started, settings, hostToken }
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 4 位纯大写房间码（去掉易混字符）
const genCode = () => Array.from(randomBytes(4)).map(b => CODE_CHARS[b % CODE_CHARS.length]).join('');
const publicDir = path.resolve(__dirname, 'public');

// SEA 单文件模式下 public/ 内嵌在可执行文件中；源码运行时这里为空、只走磁盘。
// 若可执行文件旁存在 public/ 目录，磁盘文件优先，便于部署时覆盖前端资源。
// node:sea API：getRawAsset 自 v21.7，getAssetKeys 自 v22.20/v24.8；
// 更早的运行时用内嵌的 manifest 清单配合 getAsset 读取。产物内嵌的是构建时的运行时。
const embeddedAssets = (() => {
  try {
    const sea = createRequire(import.meta.url)('node:sea');
    if (!sea.isSea()) return {};
    const map = {};
    if (typeof sea.getAssetKeys === 'function') {
      for (const key of sea.getAssetKeys()) map[key] = Buffer.from(sea.getRawAsset(key));
    } else {
      const manifest = JSON.parse(sea.getAsset('manifest', 'utf8'));
      for (const key of manifest.files) map['public/' + key] = Buffer.from(sea.getRawAsset('public/' + key));
    }
    return map;
  } catch { return {}; }
})();

const server = http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(req.url.split('?')[0]); }
  catch { res.writeHead(400); return res.end('bad request'); }
  if (p === '/api/bot-profiles') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ defaultDifficulty: DEFAULT_BOT_DIFFICULTY, profiles: listBotProfiles() }));
  }
  if (p === '/api/rooms') {
    const list = [...rooms.values()].filter(r => !r.game).map(r => ({ code: r.code, mode: r.mode, locked: !!r.password, players: r.players.length, maxPlayers: 8, settings: r.settings }));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(list));
  }
  if (p === '/') p = '/index.html';
  const file = path.resolve(publicDir, '.' + p);
  if (file !== publicDir && !file.startsWith(publicDir + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) {
      const key = 'public/' + path.relative(publicDir, file).split(path.sep).join('/');
      const asset = embeddedAssets[key];
      if (asset == null) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      return res.end(asset);
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 32768 });

// Detect half-open TCP connections so clients can enter the reconnect path.
const heartbeatTimer = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 15000);
heartbeatTimer.unref();

function send(ws, obj) { try { ws.readyState === 1 && ws.send(JSON.stringify(obj)); } catch {} }

function broadcast(room) {
  if (!room.game) return;
  room.players.forEach(pl => {
    if (!pl.ws || pl.gamePlayerId == null) return;
    try { send(pl.ws, { type: 'state', state: serialize(room.game, pl.gamePlayerId) }); }
    catch (e) { console.error('SERIALIZE ERROR:', e.stack); }
  });
  for (const spec of room.spectators || []) send(spec.ws, { type: 'state', state: serialize(room.game, null) });
  scheduleBots(room);
}
function error(ws, msg) { send(ws, { type: 'error', msg }); }
function isHost(room, pl) { return room.hostToken === pl?.token; }
function broadcastRoom(room) {
  for (const p of [...room.players, ...room.spectators]) send(p.ws, { type: 'room', room: publicRoom(room, p) });
}
function scheduleEmptyRoomCleanup(room) {
  clearTimeout(room.emptyTimer);
  if ([...room.players, ...room.spectators].some(p => p.ws)) return;
  room.emptyTimer = setTimeout(() => {
    if ([...room.players, ...room.spectators].some(p => p.ws)) return;
    clearTimeout(room.botTimer); clearTimeout(room.offerTimer);
    room.game = null;
    rooms.delete(room.code);
  }, 10 * 60 * 1000);
  room.emptyTimer.unref();
}

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    try { handleMsg(ws, raw); } catch (e) { console.error('MSG ERROR:', e.stack); error(ws, '服务器内部错误'); }
  });
  const url = new URL(req.url, 'http://x');
  const code = (url.searchParams.get('room') || '').toUpperCase();
  const name = (url.searchParams.get('name') || '').trim().slice(0, 12) || '玩家';
  let room = rooms.get(code);
  if (!code) { send(ws, { type: 'created', code: createRoom(url.searchParams.get('mode')) }); return; }
  if (!room) { error(ws, '房间不存在或已解散'); return ws.close(); }
  const token = url.searchParams.get('token');
  const old = token && [...room.players, ...room.spectators].find(p => p.kind !== 'bot' && p.token === token);
  if (old) {
    const previous = old.ws;
    clearTimeout(old.disconnectTimer);
    clearTimeout(room.emptyTimer);
    old.ws = ws;
    attach(ws, room, old);
    if (previous && previous !== ws) previous.close(4001, 'seat resumed elsewhere');
    send(ws, { type: 'me', token: old.token });
    send(ws, { type: 'joined', code, room: publicRoom(room, old) });
    if (room.game) { if (old.kind === 'human') addLog(room.game, old.gp(), '重新连接'); broadcast(room); }
    else broadcastRoom(room);
    return;
  }
  const password = url.searchParams.get('password') || '';
  if (room.password && password !== room.password) { error(ws, '房间密码错误'); return ws.close(); }
  if (room.game || room.mode === 'ai-only') {
    const pl = { ws, name, kind: 'spectator', token: randomBytes(16).toString('base64url'), gamePlayerId: null };
    room.spectators.push(pl); attach(ws, room, pl);
    clearTimeout(room.emptyTimer);
    if (room.mode === 'ai-only' && !room.hostToken) room.hostToken = pl.token;
    send(ws, { type: 'me', token: pl.token, spectator: true });
    send(ws, { type: 'joined', code, room: publicRoom(room, pl) });
    if (room.game) broadcast(room); else broadcastRoom(room);
    return;
  }
  if (room.players.length >= 8) { error(ws, '房间已满'); return ws.close(); }
  const pl = joinPlayer(room, ws, name);
  send(ws, { type: 'me', token: pl.token });
  send(ws, { type: 'joined', code, room: publicRoom(room, pl) });
  broadcastRoom(room);
});

function scheduleBots(room) {
  // A bot must give human recipients time to respond, without blocking forever.
  const offer = room.game?.offer;
  if (room.timedOffer !== offer) {
    clearTimeout(room.offerTimer);
    room.timedOffer = offer;
    if (offer && room.players.some(p => p.kind === 'bot' && p.gamePlayerId === room.game.players[offer.from]?.id)) {
      const game = room.game;
      room.offerTimer = setTimeout(() => {
        if (room.game !== game || game.offer !== offer || game.winner != null) return;
        playerAct(game, game.players[offer.from].id, { type: 'cancelOffer' });
        addLog(game, null, '交易等待 30 秒未完成，机器人已撤回提案');
        broadcast(room);
      }, 30000);
      room.offerTimer.unref();
    }
  }
  if (!room.game || room.botBusy || room.botTimer || room.game.winner != null) return;
  const bot = nextBot(room.game, room.players);
  if (!bot) return;
  room.botTimer = setTimeout(() => {
    room.botTimer = null;
    runBot(room, bot).catch((err) => console.error('BOT ERROR:', err.stack));
  }, 120);
}

async function runBot(room, bot) {
  if (!room.game || room.game.winner != null || room.botBusy) return;
  const game = room.game;
  const offer = game.offer;
  const playerId = bot.gamePlayerId;
  const state = serialize(game, playerId);
  const fallback = ruleBotAction(state);
  if (!fallback) return;
  room.botBusy = true;
  try {
    const action = await getBotProfile(bot.difficulty).decide({
      state, config: AI_CONFIG, fallback,
      onFallback: reason => {
        if (room.game === game && bot.lastFallbackReason !== reason) addLog(game, null, `${bot.name}：${reason}，已由规则机器人接手`);
        bot.lastFallbackReason = reason;
      },
    });
    if (action !== fallback) bot.lastFallbackReason = null;
    if (room.game !== game || bot.gamePlayerId !== playerId || game.winner != null) return;
    // A slow model response must never accept a replacement offer's different terms.
    if (offer && offer !== game.offer && ['acceptOffer', 'rejectOffer'].includes(action?.type)) return;
    const err = playerAct(game, playerId, action || fallback);
    if (err) {
      const freshFallback = ruleBotAction(serialize(game, playerId));
      if (freshFallback) playerAct(game, playerId, freshFallback);
    }
  } finally {
    room.botBusy = false;
    broadcast(room);
  }
}

function addBotPlayer(room, spec) {
  const difficulty = spec.difficulty || (spec.type === 'rule' ? 'rule' : DEFAULT_BOT_DIFFICULTY);
  const bot = {
    ws: null,
    name: String(spec.name || `${getBotProfile(difficulty).label} ${room.players.filter(p => p.kind === 'bot').length + 1}`).slice(0, 12),
    token: randomBytes(8).toString('base64url'),
    kind: 'bot',
    difficulty,
    gamePlayerId: null,
    gp() { return room.game ? room.game.players.find((p) => p.id === bot.gamePlayerId) : null; }
  };
  room.players.push(bot);
  return bot;
}

function createRoom(requestedMode) {
  const mode = requestedMode === 'ai-only' ? 'ai-only' : 'multiplayer';
  let code;
  do { code = genCode(); } while (rooms.has(code));
  rooms.set(code, { code, mode, players: [], spectators: [], game: null, hostToken: null, password: '', settings: { mapSize: 'small', targetVP: 10, startBonus: 'none', withBots: mode === 'ai-only', botCount: mode === 'ai-only' ? 4 : 2, botDifficulty: DEFAULT_BOT_DIFFICULTY } });
  return code;
}
function joinPlayer(room, ws, name) {
  const pl = { ws, name, token: randomBytes(8).toString('base64url'), kind: 'human', gamePlayerId: null, gp() { return room.game ? room.game.players.find(p => p.id === pl.gamePlayerId) : null; } };
  room.players.push(pl);
  if (!room.hostToken) room.hostToken = pl.token;
  ws.__pl = pl; ws.__room = room;
  return pl;
}
function attach(ws, room, pl) { ws.__pl = pl; ws.__room = room; }
function publicRoom(room, viewer) {
  return { code: room.code, mode: room.mode, settings: { ...room.settings }, locked: !!room.password, isHost: isHost(room, viewer), spectatorCount: room.spectators.filter(p => p.ws).length, players: room.players.map(p => ({ name: p.name, kind: p.kind || 'human', connected: !!p.ws || p.kind === 'bot' })) };
}

function handleMsg(ws, raw) {
  let msg; try { msg = JSON.parse(raw); } catch { return; }
  if (!msg || typeof msg !== 'object') return error(ws, '无效消息');
  const room = ws.__room;
  if (!room) return;
  const pl = ws.__pl;
  switch (msg.type) {
    case 'settings': {
      const { mapSize, targetVP, startBonus, password, withBots, botCount, botDifficulty } = msg.settings || {};
      if (!isHost(room, pl)) return error(ws, '只有房主可以修改设置');
      if (room.game) return error(ws, '游戏已开始');
      if (botDifficulty !== undefined && !getBotProfile(botDifficulty)) return error(ws, '未知的 AI 难度');
      if (Object.hasOwn(MAP_LAYOUTS, mapSize)) room.settings.mapSize = mapSize;
      if ([7, 10, 12, 15].includes(targetVP)) room.settings.targetVP = targetVP;
      if (['none', 'random1', 'random2'].includes(startBonus)) room.settings.startBonus = startBonus;
      if (password !== undefined) room.password = String(password || '').trim().slice(0, 24);
      if (typeof withBots === 'boolean' && room.mode !== 'ai-only') room.settings.withBots = withBots;
      if (Number.isInteger(botCount) && botCount >= (room.mode === 'ai-only' ? 2 : 1) && botCount <= (room.mode === 'ai-only' ? 8 : 7)) room.settings.botCount = botCount;
      if (botDifficulty !== undefined) room.settings.botDifficulty = botDifficulty;
      broadcastRoom(room);
      break;
    }
    case 'rename': {
      pl.name = (msg.name || '').trim().slice(0, 12) || pl.name;
      broadcastRoom(room);
      break;
    }
    case 'start': {
      if (!isHost(room, pl)) return error(ws, '只有房主可以开始游戏');
      if (room.game) return error(ws, '游戏已开始');
      if (room.players.some(p => p.kind === 'human' && !p.ws)) return error(ws, '请等待离线玩家重连；45 秒后会自动释放席位');
      const configuredBots = room.mode === 'ai-only' || room.settings.withBots
        ? Array.from({ length: room.settings.botCount }, () => ({ difficulty: room.settings.botDifficulty })) : [];
      const bots = room.mode === 'ai-only' ? configuredBots : Array.isArray(msg.bots) ? msg.bots.slice(0, 8) : configuredBots;
      if (bots.some(spec => !spec || !getBotProfile(spec.difficulty || (spec.type === 'rule' ? 'rule' : DEFAULT_BOT_DIFFICULTY)))) return error(ws, '未知的 AI 难度');
      if (room.players.length + bots.length < 2) return error(ws, '至少需要 2 名玩家或机器人');
      if (room.players.length + bots.length > 8) return error(ws, '最多只能有 8 名玩家和机器人');
      for (const spec of bots) addBotPlayer(room, spec || {});
      const humanPlayers = room.players.filter(p => p.kind === 'human');
      room.game = createGame({ ...room.settings, playerNames: room.players.map(p => p.name), playerKinds: room.players.map(p => p.kind) });
      room.players.forEach((p, i) => p.gamePlayerId = room.game.players[i].id);
      addLog(room.game, null, `对局配置：${humanPlayers.length} 名玩家 · ${room.players.filter(p => p.kind === 'bot').length} 个机器人`);
      broadcast(room);
      break;
    }
    case 'action': {
      if (!room.game) return;
      if (!pl.gamePlayerId) return error(ws, '观战者不能操作');
      const err = playerAct(room.game, pl.gamePlayerId, msg.action || {});
      if (err) error(ws, err);
      broadcast(room);
      break;
    }
    case 'restart': {
      if (!isHost(room, pl)) return error(ws, '只有房主可以重新开始');
      if (!room.game || room.game.winner == null) return error(ws, '本局还未结束');
      room.game = createGame({ ...room.settings, playerNames: room.players.map(p => p.name), playerKinds: room.players.map(p => p.kind) });
      room.players.forEach((p, i) => p.gamePlayerId = room.game.players[i].id);
      broadcast(room);
      break;
    }
  }
}
process.on('uncaughtException', (e) => console.error('UNCAUGHT:', e.stack));

// 断线：保留席位与游戏位
function onDisconnect(ws) {
  const room = ws.__room, pl = ws.__pl;
  if (!room || !pl || pl.ws !== ws) return;
  pl.ws = null;
  if (pl.kind === 'spectator') {
    pl.disconnectTimer = setTimeout(() => {
      if (pl.ws) return;
      room.spectators = room.spectators.filter(p => p !== pl);
      if (room.hostToken === pl.token) room.hostToken = room.spectators.find(p => p.ws)?.token || room.spectators[0]?.token || null;
      broadcastRoom(room);
      if (!room.game && !room.players.length && !room.spectators.length) rooms.delete(room.code);
    }, room.game ? 10 * 60 * 1000 : 45000);
    pl.disconnectTimer.unref();
    if (!room.game) broadcastRoom(room);
    scheduleEmptyRoomCleanup(room);
    return;
  }
  if (!room.game) {
    broadcastRoom(room);
    pl.disconnectTimer = setTimeout(() => {
      if (pl.ws || room.game) return;
      room.players = room.players.filter(p => p !== pl);
      if (room.hostToken === pl.token) room.hostToken = room.players[0]?.token || null;
      broadcastRoom(room);
      if (!room.players.length) rooms.delete(room.code);
    }, 45000);
    pl.disconnectTimer.unref();
  } else {
    if (room.game.phase === 'setup') { // 摆放阶段直接换成人机继续太难，保留等待
      addLog(room.game, pl.gp(), `${pl.name} 断线，等待重连`);
    } else {
      addLog(room.game, pl.gp(), `${pl.name} 断线`);
    }
    broadcast(room);
    scheduleEmptyRoomCleanup(room);
  }
}
wss.on('connection', ws => { ws.on('close', () => onDisconnect(ws)); });

server.listen(PORT, HOST, () => console.log(`卡坦岛服务器已启动: http://${HOST}:${PORT}`));

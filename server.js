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
import { formatBotCommentary } from './bots/narration.js';
import { AGENT_TOOLS } from './bots/agent-tools.js';
import { reconcileBotMemory, rememberBotDecision, reflectBotMemory } from './bots/memory.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const configuredTakeoverMs = Number(process.env.CATAN_DISCONNECT_TAKEOVER_MS || 15000);
const DISCONNECT_TAKEOVER_MS = Number.isFinite(configuredTakeoverMs) && configuredTakeoverMs >= 0
  ? Math.floor(configuredTakeoverMs) : 15000;
const configuredUnclaimedMs = Number(process.env.CATAN_UNCLAIMED_ROOM_MS || 60000);
const UNCLAIMED_ROOM_MS = Number.isFinite(configuredUnclaimedMs) && configuredUnclaimedMs >= 0
  ? Math.floor(configuredUnclaimedMs) : 60000;
const configuredMaxRooms = Number(process.env.CATAN_MAX_ROOMS || 500);
const MAX_ROOMS = Number.isInteger(configuredMaxRooms) && configuredMaxRooms > 0 ? configuredMaxRooms : 500;
const WS_MESSAGE_WINDOW_MS = 1000;
const WS_MESSAGE_LIMIT = 120;
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

const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

const server = http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(req.url.split('?')[0]); }
  catch { res.writeHead(400, securityHeaders); return res.end('bad request'); }
  // fs throws synchronously on NUL, which would leave the request unanswered.
  if (p.includes('\0')) { res.writeHead(400, securityHeaders); return res.end('bad request'); }
  if (p === '/api/bot-profiles') {
    res.writeHead(200, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ defaultDifficulty: DEFAULT_BOT_DIFFICULTY, profiles: listBotProfiles() }));
  }
  if (p === '/api/rooms') {
    const list = [...rooms.values()].map(r => ({ code: r.code, mode: r.mode, locked: !!r.password,
      players: r.players.length, humans: r.players.filter(p => p.kind === 'human').length,
      bots: r.players.filter(p => p.kind === 'bot').length, maxPlayers: 8,
      spectators: r.spectators.filter(p => p.ws).length,
      status: !r.game ? 'waiting' : r.game.winner == null ? 'playing' : 'finished',
      canJoin: !r.game && r.mode !== 'ai-only' && r.players.length < 8, settings: r.settings }));
    res.writeHead(200, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(list));
  }
  if (p === '/') p = '/index.html';
  const file = path.resolve(publicDir, '.' + p);
  if (file !== publicDir && !file.startsWith(publicDir + path.sep)) { res.writeHead(403, securityHeaders); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) {
      const key = 'public/' + path.relative(publicDir, file).split(path.sep).join('/');
      const asset = embeddedAssets[key];
      if (asset == null) { res.writeHead(404, securityHeaders); return res.end('not found'); }
      res.writeHead(200, { ...securityHeaders, 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      return res.end(asset);
    }
    res.writeHead(200, { ...securityHeaders, 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
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

function broadcastBotProgress(room, game, actor, progress) {
  if (room.game !== game || (game.winner != null && progress.phase !== 'done')) return;
  const message = { type: 'bot-progress', gameId: game.id, actor, ...progress };
  for (const participant of [...room.players, ...room.spectators]) send(participant.ws, message);
}

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
function scheduleEmptyRoomCleanup(room, delay = 10 * 60 * 1000) {
  clearTimeout(room.emptyTimer);
  if ([...room.players, ...room.spectators].some(p => p.ws)) return;
  room.emptyTimer = setTimeout(() => {
    if ([...room.players, ...room.spectators].some(p => p.ws)) return;
    clearRoomTimers(room);
    room.game = null;
    rooms.delete(room.code);
  }, delay);
  room.emptyTimer.unref();
}

function clearRoomTimers(room) {
  clearTimeout(room.emptyTimer);
  clearTimeout(room.botTimer);
  clearTimeout(room.offerTimer);
  for (const player of [...room.players, ...room.spectators]) {
    clearTimeout(player.disconnectTimer);
    clearTimeout(player.takeoverTimer);
  }
  room.emptyTimer = null;
  room.botTimer = null;
  room.offerTimer = null;
  room.timedOffer = null;
}

function withinMessageRate(ws) {
  const now = Date.now();
  if (!ws.messageWindowStart || now - ws.messageWindowStart >= WS_MESSAGE_WINDOW_MS) {
    ws.messageWindowStart = now;
    ws.messageCount = 0;
  }
  ws.messageCount = (ws.messageCount || 0) + 1;
  return ws.messageCount <= WS_MESSAGE_LIMIT;
}

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.messageWindowStart = 0;
  ws.messageCount = 0;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    if (!withinMessageRate(ws)) return ws.close(1008, 'message rate exceeded');
    try { handleMsg(ws, raw); } catch (e) { console.error('MSG ERROR:', e.stack); error(ws, '服务器内部错误'); }
  });
  const url = new URL(req.url, 'http://x');
  const code = (url.searchParams.get('room') || '').toUpperCase();
  const name = (url.searchParams.get('name') || '').trim().slice(0, 12) || '玩家';
  let room = rooms.get(code);
  if (!code) {
    if (rooms.size >= MAX_ROOMS) { error(ws, '服务器房间数已达上限，请稍后再试'); return ws.close(); }
    send(ws, { type: 'created', code: createRoom(url.searchParams.get('mode')) });
    return;
  }
  if (!room) { error(ws, '房间不存在或已解散'); return ws.close(); }
  const token = url.searchParams.get('token');
  const old = token && [...room.players, ...room.spectators].find(p => p.kind !== 'bot' && p.token === token);
  if (old) {
    const previous = old.ws;
    clearTimeout(old.disconnectTimer);
    clearTimeout(old.takeoverTimer);
    clearTimeout(room.emptyTimer);
    old.botTakeover = false;
    old.controlEpoch = (old.controlEpoch || 0) + 1;
    old.ws = ws;
    attach(ws, room, old);
    if (previous && previous !== ws) previous.close(4001, 'seat resumed elsewhere');
    send(ws, { type: 'me', token: old.token, spectator: old.kind === 'spectator' });
    send(ws, { type: 'joined', code, room: publicRoom(room, old) });
    if (room.game) { if (old.kind === 'human') addLog(room.game, old.gp(), '重新连接'); broadcast(room); }
    else broadcastRoom(room);
    return;
  }
  const password = url.searchParams.get('password') || '';
  if (room.password && password !== room.password) { error(ws, '房间密码错误'); return ws.close(); }
  if (room.game || room.mode === 'ai-only' || room.players.length >= 8 || url.searchParams.get('spectate') === '1') {
    const pl = { ws, name, seatId: randomBytes(8).toString('hex'), kind: 'spectator', token: randomBytes(16).toString('base64url'), gamePlayerId: null };
    room.spectators.push(pl); attach(ws, room, pl);
    clearTimeout(room.emptyTimer);
    if (!room.hostToken) room.hostToken = pl.token;
    send(ws, { type: 'me', token: pl.token, spectator: true });
    send(ws, { type: 'joined', code, room: publicRoom(room, pl) });
    broadcastRoom(room);
    if (room.game) broadcast(room);
    return;
  }
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
  const controlEpoch = bot.controlEpoch || 0;
  const state = serialize(game, playerId);
  const actor = state.viewer;
  const runId = room.botActionSeq = (room.botActionSeq || 0) + 1;
  const fallback = ruleBotAction(state);
  if (!fallback) return;
  const profile = getBotProfile(bot.difficulty);
  bot.memory = reconcileBotMemory(bot.memory, state);
  if (bot.budget?.gameId !== game.id || bot.budget?.turn !== game.turn)
    bot.budget = { gameId: game.id, turn: game.turn, calls: 0 };
  room.botBusy = true;
  try {
    let decision = null;
    const action = bot.botTakeover ? fallback : await profile.decide({
      state, config: AI_CONFIG, fallback,
      memory: bot.memory,
      remainingCalls: Math.max(0, (profile.ai?.maxTurnCalls || 0) - bot.budget.calls),
      onUsage: count => { bot.budget.calls += count; },
      onDecision: summary => { decision = summary; },
      onProgress: progress => {
        if ((bot.controlEpoch || 0) === controlEpoch)
          broadcastBotProgress(room, game, actor, { ...progress, runId });
      },
      onFallback: reason => {
        if (room.game === game && bot.lastFallbackReason !== reason) addLog(game, null, `${bot.name}：${reason}，已由规则机器人接手`);
        bot.lastFallbackReason = reason;
      },
    });
    if (action !== fallback) bot.lastFallbackReason = null;
    if (room.game !== game || bot.gamePlayerId !== playerId || (bot.controlEpoch || 0) !== controlEpoch || game.winner != null) return;
    // A slow model response must never accept a replacement offer's different terms.
    if (offer && offer !== game.offer && ['acceptOffer', 'rejectOffer'].includes(action?.type)) return;
    const err = playerAct(game, playerId, action || fallback);
    if (err) {
      const freshFallback = ruleBotAction(serialize(game, playerId));
      if (freshFallback) playerAct(game, playerId, freshFallback);
    } else {
      const after = serialize(game, playerId);
      bot.memory = decision ? rememberBotDecision(bot.memory, state, after, decision) : reconcileBotMemory(bot.memory, after);
      if (profile.ai && game.winner == null) {
        const revision = bot.memoryRevision = (bot.memoryRevision || 0) + 1;
        setImmediate(() => {
          if (room.game !== game || bot.memoryRevision !== revision || (bot.controlEpoch || 0) !== controlEpoch) return;
          try { bot.memory = reflectBotMemory(bot.memory, after); }
          catch (error) { console.error('BOT MEMORY ERROR:', error); }
        });
      }
      if (decision && profile.ai?.agentLoop) {
        if (bot.thoughtTurn !== game.turn) { bot.thoughtTurn = game.turn; bot.thoughtCount = 0; }
        const thought = formatBotCommentary({ ...decision, state });
        if (thought && bot.thoughtCount < 2) {
          addLog(game, game.players.find(p => p.id === playerId), thought, 'bot-thought',
            { tools: decision.tools.filter(tool => Object.hasOwn(AGENT_TOOLS, tool)).slice(0, 2) });
          bot.thoughtCount++;
        }
      }
    }
  } finally {
    room.botBusy = false;
    broadcastBotProgress(room, game, actor, { phase: 'done', runId });
    broadcast(room);
  }
}

function addBotPlayer(room, spec) {
  const profile = getBotProfile(spec.difficulty || (spec.type === 'rule' ? 'low' : DEFAULT_BOT_DIFFICULTY));
  const difficulty = profile.ai?.id || 'low';
  const bot = {
    ws: null,
    name: 'AI',
    seatId: randomBytes(8).toString('hex'),
    token: randomBytes(8).toString('base64url'),
    kind: 'bot',
    difficulty,
    gamePlayerId: null,
    gp() { return room.game ? room.game.players.find((p) => p.id === bot.gamePlayerId) : null; }
  };
  room.players.push(bot);
  syncBotRoster(room);
  return bot;
}

function syncBotRoster(room) {
  room.settings.botCount = room.players.filter(p => p.kind === 'bot').length;
  room.settings.withBots = room.settings.botCount > 0;
}

function transferHost(room) {
  const people = [...room.players, ...room.spectators].filter(p => p.kind !== 'bot');
  room.hostToken = (people.find(p => p.ws) || people[0])?.token || null;
}

function createRoom(requestedMode) {
  const mode = requestedMode === 'ai-only' ? 'ai-only' : 'multiplayer';
  let code;
  do { code = genCode(); } while (rooms.has(code));
  const room = { code, mode, players: [], spectators: [], game: null, hostToken: null, password: '', settings: { mapSize: 'small', targetVP: 10, startBonus: 'none', withBots: mode === 'ai-only', botCount: mode === 'ai-only' ? 4 : 2, botDifficulty: DEFAULT_BOT_DIFFICULTY } };
  if (mode === 'ai-only') for (let i = 0; i < 4; i++) addBotPlayer(room, {});
  else syncBotRoster(room);
  rooms.set(code, room);
  // Rooms nobody joins would otherwise stay in memory and the lobby forever.
  scheduleEmptyRoomCleanup(room, UNCLAIMED_ROOM_MS);
  return code;
}
function joinPlayer(room, ws, name) {
  const pl = { ws, name, seatId: randomBytes(8).toString('hex'), token: randomBytes(8).toString('base64url'), kind: 'human', gamePlayerId: null, botTakeover: false, controlEpoch: 0, gp() { return room.game ? room.game.players.find(p => p.id === pl.gamePlayerId) : null; } };
  clearTimeout(room.emptyTimer);
  room.players.push(pl);
  if (!room.hostToken) room.hostToken = pl.token;
  ws.__pl = pl; ws.__room = room;
  return pl;
}
function attach(ws, room, pl) { ws.__pl = pl; ws.__room = room; }
function publicRoom(room, viewer) {
  return { code: room.code, mode: room.mode, settings: { ...room.settings }, locked: !!room.password,
    started: !!room.game, rosterVersion: 1, isHost: isHost(room, viewer), viewerKind: viewer?.kind,
    viewerSeatId: viewer?.seatId, spectatorCount: room.spectators.filter(p => p.ws).length,
    players: room.players.map(p => ({ seatId: p.seatId, name: p.name, kind: p.kind || 'human',
      difficulty: p.kind === 'bot' ? p.difficulty : null, isHost: isHost(room, p), connected: !!p.ws || p.kind === 'bot' })) };
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
      if (botDifficulty !== undefined && (typeof botDifficulty !== 'string' || !getBotProfile(botDifficulty))) return error(ws, '未知的 AI 难度');
      if (password !== undefined && password !== null && typeof password !== 'string') return error(ws, '房间密码无效');
      let count = room.settings.botCount;
      if (Number.isInteger(botCount) && botCount >= 0 && botCount <= 8) count = botCount;
      if (withBots === false && room.mode !== 'ai-only') count = 0;
      if (withBots === true && !count) count = 2;
      if (count + room.players.filter(p => p.kind === 'human').length > 8) return error(ws, '最多只能有 8 名玩家和机器人');
      if (typeof mapSize === 'string' && Object.hasOwn(MAP_LAYOUTS, mapSize)) room.settings.mapSize = mapSize;
      if ([7, 10, 12, 15].includes(targetVP)) room.settings.targetVP = targetVP;
      if (['none', 'random1', 'random2'].includes(startBonus)) room.settings.startBonus = startBonus;
      if (password !== undefined) room.password = String(password || '').trim().slice(0, 24);
      // Keep old clients usable; new clients manage individual roster entries.
      if (botDifficulty !== undefined) {
        room.settings.botDifficulty = getBotProfile(botDifficulty).ai?.id || 'low';
        for (const bot of room.players.filter(p => p.kind === 'bot')) bot.difficulty = room.settings.botDifficulty;
      }

      while (room.players.filter(p => p.kind === 'bot').length > count) {
        room.players.splice(room.players.findLastIndex(p => p.kind === 'bot'), 1);
      }
      while (room.players.filter(p => p.kind === 'bot').length < count) addBotPlayer(room, { difficulty: room.settings.botDifficulty });
      syncBotRoster(room);
      broadcastRoom(room);
      break;
    }
    case 'addBot':
    case 'updateBot':
    case 'removeBot': {
      if (!isHost(room, pl)) return error(ws, '只有房主可以管理 AI');
      if (room.game) return error(ws, '对局开始后不能修改席位');
      if (msg.type !== 'removeBot' && (typeof msg.difficulty !== 'string' || !getBotProfile(msg.difficulty))) return error(ws, '未知的 AI 难度');
      if (msg.type === 'addBot') {
        if (room.players.length >= 8) return error(ws, '房间已满，最多 8 个席位');
        addBotPlayer(room, { difficulty: msg.difficulty });
      } else {
        const bot = room.players.find(p => p.kind === 'bot' && p.seatId === msg.seatId);
        if (!bot) return error(ws, 'AI 席位不存在');
        if (msg.type === 'removeBot') room.players = room.players.filter(p => p !== bot);
        else bot.difficulty = getBotProfile(msg.difficulty).ai?.id || 'low';
      }
      syncBotRoster(room); broadcastRoom(room); break;
    }
    case 'setRole': {
      if (room.game) return error(ws, '对局开始后不能更换身份');
      if (!['player', 'spectator'].includes(msg.role)) return error(ws, '身份无效');
      if (msg.role === 'player' && pl.kind === 'spectator') {
        if (room.mode === 'ai-only') return error(ws, '纯 AI 房间只能观战');
        if (room.players.length >= 8) return error(ws, '房间已满，请等待空闲席位');
        room.spectators = room.spectators.filter(p => p !== pl);
        pl.kind = 'human'; pl.gp = () => room.game?.players.find(p => p.id === pl.gamePlayerId);
        room.players.push(pl);
      } else if (msg.role === 'spectator' && pl.kind === 'human') {
        room.players = room.players.filter(p => p !== pl);
        pl.kind = 'spectator'; room.spectators.push(pl);
      }
      send(ws, { type: 'me', token: pl.token, spectator: pl.kind === 'spectator' });
      broadcastRoom(room); break;
    }
    case 'leaveRoom': {
      if (room.game) return error(ws, '对局已开始，席位将保留以便重连');
      room.players = room.players.filter(p => p !== pl);
      room.spectators = room.spectators.filter(p => p !== pl);
      clearTimeout(pl.disconnectTimer);
      if (room.hostToken === pl.token) transferHost(room);
      ws.__pl = null; ws.__room = null;
      send(ws, { type: 'left' }); ws.close();
      broadcastRoom(room); scheduleEmptyRoomCleanup(room);
      break;
    }
    case 'rename': {
      if (pl.kind !== 'human') return error(ws, '观战者不能改名');
      // The game keeps its own copy of names, so renaming mid-game would desync logs and board.
      if (room.game) return error(ws, '对局开始后不能改名');
      if (typeof msg.name !== 'string') return error(ws, '名字无效');
      pl.name = msg.name.trim().slice(0, 12) || pl.name;
      broadcastRoom(room);
      break;
    }
    case 'start': {
      if (!isHost(room, pl)) return error(ws, '只有房主可以开始游戏');
      if (room.game) return error(ws, '游戏已开始');
      if (room.players.some(p => p.kind === 'human' && !p.ws)) return error(ws, '请等待离线玩家重连；45 秒后会自动释放席位');
      const bots = room.mode !== 'ai-only' && !room.players.some(p => p.kind === 'bot') && Array.isArray(msg.bots) ? msg.bots : [];
      // Validate every spec before adding any, so a bad entry cannot leave partial bots in the lobby.
      const validSpec = spec => spec && typeof spec === 'object'
        && ['difficulty', 'type', 'name'].every(k => spec[k] === undefined || typeof spec[k] === 'string');
      if (!bots.every(validSpec)) return error(ws, '机器人配置无效');
      if (bots.some(spec => !getBotProfile(spec.difficulty || (spec.type === 'rule' ? 'rule' : DEFAULT_BOT_DIFFICULTY)))) return error(ws, '未知的 AI 难度');
      if (room.players.length + bots.length < 2) return error(ws, '至少需要 2 名玩家或机器人');
      if (room.players.length + bots.length > 8) return error(ws, '最多只能有 8 名玩家和机器人');
      for (const spec of bots) addBotPlayer(room, spec || {});
      const humanPlayers = room.players.filter(p => p.kind === 'human');
      room.game = createGame({ ...room.settings, playerNames: room.players.map(p => p.name), playerKinds: room.players.map(p => p.kind), playerDifficulties: room.players.map(p => p.difficulty) });
      room.players.forEach((p, i) => p.gamePlayerId = room.game.players[i].id);
      addLog(room.game, null, `对局配置：${humanPlayers.length} 名玩家 · ${room.players.filter(p => p.kind === 'bot').length} 个机器人`);
      broadcastRoom(room); broadcast(room);
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
      room.game = createGame({ ...room.settings, playerNames: room.players.map(p => p.name), playerKinds: room.players.map(p => p.kind), playerDifficulties: room.players.map(p => p.difficulty) });
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
      if (room.hostToken === pl.token) transferHost(room);
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
      if (room.hostToken === pl.token) transferHost(room);
      broadcastRoom(room);
      scheduleEmptyRoomCleanup(room);
    }, 45000);
    pl.disconnectTimer.unref();
  } else {
    addLog(room.game, pl.gp(), `${pl.name} 断线，${Math.ceil(DISCONNECT_TAKEOVER_MS / 1000)} 秒后由规则机器人暂时接管`);
    clearTimeout(pl.takeoverTimer);
    pl.takeoverTimer = setTimeout(() => {
      if (pl.ws || pl.botTakeover || !room.game || room.game.winner != null) return;
      pl.botTakeover = true;
      pl.controlEpoch = (pl.controlEpoch || 0) + 1;
      addLog(room.game, pl.gp(), `${pl.name} 暂时离线，规则机器人已接管`);
      broadcast(room);
    }, DISCONNECT_TAKEOVER_MS);
    pl.takeoverTimer.unref();
    broadcast(room);
    scheduleEmptyRoomCleanup(room);
  }
}
wss.on('connection', ws => { ws.on('close', () => onDisconnect(ws)); });

server.listen(PORT, HOST, () => console.log(`卡坦岛服务器已启动: http://${HOST}:${PORT}`));

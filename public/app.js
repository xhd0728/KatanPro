/* KatanPro 前端 */
const $ = (s) => document.querySelector(s);
const RES = ['wood', 'brick', 'sheep', 'wheat', 'ore'];
const CN = { wood: '木材', brick: '砖块', sheep: '羊毛', wheat: '小麦', ore: '矿石', desert: '沙漠' };
const IC = { wood: '🌲', brick: '🧱', sheep: '🐑', wheat: '🌾', ore: '🪨', desert: '🏜️' };
const HEXC = { wood: '#33513e', brick: '#96523f', sheep: '#6b8a55', wheat: '#b3934a', ore: '#66707e', desert: '#a89068' };
const DEV = { knight: ['骑士', '🛡️'], vp: ['胜利点', '⭐'], road: ['筑路工', '🛤️'], year: ['丰收之年', '🌻'], mono: ['垄断之年', '🏦'] };
const DICEU = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
const BANK_SIZE = 29;
// Presentation-only mapping also updates pieces in games held by an older server.
const PLAYER_COLOR_DISPLAY = {
  '#c05f4f':'#cf342d', '#3f7b9b':'#1763c0', '#568361':'#197344', '#b5843e':'#b95d00',
  '#896699':'#733bb3', '#a69836':'#92720a', '#378c85':'#00838b', '#b45f85':'#c32e7a',
};
const playerColor = color => PLAYER_COLOR_DISPLAY[color] || color;
const MAP_NAMES = {small:'小地图',medium:'中地图',large:'大地图',epic:'超大大陆',twin:'双岛地峡'};
const MAP_DESCRIPTIONS = {
  small:'19 块地形 · 9 座港口。紧凑的经典岛屿，适合 2–4 人。',
  medium:'30 块地形 · 11 座港口。纵向延展的海岸，适合 5–6 人。',
  large:'37 块地形 · 12 座港口。完整的大岛，适合 7–8 人。',
  epic:'61 块地形 · 18 座港口。广阔完整大陆，适合 6–8 人长局；手机可双指放大后建造。',
  twin:'73 块地形 · 20 座港口。两座大岛由中央地峡连通，可沿陆地修路争夺通道；适合 6–8 人。',
};
const EXP = { 2: 2.78, 3: 5.56, 4: 8.33, 5: 11.11, 6: 13.89, 7: 16.67, 8: 13.89, 9: 11.11, 10: 8.33, 11: 5.56, 12: 2.78 };
const hasBundle = (res, bundle) => RES.every(r => (res?.[r] || 0) >= (bundle?.[r] || 0));
const bundleLabel = bundle => RES.filter(r => bundle?.[r]).map(r => `${resourceIcon(r)} ${bundle[r]}`).join(' + ');

const ICON_PATHS = {
  road: '<path d="m5 20 4-16m6 0 4 16M12 5v3m0 3v3m0 3v3"/>',
  settlement: '<path d="m3 11 9-8 9 8M5 10v11h14V10M9 21v-7h6v7"/>',
  city: '<path d="M3 21V9h7v12M10 21V3h10v18M1 21h22M6 12v2m0 3v1M14 7h2m-2 4h2m-2 4h2"/>',
  cards: '<rect x="7" y="3" width="13" height="17" rx="2"/><path d="M7 6H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h11M13.5 7l3 4-3 4-3-4Z"/>',
  trade: '<path d="M3 7h17l-4-4m5 14H4l4 4M20 7l-4 4M4 17l4-4"/>',
  end: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  knight: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6ZM12 7v9M8 11h8"/>',
  wheat: '<path d="M12 21V3M12 9c-5 0-7-3-6-6 4 0 6 3 6 6Zm0 5c5 0 7-3 6-6-4 0-6 3-6 6Zm0 5c-5 0-7-3-6-6 4 0 6 3 6 6Z"/>',
  mono: '<path d="m3 8 9-5 9 5H3Zm0 13h18M5 10v8m7-8v8m7-8v8"/>',
  dice: '<rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="8" cy="8" r="1"/><circle cx="16" cy="8" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="8" cy="16" r="1"/><circle cx="16" cy="16" r="1"/>'
};
function icon(type) { return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${ICON_PATHS[type] || ICON_PATHS.cards}</svg>`; }
function resourceIcon(r) { return `<img class="resource-icon" src="/assets/${r}.svg" alt="${CN[r]}" draggable="false"/>`; }
let actionPending = false, retryAllowed = true, lastDiceStamp = null, pendingBuild = null;
let ws = null, S = null, myToken = null, pickMode = null, hoverTarget = null, modalKind = null;
let name = localStorage.getItem('catan_name') || '';
let reconnectTimer = null, reconnectAttempts = 0;
let reconnectPassword = '';
let roomCode = (new URLSearchParams(location.search).get('room') || '').toUpperCase();
let currentRoom = null;
function esc(value) {
  return String(value ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}

function toast(msg, ok) {
  const d = document.createElement('div');
  d.className = 'toast' + (ok ? ' ok' : '');
  d.textContent = msg;
  $('#toasts').appendChild(d);
  setTimeout(() => d.remove(), 3400);
}
function unavailable(reason = '') {
  return `aria-disabled="${!!reason}"${reason ? ` data-disabled-reason="${esc(reason)}" title="${esc(reason)}"` : ''}`;
}
function setUnavailable(button, reason = '') {
  button.disabled = false;
  button.setAttribute('aria-disabled', String(!!reason));
  button.dataset.disabledReason = reason;
  button.title = reason;
}
// Keep unavailable actions focusable and explain them on mouse, touch or keyboard activation.
document.addEventListener('click', e => {
  const button = e.target.closest('[aria-disabled="true"][data-disabled-reason]');
  if (!button) return;
  e.preventDefault(); e.stopImmediatePropagation(); toast(button.dataset.disabledReason);
}, true);
document.addEventListener('pointerdown', e => {
  const field = e.target.closest('.fld,.checkline')?.querySelector(':disabled');
  if (field) toast(field.title || '只有房主可以修改此设置');
}, true);
function resourceShortage(cost) {
  const missing = RES.filter(r => (me()?.res?.[r] || 0) < (cost[r] || 0));
  return missing.length ? '资源不足：还缺 ' + missing.map(r => `${CN[r]} ${cost[r] - (me()?.res?.[r] || 0)} 张`).join('、') : '';
}
function actionReason(action) {
  const m = me();
  if (!m) return '你正在观战，不能操作其他玩家的回合';
  if (S.phase === 'over') return '本局已结束';
  if (S.phase === 'setup') return '请先完成初始摆放';
  if (S.viewer !== S.current) return '还没轮到你，请等待自己的回合';
  if (S.discardCount) return m.needDiscard ? '请先选择并确认要弃掉的资源卡' : '请等待其他玩家完成弃牌';
  if (S.robberPending) return '请先移动强盗';
  if (S.stealPending) return '请先选择抢牌目标';
  if (S.roadBuildLeft && action !== 'road') return '请先完成筑路工的免费道路';
  if (action === 'roll') return S.rolled ? '本回合已经掷过骰子' : '';
  if (!S.rolled && !(action === 'road' && S.roadBuildLeft)) return '请先掷骰子';
  if (action === 'endTurn' && S.offer) return '请先等待交易回复，或取消当前提案';
  const costs = {road:{wood:1,brick:1},settlement:{wood:1,brick:1,sheep:1,wheat:1},city:{wheat:2,ore:3},buyDev:{sheep:1,wheat:1,ore:1}};
  if (!costs[action]) return '';
  const limit = {road:[m.roads,15,'道路'],settlement:[m.settlements,5,'定居点'],city:[m.cities,4,'城市']}[action];
  if (limit && limit[0] >= limit[1]) return `${limit[2]}已达到 ${limit[1]} 个的上限`;
  if (action === 'buyDev' && !S.deckLeft) return '发展卡牌堆已空';
  const missing = action === 'road' && S.roadBuildLeft ? '' : resourceShortage(costs[action]);
  if (missing) return missing;
  if (action === 'buyDev') return '';
  if (S.legal?.[action]?.length) return '';
  return {road:'没有可连接的空路段；道路不能穿过对手的建筑',settlement:'没有合法交点：需要连接自己的道路，且与其他建筑至少隔一条边',city:'没有可升级的定居点'}[action];
}
function connectionStatus(text, offline = false) {
  $('#connectionStatus').textContent = text;
  $('#connectionStatus').classList.toggle('offline', offline);
}
function connect(code, password = '') {
  if (ws) { ws.onclose = null; ws.close(); }
  clearTimeout(reconnectTimer); reconnectTimer = null;
  retryAllowed = true;
  if (password) reconnectPassword = password;
  if (code && !password) password = reconnectPassword;
  connectionStatus('连接中', true);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  let u = `${proto}://${location.host}/ws?name=${encodeURIComponent(name)}${code ? '&room=' + code : ''}${password ? '&password=' + encodeURIComponent(password) : ''}`;
  if (!code) u += '&mode=' + encodeURIComponent(document.querySelector('[name="createMode"]:checked').value);
  if (code && myToken) u += '&token=' + encodeURIComponent(myToken);
  const socket = ws = new WebSocket(u);
  ws.onopen = () => { reconnectAttempts = 0; connectionStatus('已连接'); };
  ws.onmessage = (e) => {
    if (ws !== socket) return;
    let m; try { m = JSON.parse(e.data); } catch { return toast('收到无效服务器消息'); }
    if (m.type === 'created') { location.href = '/?room=' + m.code; }
    else if (m.type === 'me') {
      myToken = m.token;
      if (code && m.token) localStorage.setItem('catan_tk_' + code, m.token);
    }
    else if (m.type === 'joined' || m.type === 'room') { showRoom(m.room); }
    else if (m.type === 'state') {
      actionPending = false;
      if (S && (S.id !== m.state.id || S.current !== m.state.current || m.state.eventPending)) {
        pendingBuild = null;
        if (!['discard', 'steal', 'win'].includes(modalKind)) closeModal();
      }
      syncRobberMotion(S, m.state);
      S = m.state; showGame();
      if (S.roadBuildLeft && S.viewer === S.current) pickMode = 'road';
      render();
      if (modalKind === 'trade') window.refreshTrade?.();
    }
    else if (m.type === 'error') {
      actionPending = false; toast(m.msg);
      if (/密码|不存在|已满/.test(m.msg)) { retryAllowed = false; connectionStatus('未连接', true); }
      if (/密码/.test(m.msg)) $('#passwordInput').focus();
    }
  };
  ws.onclose = e => {
    if (ws !== socket) return;
    actionPending = false; connectionStatus('连接断开', true);
    if (e.code === 4001) { retryAllowed = false; toast('此席位已在另一个页面打开'); }
    if (!retryAllowed || !roomCode || reconnectTimer) return;
    toast('连接断开，正在重连…');
    const delay = Math.min(15000, 1500 * 2 ** Math.min(reconnectAttempts++, 3));
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(roomCode); }, delay);
  };
}
window.addEventListener('online', () => {
  if (roomCode && (!ws || ws.readyState !== WebSocket.OPEN) && !reconnectTimer) connect(roomCode);
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && roomCode && (!ws || ws.readyState !== WebSocket.OPEN) && !reconnectTimer) connect(roomCode);
});
/* ---------- 大厅 ---------- */
$('#nameInput').value = name;
$('#nameInput').addEventListener('input', e => { name = e.target.value.trim(); localStorage.setItem('catan_name', name); });
async function loadRooms() {
  const list = $('#roomList');
  try {
    const rooms = await fetch('/api/rooms', { cache: 'no-store' }).then(r => r.json());
    $('#roomCount').textContent = `${rooms.length} 个`;
    list.innerHTML = rooms.length ? rooms.map(r => `<div class="room-item"><div><b>${r.locked ? '🔒' : '🌐'} ${r.code}</b><span>${r.mode === 'ai-only' ? `${r.settings.botCount} 位 AI · 观战` : `${r.players}/${r.maxPlayers} 人`} · ${MAP_NAMES[r.settings.mapSize] || '小地图'}</span></div><button class="btn tiny" onclick="quickJoin('${r.code}', ${r.locked})">${r.mode === 'ai-only' ? '观战' : '加入'}</button></div>`).join('') : '<div class="empty-state">暂无公开房间，创建一个吧</div>';
  } catch { list.innerHTML = '<div class="empty-state">大厅暂时不可用</div>'; }
}
window.quickJoin = (code, locked) => { $('#codeInput').value = code; if (locked) $('#passwordInput').focus(); else joinRoom(); };
function joinRoom() {
  const code = $('#codeInput').value.trim().toUpperCase();
  const password = $('#passwordInput').value.trim();
  if (!/^[A-HJ-NP-Z2-9]{4}$/.test(code)) return toast('请输入有效的 4 位房间码');
  if (!name) return toast('先输入昵称');
  roomCode = code; myToken = localStorage.getItem('catan_tk_' + code);
  connect(code, password);
}
$('#createBtn').onclick = async () => {
  if (!name) return toast('先输入昵称');
  const supportsProfiles = await botCatalogReady;
  if (document.querySelector('[name="createMode"]:checked').value === 'ai-only' && !supportsProfiles) return toast('当前服务版本不支持纯 AI 观战，请重启服务后重试');
  connect(null);
};
$('#joinBtn').onclick = joinRoom;
$('#refreshRooms').onclick = loadRooms;
loadRooms();
function showRoom(r) {
  currentRoom = r;
  roomCode = r.code;
  if (location.search !== '?room=' + r.code) history.replaceState(null, '', '/?room=' + r.code);
  $('#lobbyMain').hidden = true;
  $('#roomView').hidden = false;
  $('#roomCode').textContent = r.code;
  const isHost = r.isHost;
  const aiOnly = r.mode === 'ai-only';
  $('#roomTitle').textContent = aiOnly ? '让 AI 开拓，你来观战' : '等待伙伴入座';
  $('#roomRole').textContent = isHost ? (aiOnly ? '房主 · 观战' : '房主') : aiOnly ? '观战者' : '玩家';
  $('#roomPlayers').innerHTML = aiOnly ? `<span class="chip">${r.settings.botCount} 位 AI · ${r.spectatorCount} 人观战</span>` : r.players.map(p => `<span class="chip">${esc(p.name)}${p.connected === false ? ' · 离线' : ''}</span>`).join('') || '<span class="chip">虚位以待</span>';
  $('#setMap').value = r.settings.mapSize; $('#setVP').value = r.settings.targetVP; $('#setBonus').value = r.settings.startBonus;
  $('#mapDescription').textContent = MAP_DESCRIPTIONS[r.settings.mapSize] || '';
  ['setMap', 'setVP', 'setBonus', 'setPassword'].forEach(id => $('#' + id).disabled = !isHost);
  setUnavailable($('#startBtn'), isHost ? '' : '只有房主可以开始游戏');
  $('#hostTip').textContent = isHost ? (aiOnly ? '全部席位由 AI 执行，你负责设置牌桌并观战；也可邀请朋友一起观看。' : '你是房主，可以修改设置并开启游戏') : '当前房主正在准备，只有房主可以修改设置和开启游戏';
  $('#startBtn').textContent = aiOnly ? '开始 AI 对局 →' : '启程，开始游戏 →';
  // Old running servers serve the current assets but omit the newer AI settings.
  // Preserve the local choices when those fields are absent from their room messages.
  if (typeof r.settings.withBots === 'boolean') soloMode.checked = r.settings.withBots;
  if (Number.isInteger(r.settings.botCount)) botCount.value = String(r.settings.botCount);
  if (r.settings.botDifficulty) botDifficulty.value = r.settings.botDifficulty;
  syncBotOptions();
}
const settingKeys = {setMap:'mapSize',setVP:'targetVP',setBonus:'startBonus',setPassword:'password'};
Object.entries(settingKeys).forEach(([id,key]) => $('#' + id).addEventListener('change', () => {
  send({type:'settings',settings:{[key]:id==='setVP'?+$('#'+id).value:$('#'+id).value}});
}));
const soloMode = $('#soloMode');
const botCount = $('#botCount');
const botDifficulty = $('#botDifficulty');
let botProfiles = [
  {id:'llm',description:'由服务端配置的大模型决策，超时或无效动作时自动回退。'},
  {id:'rule',description:'使用本地规则策略，无需外部模型，行动更快。'},
];
const botCatalogReady = fetch('/api/bot-profiles').then(r => { if (!r.ok) throw new Error(); return r.json(); }).then(catalog => {
  const selected = currentRoom?.settings.botDifficulty || botDifficulty.value || catalog.defaultDifficulty;
  botProfiles = catalog.profiles;
  botDifficulty.innerHTML = botProfiles.map(p => `<option value="${esc(p.id)}">${esc(p.label)}${p.id === catalog.defaultDifficulty ? '（默认）' : ''}</option>`).join('');
  botDifficulty.value = selected;
  syncBotOptions();
  return true;
}).catch(() => false);
function syncBotOptions() {
  const aiOnly = currentRoom?.mode === 'ai-only';
  const isHost = currentRoom?.isHost ?? true;
  if (aiOnly) soloMode.checked = true;
  const enabled = soloMode.checked;
  const spaces = aiOnly ? 8 : Math.max(0, 8 - (currentRoom?.players.length || 1));
  [...botCount.options].forEach(o => { o.disabled = +o.value > spaces || (aiOnly && +o.value < 2); o.hidden = o.disabled; });
  if (!botCount.value) botCount.value = String(aiOnly ? 4 : 2);
  if (!botDifficulty.value) botDifficulty.value = 'llm';
  if (+botCount.value > spaces) botCount.value = String(Math.max(aiOnly ? 2 : 1, spaces));
  soloMode.disabled = aiOnly || !isHost;
  soloMode.title = aiOnly ? 'AI 观战模式下所有席位都由机器人参与' : !isHost ? '只有房主可以设置 AI' : '';
  const reason = !isHost ? '只有房主可以设置 AI' : !enabled ? '请先勾选“邀请机器人入座”' : !spaces ? '房间已满，没有空闲席位' : '';
  for (const field of [botCount,botDifficulty]) { field.disabled = !!reason; field.title = reason; }
  $('#botDescription').textContent = botProfiles.find(p => p.id === botDifficulty.value)?.description || '';
}
soloMode.addEventListener('change', () => { syncBotOptions(); send({type:'settings',settings:{withBots:soloMode.checked}}); });
botCount.addEventListener('change', () => send({type:'settings',settings:{botCount:+botCount.value}}));
botDifficulty.addEventListener('change', () => { syncBotOptions(); send({type:'settings',settings:{botDifficulty:botDifficulty.value}}); });
syncBotOptions();
$('#startBtn').onclick = () => {
  const available = Math.max(0, 8 - (currentRoom?.players.length || 1));
  const bots = soloMode.checked ? Array.from({ length: Math.min(available, +botCount.value || 1) }, () => ({ difficulty: botDifficulty.value, type: botDifficulty.value === 'rule' ? 'rule' : 'ai' })) : [];
  send({ type: 'start', bots });
};
$('#copyLink').onclick = () => copyLink();
$('#leaveRoom').onclick = () => { location.href = '/'; };
$('#shareBtn').onclick = () => copyLink();
function copyLink() {
  const url = location.origin + '/?room=' + roomCode;
  if (!navigator.clipboard?.writeText) { prompt('复制链接发给朋友：', url); return; }
  navigator.clipboard.writeText(url).then(() => toast('邀请链接已复制', true), () => prompt('复制链接发给朋友：', url));
}

function send(obj) {
  if (!ws || ws.readyState !== 1) { toast('连接尚未恢复，请稍后重试'); return false; }
  ws.send(JSON.stringify(obj)); return true;
}
function act(a) {
  if (actionPending) return false;
  actionPending = send({ type: 'action', action: a });
  return actionPending;
}

/* ---------- 对局 ---------- */
function showGame() {
  $('#lobby').hidden = true;
  $('#game').hidden = false;
  $('#hRoom').textContent = roomCode;
}
let lastViewportWidth = window.innerWidth;
function resetBoardView() {
  if (window.innerWidth !== lastViewportWidth) { needResizeFit = true; lastViewportWidth = window.innerWidth; }
  hoverTarget = null;
  if (S) requestAnimationFrame(drawBoard);
}
window.addEventListener('resize', resetBoardView);
window.addEventListener('orientationchange', () => { needResizeFit = true; resetBoardView(); });
function me() { return S && S.viewer >= 0 ? S.players[S.viewer] : null; }

let winDismissed = false;
function render() {
  S.players.forEach(p => { p.color = playerColor(p.color); });
  S.log.forEach(entry => { entry.color = playerColor(entry.color); });
  if (S.offer) S.offer.fromColor = playerColor(S.offer.fromColor);
  const spectating = !me();
  if ($('#game').classList.contains('spectating') !== spectating) needResizeFit = true;
  $('#game').classList.toggle('spectating', spectating);
  if (S.winner == null) winDismissed = false;
  if (S.phase !== 'play' || S.viewer !== S.current || (!S.rolled && !S.roadBuildLeft)) pickMode = null;
  else if (pickMode && !S.legal?.[pickMode === 'road' ? 'road' : pickMode]?.length) pickMode = null;
  renderHeader(); renderSidebar(); renderHand(); renderActionBar(); renderOfferBar(); renderModals(); drawBoard(); renderHint(); renderBuildConfirm();
}

function activePlayer() { return S.phase === 'setup' ? S.legal?.setupPlayer ?? S.current : S.current; }
function renderHeader() {
  const die = n => {
    const positions = {1:[4],2:[0,8],3:[0,4,8],4:[0,2,6,8],5:[0,2,4,6,8],6:[0,2,3,5,6,8]}[n];
    return `<span class="dice-tile" aria-label="${n} 点">${Array.from({length:9},(_,i)=>`<i ${positions.includes(i) ? 'class="dice-pip"' : ''}></i>`).join('')}</span>`;
  };
  const stamp = S.dice?.when ?? null;
  if (stamp !== lastDiceStamp || !$('#diceView').innerHTML) {
    $('#diceView').innerHTML = S.dice ? `<span class="dice-caption">本轮骰点</span>${die(S.dice.a)}${die(S.dice.b)}<strong class="dice-total">${S.dice.a + S.dice.b}</strong>` : '<span class="dice-caption">资源产出</span><span class="dice-pending">等待掷骰</span>';
    $('#diceView').classList.toggle('rolled', !!S.dice); lastDiceStamp = stamp;
  }
  const cur = S.players[activePlayer()];
  const ph = S.phase === 'setup' ? '摆放' : S.phase === 'over' ? '已结束' : `回合 ${S.turn}`;
  $('#turnBanner').innerHTML = `<span class="turn-pill">${ph}</span><span><b style="color:${cur.color}">${esc(cur.name)}</b>${S.phase === 'over' ? '' : ' 的回合'}</span>`;
  $('#gameGoal').textContent = `${S.players.length} 位玩家 · 目标 ${S.settings.targetVP} 分`;
  $('#boardSubtitle').textContent = `${S.map.hexes.length} 块地形 · ${S.map.ports.length} 座港口`;
}
function renderSidebar() {
  $('#playerCards').innerHTML = S.players.map((p, i) => `<div class="pcard ${i === activePlayer() ? 'cur' : ''}" style="--player-color:${p.color}">
    <div class="top"><span class="avatar" aria-label="玩家 ${i + 1}" title="玩家 ${i + 1}">${i + 1}</span><span class="nm">${esc(p.name)}${i === S.viewer ? '<small class="you-tag">你</small>' : ''}</span><span class="vp"><b>${p.vp}</b>分</span></div>
    <div class="meta"><span>${icon('settlement')}${p.settlements}</span><span>${icon('city')}${p.cities}</span><span>${icon('road')}${p.roads}</span><span>${icon('cards')}${p.total} 张</span><span>${p.needDiscard ? '待弃牌' : p.kind === 'bot' ? 'AI / BOT' : `${p.devCount} 发展卡`}</span></div>
    <div class="score-track"><span style="width:${Math.min(100,p.vp/S.settings.targetVP*100)}%"></span></div></div>`).join('');
  $('#badgeBar').innerHTML = `<div class="achievement">${icon('road')} 最长道路 · +2<b>${esc(S.longest.name || '等待 5 段连路')}${S.longest.len ? ' · ' + S.longest.len + ' 段' : ''}</b></div><div class="achievement">${icon('knight')} 最大骑士团 · +2<b>${esc(S.army.name || '等待 3 张骑士')}</b></div>`;
  $('#bankBar').innerHTML = `<strong>银行储备 <span> / 每种共 ${BANK_SIZE} 张</span></strong>${RES.map(r => `<span title="${CN[r]}剩余 ${S.bank?.[r] ?? BANK_SIZE} 张">${resourceIcon(r)}${S.bank?.[r] ?? BANK_SIZE}</span>`).join('')}`;
  $('#deckLeft').textContent = `发展卡余 ${S.deckLeft}`;
  const log = $('#log'), nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 45;
  log.innerHTML = S.log.map(l => `<div class="logline"><b style="color:${l.color || '#7e8f69'}">${esc(l.name)}</b> ${esc(l.text)}</div>`).join('');
  if (nearBottom) log.scrollTop = log.scrollHeight;
  renderStats();
}
function renderHand() {
  const m = me();
  $('#handTray').innerHTML = m ? `<div class="hand-label"><span class="eyebrow">你的资源</span><b>${m.total}<small>张手牌</small></b></div>${RES.map(r => `<div class="hand-card res-${r} ${m.res[r] ? '' : 'empty'}" title="${CN[r]} ${m.res[r]} 张"><span class="hand-count">${m.res[r]}</span>${resourceIcon(r)}<span class="hand-card-name">${CN[r]}</span></div>`).join('')}<button class="hand-dev" onclick="openCards()" aria-label="查看我的发展卡">${icon('cards')}<strong>${m.devCount}</strong><span>发展卡</span></button>` : '<span class="waitmsg">你正在观战 · 资源手牌仅对持有者可见</span>';
}
for (const dock of [$('#handTray'), $('#actionbar')]) {
  const items = () => dock.querySelectorAll('.hand-card,.hand-dev,.abtn');
  const reset = () => items().forEach(item => { item.style.removeProperty('--dock-scale'); item.style.removeProperty('--dock-lift'); });
  dock.addEventListener('pointermove', e => {
    if (e.pointerType !== 'mouse' || !matchMedia('(hover:hover) and (pointer:fine)').matches || matchMedia('(prefers-reduced-motion:reduce)').matches) return reset();
    items().forEach(item => {
      const box = item.getBoundingClientRect();
      const proximity = Math.max(0, 1 - Math.abs(e.clientX - box.x - box.width / 2) / 125);
      item.style.setProperty('--dock-scale', String(1 + proximity * .075));
      item.style.setProperty('--dock-lift', `${-proximity * 6}px`);
    });
  });
  dock.addEventListener('pointerleave', reset);
  dock.addEventListener('focusout', reset);
}
$('#mobileInfoBtn').onclick = () => {
  const open = $('#game').classList.toggle('info-open');
  $('#mobileInfoBtn').setAttribute('aria-expanded', String(open));
  $('#mobileInfoBtn').textContent = open ? '收起信息 ×' : '玩家与动态 ↑';
};
function renderStats() {
  const box = $('#diceStats');
  if (box.hidden) return;
  const rolls = Object.values(S.tally || {}).reduce((a, b) => a + b, 0);
  let rows = `<div style="font-size:12px;color:var(--muted);margin-bottom:6px">骰子统计（共 ${rolls} 次 · 白线 = 理论概率）</div>`;
  for (let n = 2; n <= 12; n++) {
    const c = S.tally?.[n] || 0;
    const pct = rolls ? c / rolls * 100 : 0;
    rows += `<div class="srow"><span>${n}${[6, 8].includes(n) ? '🔥' : ''}</span>
      <span class="sbar"><span class="sfill" style="width:${Math.min(100, pct * 5)}%"></span><span class="smark" style="left:${EXP[n] * 5}%"></span></span>
      <span>${pct.toFixed(1)}%</span></div>`;
  }
  box.innerHTML = rows;
}
$('#statsBtn').onclick = () => { $('#diceStats').hidden = !$('#diceStats').hidden; if (!$('#diceStats').hidden && matchMedia('(max-width:900px)').matches && !$('#game').classList.contains('info-open')) $('#mobileInfoBtn').click(); renderStats(); };
$('#helpBtn').onclick = () => openModal(`<h3>❔ 玩法速览</h3>
  <div class="help-grid">
    <div><b>1. 初始摆放</b><p>每人摆 2 个定居点与相连道路，顺序为正序再倒序。第二个定居点会带来相邻资源。</p></div>
    <div><b>2. 每回合</b><p>掷骰子后产出资源，再建造、交易或购买发展卡。点击高亮处建造；手机先预览，再确认位置。双指可缩放棋盘。</p></div>
    <div><b>3. 强盗与交易</b><p>掷出 7 时，手牌超过 7 张的玩家各弃一半；然后移动强盗并抢夺一张牌。港口能降低银行交易比例。</p></div>
    <div><b>4. 胜利点</b><p>定居点 1 分、城市 2 分；最长路至少 5 段和最大骑士团至少 3 张各加 2 分。胜利点发展卡只对持有者显示。</p></div>
  </div><div class="help-cost">🛣️ 木1 砖1 · 🏠 木1 砖1 羊1 麦1 · 🏛️ 麦2 矿3 · 🃏 羊1 麦1 矿1</div>
  <div class="help-grid">
    <div><b>5. 发展卡</b><p>骑士可移动强盗；筑路工免费修两段路；丰收之年取两张资源；垄断之年收取全场一种资源。购入的卡要等下个自己的回合才能打出，每回合至多打一张。</p></div>
    <div><b>6. 港口</b><p>在港口所连接的任一海岸交点建房，即可使用 3:1 或对应资源 2:1 的银行交易比例。</p></div>
  </div><div class="tip">每人至多 15 条路、5 个定居点、4 座城市；本版本每种资源各 29 张。详细规则：<a href="https://game.hullqin.cn/ktd" target="_blank" rel="noopener">原站</a> · <a href="https://www.catan.com/understand-catan/game-rules" target="_blank" rel="noopener">CATAN 官方</a></div>
  <div class="mbtns"><button class="btn primary" onclick="closeModal()">明白了</button></div>`);

function renderActionBar() {
  const bar = $('#actionbar'), m = me();
  if (S.phase === 'over') {
    bar.innerHTML = `<span class="waitmsg">${esc(S.players[S.winner].name)} 赢得这座岛屿 · ${S.players[S.winner].vp} 分</span>${currentRoom?.isHost ? '<button class="btn primary" onclick="send({type:\'restart\'})">再来一局 →</button>' : ''}`;
    return;
  }
  if (S.phase === 'setup') {
    bar.innerHTML = `<span class="waitmsg">${activePlayer() === S.viewer ? (S.legal.kind === 'settlement' ? '选择高亮交点，安放你的定居点' : '选择相连的高亮道路，开启你的路网') : `等待 ${esc(S.players[activePlayer()].name)} 完成摆放`}<div class="wait-secondary">先放定居点，再放道路 · 正序与倒序各一轮</div></span>`;
    return;
  }
  if (!m) {
    bar.innerHTML = `<span class="waitmsg">正在观战 · ${currentRoom?.mode === 'ai-only' ? 'AI 会自动掷骰、交易与建造' : '等待各位开拓者行动'}<div class="wait-secondary">可查看玩家、骰子统计与岛上动态</div></span>`;
    return;
  }
  const myTurn = !!m && S.viewer === S.current && !S.eventPending;
  const free = S.roadBuildLeft || 0;
  const build = (mode,label,cost) => `<button class="btn abtn ${pickMode===mode?'active':''}" ${unavailable(actionReason(mode))} onclick="togglePick('${mode}')" aria-pressed="${pickMode===mode}"><span class="action-name">${icon(mode)}${label}</span><span class="cost">${cost}</span></button>`;
  bar.innerHTML = `<span class="phase-step">${myTurn ? '轮到你了' : '等待对手'}<br>${S.rolled ? '交易与建设' : '掷骰与产出'}</span>
    <button class="btn primary abtn rollbtn" ${unavailable(actionReason('roll'))} onclick="act({type:'roll'})"><span class="action-name">${icon('dice')}${S.rolled ? '已掷骰' : '掷骰子'}</span><span class="cost">${S.rolled && S.dice ? S.dice.a + ' + ' + S.dice.b : '开始你的回合'}</span></button>
    ${build('road','道路',free ? '剩余 ' + free + ' 段免费' : '木 1 · 砖 1')}
    ${build('settlement','定居点','木 · 砖 · 羊 · 麦')}
    ${build('city','城市','麦 2 · 矿 3')}
    <button class="btn abtn" ${unavailable(actionReason('buyDev'))} onclick="act({type:'buyDev'})"><span class="action-name">${icon('cards')}买发展卡</span><span class="cost">羊 1 · 麦 1 · 矿 1</span></button>
    <button class="btn abtn" ${unavailable(actionReason('trade'))} onclick="openTrade()"><span class="action-name">${icon('trade')}交易</span><span class="cost">玩家 / 银行</span></button>
    <button class="btn abtn end-btn" ${unavailable(actionReason('endTurn'))} onclick="act({type:'endTurn'})"><span class="action-name">结束回合 ${icon('end')}</span><span class="cost">交给下一位</span></button>`;
}
window.togglePick = (mode) => { pendingBuild = null; pickMode = pickMode === mode ? null : mode; render(); };
window.act = act; window.send = send;

function renderHint() {
  const h = $('#hint');
  if (S.phase === 'setup') h.textContent = activePlayer() === S.viewer ? (S.legal.kind === 'settlement' ? '选择一个交点 · 定居点之间至少隔一条边' : '选择与新定居点相连的一条路') : `等待 ${S.players[activePlayer()].name} 摆放`;
  else if (me()?.needDiscard) h.textContent = '请点选要弃掉的资源卡';
  else if (S.discardCount) {
    const waiting=S.players.filter(p=>p.needDiscard);
    h.textContent=waiting.length<=2 ? `等待 ${waiting.map(p=>p.name).join('、')} 弃牌` : `等待 ${waiting.length} 位玩家弃牌`;
  }
  else if (S.robberPending) h.textContent = S.viewer === S.current ? '选择另一块地形，移动强盗' : '等待对手移动强盗';
  else if (S.stealPending) h.textContent = '等待选择抢牌目标';
  else if (S.roadBuildLeft) h.textContent = S.viewer === S.current ? `筑路工 · 还可免费修建 ${S.roadBuildLeft} 段道路` : '对手正在修建免费道路';
  else if (pickMode) h.textContent = `${{road:'选择高亮路段',settlement:'选择高亮交点',city:'选择你的定居点'}[pickMode]} · 再按一次操作按钮可取消`;
  else if (S.phase === 'over') h.textContent = '本局已结束';
  else if (S.viewer === S.current) h.textContent = S.rolled ? '选择下方操作，或直接点击棋盘高亮处' : '掷骰开始回合，也可以先打出发展卡';
  else h.textContent = `等待 ${S.players[S.current].name} 行动`;
  if(S.phase==='setup' && activePlayer()===S.viewer && S.map.hexes.length>37 && innerWidth<=620) h.textContent+=' · 可双指放大';
}
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { if (!['discard','steal'].includes(modalKind)) closeModal(); pendingBuild = null; pickMode = null; if (S) render(); }
  if (e.key === 'Tab' && !$('#modal').hidden) {
    const nodes = [...$('#modalCard').querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href]')];
    const first = nodes[0], last = nodes.at(-1);
    if (e.shiftKey && (document.activeElement === first || document.activeElement === $('#modalCard'))) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
  }
});

function renderOfferBar() {
  const bar = $('#offerBar');
  if (!S.offer) { bar.hidden = true; return; }
  const o = S.offer;
  bar.hidden = false;
  const txt = `💱 ${esc(o.fromName)} 的报价：出 ${bundleLabel(o.give)} ⇄ 求 ${bundleLabel(o.want)}`;
  bar.innerHTML = `<span>${txt}</span>` + (o.from === S.viewer
    ? `<span class="waitmsg">等待 ${o.targets?.length || 0} 人回复</span><button class="btn tiny" onclick="act({type:'cancelOffer'})">取消</button>`
    : S.viewer < 0 ? '<span class="waitmsg">观战中</span>'
    : !o.targets?.includes(S.viewer) ? '<span class="waitmsg">未邀请你</span>'
    : `<button class="btn tiny primary" ${unavailable(S.eventPending ? '请先完成弃牌、移动强盗或抢牌' : resourceShortage(o.want))} onclick="act({type:'acceptOffer'})">接受</button><button class="btn tiny" ${unavailable(S.eventPending ? '请先完成当前事件' : '')} onclick="act({type:'rejectOffer'})">拒绝</button>`);
}

/* ---------- 弹窗 ---------- */
let modalFocus = null;
function closeModal() { modalKind = null; $('#modal').hidden = true; if (modalFocus?.isConnected) modalFocus.focus(); }
function openModal(html, kind = 'x') { if ($('#modal').hidden) modalFocus = document.activeElement; modalKind = kind; $('#modalCard').innerHTML = html; $('#modal').hidden = false; $('#modalCard').focus({preventScroll:true}); }
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal' && modalKind !== 'discard') closeModal(); });

window.openCards = () => {
  if (!S.cards || !me()) return;
  const c = S.cards, fresh = c.fresh || [];
  const turn = S.viewer === S.current && S.phase === 'play';
  const types = {knight:['骑士','knight','移动强盗，并从相邻玩家处抢一张资源。',"act({type:'playKnight'});closeModal()"],road:['筑路工','road','免费修建两段道路，不需要消耗资源。',"act({type:'playRoad'});closeModal()"],year:['丰收之年','wheat','从银行选择两张资源，可以选同一种。','openYear()'],mono:['垄断之年','mono','选一种资源，收取其他所有玩家手中的该资源。','openMono()']};
  const rows = Object.entries(types).filter(([t])=>c[t]>0).map(([t,[label,art,desc,action]])=> {
    const ready = c[t] - fresh.filter(x=>x===t).length;
    const reason = !turn ? '等待自己的回合' : S.eventPending || S.roadBuildLeft ? '先完成当前事件' : S.devPlayed ? '本回合已使用发展卡' : !ready ? '新购入 · 下回合可用' : t==='road' && !S.legal?.canPlayRoad ? '暂无可修建的道路' : '';
    return `<div class="dev-card">${icon(art)}<h4>${label}<span>×${c[t]}</span></h4><p>${desc}</p><small>${reason || '可用 '+ready+' 张'}</small><button class="btn ${reason?'':'primary'}" ${unavailable(reason)} onclick="${action}">${reason?'暂不可用':'打出这张卡'}</button></div>`;
  });
  openModal(`<span class="eyebrow">YOUR DEVELOPMENT</span><h3>每张卡，都是新的可能</h3><p class="tip">每回合可打一张行动发展卡，新购入的卡要等下回合。</p><div class="dev-grid">${rows.join('')}</div>${!rows.length ? '<div class="empty-state">还没有行动发展卡。<br>用羊毛、小麦、矿石各一张购买。</div>' : ''}<div class="dev-vp">胜利点卡 · ${me().dev.vp} 张 <span>已自动计入自己的分数</span></div><div class="mbtns"><button class="btn" onclick="closeModal()">返回棋盘</button></div>`, 'cards');
};
window.openYear = () => {
  openModal(`<h3>🌻 丰收之年 — 从银行领 2 张资源</h3>
    <div class="mrow">${RES.map(r => `<button class="btn year-choice" data-res="${r}" onclick="yearPick('${r}')">${resourceIcon(r)} ${CN[r]} <small>剩 ${S.bank?.[r] ?? 0}</small></button>`).join('')}</div>
    <div class="mrow">已选: <b id="yearSel">无</b><button class="text-btn" onclick="openYear()">重新选择</button></div>
    <div class="mbtns"><button class="btn" onclick="closeModal()">取消</button>
    <button id="yearConfirm" class="btn primary" onclick="yearOk()" ${unavailable("请选择 2 张资源")}>确认</button></div>`);
  window._year = [];
  window.yearPick = (r) => {
    if (window._year.length >= 2 || window._year.filter(x => x === r).length >= (S.bank?.[r] || 0)) return;
    window._year.push(r);
    $('#yearSel').innerHTML = window._year.map(x => resourceIcon(x) + CN[x]).join(' + ');
    setUnavailable($('#yearConfirm'), window._year.length !== 2 ? '请选择 2 张资源' : '');
    document.querySelectorAll('.year-choice').forEach(b => { setUnavailable(b, window._year.length >= 2 ? '已选满 2 张，请重新选择后再修改' : window._year.filter(x => x === b.dataset.res).length >= (S.bank?.[b.dataset.res] || 0) ? '银行的这类资源已选完' : ''); });
  };
  document.querySelectorAll('.year-choice').forEach(b => { setUnavailable(b, !S.bank?.[b.dataset.res] ? '银行已没有这类资源' : ''); });
  window.yearOk = () => { if (window._year.length !== 2) return toast('请选择 2 张资源'); act({ type: 'playYear', r1: window._year[0], r2: window._year[1] }); closeModal(); };
};
window.openMono = () => {
  openModal(`<h3>🏦 垄断之年 — 选一种资源，全场交给你</h3>
    <div class="mrow">${RES.map(r => `<button class="btn" onclick="act({type:'playMono',res:'${r}'});closeModal()">${resourceIcon(r)} ${CN[r]}</button>`).join('')}</div>
    <div class="mbtns"><button class="btn" onclick="closeModal()">取消</button></div>`);
};

window.openTrade = () => {
  const m = me(); if (!m) return toast('观战时不能发起交易');
  const r = m.res || {};
  const rate = (g) => me().ports?.[g] || 4;
  const bundleInputs = (prefix, max) => RES.map(res => `<div class="trade-res-row"><span class="trade-res-label">${resourceIcon(res)}<span>${CN[res]}<small id="${prefix}_state_${res}"></small></span></span><div class="stepper"><button type="button" aria-label="减少${CN[res]}" onclick="tradeStep('${prefix}_${res}',-1)">−</button><input aria-label="${prefix==='give'?'给出':'想要'}${CN[res]}数量" id="${prefix}_${res}" type="number" min="0" max="${max(res)}" value="0" readonly tabindex="-1"><button type="button" aria-label="增加${CN[res]}" onclick="tradeStep('${prefix}_${res}',1)">＋</button></div></div>`).join('');
  const targetInputs = S.players.map((p, i) => i === S.viewer ? '' : `<label class="trade-person"><input type="checkbox" class="trade-target" value="${i}" checked><span class="dot" style="background:${p.color}"></span>${esc(p.name)}</label>`).join('');
  openModal(`<div class="trade-scroll"><span class="eyebrow">A FAIR EXCHANGE</span><h3>让每一张资源，物尽其用</h3>
    <div class="trade-inventory" aria-label="我的资源与银行库存">${RES.map(res => `<div class="res-${res}">${resourceIcon(res)}<span>${CN[res]}</span><strong id="stock_${res}"></strong><small id="bank_stock_${res}"></small></div>`).join('')}</div>
    <div class="trade-title">银行交易 <span>有港口时自动采用最优比例</span></div>
    <div class="mrow">出 <select id="bg"></select><b id="bn">4</b> 张 → 得 1 张 <select id="bw"></select>
    <button id="bankConfirm" class="btn tiny primary" onclick="bankGo()">成交</button></div><p id="bankPreview" class="trade-preview" aria-live="polite"></p>
    <div class="trade-title">玩家交易 <span>可组合多种资源</span></div>
    <div class="trade-grid"><div><b>我给出</b>${bundleInputs('give', res => r[res] || 0)}</div><div><b>我想要</b>${bundleInputs('want', () => BANK_SIZE)}</div></div>
    <p id="tradePreview" class="trade-preview" aria-live="polite"></p><div class="trade-title">发送给</div><div class="trade-targets">${targetInputs}</div></div>
    <div class="trade-actions"><button class="btn" onclick="closeModal()">关闭</button><button id="offerConfirm" class="btn primary" onclick="offerGo()">发出提案</button></div>`, 'trade');
  $('#bg').innerHTML = RES.map(x => `<option value="${x}">${CN[x]}（持有${r[x]}）</option>`).join('');
  $('#bw').innerHTML = RES.map(x => `<option value="${x}">${CN[x]}（银行${S.bank?.[x] ?? BANK_SIZE}）</option>`).join('');
  $('#bw').value = 'brick';
  const readBundle = prefix => Object.fromEntries(RES.map(res => [res, +$('#' + prefix + '_' + res).value]));
  const validBundle = b => RES.every(res => Number.isInteger(b[res]) && b[res] >= 0 && b[res] <= BANK_SIZE);
  const countBundle = b => RES.reduce((n, res) => n + b[res], 0);
  window.tradeStep = (id, delta) => { const input = $('#' + id); const next = +input.value + delta; if (next < 0) return toast('数量已经为 0'); if (next > +input.max) return toast(id.startsWith('give') ? '持有的这类资源已全部选中' : `每种资源最多 ${BANK_SIZE} 张`); input.value = next; updateTrade(); };
  const updateTrade = window.refreshTrade = () => {
    const r = me().res;
    const give = readBundle('give'), want = readBundle('want');
    RES.forEach(res => {
      $('#give_' + res).max = r[res];
      $('#stock_' + res).textContent = `持有 ${r[res]}`;
      $('#bank_stock_' + res).textContent = `银行 ${S.bank?.[res] ?? 0}`;
      $('#give_state_' + res).textContent = `选 ${give[res]} · 剩 ${Math.max(0,r[res] - give[res])}`;
      $('#want_state_' + res).textContent = `成交后 ${r[res] - give[res] + want[res]} 张`;
      $('#give_state_' + res).classList.toggle('shortage', give[res] > r[res]);
      $('#bg').querySelector(`[value="${res}"]`).textContent = `${CN[res]}（持有 ${r[res]}）`;
      $('#bw').querySelector(`[value="${res}"]`).textContent = `${CN[res]}（银行 ${S.bank?.[res] ?? 0}）`;
    });
    $('#bn').textContent = rate($('#bg').value);
    const bankGive = $('#bg').value, bankWant = $('#bw').value;
    $('#bankPreview').textContent = bankGive === bankWant ? '请选择两种不同的资源' : `成交后：${CN[bankGive]}剩 ${Math.max(0,r[bankGive] - rate(bankGive))} 张，${CN[bankWant]}共 ${r[bankWant] + 1} 张 · 银行${CN[bankWant]}余 ${Math.max(0,(S.bank?.[bankWant] || 0) - 1)} 张`;
    $('#tradePreview').textContent = `本次给出 ${countBundle(give)} 张，换回 ${countBundle(want)} 张 · 对方各类手牌保密，以实际回复为准`;
    setUnavailable($('#bankConfirm'), actionReason('trade') || (bankGive === bankWant ? '请选择两种不同的资源' : r[bankGive] < rate(bankGive) ? `资源不足：需要 ${rate(bankGive)} 张${CN[bankGive]}，当前只有 ${r[bankGive]} 张` : !S.bank?.[bankWant] ? `银行已没有${CN[bankWant]}` : ''));
    setUnavailable($('#offerConfirm'), actionReason('trade') || (S.offer ? '请先等待或取消当前交易提案' : !validBundle(give) || !validBundle(want) ? '请选择有效的资源数量' : !countBundle(give) ? '请先选择要给出的资源' : !countBundle(want) ? '请先选择想要的资源' : RES.every(res => give[res] === want[res]) ? '给出和想要的资源不能完全相同' : resourceShortage(give) || (!document.querySelector('.trade-target:checked') ? '请至少选择一位交易对象' : '')));
  };
  ['#bg', '#bw'].forEach(id => $(id).addEventListener('input', updateTrade));
  document.querySelectorAll('.trade-grid input, .trade-target').forEach(input => input.addEventListener('input', updateTrade));
  updateTrade();
  window.bankGo = () => { if ($('#bankConfirm').getAttribute('aria-disabled') === 'true') return toast($('#bankConfirm').dataset.disabledReason); act({ type: 'bankTrade', give: $('#bg').value, want: $('#bw').value }); closeModal(); };
  window.offerGo = () => {
    if ($('#offerConfirm').getAttribute('aria-disabled') === 'true') return toast($('#offerConfirm').dataset.disabledReason);
    const targets = [...document.querySelectorAll('.trade-target:checked')].map(x => +x.value);
    act({ type: 'offerTrade', give: readBundle('give'), want: readBundle('want'), targets }); closeModal();
  };
};

function renderModals() {
  const m = me();
  if (S.phase === 'over' && S.winner != null) {
    if (modalKind !== 'win' && !winDismissed) {
      modalKind = 'win';
      const w = S.players[S.winner];
      openModal(`<div class="win-overlay"><div style="font-size:44px">🏆</div><div class="big"><b style="color:${w.color}">${esc(w.name)}</b> 获胜！</div>
        <div class="tip">${w.vp} / ${S.settings.targetVP} 分</div>
        <div class="mbtns" style="justify-content:center">
        ${currentRoom?.isHost ? '<button class="btn primary" onclick="send({type:\'restart\'});closeModal()">🔄 再来一局</button>' : ''}
        <button class="btn" onclick="winDismissed=true;closeModal()">看棋盘</button></div></div>`, 'win');
    }
    return;
  }
  if (S.stealFrom?.length && S.viewer === S.current) {
    if (modalKind !== 'steal') {
      modalKind = 'steal';
      const btns = S.stealFrom.map(i => { const p = S.players[i]; return `<button class="stealbtn" onclick="act({type:'steal',from:${i}});closeModal()"><span class="dot" style="background:${p.color}"></span>抢 <b>${esc(p.name)}</b>（手里 ${p.total} 张）</button>`; }).join('');
      openModal(`<h3>🥷 强盗来袭 — 选择抢劫目标</h3>${btns}`, 'steal');
    }
    return;
  }
  if (m?.needDiscard) {
    if (modalKind !== 'discard') {
      const need = Math.floor(m.total / 2);
      const cards = RES.flatMap(r => Array.from({ length: m.res[r] }, (_, i) => ({ r, i })));
      const picked = new Set();
      openModal(`<div class="discard-head"><span class="discard-mark">🃏</span><div><h3>选择要弃的资源卡</h3><p>掷出 7 · 手牌 ${m.total} 张 · 需弃 ${need} 张</p></div></div>
        <div class="discard-progress"><span>已选 <b id="dSelected">0</b> / ${need}</span><span id="dLeft">再选 ${need} 张</span></div>
        <div class="discard-cards" id="discCards">${cards.map(({ r, i }) => `<button type="button" class="resource-card res-${r}" data-key="${r}-${i}" data-res="${r}" aria-pressed="false" aria-label="选择${CN[r]}卡"><span class="resource-card-art">${resourceIcon(r)}</span><span class="resource-card-name">${CN[r]}</span><span class="resource-card-check">✓</span></button>`).join('')}</div>
        <div class="discard-actions"><button class="btn" id="discAuto" type="button">帮我选择</button><button class="btn primary" id="discOk" type="button" ${unavailable(`请先选满 ${need} 张资源卡`)}>确认弃牌</button></div>`, 'discard');
      const refresh = () => {
        $('#dSelected').textContent = picked.size;
        $('#dLeft').textContent = picked.size === need ? '可以弃牌' : `再选 ${need - picked.size} 张`;
        setUnavailable($('#discOk'), picked.size !== need ? `还需选择 ${need - picked.size} 张资源卡` : '');
        $('#discCards').querySelectorAll('.resource-card').forEach(card => {
          const selected = picked.has(card.dataset.key);
          card.classList.toggle('selected', selected);
          card.setAttribute('aria-pressed', String(selected));
          setUnavailable(card, !selected && picked.size >= need ? '已选够弃牌数量，可先取消一张再更换' : '');
        });
      };
      $('#discCards').addEventListener('click', e => {
        const card = e.target.closest('.resource-card');
        if (!card) return;
        const key = card.dataset.key;
        if (picked.has(key)) picked.delete(key);
        else if (picked.size < need) picked.add(key);
        refresh();
      });
      $('#discAuto').onclick = () => {
        picked.clear();
        for (const card of [...cards].sort(() => Math.random() - .5).slice(0, need)) picked.add(`${card.r}-${card.i}`);
        refresh();
      };
      $('#discOk').onclick = () => {
        if (picked.size !== need) return;
        const selected = Object.fromEntries(RES.map(r => [r, 0]));
        for (const key of picked) selected[key.split('-')[0]]++;
        act({ type: 'discard', res: selected });
      };
    }
    return;
  }
  if (modalKind === 'discard' || modalKind === 'steal') { modalKind = null; $('#modal').hidden = true; }
}
window.closeModal = closeModal;

/* ---------- 棋盘绘制（美术资产：从参考站点包中解出的原始 SVG 路径数据，Path2D 复刻）---------- */
const cv = $('#board'), ctx = cv.getContext('2d');
let view = { scale: 40, ox: 0, oy: 0 };
let fitScale = 40;
let boardSize = { w: 0, h: 0 };
let geom = null, geomKey = '';
let robberMotion = null, robberFrame = null;
const ROBBER_DURATION = 760;
const ROBBER_PATH = new Path2D('M-33 32Q-32 6-16-9C-42-46 42-46 16-9Q32 6 33 32Z');

function robberPose(now = performance.now()) {
  const h = S?.map.hexes.find(h=>h.id===S.map.robber);
  if (!h) return null;
  if (!robberMotion) return {x:h.x,y:h.y,progress:1};
  if (robberMotion.game !== S.id || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    robberMotion = null; return {x:h.x,y:h.y,progress:1};
  }
  const t = Math.min(1,Math.max(0,(now-robberMotion.start)/ROBBER_DURATION));
  const ease = t*t*(3-2*t), m = robberMotion;
  const pose = {x:m.from.x+(m.to.x-m.from.x)*ease,y:m.from.y+(m.to.y-m.from.y)*ease-Math.sin(Math.PI*t)*.45,progress:t};
  if(t===1) robberMotion=null;
  return pose;
}

function syncRobberMotion(previous, next) {
  if(!previous || previous.id!==next.id || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    cancelAnimationFrame(robberFrame);robberFrame=null;robberMotion=null;return;
  }
  if(previous.map.robber===next.map.robber) return;
  const from=robberPose(),to=next.map.hexes.find(h=>h.id===next.map.robber);
  if(!from||!to) return;
  cancelAnimationFrame(robberFrame);
  robberMotion={game:next.id,from:{x:from.x,y:from.y},to:{x:to.x,y:to.y},start:performance.now()};
  const tick=()=>{robberFrame=null;if(!S) return;drawBoard();if(robberMotion) robberFrame=requestAnimationFrame(tick);};
  robberFrame=requestAnimationFrame(tick);
}

// 地形调色板：[描边、底色、受光面]
const PAL = {
  wood: ['#356b47', '#4f8c61', '#9bc783'],
  brick: ['#a45330', '#c77749', '#e7a77d'],
  sheep: ['#78963b', '#a6c66b', '#d4e5a2'],
  wheat: ['#b08425', '#d8b33e', '#f1d371'],
  ore: ['#536e8b', '#7895ad', '#b1c7d4'],
  desert: ['#b49776', '#cfb28a', '#ead5b4'],
};
const resourceImages = Object.fromEntries([...RES, 'desert'].map(r => {
  const img = new Image(); img.onload = () => { if (S) drawBoard(); }; img.src = `/assets/${r}.svg`; return [r,img];
}));

// Derive piece shading from the actual player color, keeping canvas and UI consistent.
const srOf = color => {
  const rgb = [1,3,5].map(i => parseInt(color.slice(i,i+2),16));
  const mix = (target, amount) => '#' + rgb.map(v => Math.round(v+(target-v)*amount).toString(16).padStart(2,'0')).join('');
  return [mix(255,.12), color, mix(0,.38)];
};

// —— 原版路径数据 ——
const hexPCache = {};
function hexP(r) {
  if (!hexPCache[r]) {
    const pts = [];
    for (let i = 0; i < 6; i++) { const a = Math.PI / 180 * (60 * i - 90); pts.push(`${(Math.cos(a) * r).toFixed(2)},${(Math.sin(a) * r).toFixed(2)}`); }
    hexPCache[r] = new Path2D('M' + pts.join('L') + 'Z');
  }
  return hexPCache[r];
}
const P_VILL_F = new Path2D('M99,91L89,111H39L29,91L23,95L30,48L64,19L98,48L105,95Z');
const P_VILL_S = new Path2D('M99,91L87,111H39L31,91M64,19V65L23,95L30,48L64,19L98,48L105,95L64,65');
const P_CITY_F1 = new Path2D('M122,96L121,69L112,59H82L69,96Z');
const P_CITY_F2 = new Path2D('M43,10L8,29L2,80L9,76L23.4,112H109L116,96H69L77,76L84,80L78,29Z');
const P_CITY_S = new Path2D('M77,76L69,96H122L121,69L112,59H82M116,96L109,112H23.4L9,76M43,57L84,79.9L78,29L43,10L8,29L2,80L43,57L43,10');
const P_ROAD = new Path2D('M-20,85V-85L0,-96L20,-85V85L0,96Z');

function buildGeom() {
  const key = S.id || S.map.hexes.length + ':' + S.map.vertices.length;
  if (geomKey === key) return;
  geomKey = key;
  const vs = Object.fromEntries(S.map.vertices.map(v => [v.id, v]));
  geom = { vs, es: S.map.edges, hs: S.map.hexes };
  fitBoard();
}
function portPosition(port) {
  if (Number.isFinite(port.x) && Number.isFinite(port.y)) return [port.x, port.y];
  // Existing rooms created before fixed port anchors still render consistently.
  const a = geom.vs[port.a], b = geom.vs[port.b];
  const land = S.map.hexes.find(h => h.id === port.hex);
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  const nx = mx - (land?.x ?? 0), ny = my - (land?.y ?? 0), len = Math.hypot(nx, ny) || 1;
  return [mx + nx / len * Math.sqrt(3) / 2, my + ny / len * Math.sqrt(3) / 2];
}
function fitBoard() {
  const w=cv.clientWidth,h=cv.clientHeight;
  const points=S.map.vertices.map(v=>[v.x,v.y]);
  for(const port of S.map.ports||[]) {
    const [x,y]=portPosition(port);
    points.push([x-.3,y-.3],[x+.3,y+.3]);
  }
  const xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);
  const minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);
  const landscape=w>h*1.8&&h<400,top=landscape?43:w<620?87:57,bottom=landscape?49:w<620?77:67;
  const scale=Math.max(1,Math.min((w-30)/(maxX-minX),(h-top-bottom)/(maxY-minY)));
  fitScale=scale;view={scale,ox:w/2-(minX+maxX)/2*scale,oy:top+(h-top-bottom)/2-(minY+maxY)/2*scale};
  boardSize={w,h};
}
function preserveBoardViewOnResize() {
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!boardSize.w || !boardSize.h || (boardSize.w === w && boardSize.h === h)) return;
  const centerX = (boardSize.w / 2 - view.ox) / view.scale;
  const centerY = (boardSize.h / 2 - view.oy) / view.scale;
  view.ox = w / 2 - centerX * view.scale;
  view.oy = h / 2 - centerY * view.scale;
  boardSize = { w, h };
}
const W2S = (x, y) => [x * view.scale + view.ox, y * view.scale + view.oy];
function zoomBoard(factor) {
  if (!S || !geom) return;
  const next = Math.max(fitScale, Math.min(fitScale * 3.5, view.scale * factor));
  const f = next / view.scale;
  const cx = cv.clientWidth / 2, cy = cv.clientHeight / 2;
  view.ox = cx - (cx - view.ox) * f;
  view.oy = cy - (cy - view.oy) * f;
  view.scale = next;
  drawBoard();
}
$('#zoomIn').onclick = () => zoomBoard(1.4);
$('#zoomOut').onclick = () => zoomBoard(1 / 1.4);
$('#zoomFit').onclick = () => { if (S) { fitBoard(); drawBoard(); } };
cv.addEventListener('wheel', e => { e.preventDefault(); zoomBoard(e.deltaY < 0 ? 1.18 : 1 / 1.18); }, { passive: false });

function targets() {
  if (!S) return { verts: new Set(), edges: new Set(), hexes: new Set() };
  const t = { verts: new Set(), edges: new Set(), hexes: new Set() };
  if (S.phase === 'setup' && S.legal?.setupPlayer === S.viewer) {
    if (S.legal.kind === 'settlement') S.legal.setup.forEach(v => t.verts.add(v));
    else S.legal.setup.forEach(e => t.edges.add(e));
  } else if (S.needMoveRobber && S.viewer === S.current) {
    S.map.hexes.forEach(h => { if (h.id !== S.map.robber) t.hexes.add(h.id); });
  } else if (S.viewer === S.current && !S.eventPending && (S.rolled || S.roadBuildLeft)) {
    const L = S.legal || {};
    if (!pickMode || pickMode === 'road') L.road?.forEach(e => t.edges.add(e));
    if (!S.roadBuildLeft && (!pickMode || pickMode === 'settlement')) L.settlement?.forEach(v => t.verts.add(v));
    if (!S.roadBuildLeft && (!pickMode || pickMode === 'city')) L.city?.forEach(v => t.verts.add(v));
  }
  return t;
}

function drawBoard() {
  if (!S) return;
  const dpr = Math.min(2, devicePixelRatio || 1);
  if (cv.width !== Math.round(cv.clientWidth * dpr) || cv.height !== Math.round(cv.clientHeight * dpr)) {
    cv.width = Math.round(cv.clientWidth * dpr); cv.height = Math.round(cv.clientHeight * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = cv.clientWidth, hgt = cv.clientHeight;
  ctx.clearRect(0, 0, w, hgt);
  buildGeom();
  if (needResizeFit) { fitBoard(); needResizeFit = false; }
  else preserveBoardViewOnResize();
  const sea = ctx.createLinearGradient(0, 0, w, hgt);
  sea.addColorStop(0, '#e4eeea'); sea.addColorStop(.5, '#dcece7'); sea.addColorStop(1, '#ceded8');
  ctx.fillStyle = sea; ctx.fillRect(0, 0, w, hgt);
  ctx.fillStyle = 'rgba(52,107,94,.08)';
  for (let x=18; x<w; x+=26) for(let y=18; y<hgt; y+=26) { ctx.beginPath();ctx.arc(x,y,.8,0,Math.PI*2);ctx.fill(); }
  const s = view.scale, k = s / 202, T = targets();
  const pulse = matchMedia('(prefers-reduced-motion: reduce)').matches ? .7 : .65 + .35 * Math.sin(Date.now()/380);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const h of S.map.hexes) {
    const [cx, cy] = W2S(h.x, h.y);
    ctx.save(); ctx.translate(cx, cy); ctx.scale(k, k);
    const pal = PAL[h.resource] || PAL.desert;
    ctx.shadowColor = 'rgba(41,79,61,.19)'; ctx.shadowBlur = 18; ctx.shadowOffsetY = 8;
    ctx.fillStyle = '#f6f2df'; ctx.fill(hexP(198));
    ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    ctx.fillStyle = pal[0]; ctx.fill(hexP(187));
    const g = ctx.createLinearGradient(-100,-160,140,140);
    g.addColorStop(0,pal[2]); g.addColorStop(1,pal[1]); ctx.fillStyle=g;ctx.fill(hexP(181));
    ctx.strokeStyle = '#ffffff45'; ctx.lineWidth=2; ctx.stroke(hexP(176));
    const blocked = h.id === S.map.robber;
    if (S.dice && S.rolled && h.number === S.dice.a + S.dice.b && !blocked) {
      ctx.strokeStyle = '#fbf6d3';ctx.lineWidth=9;ctx.stroke(hexP(180));
    }
    if (T.hexes.has(h.id)) { ctx.strokeStyle=`rgba(49,113,89,${.3+.4*pulse})`;ctx.lineWidth=10;ctx.stroke(hexP(190)); }
    const img=resourceImages[h.resource];
    if (img?.complete && img.naturalWidth) { ctx.globalAlpha=blocked?.62:1;ctx.drawImage(img,-80,-149,160,134);ctx.globalAlpha=1; }
    if(h.number) {
      const hot=[6,8].includes(h.number), y=blocked?103:67;
      ctx.beginPath();ctx.arc(0,y,42,0,Math.PI*2);ctx.fillStyle='#fffbea';ctx.fill();
      ctx.strokeStyle='#a49b723b';ctx.lineWidth=2;ctx.stroke();
      ctx.fillStyle=hot?'#b3604d':'#4c6250';ctx.font='600 54px Georgia, serif';ctx.fillText(String(h.number),0,y-4);
      const count=6-Math.abs(7-h.number);
      for(let i=0;i<count;i++){ctx.beginPath();ctx.arc((i-(count-1)/2)*10,y+25,2.9,0,Math.PI*2);ctx.fill();}
    }
    ctx.restore();
  }

  // 两段木码头沿海上六边形的半径伸出，终点留出港口徽章的空间。
  for (const port of S.map.ports || []) {
    const a = geom.vs[port.a], b = geom.vs[port.b];
    const [px, py] = W2S(...portPosition(port));
    for (const v of [a, b]) {
      const [vx, vy] = W2S(v.x, v.y);
      const len = Math.hypot(px-vx, py-vy), dx = (px-vx)/len, dy = (py-vy)/len;
      const start = s*.10, end = len-s*.34, width = Math.max(3, s*.13);
      ctx.save(); ctx.lineCap='butt';
      ctx.beginPath(); ctx.moveTo(vx+dx*start,vy+dy*start); ctx.lineTo(vx+dx*end,vy+dy*end);
      ctx.strokeStyle='#94794e';ctx.lineWidth=width+1.5;ctx.stroke();
      ctx.strokeStyle='#d9bc84';ctx.lineWidth=width;ctx.stroke();
      ctx.strokeStyle='#a58a59';ctx.lineWidth=Math.max(.65,s*.012);
      for(let d=start+s*.10;d<end;d+=s*.12){
        const x=vx+dx*d,y=vy+dy*d;
        ctx.beginPath();ctx.moveTo(x-dy*width/2,y+dx*width/2);ctx.lineTo(x+dy*width/2,y-dx*width/2);ctx.stroke();
      }
      ctx.restore();
    }
    ctx.save(); ctx.translate(px, py); ctx.scale(k, k);
    ctx.beginPath(); ctx.arc(0, 0, 54, 0, 7); ctx.fillStyle = '#52756230'; ctx.fill();
    ctx.beginPath(); ctx.arc(0, 0, 50, 0, 7); ctx.fillStyle = '#fffbed'; ctx.fill();
    ctx.strokeStyle = '#a8b89a'; ctx.lineWidth = 3; ctx.stroke();
    ctx.fillStyle = '#536b56';
    if (port.type === '3') { ctx.font = 'bold 40px system-ui'; ctx.fillText('3:1', 0, 2); }
    else {
      const portImage = resourceImages[port.type.slice(2)];
      if(portImage?.complete && portImage.naturalWidth) ctx.drawImage(portImage,-32,-42,64,51);
      ctx.font = 'bold 30px system-ui'; ctx.fillText('2:1', 0, 24);
    }
    ctx.restore();
  }

  // —— 道路（原版木板路径 + 渐变 + 描边）——
  for (const e of S.map.edges) {
    const a = geom.vs[e.a], b = geom.vs[e.b];
    const [x1, y1] = W2S(a.x, a.y), [x2, y2] = W2S(b.x, b.y);
    if (T.edges.has(e.id)) {
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
      ctx.strokeStyle = `rgba(51,126,91,${0.3 + 0.4 * pulse})`;
      ctx.lineWidth = Math.max(9, s * 0.26); ctx.lineCap = 'round'; ctx.stroke();
    }
    if (!e.owner) continue;
    const owner = S.players.find(p => p.id === e.owner); if (!owner) continue;
    const [light, main, dark] = srOf(owner.color);
    const ang = Math.atan2(y2 - y1, x2 - x1);
    ctx.save(); ctx.translate((x1 + x2) / 2, (y1 + y2) / 2); ctx.rotate(ang + Math.PI / 2); ctx.scale(k, k);
    const g = ctx.createLinearGradient(-23, 0, 23, 0);
    g.addColorStop(0, light); g.addColorStop(.4, main); g.addColorStop(.5, main); g.addColorStop(1, light);
    ctx.strokeStyle = '#fffbed'; ctx.lineWidth = 12; ctx.lineJoin = 'round'; ctx.stroke(P_ROAD);
    ctx.fillStyle = g; ctx.fill(P_ROAD);
    ctx.strokeStyle = dark; ctx.lineWidth = 4.8; ctx.stroke(P_ROAD);
    ctx.restore();
  }

  // —— 定居点 / 城市（原版 vill/city 路径 + 径向渐变）——
  for (const p of S.players) {
    for (const vid of p.settleVerts) drawHouse(geom.vs[vid], p.color, false);
    for (const vid of p.cityVerts) drawHouse(geom.vs[vid], p.color, true);
  }

  // —— 放置高亮 ——
  for (const vid of T.verts) {
    const v = geom.vs[vid]; const [x, y] = W2S(v.x, v.y);
    ctx.save(); ctx.translate(x, y); ctx.scale(k, k);
    ctx.beginPath(); ctx.arc(0, 0, 30, 0, 7);
    ctx.fillStyle = `rgba(51,126,91,${0.24 * pulse + 0.14})`; ctx.fill();
    ctx.strokeStyle = `rgba(51,126,91,${0.5 + 0.5 * pulse})`; ctx.lineWidth = 5; ctx.stroke();
    ctx.restore();
  }
  for (const eid of T.edges) {
    const e = S.map.edges.find(x => x.id === eid);
    const a = geom.vs[e.a], b = geom.vs[e.b];
    const [x, y] = W2S((a.x + b.x) / 2, (a.y + b.y) / 2);
    ctx.beginPath(); ctx.arc(x, y, Math.max(5, s * 0.1), 0, 7);
    ctx.fillStyle = `rgba(65,126,76,${0.6 + 0.4 * pulse})`; ctx.fill();
  }
  if (hoverTarget || pendingBuild?.target) {
    const t=pendingBuild?.target || hoverTarget;
    const point=t.kind==='vert'?geom.vs[t.id]:t.kind==='hex'?S.map.hexes.find(h=>h.id===t.id):(()=>{const e=S.map.edges.find(e=>e.id===t.id),a=geom.vs[e.a],b=geom.vs[e.b];return {x:(a.x+b.x)/2,y:(a.y+b.y)/2};})();
    const [x,y]=W2S(point.x,point.y);
    ctx.beginPath(); ctx.arc(x, y, Math.max(8, s * 0.16), 0, 7);
    ctx.strokeStyle = '#2f7459'; ctx.lineWidth = 3; ctx.stroke();
  }

  // Draw once above the board, so travel between tiles stays visible.
  const pose = robberPose();
  if (pose) {
    if (robberMotion) {
      const [tx,ty]=W2S(robberMotion.to.x,robberMotion.to.y);
      ctx.save();ctx.strokeStyle=`rgba(157,112,51,${.25+.45*pose.progress})`;ctx.lineWidth=Math.max(1.5,s*.035);
      ctx.setLineDash([s*.08,s*.06]);ctx.beginPath();ctx.arc(tx,ty,s*(.40+.12*Math.sin(Math.PI*pose.progress)),0,Math.PI*2);ctx.stroke();ctx.restore();
    }
    const [x,y]=W2S(pose.x,pose.y);
    ctx.save();ctx.translate(x,y);ctx.scale(k,k);
    ctx.fillStyle='#34403725';ctx.beginPath();ctx.ellipse(0,38,34,10,0,0,Math.PI*2);ctx.fill();
    ctx.shadowColor='#34403750';ctx.shadowBlur=12;
    ctx.fillStyle='#394a44';ctx.strokeStyle='#f0ddb4';ctx.lineWidth=5;
    ctx.fill(ROBBER_PATH);ctx.stroke(ROBBER_PATH);ctx.shadowBlur=0;
    ctx.fillStyle='#7a6241';ctx.font='18px sans-serif';ctx.fillText('强盗',0,58);ctx.restore();
  }

  function drawHouse(v, color, city) {
    if (!v) return;
    const [x, y] = W2S(v.x, v.y);
    const [light, main, dark] = srOf(color);
    ctx.save(); ctx.translate(x, y); ctx.scale(k, k); ctx.translate(-64, -64);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#fffbed'; ctx.lineWidth = 11;
    if (city) { ctx.stroke(P_CITY_F2); ctx.stroke(P_CITY_F1); }
    else ctx.stroke(P_VILL_F);
    if (city) {
      const g = ctx.createRadialGradient(64, 64, 6, 64, 64, 62);
      g.addColorStop(0, light); g.addColorStop(1, main);
      ctx.fillStyle = g; ctx.fill(P_CITY_F2);
      const g2 = ctx.createLinearGradient(0, 59, 0, 96);
      g2.addColorStop(.26, light); g2.addColorStop(.4, main);
      ctx.fillStyle = g2; ctx.fill(P_CITY_F1);
      ctx.strokeStyle = dark; ctx.lineWidth = 4.8; ctx.stroke(P_CITY_S);
    } else {
      const g = ctx.createRadialGradient(64, 64, 6, 64, 64, 58);
      g.addColorStop(0, light); g.addColorStop(1, main);
      ctx.fillStyle = g; ctx.fill(P_VILL_F);
      ctx.strokeStyle = dark; ctx.lineWidth = 4.8; ctx.stroke(P_VILL_S);
    }
    ctx.restore();
  }
}
let needResizeFit = false;
new ResizeObserver(() => { if (S) drawBoard(); }).observe($('#boardwrap'));

/* 高亮存在时的脉动动画 */
setInterval(() => {
  if (!S || document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const t = targets();
  if (t.verts.size || t.edges.size || t.hexes.size) drawBoard();
}, 66);

/* ---------- 交互 ---------- */
function evPos(e) { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
function pickAt(mx, my) {
  const T=targets(), coarse=matchMedia('(pointer: coarse)').matches, hits=[];
  for(const vid of T.verts) {
    const v=geom.vs[vid], [x,y]=W2S(v.x,v.y), d=Math.hypot(mx-x,my-y);
    if(d<Math.max(coarse?17:12,view.scale*.2)) hits.push({kind:'vert',id:vid,screen:[x,y],d});
  }
  for(const eid of T.edges) {
    const e=S.map.edges.find(x=>x.id===eid), a=geom.vs[e.a],b=geom.vs[e.b];
    const [ax,ay]=W2S(a.x,a.y),[bx,by]=W2S(b.x,b.y),d=distSeg(mx,my,ax,ay,bx,by);
    if(d<Math.max(coarse?13:9,view.scale*.15)) hits.push({kind:'edge',id:eid,screen:[(ax+bx)/2,(ay+by)/2],d:d+2});
  }
  for(const hid of T.hexes) {
    const h=S.map.hexes.find(x=>x.id===hid),[x,y]=W2S(h.x,h.y),d=Math.hypot(mx-x,my-y);
    if(d<view.scale*.86) hits.push({kind:'hex',id:hid,screen:[x,y],d});
  }
  return hits.sort((a,b)=>a.d-b.d)[0] || null;
}
function renderBuildConfirm() {
  const el=$('#buildConfirm');
  if(pendingBuild) {
    const t=targets(), target=pendingBuild.target;
    const valid=target.kind==='vert'?t.verts.has(target.id):target.kind==='edge'?t.edges.has(target.id):t.hexes.has(target.id);
    if(!valid) pendingBuild=null;
  }
  el.hidden=!pendingBuild;
  if(pendingBuild) el.innerHTML=`<span>${pendingBuild.label}</span><button class="btn primary" onclick="confirmBoardAction()">确认</button><button class="text-btn" onclick="cancelBoardAction()">取消</button>`;
}
window.confirmBoardAction=()=>{ if(pendingBuild && act(pendingBuild.action)){pendingBuild=null;renderBuildConfirm();} };
window.cancelBoardAction=()=>{pendingBuild=null;renderBuildConfirm();drawBoard();};
function distSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - x1 - t * dx, py - y1 - t * dy);
}
cv.addEventListener('mousemove', e => {
  if (!S || !geom) return;
  const [mx, my] = evPos(e);
  hoverTarget = pickAt(mx, my);
  cv.style.cursor = hoverTarget ? 'pointer' : 'default';
});
let dragBoard=null, suppressBoardClick=false;
const touchPoints=new Map();
let pinch=null;
cv.addEventListener('pointerdown',e=>{
  touchPoints.set(e.pointerId,evPos(e));
  cv.setPointerCapture(e.pointerId);
  if(touchPoints.size===1) suppressBoardClick=false;
  if(touchPoints.size===2){
    const [a,b]=[...touchPoints.values()],cx=(a[0]+b[0])/2,cy=(a[1]+b[1])/2;
    pinch={distance:Math.hypot(a[0]-b[0],a[1]-b[1]),scale:view.scale,worldX:(cx-view.ox)/view.scale,worldY:(cy-view.oy)/view.scale};
    dragBoard=null;suppressBoardClick=true;
  }
  else if(view.scale>fitScale*1.01) dragBoard={x:e.clientX,y:e.clientY,startX:e.clientX,startY:e.clientY,moved:false};
});
cv.addEventListener('pointermove',e=>{
  if(!touchPoints.has(e.pointerId))return;
  touchPoints.set(e.pointerId,evPos(e));
  if(pinch && touchPoints.size===2){
    const [a,b]=[...touchPoints.values()],cx=(a[0]+b[0])/2,cy=(a[1]+b[1])/2;
    const next=Math.max(fitScale,Math.min(fitScale*3.5,pinch.scale*Math.hypot(a[0]-b[0],a[1]-b[1])/Math.max(1,pinch.distance)));
    view.ox=cx-pinch.worldX*next;view.oy=cy-pinch.worldY*next;view.scale=next;drawBoard();return;
  }
  if(!dragBoard)return;
  const dx=e.clientX-dragBoard.x,dy=e.clientY-dragBoard.y;
  if(Math.hypot(e.clientX-dragBoard.startX,e.clientY-dragBoard.startY)>5)dragBoard.moved=true;
  if(dragBoard.moved){view.ox+=dx;view.oy+=dy;drawBoard();}
  dragBoard.x=e.clientX;dragBoard.y=e.clientY;
});
function endPointer(e){
  touchPoints.delete(e.pointerId);
  if(pinch){suppressBoardClick=true;if(touchPoints.size<2)pinch=null;}
  if(dragBoard){suppressBoardClick=dragBoard.moved;dragBoard=null;}
  if(cv.hasPointerCapture(e.pointerId))cv.releasePointerCapture(e.pointerId);
}
cv.addEventListener('pointerup',endPointer);cv.addEventListener('pointercancel',endPointer);
cv.addEventListener('contextmenu',e=>{e.preventDefault();pendingBuild=null;pickMode=null;render();});
cv.addEventListener('click',e=>{
  if(suppressBoardClick){suppressBoardClick=false;return;}
  if(!S||!geom||e.button!==0)return;
  const [mx,my]=evPos(e),t=pickAt(mx,my);
  if(!t){pendingBuild=null;renderBuildConfirm();return;}
  let action,label;
  if(S.phase==='setup' && activePlayer()===S.viewer){
    if(S.legal.kind==='settlement'&&t.kind==='vert'){action={type:'placeSettlement',vertex:t.id};label='在此安放定居点';}
    if(S.legal.kind==='road'&&t.kind==='edge'){action={type:'placeRoad',edge:t.id};label='在此安放道路';}
  }else if(S.needMoveRobber&&S.viewer===S.current&&t.kind==='hex'){action={type:'moveRobber',hex:t.id};label='把强盗移到这里';}
  else if(S.viewer===S.current&&!S.eventPending){
    if(t.kind==='edge'&&S.legal?.road?.includes(t.id)){action={type:'buildRoad',edge:t.id};label=S.roadBuildLeft?'免费修建道路':'修建道路 · 木1 砖1';}
    else if(t.kind==='vert'&&S.legal?.city?.includes(t.id)){action={type:'buildCity',vertex:t.id};label='升级城市 · 麦2 矿3';}
    else if(t.kind==='vert'&&S.legal?.settlement?.includes(t.id)){action={type:'buildSettlement',vertex:t.id};label='建定居点 · 木砖羊麦各1';}
  }
  if(!action)return;
  if(matchMedia('(pointer: coarse)').matches){pendingBuild={action,label,target:t};renderBuildConfirm();drawBoard();}
  else act(action);
});

/* ---------- 启动 ---------- */
if (roomCode) {
  myToken = localStorage.getItem('catan_tk_' + roomCode);
  if (name) { $('#nameInput').value = name; connect(roomCode); }
  else {
    // 需要先起昵称
    $('#joinBtn').textContent = '进入房间';
    $('#codeInput').value = roomCode;
    $('#joinBtn').onclick = () => { if (!name) return toast('先输入昵称'); connect(roomCode); };
  }
}

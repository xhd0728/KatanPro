// Local Chrome UI regression: real room, canvas setup, trade, reconnection and mobile layouts.
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import {createGame,serialize,playerAct} from '../game/engine.js';
import {ruleBotAction} from '../bot.js';
const chromeBin=process.env.CHROME_BIN || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/google-chrome','/usr/bin/chromium'].find(p=>fs.existsSync(p));
if(!chromeBin) throw new Error('Set CHROME_BIN to a Chrome/Chromium executable.');
const port=22000+Math.floor(Math.random()*8000),origin=`http://127.0.0.1:${port}`;
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'catan-ui-'));
const output=path.resolve('artifacts/ui');fs.mkdirSync(output,{recursive:true});
const chromeStartupTimeout=Math.max(5000,Number(process.env.UI_CHROME_STARTUP_TIMEOUT_MS)||30000);
const server=spawn(process.execPath,['server.js'],{env:{...process.env,PORT:String(port),CATAN_AI_BASE_URL:'',CATAN_AI_MODEL:'',CATAN_AI_KEY:''},stdio:'ignore'});
const chrome=spawn(chromeBin,['--headless=new','--no-sandbox','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:['ignore','ignore','pipe']});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
let socket;const errors=[];let seq=0;const callbacks=new Map();
try{
  const endpoint=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error(`Chrome startup timed out after ${chromeStartupTimeout}ms`)),chromeStartupTimeout);
    chrome.stderr.on('data',b=>{const match=b.toString().match(/DevTools listening on (ws:\/\/[^\s]+)/);if(match){clearTimeout(timer);resolve(match[1]);}});
    chrome.on('error',reject);
  });
  for(let n=0;n<80;n++){try{if((await fetch(origin+'/api/rooms')).ok)break;}catch{}await pause(50);}
  const debuggerOrigin=endpoint.replace('ws:','http:').split('/devtools/')[0];
  const target=await fetch(debuggerOrigin+'/json/new?'+origin,{method:'PUT'}).then(r=>r.json());
  socket=new WebSocket(target.webSocketDebuggerUrl);await once(socket,'open');
  socket.on('message',bytes=>{const m=JSON.parse(bytes);if(m.id){const c=callbacks.get(m.id);if(c){callbacks.delete(m.id);m.error?c.reject(new Error(JSON.stringify(m.error))):c.resolve(m.result);}}else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);});
  const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;callbacks.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
  const run=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result?.value;};
  const until=async(expression,ms=10000)=>{for(let i=0;i<ms/60;i++){try{const v=await run(expression);if(v)return v;}catch{}await pause(60);}throw new Error('Timed out: '+expression);};
  const screenshot=async name=>{await pause(140);const r=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(output,name+'.png'),Buffer.from(r.data,'base64'));};
  const viewport=async(width,height,mobile=false)=>{await call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile});await call('Emulation.setTouchEmulationEnabled',{enabled:mobile});await pause(180);};
  const click=async(x,y)=>{await call('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});await call('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1});};
  const touch=(type,touchPoints)=>call('Input.dispatchTouchEvent',{type,touchPoints});
  const tap=async(x,y)=>{await touch('touchStart',[{x,y,id:1}]);await touch('touchEnd',[]);await pause(60);};
  const tapElement=async selector=>{const pos=await run(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()`);await tap(...pos);};
  await call('Page.enable');await call('Runtime.enable');await viewport(1440,960);
  await until("document.querySelector('#nameInput')");await screenshot('lobby-desktop');await viewport(390,844,true);await screenshot('lobby-mobile');await viewport(1440,960);
  await run("$('#nameInput').value='海岸旅人';$('#nameInput').dispatchEvent(new Event('input'));$('#createBtn').click()");
  await until("document.querySelector('#roomView')&&!$('#roomView').hidden");
  // A stale server must not silently pretend to accept the new roster controls.
  await run("window._modernRoom=currentRoom;showRoom({...currentRoom,rosterVersion:undefined})");
  assert.equal(await run("$('#addBotBtn').getAttribute('aria-disabled')"),'true');
  await run('showRoom(_modernRoom)');
  await tapElement('#addBotBtn');await until('currentRoom.players.length===2');
  await run("$('#roomPlayers .seat-difficulty').value='highest';$('#roomPlayers .seat-difficulty').dispatchEvent(new Event('change',{bubbles:true}))");
  await until("currentRoom.players[1].difficulty==='highest'");
  await tapElement('#roomPlayers .remove-bot');await until('currentRoom.players.length===1');
  await tapElement('#roomRoleBtn');await until("currentRoom.viewerKind==='spectator'");
  assert.equal(await run('currentRoom.isHost'),true);
  await call('Page.reload');await until("typeof currentRoom!=='undefined'&&currentRoom?.viewerKind==='spectator'");
  assert.equal(await run('currentRoom.isHost'),true,'room role and host survive reload');
  await tapElement('#roomRoleBtn');await until("currentRoom.viewerKind==='human'");
  await run("$('#botDifficulty').value='low';$('#botDifficulty').dispatchEvent(new Event('change'))");
  for(let i=2;i<=3;i++){await tapElement('#addBotBtn');await until(`currentRoom.players.length===${i}`);}
  assert.equal(await run("currentRoom.players.slice(1).every(p=>p.name==='AI'&&p.difficulty==='low')"),true);
  for(const [i,level] of ['medium','high','very-high','highest','low'].entries()) {
    await run(`$('#botDifficulty').value='${level}';$('#addBotBtn').click()`);
    await until(`currentRoom.players.length===${i+4}`);
  }
  assert.equal(await run("$('#addBotBtn').getAttribute('aria-disabled')"),'true','full roster cannot add bots');
  await screenshot('mixed-room-eight-desktop');
  await viewport(320,568,true);await run("$('#roomPlayers').scrollIntoView({block:'start'})");await screenshot('mixed-room-eight-mobile');
  assert.equal(await run('document.documentElement.scrollWidth<=innerWidth'),true,'eight-seat roster fits narrow phones');
  assert.equal(await run("$('#roomPlayers').scrollHeight>$('#roomPlayers').clientHeight"),true,'long mobile roster scrolls within its own area');
  for(let i=7;i>=3;i--){await tapElement('#roomPlayers .room-seat:last-child .remove-bot');await until(`currentRoom.players.length===${i}`);}
  await viewport(1440,960);await run('window.scrollTo(0,0)');
  for(const size of ['epic','twin','small']) {
    await run(`$('#setMap').value='${size}';$('#setMap').dispatchEvent(new Event('change'))`);
    await until(`currentRoom.settings.mapSize==='${size}'`);
    assert.ok(await run("$('#mapDescription').textContent.length>10"));
  }
  await run("$('#startBtn').click()");
  await until("typeof S !== 'undefined' && S?.phase==='setup'");
  assert.equal(await run("Number($('#playerCards').firstElementChild.dataset.playerIndex)"),await run('activePlayer()'),'setup actor is pinned first');
  const setupSnapshot=await run('JSON.stringify(S)');
  await viewport(390,844,true);
  let canvasClicks=0;
  for(let n=0;n<180;n++){
    const phase=await run('S.phase');if(phase==='play')break;
    const pos=await run(`S.legal.setupPlayer===S.viewer?(()=>{const id=S.legal.setup[0],v=S.legal.kind==='settlement'?geom.vs[id]:(()=>{const e=S.map.edges.find(e=>e.id===id),a=geom.vs[e.a],b=geom.vs[e.b];return{x:(a.x+b.x)/2,y:(a.y+b.y)/2}})(),p=W2S(v.x,v.y),r=cv.getBoundingClientRect();return [r.x+p[0],r.y+p[1]]})():null`);
    if(pos){
      await tap(...pos);assert.ok(await run('pendingBuild'),'touch opens placement confirmation');
      await tapElement('#buildConfirm .primary');canvasClicks++;
    }
    await pause(160);
  }
  await until("S.phase==='play'");assert.ok(canvasClicks>=4);await viewport(1440,960);
  await screenshot('game-desktop');
  // Use real actions for the first roll and any robber event, then verify trade response.
  await run("act({type:'roll'})");await until('S.rolled');
  if(await run('S.needMoveRobber')){
    await run("act({type:'moveRobber',hex:S.map.hexes.find(h=>h.id!==S.map.robber).id})");await pause(180);
    if(await run('S.stealFrom.length'))await run("act({type:'steal',from:S.stealFrom[0]})");
  }
  await until('!S.eventPending');await screenshot('game-dice');
  const tradeRes=await run('Object.entries(me().res).find(([,n])=>n>0)?.[0]');
  if(tradeRes){await run(`act({type:'offerTrade',give:{${tradeRes}:1},want:{ore:29},targets:[1,2]})`);await until('S.log.some(l=>l.text.includes("均已拒绝"))');assert.equal(await run('S.offer'),null);}
  await run('openTrade()');await screenshot('trade-desktop');await run('closeModal()');
  const originalCode=await run('roomCode'), originalToken=await run('myToken');
  const seat=await run('S.viewer');await call('Page.reload');await until('typeof S!=="undefined" && S?.phase==="play"');assert.equal(await run('S.viewer'),seat);assert.equal(await run('currentRoom.isHost'),true);
  await viewport(390,844,true);await screenshot('game-mobile');
  const before=await run('zoomBoard(1.4); view.scale');
  await run("S.current=(S.current+1)%S.players.length;render()");await pause(100);
  assert.equal(await run('view.scale'),before,'turn change preserves zoom');
  await run('S.current=S.viewer;render();fitBoard();drawBoard()');
  await run("$('#mobileInfoBtn').click()");await screenshot('info-mobile');await run("$('#mobileInfoBtn').click()");
  await run('openTrade()');await screenshot('trade-mobile');
  await tapElement('#want_ore + button');assert.equal(await run("$('#want_ore').value"),'1');
  assert.equal(await run("$('#stock_ore').textContent"),await run("'持有 '+me().res.ore"));
  assert.equal(await run("$('#want_state_ore').textContent"),await run("'成交后 '+(me().res.ore+1)+' 张'"));
  await run("me().res.ore=4;S.bank.ore=20;refreshTrade()");
  assert.equal(await run("$('#stock_ore').textContent"),'持有 4');
  assert.equal(await run("$('#bank_stock_ore').textContent"),'银行 20');
  await tapElement('#give_ore + button');
  assert.equal(await run("$('#give_state_ore').textContent"),'选 1 · 剩 3');
  assert.equal(await run("$('#want_state_ore').textContent"),'成交后 4 张');await run('closeModal()');
  // Isolated client fixtures exercise all card UI states without granting server resources.
  const snapshot=await run('JSON.stringify(S)');
  await run("me().res={wood:0,brick:0,sheep:0,wheat:0,ore:0};S.rolled=true;S.roadBuildLeft=0;S.eventPending=false;S.discardCount=0;S.robberPending=false;S.stealPending=false;render()");
  await tapElement('#actionbar button[onclick*="city"]');
  assert.match(await run("$('#toasts').lastElementChild.textContent"),/还缺 小麦 2 张、矿石 3 张/);
  assert.equal(await run('pickMode'),null,'unavailable build does not enter placement');
  await tapElement('#actionbar .rollbtn');
  assert.match(await run("$('#toasts').lastElementChild.textContent"),/已经掷过/);
  await run('openTrade()');await tapElement('#bankConfirm');
  assert.match(await run("$('#toasts').lastElementChild.textContent"),/资源不足/);
  assert.equal(await run('modalKind'),'trade','unavailable bank action keeps the dialog open');
  await tapElement('#offerConfirm');assert.match(await run("$('#toasts').lastElementChild.textContent"),/选择要给出/);
  await run(`closeModal();S=JSON.parse(${JSON.stringify(snapshot)});render()`);
  await run("S.cards={knight:1,road:1,year:1,mono:1,fresh:['mono']};me().dev.vp=1;openCards()");await screenshot('development-mobile');assert.equal(await run("$('#modal').hidden"),false);await run('closeModal()');
  await run("me().res={wood:3,brick:2,sheep:2,wheat:1,ore:1};me().total=9;me().needDiscard=true;renderModals()");
  for(let i=1;i<=4;i++)await tapElement(`.resource-card:nth-child(${i})`);
  assert.equal(await run("document.querySelectorAll('.resource-card.selected').length"),4);assert.equal(await run("$('#discOk').getAttribute('aria-disabled')"),'false');await screenshot('discard-mobile');
  await run(`closeModal();S=JSON.parse(${JSON.stringify(setupSnapshot)});render()`);
  await run('fitBoard();drawBoard()');
  const center=await run('(()=>{const r=cv.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,wx:(r.width/2-view.ox)/view.scale,wy:(r.height/2-view.oy)/view.scale,scale:view.scale}})()');
  await touch('touchStart',[{x:center.x-40,y:center.y,id:1},{x:center.x+40,y:center.y,id:2}]);
  await touch('touchMove',[{x:center.x-60,y:center.y+30,id:1},{x:center.x+100,y:center.y+30,id:2}]);
  await touch('touchEnd',[]);await pause(80);
  assert.ok(await run('view.scale')>center.scale*1.5,'two-finger pinch zooms board');
  const anchor=await run(`W2S(${center.wx},${center.wy})`),rect=await run('(()=>{const r=cv.getBoundingClientRect();return{x:r.x,y:r.y}})()');
  assert.ok(Math.abs(anchor[0]+rect.x-center.x-20)<3&&Math.abs(anchor[1]+rect.y-center.y-30)<3,'pinch follows moving finger midpoint');
  assert.equal(await run('pendingBuild'),null,'pinch cannot place pieces');
  const panBefore=await run('({x:view.ox,y:view.oy})');
  await touch('touchStart',[{x:center.x,y:center.y,id:1}]);
  await touch('touchMove',[{x:center.x+35,y:center.y+25,id:1}]);
  await touch('touchEnd',[]);await pause(60);
  const panAfter=await run('({x:view.ox,y:view.oy})');
  assert.ok(Math.abs(panAfter.x-panBefore.x-35)<3&&Math.abs(panAfter.y-panBefore.y-25)<3,'one-finger drag pans zoomed board');
  assert.equal(await run('pendingBuild'),null,'drag cannot place pieces');
  await tapElement('#zoomFit');
  const touchTarget=await run("(()=>{const v=geom.vs[S.legal.setup[0]],p=W2S(v.x,v.y),r=cv.getBoundingClientRect();return [p[0]+r.x,p[1]+r.y]})()");
  await tap(...touchTarget);assert.ok(await run('pendingBuild'),'mobile tap after pinch previews placement');
  await screenshot('placement-mobile');await run('cancelBoardAction()');assert.equal(await run('pendingBuild'),null);
  await run(`closeModal();S=JSON.parse(${JSON.stringify(snapshot)});render()`);
  for(const width of [320,768]){await viewport(width,844,true);assert.equal(await run('document.documentElement.scrollWidth<=innerWidth'),true,`no horizontal page overflow at ${width}`);await screenshot('game-'+width);}
  await viewport(320,568,true);await run('openTrade()');
  assert.equal(await run("[...document.querySelectorAll('.stepper button')].every(b=>{const r=b.getBoundingClientRect();return r.width>=39&&r.height>=43})"),true,'small-phone trade targets remain tappable');
  assert.equal(await run("document.querySelector('.trade-grid').scrollWidth<=document.querySelector('.trade-grid').clientWidth"),true,'small-phone trade grid does not overflow');
  await tapElement('#want_ore + button');assert.equal(await run("$('#want_ore').value"),'1');
  await screenshot('trade-320');await run('closeModal()');
  assert.equal(await run('document.documentElement.scrollWidth<=innerWidth'),true,'320x568 has no page overflow');
  await viewport(844,390,true);await screenshot('game-landscape');
  assert.equal(await run("(()=>{const r=$('#handTray').getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('#handTray')!==null})()"),true,'closed information drawer must not cover landscape controls');
  // Render each server-generated layout at desktop and phone sizes. These are
  // isolated display fixtures; the real multiplayer path above stays separate.
  // Authoritative-state messages trigger travel for players and spectators.
  await viewport(1440,960);
  for(const spectator of [false,true]) {
    const game=createGame({mapSize:'small',targetVP:10,startBonus:'none',playerNames:['动画玩家','另一位玩家']});
    game.phase='play';
    const before=serialize(game,spectator?null:game.players[0].id);
    const origin=game.map.hexes.find(h=>h.id===game.map.robber);
    const destination=game.map.hexes.reduce((best,h)=>Math.hypot(h.x-origin.x,h.y-origin.y)>Math.hypot(best.x-origin.x,best.y-origin.y)?h:best);
    game.map.robber=destination.id;const after=serialize(game,spectator?null:game.players[0].id);
    await run(`ws.onmessage({data:JSON.stringify({type:'state',state:${JSON.stringify(before)}})})`);
    assert.equal(await run('robberMotion'),null,'new game does not animate from previous board');
    await run(`ws.onmessage({data:JSON.stringify({type:'state',state:${JSON.stringify(after)}})})`);
    await pause(200);
    const midway=await run('robberPose()');
    assert.ok(midway.progress>0&&midway.progress<1,'robber visibly travels over multiple frames');
    assert.ok(Math.hypot(midway.x-destination.x,midway.y-destination.y)>.1,'not teleporting');
    if(!spectator)await screenshot('robber-moving');
    await until('robberMotion===null');
    const end=await run('robberPose()');assert.ok(Math.hypot(end.x-destination.x,end.y-destination.y)<1e-8);
    await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    await run(`ws.onmessage({data:JSON.stringify({type:'state',state:${JSON.stringify(before)}})})`);
    assert.equal(await run('robberMotion'),null,'reduced motion places robber immediately');
    await call('Emulation.setEmulatedMedia',{features:[]});
  }
  for(const [mapSize,count,ports] of [['small',19,9],['medium',30,11],['large',37,12],['epic',61,18],['twin',73,20]]) {
    const game=createGame({mapSize,targetVP:10,startBonus:'none',playerNames:['海岸旅人','地图对手']});
    const state=serialize(game,game.players[0].id);
    assert.equal(state.map.hexes.length,count);assert.equal(state.map.ports.length,ports);
    await run(`S=${JSON.stringify(state)};pickMode=null;pendingBuild=null;render()`);
    for(const [width,height,name] of [[1440,960,'desktop'],[390,844,'mobile']]) {
      await viewport(width,height,width<600);await run('fitBoard();drawBoard()');
      assert.equal(await run('S.map.ports.every(p=>{const [x,y]=W2S(...portPosition(p)),r=view.scale*.3;return x-r>=0&&x+r<=cv.clientWidth&&y-r>=0&&y+r<=cv.clientHeight})'),true,`${mapSize} ports stay in ${name} viewport`);
      await screenshot(`map-${mapSize}-${name}`);
    }
  }
  const crowded=createGame({mapSize:'large',targetVP:10,startBonus:'none',playerNames:Array.from({length:8},(_,i)=>'开拓者 '+(i+1))});
  while(crowded.phase==='setup') {
    const index=serialize(crowded,null).legal.setupPlayer,id=crowded.players[index].id;
    assert.equal(playerAct(crowded,id,ruleBotAction(serialize(crowded,id))),null);
  }
  crowded.log=Array.from({length:50},(_,i)=>({name:'系统',text:'布局检查日志 '+i}));
  crowded.log.push({name:'最高 AI',color:crowded.players[1].color,kind:'bot-thought',text:'看过建造位置后，觉得继续修路先等等：现在更需要直接争取分数，于是选择升级城市。'});
  await viewport(1280,720);
  await run(`S=${JSON.stringify(serialize(crowded,crowded.players[0].id))};render();$('#diceStats').hidden=false;renderStats();$('#side').scrollTop=$('#side').scrollHeight;$('#log').scrollTop=$('#log').scrollHeight`);
  assert.equal(await run("(()=>{const s=$('#side').getBoundingClientRect();return ['#handTray','#actionbar'].every(id=>$(id).getBoundingClientRect().right<=s.left+1)&&s.bottom<=innerHeight})()"),true,'desktop controls never overlap sidebar');
  assert.equal(await run("(()=>{const e=$('#log').lastElementChild,r=e.getBoundingClientRect();return r.bottom<=innerHeight&&document.elementFromPoint(r.x+10,r.y+r.height/2)?.closest('#log')!==null})()"),true,'last log remains visible with eight players and statistics');
  assert.equal(await run("document.querySelectorAll('#log .bot-thought').length"),1,'agent summary uses its own visible log style');
  await run(`ws.onmessage({data:JSON.stringify({type:'bot-progress',gameId:S.id,actor:1,runId:99,phase:'thinking'})});ws.onmessage({data:JSON.stringify({type:'bot-progress',gameId:S.id,actor:1,runId:99,phase:'tool',tool:'inspectBuilds'})})`);
  assert.equal(await run("!$('#botProgress').hidden && $('#botProgress').textContent.includes('已查 建造位置')"),true,'live tool status is visible');
  assert.equal(await run("$('.bot-progress-head b').textContent"),`${crowded.players[1].name} · 2 号`,'live status names the acting seat');
  assert.equal(await run("$('#log').getBoundingClientRect().height>=100"),true,'island activity has a dedicated scrolling area');
  assert.equal(await run("$('#log').firstElementChild.textContent.includes(S.log.at(-1).text)"),true,'newest activity appears first');
  assert.equal(await run("(()=>{S.startedAt=1000;S.endedAt=66000;renderDuration();return $('#gameDuration').textContent})()"),'00:01:05','finished game duration uses server timestamps');
  assert.equal(await run("[...$('#playerCards').children].every(card=>{const rect=card.getBoundingClientRect();return rect.top>=70&&rect.bottom<$('.logbox').getBoundingClientRect().top}) && $('#playerCards').scrollHeight<=$('#playerCards').clientHeight+1"),true,'all eight players are visible without roster scrolling');
  await screenshot('sidebar-eight-players');
  await run(`ws.onmessage({data:JSON.stringify({type:'bot-progress',gameId:S.id,actor:1,runId:99,phase:'done'})})`);
  assert.equal(await run("$('#botProgress').hidden"),true,'live status clears after the decision');
  const dockSize=await run("({h:$('#handTray').offsetHeight,a:$('#actionbar').offsetHeight})");
  const dockCard=await run("(()=>{const r=$('.hand-card').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
  await call('Input.dispatchMouseEvent',{type:'mouseMoved',...dockCard});await pause(200);
  if(await run("matchMedia('(hover:hover) and (pointer:fine)').matches")) assert.ok(await run("parseFloat($('.hand-card').style.getPropertyValue('--dock-scale'))")>1,'mouse proximity magnifies dock icons');
  assert.equal(await run("({h:$('#handTray').offsetHeight,a:$('#actionbar').offsetHeight})").then(v=>JSON.stringify(v)),JSON.stringify(dockSize),'dock hover preserves board layout');
  await screenshot('dock-desktop');
  assert.deepEqual(await run("[...document.querySelectorAll('.avatar')].map(e=>e.textContent)"),['1','2','3','4','5','6','7','8'],'player numbers supplement color identity');
  assert.equal(await run("[...document.querySelectorAll('.pcard')].every((card,i)=>[S.players[i].settlements,S.players[i].cities,S.players[i].roadLength,S.players[i].robberMoves].every((n,j)=>card.querySelectorAll('.pcard-metrics strong')[j].textContent===String(n)))"),true,'buildings, connected roads and robber moves are prominent');
  assert.equal(await run("parseFloat(getComputedStyle($('.pcard-metrics strong')).fontSize)>parseFloat(getComputedStyle($('.pcard-details')).fontSize)"),true,'resource hand count is secondary');
  await viewport(1440,960);await run("$('#diceStats').hidden=true;$('#side').scrollTop=0;render()");await screenshot('players-contrast-desktop');
  const nextSeat=await run('(activePlayer()+3)%S.players.length');
  await run(`$('#playerCards').scrollTop=$('#playerCards').scrollHeight;S.current=${nextSeat};render()`);
  assert.deepEqual(await run("[...$('#playerCards').children].map(card=>Number(card.dataset.playerIndex))"),[nextSeat,...Array.from({length:8},(_,i)=>i).filter(i=>i!==nextSeat)],'turn actor moves first without changing seat identities');
  assert.equal(await run("$('#playerCards').firstElementChild.getAttribute('aria-current')"),'true');
  assert.equal(await run("[...$('#playerCards').children].some(card=>card.getAnimations().some(animation=>animation.effect.getKeyframes().some(frame=>String(frame.transform||'').startsWith('translateY('))))"),true,'turn change animates card travel');
  await pause(180);await screenshot('players-turn-moving');await pause(720);
  assert.ok(await run("$('#playerCards').scrollTop")<2,'new actor is brought into view');
  await run('render()');
  assert.equal(await run("[...$('#playerCards').children].some(card=>card.getAnimations().some(animation=>animation.effect.getKeyframes().some(frame=>String(frame.transform||'').startsWith('translateY('))))"),false,'same turn does not replay travel');
  await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await run('S.current=(S.current+1)%S.players.length;render()');
  assert.equal(await run("Number($('#playerCards').firstElementChild.dataset.playerIndex)"),await run('activePlayer()'),'reduced motion still reorders cards');
  assert.equal(await run("[...$('#playerCards').children].some(card=>card.getAnimations().some(animation=>animation.effect.getKeyframes().some(frame=>String(frame.transform||'').startsWith('translateY('))))"),false,'reduced motion skips travel');
  await call('Emulation.setEmulatedMedia',{features:[]});
  await viewport(390,844,true);await run("$('#mobileInfoBtn').click()");await screenshot('players-contrast-mobile');await run("$('#mobileInfoBtn').click()");
  await call('Page.navigate',{url:origin+'/?ui-smoke=ai-only'});
  await until("location.search==='?ui-smoke=ai-only' && document.readyState==='complete' && typeof $==='function' && !!document.querySelector('[name=createMode]')");
  await run("document.querySelector('[name=createMode][value=\"ai-only\"]').checked=true;$('#createBtn').click()");
  await until("typeof currentRoom!=='undefined'&&currentRoom?.mode==='ai-only'");
  assert.equal(await run("$('#botDifficulty').value"),'medium','medium is the default');
  assert.equal(await run('currentRoom.players.length'),4,'AI seats exist before start');
  assert.equal(await run("currentRoom.players.every(p=>p.kind==='bot')"),true,'host does not occupy a player seat');
  for(let i=3;i>=2;i--){await tapElement('#roomPlayers .remove-bot');await until(`currentRoom.players.length===${i}`);}
  await viewport(390,844,true);await screenshot('ai-room-mobile');await viewport(1440,960);await screenshot('ai-room-desktop');
  await run("$('#startBtn').click()");await until("typeof S!=='undefined'&&S?.phase==='play'",15000);
  assert.equal(await run('S.viewer'),-1);assert.equal(await run('S.players.every(p=>p.kind===\'bot\'&&p.res===null)'),true);
  assert.equal(await run("document.querySelectorAll('#playerCards .difficulty-badge').length"),2);
  assert.equal(await run("[...document.querySelectorAll('.pcard .top')].every(top=>{const mid=e=>{const r=e.getBoundingClientRect();return r.top+r.height/2};const y=mid(top.querySelector('.avatar'));return [...top.querySelectorAll('.nm,.difficulty-badge,.turn-status,.vp')].every(e=>Math.abs(mid(e)-y)<=2)})"),true,'player name, difficulty and turn status share one row');
  await screenshot('ai-spectator-desktop');
  await call('Page.reload');await until("typeof S!=='undefined'&&S?.viewer===-1");
  assert.equal(await run('currentRoom.isHost'),true,'spectator host survives reload');
  await viewport(390,844,true);await screenshot('ai-spectator-mobile');
  assert.equal(await run("getComputedStyle($('#handTray')).display"),'none','spectators have more board space');
  await viewport(844,390,true);await screenshot('ai-spectator-landscape');
  assert.equal(await run('document.documentElement.scrollWidth<=innerWidth'),true,'spectator landscape has no overflow');
  await call('Page.navigate',{url:origin+'/?ui-smoke=rooms'});
  await until("location.search==='?ui-smoke=rooms' && document.readyState==='complete' && typeof $==='function' && !!$('#roomList .room-item')");
  await viewport(1440,960);await screenshot('lobby-active-rooms');
  assert.ok(await run("$('#roomList').textContent.includes('对局中')"),'active games remain discoverable');
  assert.ok(await run("$('#roomList').textContent.includes('返回')"),'existing players can return from the lobby');
  await run(`quickJoin('${originalCode}',false,true)`);
  await until("typeof S!=='undefined'&&S?.viewer===-1");
  assert.equal(await run(`localStorage.getItem('catan_tk_${originalCode}')`),originalToken,'watching never replaces the player resume token');
  assert.notEqual(await run('myToken'),originalToken);
  await call('Page.navigate',{url:origin+'/?room='+originalCode});
  await until("typeof S!=='undefined'&&S?.viewer===0");
  assert.equal(await run('myToken'),originalToken,'normal room link resumes the player seat');
  assert.deepEqual(errors,[],'browser runtime errors');
  console.log(JSON.stringify({passed:true,canvasClicks,players:3,touchChecks:['setup-confirm','pinch-with-pan','single-finger-pan','tap-after-pinch','discard-cards','trade-stepper'],viewports:['1440×960','390×844','320×844','320×568','768×844','844×390'],featureChecks:['trade-inventory','unavailable-reasons','sidebar-eight-players','turn-card-sort-motion','dock-hover','ai-only-room','mixed-room-eight','per-seat-difficulty','role-switch-reload','lobby-watch','spectator-token-isolation','spectator-host-reload'],screenshots:output,browserErrors:errors},null,2));
} finally {
  socket?.terminate();chrome.kill();server.kill();
  await pause(200);try{fs.rmSync(profile,{recursive:true,force:true});}catch{}
}

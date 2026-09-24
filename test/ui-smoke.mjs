// Local Chrome UI regression: real room, canvas setup, trade, reconnection and mobile layouts.
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import {createGame,serialize} from '../game/engine.js';
const chromeBin=process.env.CHROME_BIN || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/google-chrome','/usr/bin/chromium'].find(p=>fs.existsSync(p));
if(!chromeBin) throw new Error('Set CHROME_BIN to a Chrome/Chromium executable.');
const port=22000+Math.floor(Math.random()*8000),origin=`http://127.0.0.1:${port}`;
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'catan-ui-'));
const output=path.resolve('artifacts/ui');fs.mkdirSync(output,{recursive:true});
const server=spawn(process.execPath,['server.js'],{env:{...process.env,PORT:String(port),CATAN_AI_BASE_URL:'',CATAN_AI_MODEL:'',CATAN_AI_KEY:''},stdio:'ignore'});
const chrome=spawn(chromeBin,['--headless=new','--no-sandbox','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:['ignore','ignore','pipe']});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
let socket;const errors=[];let seq=0;const callbacks=new Map();
try{
  const endpoint=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Chrome startup timed out')),12000);
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
  // Reproduce a still-running older backend echoing room settings without AI fields.
  await run("window._modernRoom=JSON.stringify(currentRoom);window._originalSend=send;window._legacyRoom={...currentRoom,settings:{mapSize:'small',targetVP:10,startBonus:'none'}};send=()=>{showRoom(_legacyRoom);return true};showRoom(_legacyRoom)");
  await tapElement('#soloMode');
  assert.equal(await run("$('#soloMode').checked"),true,'legacy room echo preserves robot checkbox');
  assert.equal(await run("$('#botCount').value"),'2');assert.equal(await run("$('#botDifficulty').value"),'llm');
  assert.equal(await run("$('#botDifficulty').disabled"),false,'legacy robot controls remain usable');
  await tapElement('#soloMode');assert.equal(await run("$('#soloMode').checked"),false);
  await run('send=_originalSend;showRoom(JSON.parse(_modernRoom))');
  await tapElement('#soloMode');await until('currentRoom.settings.withBots===true');
  assert.equal(await run("$('#soloMode').checked"),true,'modern room keeps checkbox after server response');
  for(const size of ['epic','twin','small']) {
    await run(`$('#setMap').value='${size}';$('#setMap').dispatchEvent(new Event('change'))`);
    await until(`currentRoom.settings.mapSize==='${size}'`);
    assert.ok(await run("$('#mapDescription').textContent.length>10"));
  }
  await run("$('#soloMode').checked=true;$('#soloMode').dispatchEvent(new Event('change'));$('#botCount').value='2';$('#botDifficulty').value='rule';$('#botDifficulty').dispatchEvent(new Event('change'));$('#startBtn').click()");
  await until("typeof S !== 'undefined' && S?.phase==='setup'");
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
  const crowded=createGame({mapSize:'small',targetVP:10,startBonus:'none',playerNames:Array.from({length:8},(_,i)=>'开拓者 '+(i+1))});
  crowded.phase='play';crowded.log=Array.from({length:50},(_,i)=>({name:'系统',text:'布局检查日志 '+i}));
  await viewport(1280,720);
  await run(`S=${JSON.stringify(serialize(crowded,crowded.players[0].id))};render();$('#diceStats').hidden=false;renderStats();$('#side').scrollTop=$('#side').scrollHeight;$('#log').scrollTop=$('#log').scrollHeight`);
  assert.equal(await run("(()=>{const s=$('#side').getBoundingClientRect();return ['#handTray','#actionbar'].every(id=>$(id).getBoundingClientRect().right<=s.left+1)&&s.bottom<=innerHeight})()"),true,'desktop controls never overlap sidebar');
  assert.equal(await run("(()=>{const e=$('#log').lastElementChild,r=e.getBoundingClientRect();return r.bottom<=innerHeight&&document.elementFromPoint(r.x+10,r.y+r.height/2)?.closest('#log')!==null})()"),true,'last log remains visible with eight players and statistics');
  await screenshot('sidebar-eight-players');
  const dockSize=await run("({h:$('#handTray').offsetHeight,a:$('#actionbar').offsetHeight})");
  const dockCard=await run("(()=>{const r=$('.hand-card').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
  await call('Input.dispatchMouseEvent',{type:'mouseMoved',...dockCard});await pause(200);
  if(await run("matchMedia('(hover:hover) and (pointer:fine)').matches")) assert.ok(await run("parseFloat($('.hand-card').style.getPropertyValue('--dock-scale'))")>1,'mouse proximity magnifies dock icons');
  assert.equal(await run("({h:$('#handTray').offsetHeight,a:$('#actionbar').offsetHeight})").then(v=>JSON.stringify(v)),JSON.stringify(dockSize),'dock hover preserves board layout');
  await screenshot('dock-desktop');
  await call('Page.navigate',{url:origin});await until("document.querySelector('[name=createMode]')");
  await run("document.querySelector('[name=createMode][value=\"ai-only\"]').checked=true;$('#createBtn').click()");
  await until("typeof currentRoom!=='undefined'&&currentRoom?.mode==='ai-only'");
  assert.equal(await run("$('#botDifficulty').value"),'llm','large model is the default');
  assert.equal(await run('currentRoom.players.length'),0,'host does not occupy a player seat');
  await run("$('#botCount').value='2';$('#botCount').dispatchEvent(new Event('change'))");await until('currentRoom.settings.botCount===2');
  await viewport(390,844,true);await screenshot('ai-room-mobile');await viewport(1440,960);await screenshot('ai-room-desktop');
  await run("$('#startBtn').click()");await until("typeof S!=='undefined'&&S?.phase==='play'",15000);
  assert.equal(await run('S.viewer'),-1);assert.equal(await run('S.players.every(p=>p.kind===\'bot\'&&p.res===null)'),true);
  await screenshot('ai-spectator-desktop');
  await call('Page.reload');await until("typeof S!=='undefined'&&S?.viewer===-1");
  assert.equal(await run('currentRoom.isHost'),true,'spectator host survives reload');
  await viewport(390,844,true);await screenshot('ai-spectator-mobile');
  assert.equal(await run("getComputedStyle($('#handTray')).display"),'none','spectators have more board space');
  await viewport(844,390,true);await screenshot('ai-spectator-landscape');
  assert.equal(await run('document.documentElement.scrollWidth<=innerWidth'),true,'spectator landscape has no overflow');
  assert.deepEqual(errors,[],'browser runtime errors');
  console.log(JSON.stringify({passed:true,canvasClicks,players:3,touchChecks:['setup-confirm','pinch-with-pan','single-finger-pan','tap-after-pinch','discard-cards','trade-stepper'],viewports:['1440×960','390×844','320×844','320×568','768×844','844×390'],featureChecks:['trade-inventory','unavailable-reasons','sidebar-eight-players','dock-hover','ai-only-room','spectator-host-reload'],screenshots:output,browserErrors:errors},null,2));
} finally {
  socket?.terminate();chrome.kill();server.kill();
  await pause(200);try{fs.rmSync(profile,{recursive:true,force:true});}catch{}
}

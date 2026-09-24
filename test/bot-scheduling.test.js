import test from 'node:test';
import assert from 'node:assert/strict';
import {createGame,playerAct,serialize,RES} from '../game/engine.js';
import {nextBot,botNeedsAction} from '../game/bot-scheduling.js';
import {ruleBotAction} from '../bot.js';

function waitingRoom() {
  const g=createGame({mapSize:'twin',targetVP:10,startBonus:'none',playerNames:Array.from({length:8},(_,i)=>`玩家${i}`)});
  g.phase='play';g.current=5;g.rolled=true;g.turn=22;g.needMoveRobber=true;g.discardQueue=[2,5,6,7];
  for(const [i,r,n] of [[2,'wood',10],[5,'brick',15],[6,'sheep',10],[7,'wheat',12]]){g.players[i].res[r]=n;g.bank[r]-=n;}
  return {g,roster:g.players.map((p,i)=>({kind:i===0?'human':'bot',gamePlayerId:p.id}))};
}

test('第22回合多人弃牌：当前 AI 弃完后继续调度后面的 AI',()=>{
  const {g,roster}=waitingRoom(),order=[];
  while(g.discardQueue.length){
    const bot=nextBot(g,roster);assert.ok(bot);
    const i=g.players.findIndex(p=>p.id===bot.gamePlayerId),action=ruleBotAction(serialize(g,bot.gamePlayerId));
    assert.equal(action.type,'discard');order.push(i);assert.equal(playerAct(g,bot.gamePlayerId,action),null);
    if(i===5)assert.equal(botNeedsAction(g,g.players[5].id),false,'已弃牌的当前玩家必须让出调度');
  }
  assert.deepEqual(order,[2,5,6,7]);
  const bot=nextBot(g,roster);assert.equal(bot.gamePlayerId,g.players[5].id);
  const action=ruleBotAction(serialize(g,bot.gamePlayerId));assert.equal(action.type,'moveRobber');
  assert.equal(playerAct(g,bot.gamePlayerId,action),null);assert.equal(g.needMoveRobber,false);
  for(const r of RES)assert.equal(g.bank[r]+g.players.reduce((sum,p)=>sum+p.res[r],0),29);
});

test('等待真人弃牌时不空转，提交弃牌后 AI 恢复移动强盗',()=>{
  const {g,roster}=waitingRoom();g.discardQueue=[0];g.players[0].res.ore=8;g.bank.ore-=8;
  assert.equal(nextBot(g,roster),null);
  assert.equal(playerAct(g,g.players[0].id,{type:'discard',res:{ore:4}}),null);
  assert.equal(nextBot(g,roster).gamePlayerId,g.players[5].id);
});

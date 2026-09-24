import test from 'node:test';
import assert from 'node:assert/strict';
import {createGame,playerAct,serialize,RES,BANK_SIZE,PIECES} from '../game/engine.js';
import {ruleBotAction} from '../bot.js';
import {nextBot} from '../game/bot-scheduling.js';

for(const [count,mapSize] of [[2,'small'],[3,'small'],[4,'small'],[6,'medium'],[8,'large'],[8,'epic'],[8,'twin']]) test(`${mapSize} ${count} 人完整对局：资源守恒、合法动作与胜负`, {timeout:20000}, () => {
  const g=createGame({mapSize,targetVP:7,startBonus:'none',playerNames:Array.from({length:count},(_,i)=>`玩家${i}`)});
  const roster=g.players.map(p=>({kind:'bot',gamePlayerId:p.id}));
  let actions=0;
  for(;actions<6000 && g.winner==null;actions++){
    const bot=nextBot(g,roster);
    assert.ok(bot,`第${g.turn}回合调度器必须找到可行动的机器人`);
    const p=g.players.find(p=>p.id===bot.gamePlayerId),s=serialize(g,p.id),action=ruleBotAction(s);
    assert.ok(action,`第${g.turn}回合必须存在可行动作`);
    assert.equal(playerAct(g,p.id,action),null,JSON.stringify(action));
    for(const r of RES){
      assert.equal(g.bank[r]+g.players.reduce((sum,p)=>sum+p.res[r],0),BANK_SIZE);
      assert.ok(Number.isInteger(g.bank[r])&&g.bank[r]>=0);
      for(const p of g.players)assert.ok(Number.isInteger(p.res[r])&&p.res[r]>=0);
    }
    for(const p of g.players){assert.ok(p.roads.length<=PIECES.road);assert.ok(p.settlements.length<=PIECES.settlement);assert.ok(p.cities.length<=PIECES.city);}
  }
  assert.notEqual(g.winner,null,`${actions} 次动作后仍无胜者`);
  assert.equal(g.current,g.winner);
});

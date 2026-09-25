const ACTION = Object.freeze({
  placeSettlement: '安下定居点', placeRoad: '铺设开局道路', buildRoad: '继续修路',
  buildSettlement: '建造定居点', buildCity: '升级城市', buyDev: '购买发展卡',
  playKnight: '打出骑士牌', playYear: '使用丰收之年', playMono: '使用垄断之年',
  playRoad: '使用筑路工', bankTrade: '与银行兑换', offerTrade: '提出玩家交易',
  acceptOffer: '接受报价', rejectOffer: '拒绝报价', moveRobber: '移动强盗', steal: '选择抢牌目标',
});
const AVOID = Object.freeze({
  road: '继续修路', settlement: '建定居点', city: '升级城市', development: '买发展卡',
  bankTrade: '与银行兑换', playerTrade: '向玩家报价', robber: '移动强盗', endTurn: '立即结束回合',
});
const REASON = Object.freeze({
  scarceResources: '手头资源值得留给更重要的一步',
  weakProduction: '眼下的产出收益不够高',
  urgentScore: '现在更需要直接争取分数',
  opponentLead: '领先的对手需要受到牵制',
  blockedRoute: '这条扩张路线容易受阻',
  handRisk: '继续攒牌有被强盗打乱的风险',
  betterPort: '港口会让之后的兑换更划算',
  timing: '这一步放在当前回合更合适',
});
const TOOL = Object.freeze({
  inspectBuilds: '建造位置', inspectResources: '资源缺口',
  evaluateTrade: '交易收益', inspectRobber: '强盗落点', inspectHistory: '近期局势',
});
const OUTCOME = Object.freeze({
  placeSettlement: '争取更好的资源产出', placeRoad: '为下一处落脚点铺路',
  buildRoad: '继续拓展可建造路线', buildSettlement: '增加产出并获得胜利点',
  buildCity: '提高地块产出并获得胜利点', buyDev: '增加发展卡选择',
  playKnight: '调整强盗位置并积累骑士数', playYear: '补齐下一步所需资源',
  playMono: '集中取得一种资源', playRoad: '趁机延伸道路',
  bankTrade: '把资源换成当前更有用的种类', offerTrade: '尝试换取下一步所需资源',
  acceptOffer: '接受这笔交易', rejectOffer: '暂不接受这笔交易',
  moveRobber: '尝试牵制对手的资源产出', steal: '从目标玩家取得一张牌',
});

export function normalizeBotCommentary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const avoid = Object.hasOwn(AVOID, value.avoid) ? value.avoid : null;
  const reason = Object.hasOwn(REASON, value.reason) ? value.reason : null;
  return avoid || reason ? { avoid, reason } : null;
}

export function formatBotCommentary({ action, commentary, tools = [] }) {
  const choice = ACTION[action?.type];
  if (!choice) return null;
  const note = normalizeBotCommentary(commentary);
  const inspected = [...new Set(tools.filter(tool => Object.hasOwn(TOOL, tool)))].slice(0, 2).map(tool => TOOL[tool]);
  const looked = inspected.length ? `看过${inspected.join('和')}后，` : '';
  const avoided = note?.avoid && AVOID[note.avoid] !== choice ? `觉得${AVOID[note.avoid]}先等等：` : '';
  const reason = note?.reason ? REASON[note.reason] : '';
  if (avoided && reason) return `${looked}${avoided}${reason}，于是选择${choice}。`;
  if (avoided) return `${looked}${avoided}这步选择${choice}。`;
  if (reason) return `${looked}盘算着${reason}，选择${choice}。`;
  return `${looked}选择${choice}，${OUTCOME[action.type]}。`;
}

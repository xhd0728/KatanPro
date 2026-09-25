import { aiBotAction } from '../bot.js';

export const DEFAULT_BOT_DIFFICULTY = 'medium';

const decideWithModel = (id, { state, config, fallback, onFallback, onDecision, onProgress, memory, remainingCalls, onUsage }) =>
  aiBotAction(state, config, fallback, onFallback, BOT_PROFILES[id].ai, onDecision,
    { memory, remainingCalls, onUsage, onProgress });

// Add profiles here. decide receives only the current player's serialized view,
// server-side credentials, a legal fallback, and callbacks for fallback notices
// and validated agent decisions.
// It returns an action or a Promise of an action. Credentials never enter the catalog.
export const BOT_PROFILES = Object.freeze({
  low: {
    label: '低',
    description: '纯本地规则策略，不调用外部模型，速度最快。',
    decide: ({ fallback }) => fallback,
  },
  medium: {
    label: '中',
    description: '近期公开历史辅助的一次模型决策；失败时自动回退规则策略。',
    ai: { id: 'medium', temperature: 0.85, stateDetail: 'compact', historyLimit: 4, maxCalls: 1, maxTools: 0, maxTurnCalls: 4 },
    decide: args => decideWithModel('medium', args),
  },
  high: {
    label: '高',
    description: '近期历史与短期目标；合法动作直接执行，需要时只读查询或修正。',
    ai: { id: 'high', temperature: 0.55, stateDetail: 'compact', historyLimit: 6, maxCalls: 2, maxTools: 1, maxTurnCalls: 6, timeoutMultiplier: 1.25, agentLoop: true },
    decide: args => decideWithModel('high', args),
  },
  'very-high': {
    label: '极高',
    description: '详细局面与跨回合计划；合法动作直接执行，需要时只读查询或修正。',
    ai: { id: 'very-high', temperature: 0.3, stateDetail: 'rich', historyLimit: 10, maxCalls: 3, maxTools: 1, maxTurnCalls: 8, timeoutMultiplier: 1.5, agentLoop: true },
    decide: args => decideWithModel('very-high', args),
  },
  highest: {
    label: '最高',
    description: '跨回合计划与公开历史；关键动作可复核，其他合法动作直接执行。',
    ai: { id: 'highest', temperature: 0.15, stateDetail: 'rich', historyLimit: 12, maxCalls: 5, maxTools: 2, maxTurnCalls: 12, timeoutMultiplier: 2, agentLoop: true },
    decide: args => decideWithModel('highest', args),
  },
});

export function getBotProfile(id = DEFAULT_BOT_DIFFICULTY) {
  if (id === 'rule') id = 'low';
  if (id === 'llm') id = 'medium';
  return Object.hasOwn(BOT_PROFILES, id) ? BOT_PROFILES[id] : null;
}

export function listBotProfiles() {
  return Object.entries(BOT_PROFILES).map(([id, { label, description }]) => ({ id, label, description }));
}

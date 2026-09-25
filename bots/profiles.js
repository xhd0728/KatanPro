import { aiBotAction } from '../bot.js';

export const DEFAULT_BOT_DIFFICULTY = 'medium';

// Add profiles here. decide receives only the current player's serialized view,
// server-side credentials, a legal fallback, and a callback for fallback notices.
// It returns an action or a Promise of an action. Credentials never enter the catalog.
export const BOT_PROFILES = Object.freeze({
  low: {
    label: '低',
    description: '纯本地规则策略，不调用外部模型，速度最快。',
    decide: ({ fallback }) => fallback,
  },
  medium: {
    label: '中',
    description: '轻量大模型辅助，优先遵循规则建议，失败时自动回退。',
    ai: { temperature: 0.85, stateDetail: 'compact', review: false },
    decide: ({ state, config, fallback, onFallback }) => aiBotAction(state, config, fallback, onFallback, BOT_PROFILES.medium.ai),
  },
  high: {
    label: '高',
    description: '标准大模型决策，使用当前局面的关键候选与资源信息。',
    ai: { temperature: 0.55, stateDetail: 'compact', review: false },
    decide: ({ state, config, fallback, onFallback }) => aiBotAction(state, config, fallback, onFallback, BOT_PROFILES.high.ai),
  },
  'very-high': {
    label: '极高',
    description: '大模型决策并提供更完整的地图、路线和对手信息。',
    ai: { temperature: 0.3, stateDetail: 'rich', review: false },
    decide: ({ state, config, fallback, onFallback }) => aiBotAction(state, config, fallback, onFallback, BOT_PROFILES['very-high'].ai),
  },
  highest: {
    label: '最高',
    description: '完整信息决策后再进行一次模型复核，成本和响应时间最高。',
    ai: { temperature: 0.15, stateDetail: 'rich', review: true },
    decide: ({ state, config, fallback, onFallback }) => aiBotAction(state, config, fallback, onFallback, BOT_PROFILES.highest.ai),
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

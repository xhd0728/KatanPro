import { aiBotAction } from '../bot.js';

export const DEFAULT_BOT_DIFFICULTY = 'llm';

// Add profiles here. decide receives only the current player's serialized view,
// server-side credentials, a legal fallback, and a callback for fallback notices.
// It returns an action or a Promise of an action. Credentials never enter the catalog.
export const BOT_PROFILES = Object.freeze({
  llm: {
    label: '大模型',
    description: '由服务端配置的大模型决策，超时或无效动作时自动回退。',
    decide: ({ state, config, fallback, onFallback }) => aiBotAction(state, config, fallback, onFallback),
  },
  rule: {
    label: '基础规则',
    description: '使用本地规则策略，无需外部模型，行动更快。',
    decide: ({ fallback }) => fallback,
  },
});

export function getBotProfile(id = DEFAULT_BOT_DIFFICULTY) {
  return Object.hasOwn(BOT_PROFILES, id) ? BOT_PROFILES[id] : null;
}

export function listBotProfiles() {
  return Object.entries(BOT_PROFILES).map(([id, { label, description }]) => ({ id, label, description }));
}

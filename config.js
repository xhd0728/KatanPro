import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';

const envFile = new URL('./.env', import.meta.url);
if (existsSync(envFile)) loadEnvFile(envFile);

const requestedTimeout = Number(process.env.CATAN_AI_TIMEOUT_MS || 9000);
export const DEFAULT_AI_CONFIG = {
  baseUrl: process.env.CATAN_AI_BASE_URL || '',
  apiMode: process.env.CATAN_AI_API_MODE || 'chat',
  model: process.env.CATAN_AI_MODEL || '',
  models: {
    medium: process.env.CATAN_AI_MODEL_MEDIUM || '',
    high: process.env.CATAN_AI_MODEL_HIGH || '',
    'very-high': process.env.CATAN_AI_MODEL_VERY_HIGH || '',
    highest: process.env.CATAN_AI_MODEL_HIGHEST || '',
  },
  apiKey: process.env.CATAN_AI_KEY || '',
  timeout: Number.isFinite(requestedTimeout) ? requestedTimeout : 9000,
};

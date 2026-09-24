import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';

const envFile = new URL('./.env', import.meta.url);
if (existsSync(envFile)) loadEnvFile(envFile);

const requestedTimeout = Number(process.env.CATAN_AI_TIMEOUT_MS || 9000);
export const DEFAULT_AI_CONFIG = {
  baseUrl: process.env.CATAN_AI_BASE_URL || '',
  model: process.env.CATAN_AI_MODEL || '',
  apiKey: process.env.CATAN_AI_KEY || '',
  timeout: Number.isFinite(requestedTimeout) ? requestedTimeout : 9000,
};

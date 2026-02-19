import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.resolve(__dirname, '..', '.env');

export interface RuntimeSettings {
  ZAI_API_KEY: string;
  ZAI_MODEL: string;
  ZAI_BASE_URL: string;
  MAX_CONCURRENT: number;
  MAX_CALLS_PER_HOUR: number;
  MAX_ORCHESTRATOR_ITERATIONS: number;
  MAX_WORKER_TOOL_LOOPS: number;
  MAX_SUBTASK_ATTEMPTS: number;
  GITHUB_PAT: string;
  GITHUB_USERNAME: string;
  GITHUB_EMAIL: string;
  AUTO_DEPLOY_GITHUB_PAGES: boolean;
}

let settings: RuntimeSettings = {
  ZAI_API_KEY: CONFIG.ZAI_API_KEY,
  ZAI_MODEL: CONFIG.ZAI_MODEL,
  ZAI_BASE_URL: CONFIG.ZAI_BASE_URL,
  MAX_CONCURRENT: CONFIG.MAX_CONCURRENT,
  MAX_CALLS_PER_HOUR: CONFIG.MAX_CALLS_PER_HOUR,
  MAX_ORCHESTRATOR_ITERATIONS: CONFIG.MAX_ORCHESTRATOR_ITERATIONS,
  MAX_WORKER_TOOL_LOOPS: CONFIG.MAX_WORKER_TOOL_LOOPS,
  MAX_SUBTASK_ATTEMPTS: CONFIG.MAX_SUBTASK_ATTEMPTS,
  GITHUB_PAT: CONFIG.GITHUB_PAT,
  GITHUB_USERNAME: CONFIG.GITHUB_USERNAME,
  GITHUB_EMAIL: CONFIG.GITHUB_EMAIL,
  AUTO_DEPLOY_GITHUB_PAGES: CONFIG.AUTO_DEPLOY_GITHUB_PAGES,
};

export function getRuntimeConfig(): Readonly<RuntimeSettings> {
  return settings;
}

export function updateRuntimeConfig(updates: Partial<RuntimeSettings>): void {
  settings = { ...settings, ...updates };
}

export function saveSettingsToEnv(): void {
  const lines = [
    `ZAI_API_KEY=${settings.ZAI_API_KEY}`,
    `ZAI_MODEL=${settings.ZAI_MODEL}`,
    `ZAI_BASE_URL=${settings.ZAI_BASE_URL}`,
    `ZAI_MAX_CONCURRENT=${settings.MAX_CONCURRENT}`,
    `ZAI_MAX_CALLS_PER_HOUR=${settings.MAX_CALLS_PER_HOUR}`,
    `GITHUB_PAT=${settings.GITHUB_PAT}`,
    `GITHUB_USERNAME=${settings.GITHUB_USERNAME}`,
    `GITHUB_EMAIL=${settings.GITHUB_EMAIL}`,
    `AUTO_DEPLOY_GITHUB_PAGES=${settings.AUTO_DEPLOY_GITHUB_PAGES}`,
  ];
  fs.writeFileSync(ENV_PATH, lines.join('\n') + '\n', 'utf-8');
}

export function getMaskedSettings(): Omit<RuntimeSettings, 'ZAI_API_KEY' | 'GITHUB_PAT'> & { ZAI_API_KEY: string; GITHUB_PAT: string } {
  const key = settings.ZAI_API_KEY;
  const maskedKey = key.length > 4 ? '****' + key.slice(-4) : '****';
  const pat = settings.GITHUB_PAT;
  const maskedPat = pat.length > 4 ? '****' + pat.slice(-4) : '****';
  return { ...settings, ZAI_API_KEY: maskedKey, GITHUB_PAT: maskedPat };
}

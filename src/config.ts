import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

export const CONFIG = Object.freeze({
  ZAI_API_KEY: process.env.ZAI_API_KEY ?? '',
  ZAI_MODEL: process.env.ZAI_MODEL ?? 'glm-5',
  ZAI_BASE_URL: process.env.ZAI_BASE_URL ?? 'https://api.z.ai/api/coding/paas/v4',
  MAX_CONCURRENT: parseInt(process.env.ZAI_MAX_CONCURRENT ?? '4', 10),
  MAX_CALLS_PER_HOUR: parseInt(process.env.ZAI_MAX_CALLS_PER_HOUR ?? '300', 10),
  MAX_ORCHESTRATOR_ITERATIONS: 50,
  MAX_WORKER_TOOL_LOOPS: 20,
  MAX_SUBTASK_ATTEMPTS: 3,
  PROJECTS_ROOT: path.join(ROOT, 'projects'),
  GITHUB_PAT: process.env.GITHUB_PAT ?? '',
  GITHUB_USERNAME: process.env.GITHUB_USERNAME ?? '',
  GITHUB_EMAIL: process.env.GITHUB_EMAIL ?? '',
  AUTO_DEPLOY_GITHUB_PAGES: process.env.AUTO_DEPLOY_GITHUB_PAGES === 'true',
});

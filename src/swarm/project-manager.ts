import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../config.js';

export function createProjectDir(taskDescription: string): string {
  // Create a slug from the task description
  const slug = taskDescription
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);

  const timestamp = Date.now();
  const dirName = `${slug}-${timestamp}`;
  const fullPath = path.join(CONFIG.PROJECTS_ROOT, dirName);

  fs.mkdirSync(fullPath, { recursive: true });

  return fullPath;
}

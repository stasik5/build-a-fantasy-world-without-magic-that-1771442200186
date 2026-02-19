import fs from 'node:fs/promises';
import { resolveSafe } from './utils.js';

const MAX_CHARS = 10_000;

export async function readFileTool(
  projectRoot: string,
  args: { path: string }
): Promise<string> {
  try {
    const fullPath = resolveSafe(projectRoot, args.path);
    const content = await fs.readFile(fullPath, 'utf-8');
    if (content.length > MAX_CHARS) {
      return content.slice(0, MAX_CHARS) + `\n\n... [truncated, ${content.length} total chars]`;
    }
    return content;
  } catch (err: any) {
    return `Error reading file: ${err.message}`;
  }
}

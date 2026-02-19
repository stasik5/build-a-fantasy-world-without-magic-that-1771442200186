import fs from 'node:fs/promises';
import { resolveSafe } from './utils.js';

export async function listDirectoryTool(
  projectRoot: string,
  args: { path?: string }
): Promise<string> {
  try {
    const fullPath = resolveSafe(projectRoot, args.path ?? '.');
    const entries = await fs.readdir(fullPath, { withFileTypes: true });
    const lines = entries.map((e) => {
      const type = e.isDirectory() ? '[DIR]' : '[FILE]';
      return `${type} ${e.name}`;
    });
    return lines.length > 0 ? lines.join('\n') : '(empty directory)';
  } catch (err: any) {
    return `Error listing directory: ${err.message}`;
  }
}

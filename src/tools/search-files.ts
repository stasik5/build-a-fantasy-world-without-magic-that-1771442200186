import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveSafe } from './utils.js';

const MAX_RESULTS = 50;

export async function searchFilesTool(
  projectRoot: string,
  args: { pattern: string; path?: string }
): Promise<string> {
  try {
    const searchRoot = resolveSafe(projectRoot, args.path ?? '.');
    const results: string[] = [];
    await searchRecursive(searchRoot, projectRoot, args.pattern, results);

    if (results.length === 0) return 'No matches found.';
    return results.join('\n');
  } catch (err: any) {
    return `Error searching files: ${err.message}`;
  }
}

async function searchRecursive(
  dir: string,
  projectRoot: string,
  pattern: string,
  results: string[]
): Promise<void> {
  if (results.length >= MAX_RESULTS) return;

  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (results.length >= MAX_RESULTS) return;

    const fullPath = path.join(dir, entry.name);

    if (entry.name === 'node_modules' || entry.name === '.git') continue;

    if (entry.isDirectory()) {
      await searchRecursive(fullPath, projectRoot, pattern, results);
    } else if (entry.isFile()) {
      try {
        const content = await fs.readFile(fullPath, 'utf-8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (results.length >= MAX_RESULTS) return;
          if (lines[i]!.includes(pattern)) {
            const relPath = path.relative(projectRoot, fullPath);
            results.push(`${relPath}:${i + 1}: ${lines[i]!.trim()}`);
          }
        }
      } catch {
        // Skip binary/unreadable files
      }
    }
  }
}

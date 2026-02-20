// Glob-based file finder for workers.
// Lets workers find files by pattern (e.g., "src/\*\*\/\*.ts", "*.json").

import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveSafe } from './utils.js';

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', '.cache',
  'coverage', '.turbo', '__pycache__', '.venv', 'venv',
]);

const MAX_RESULTS = 100;

export async function globFilesTool(
  projectRoot: string,
  args: { pattern: string }
): Promise<string> {
  try {
    if (!args.pattern || args.pattern.trim().length === 0) {
      return 'Error: pattern is required. Example: "src/**/*.ts", "*.json", "**/*.test.js"';
    }

    const matches: string[] = [];
    await walkAndMatch(projectRoot, projectRoot, args.pattern, matches);

    if (matches.length === 0) return `No files matching "${args.pattern}" found.`;
    return `Found ${matches.length} file(s):\n${matches.join('\n')}`;
  } catch (err: any) {
    return `Error globbing files: ${err.message}`;
  }
}

async function walkAndMatch(
  dir: string,
  root: string,
  pattern: string,
  matches: string[],
  depth = 0
): Promise<void> {
  if (depth > 10 || matches.length >= MAX_RESULTS) return;

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (matches.length >= MAX_RESULTS) return;
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(root, fullPath).replace(/\\/g, '/');

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      await walkAndMatch(fullPath, root, pattern, matches, depth + 1);
    } else if (entry.isFile()) {
      if (matchGlob(relPath, pattern)) {
        matches.push(relPath);
      }
    }
  }
}

/**
 * Simple glob matcher supporting:
 * - * matches anything except /
 * - ** matches anything including /
 * - ? matches single char except /
 */
function matchGlob(filePath: string, pattern: string): boolean {
  // Convert glob to regex
  let regex = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // ** matches any path segment
        if (pattern[i + 2] === '/') {
          regex += '(?:.*/)?';
          i += 3;
        } else {
          regex += '.*';
          i += 2;
        }
      } else {
        regex += '[^/]*';
        i++;
      }
    } else if (ch === '?') {
      regex += '[^/]';
      i++;
    } else if ('.+^${}()|[]\\'.includes(ch)) {
      regex += '\\' + ch;
      i++;
    } else {
      regex += ch;
      i++;
    }
  }

  try {
    return new RegExp(`^${regex}$`).test(filePath);
  } catch {
    return false;
  }
}

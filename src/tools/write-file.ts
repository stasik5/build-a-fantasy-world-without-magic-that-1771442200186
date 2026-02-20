import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveSafe } from './utils.js';
import { fileLockManager } from '../swarm/file-lock.js';
import { messageBus } from '../swarm/message-bus.js';

export async function writeFileTool(
  projectRoot: string,
  args: { path: string; content: string },
  artifacts: string[],
  workerIndex?: number
): Promise<string> {
  try {
    const fullPath = resolveSafe(projectRoot, args.path);

    // Acquire file lock if worker index is provided
    if (workerIndex !== undefined) {
      await fileLockManager.acquire(args.path, workerIndex);
    }

    try {
      // Read-before-write: warn if overwriting an existing file the worker hasn't read
      let overwriteWarning = '';
      try {
        const existing = await fs.readFile(fullPath, 'utf-8');
        if (existing.length > 0) {
          // Show a snippet of what's being overwritten so the LLM is aware
          const preview = existing.length > 500
            ? existing.slice(0, 500) + `\n... [${existing.length} chars total]`
            : existing;
          overwriteWarning = `\nNote: Overwrote existing file (${existing.length} chars). Previous content started with:\n${preview}`;
        }
      } catch {
        // File doesn't exist yet — that's fine
      }

      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, args.content, 'utf-8');
      artifacts.push(args.path);
      messageBus.emit('file:written', { path: args.path, workerIndex });
      return `File written: ${args.path}${overwriteWarning}`;
    } finally {
      if (workerIndex !== undefined) {
        fileLockManager.release(args.path);
      }
    }
  } catch (err: any) {
    return `Error writing file: ${err.message}`;
  }
}

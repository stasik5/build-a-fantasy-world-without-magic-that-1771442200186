import fs from 'node:fs/promises';
import { resolveSafe } from './utils.js';
import { fileLockManager } from '../swarm/file-lock.js';
import { messageBus } from '../swarm/message-bus.js';

export async function patchFileTool(
  projectRoot: string,
  args: { path: string; search: string; replace: string },
  artifacts: string[],
  workerIndex?: number
): Promise<string> {
  try {
    const fullPath = resolveSafe(projectRoot, args.path);

    await fileLockManager.acquire(fullPath, workerIndex ?? 0);
    try {
      const content = await fs.readFile(fullPath, 'utf-8');
      const index = content.indexOf(args.search);

      if (index === -1) {
        return `Error: Search text not found in ${args.path}. Make sure the search string matches exactly (including whitespace and newlines).`;
      }

      // Check for multiple matches
      const secondIndex = content.indexOf(args.search, index + 1);
      if (secondIndex !== -1) {
        return `Warning: Multiple matches found for search text in ${args.path}. Replacing the first occurrence. Use a more specific search string for precision.`;
      }

      const patched = content.slice(0, index) + args.replace + content.slice(index + args.search.length);
      await fs.writeFile(fullPath, patched, 'utf-8');

      if (!artifacts.includes(args.path)) {
        artifacts.push(args.path);
      }

      messageBus.emit('file:written', { path: args.path, workerIndex });
      return `Successfully patched ${args.path} (replaced ${args.search.length} chars with ${args.replace.length} chars)`;
    } finally {
      fileLockManager.release(fullPath);
    }
  } catch (err: any) {
    return `Error patching file: ${err.message}`;
  }
}

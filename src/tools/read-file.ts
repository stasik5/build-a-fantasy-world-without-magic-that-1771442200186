import fs from 'node:fs/promises';
import { resolveSafe } from './utils.js';

const MAX_CHARS = 20_000;

export async function readFileTool(
  projectRoot: string,
  args: { path: string; startLine?: number; endLine?: number }
): Promise<string> {
  try {
    const fullPath = resolveSafe(projectRoot, args.path);
    const content = await fs.readFile(fullPath, 'utf-8');

    // Line-range reading
    if (args.startLine || args.endLine) {
      const lines = content.split('\n');
      const start = Math.max(0, (args.startLine ?? 1) - 1); // 1-based to 0-based
      const end = args.endLine ? Math.min(lines.length, args.endLine) : lines.length;
      const slice = lines.slice(start, end).join('\n');
      const header = `[Lines ${start + 1}-${end} of ${lines.length} total]\n`;
      if (slice.length > MAX_CHARS) {
        return header + slice.slice(0, MAX_CHARS) + `\n\n... [truncated, ${slice.length} total chars in range]`;
      }
      return header + slice;
    }

    if (content.length > MAX_CHARS) {
      const lines = content.split('\n');
      return content.slice(0, MAX_CHARS) + `\n\n... [truncated, ${content.length} total chars, ${lines.length} total lines. Use startLine/endLine to read specific sections.]`;
    }
    return content;
  } catch (err: any) {
    return `Error reading file: ${err.message}`;
  }
}

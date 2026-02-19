/**
 * Multi-strategy JSON parser for extracting structured data from LLM responses.
 * Handles code fences, conversational wrappers, partial JSON, and malformed output.
 */

export function parseJSON<T>(text: string): T | null {
  if (!text || !text.trim()) return null;

  // Strategy 1: Direct parse
  const direct = tryParse<T>(text.trim());
  if (direct !== null) return direct;

  // Strategy 2: Strip markdown code fences (```json ... ``` or ``` ... ```)
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    const result = tryParse<T>(fenceMatch[1]!.trim());
    if (result !== null) return result;
  }

  // Strategy 3: Find the first { ... } or [ ... ] block
  const jsonBlock = extractJsonBlock(text);
  if (jsonBlock) {
    const result = tryParse<T>(jsonBlock);
    if (result !== null) return result;
  }

  // Strategy 4: Try to fix common issues (trailing commas, single quotes)
  const fixed = fixCommonJsonIssues(text);
  const fixedBlock = extractJsonBlock(fixed);
  if (fixedBlock) {
    const result = tryParse<T>(fixedBlock);
    if (result !== null) return result;
  }

  return null;
}

function tryParse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function extractJsonBlock(text: string): string | null {
  // Find the outermost balanced { } or [ ]
  const startChars = ['{', '['];
  const endMap: Record<string, string> = { '{': '}', '[': ']' };

  for (const startChar of startChars) {
    const startIdx = text.indexOf(startChar);
    if (startIdx === -1) continue;

    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = startIdx; i < text.length; i++) {
      const ch = text[i]!;

      if (escape) {
        escape = false;
        continue;
      }

      if (ch === '\\' && inString) {
        escape = true;
        continue;
      }

      if (ch === '"') {
        inString = !inString;
        continue;
      }

      if (inString) continue;

      if (ch === startChar) depth++;
      if (ch === endMap[startChar]) {
        depth--;
        if (depth === 0) {
          return text.slice(startIdx, i + 1);
        }
      }
    }
  }

  return null;
}

function fixCommonJsonIssues(text: string): string {
  let fixed = text;
  // Remove trailing commas before } or ]
  fixed = fixed.replace(/,\s*([}\]])/g, '$1');
  // Replace single quotes around keys/values (naive, may break on apostrophes in values)
  // Only do this if there are no double quotes at all
  if (!fixed.includes('"') && fixed.includes("'")) {
    fixed = fixed.replace(/'/g, '"');
  }
  return fixed;
}

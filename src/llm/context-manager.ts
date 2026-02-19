import type { ChatMessage } from '../types.js';
import { chatCompletion } from './client.js';

// Rough estimate: 1 token ~= 4 chars for English text
const CHARS_PER_TOKEN = 4;
const MAX_CONTEXT_CHARS = 100_000; // ~25K tokens, conservative for most models
const SUMMARIZE_THRESHOLD = 80_000; // Start summarizing at ~20K tokens

function estimateChars(messages: ChatMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      total += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if ('text' in part) total += part.text.length;
      }
    }
  }
  return total;
}

/**
 * Keeps orchestrator conversation within context budget.
 * When the conversation gets too long, it summarizes older messages
 * while preserving the system prompt and the most recent exchanges.
 */
export async function manageContext(messages: ChatMessage[]): Promise<ChatMessage[]> {
  const totalChars = estimateChars(messages);

  if (totalChars < SUMMARIZE_THRESHOLD) {
    return messages; // Within budget
  }

  // Preserve: system prompt (index 0) + last 6 messages (3 exchanges)
  const systemPrompt = messages[0]!;
  const recentCount = Math.min(6, messages.length - 1);
  const recentMessages = messages.slice(-recentCount);
  const middleMessages = messages.slice(1, messages.length - recentCount);

  if (middleMessages.length === 0) {
    return messages; // Nothing to summarize
  }

  // Build a summary of the middle messages
  const middleText = middleMessages
    .map((m) => {
      const role = 'role' in m ? m.role : 'unknown';
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return `[${role}]: ${content?.slice(0, 500) ?? ''}`;
    })
    .join('\n');

  try {
    const summaryResponse = await chatCompletion(
      [
        {
          role: 'system',
          content: 'Summarize the following conversation history concisely. Focus on: decisions made, subtasks planned/completed, key results, and current project state. Output ONLY the summary, no preamble.',
        },
        { role: 'user', content: middleText.slice(0, 30_000) },
      ],
      undefined,
      { temperature: 0.1, maxTokens: 1024 }
    );

    const summary = summaryResponse.choices[0]?.message?.content ?? 'Previous context was summarized.';

    return [
      systemPrompt,
      {
        role: 'user' as const,
        content: `[CONTEXT SUMMARY - Previous conversation was summarized to save context space]\n\n${summary}`,
      },
      ...recentMessages,
    ];
  } catch {
    // If summarization fails, just truncate the middle
    return [systemPrompt, ...recentMessages];
  }
}

export function getContextStats(messages: ChatMessage[]) {
  const chars = estimateChars(messages);
  return {
    messageCount: messages.length,
    estimatedTokens: Math.ceil(chars / CHARS_PER_TOKEN),
    chars,
    budgetUsedPercent: Math.round((chars / MAX_CONTEXT_CHARS) * 100),
  };
}

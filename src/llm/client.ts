import OpenAI from 'openai';
import { getRuntimeConfig } from '../runtime-config.js';
import { rateLimiter } from './rate-limiter.js';
import { tokenTracker } from './token-tracker.js';
import { messageBus } from '../swarm/message-bus.js';
import type { ChatMessage, ToolDefinition } from '../types.js';
import type { RateLimiter } from './rate-limiter.js';

let _openai: OpenAI | null = null;
let _lastKey = '';
let _lastUrl = '';

function getClient(): OpenAI {
  const cfg = getRuntimeConfig();
  if (!_openai || cfg.ZAI_API_KEY !== _lastKey || cfg.ZAI_BASE_URL !== _lastUrl) {
    _openai = new OpenAI({ apiKey: cfg.ZAI_API_KEY, baseURL: cfg.ZAI_BASE_URL });
    _lastKey = cfg.ZAI_API_KEY;
    _lastUrl = cfg.ZAI_BASE_URL;
  }
  return _openai;
}

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

function getRetryDelay(attempt: number): number {
  const delay = BASE_DELAY_MS * Math.pow(2, attempt);
  const jitter = Math.random() * 500;
  return delay + jitter;
}

function isRetryable(err: any): boolean {
  if (!err) return false;
  const status = err.status ?? err.statusCode;
  if (status === 429 || (status >= 500 && status < 600)) return true;
  if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'ENOTFOUND') return true;
  return false;
}

export async function chatCompletion(
  messages: ChatMessage[],
  tools?: ToolDefinition[],
  options?: { temperature?: number; maxTokens?: number; rateLimiter?: RateLimiter }
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  const limiter = options?.rateLimiter ?? rateLimiter;
  let lastError: any;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await limiter.acquire();
    try {
      const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
        model: getRuntimeConfig().ZAI_MODEL,
        messages,
        temperature: options?.temperature ?? 0.3,
        max_tokens: options?.maxTokens ?? 4096,
      };

      if (tools && tools.length > 0) {
        params.tools = tools;
        params.tool_choice = 'auto';
      }

      const response = await getClient().chat.completions.create(params);

      if (response.usage) {
        tokenTracker.record(response.usage.prompt_tokens, response.usage.completion_tokens);
      }

      return response;
    } catch (err: any) {
      lastError = err;

      if (attempt < MAX_RETRIES && isRetryable(err)) {
        const delay = getRetryDelay(attempt);
        messageBus.emit('llm:retry', { attempt: attempt + 1, maxRetries: MAX_RETRIES, delayMs: delay, error: err.message });
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    } finally {
      limiter.release();
    }
  }

  throw lastError;
}

export async function chatCompletionStream(
  messages: ChatMessage[],
  tools?: ToolDefinition[],
  onToken?: (token: string) => void,
  options?: { temperature?: number; maxTokens?: number; rateLimiter?: RateLimiter }
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  const limiter = options?.rateLimiter ?? rateLimiter;
  let lastError: any;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await limiter.acquire();
    try {
      const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
        model: getRuntimeConfig().ZAI_MODEL,
        messages,
        temperature: options?.temperature ?? 0.3,
        max_tokens: options?.maxTokens ?? 4096,
        stream: true,
        stream_options: { include_usage: true },
      };

      if (tools && tools.length > 0) {
        params.tools = tools;
        params.tool_choice = 'auto';
      }

      const stream = await getClient().chat.completions.create(params);

      let content = '';
      const toolCalls: Map<number, { id: string; type: 'function'; function: { name: string; arguments: string } }> = new Map();
      let finishReason: string | null = null;

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          content += delta.content;
          onToken?.(delta.content);
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const existing = toolCalls.get(tc.index);
            if (!existing) {
              toolCalls.set(tc.index, {
                id: tc.id ?? '',
                type: 'function',
                function: { name: tc.function?.name ?? '', arguments: tc.function?.arguments ?? '' },
              });
            } else {
              if (tc.id) existing.id = tc.id;
              if (tc.function?.name) existing.function.name += tc.function.name;
              if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
            }
          }
        }

        if (chunk.choices[0]?.finish_reason) {
          finishReason = chunk.choices[0].finish_reason;
        }

        if (chunk.usage) {
          tokenTracker.record(chunk.usage.prompt_tokens, chunk.usage.completion_tokens);
        }
      }

      const toolCallsArray = toolCalls.size > 0
        ? [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, tc]) => tc)
        : undefined;

      return {
        id: 'stream-' + Date.now(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: getRuntimeConfig().ZAI_MODEL,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: content || null,
            tool_calls: toolCallsArray,
            refusal: null,
          },
          finish_reason: finishReason ?? 'stop',
          logprobs: null,
        }],
        usage: undefined as any,
      } as OpenAI.Chat.Completions.ChatCompletion;
    } catch (err: any) {
      lastError = err;

      if (attempt < MAX_RETRIES && isRetryable(err)) {
        const delay = getRetryDelay(attempt);
        messageBus.emit('llm:retry', { attempt: attempt + 1, maxRetries: MAX_RETRIES, delayMs: delay, error: err.message });
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    } finally {
      limiter.release();
    }
  }

  throw lastError;
}

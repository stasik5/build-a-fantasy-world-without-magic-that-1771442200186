import fs from 'node:fs/promises';
import path from 'node:path';
import type { Subtask, ProjectContext, WorkerResult, ChatMessage } from '../types.js';
import { chatCompletionStream } from '../llm/client.js';
import { WORKER_TOOLS, executeTool } from '../tools/index.js';
import { getRuntimeConfig } from '../runtime-config.js';
import { messageBus } from '../swarm/message-bus.js';
import type { RateLimiter } from '../llm/rate-limiter.js';

// Cache the limitations file content (loaded once per process)
let limitationsCache: string | null = null;

async function loadLimitations(projectRoot: string): Promise<string> {
  if (limitationsCache !== null) return limitationsCache;
  try {
    // Check project root first, then the swarm's own root
    const swarmRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
    for (const dir of [projectRoot, swarmRoot]) {
      try {
        const content = await fs.readFile(path.join(dir, 'LIMITATIONS.md'), 'utf-8');
        if (content.length > 0) {
          limitationsCache = content;
          return content;
        }
      } catch { /* try next */ }
    }
  } catch { /* ignore */ }
  limitationsCache = '';
  return '';
}

function buildWorkerSystemPrompt(workerIndex: number, ctx: ProjectContext, limitations: string): string {
  const limitationsSection = limitations
    ? `\n\n--- IMPORTANT: KNOWN LIMITATIONS ---\nRead and internalize these before starting work:\n${limitations.slice(0, 4000)}\n--- END LIMITATIONS ---`
    : '';

  return `You are Worker ${workerIndex}, a coding agent in a multi-agent builder swarm.

Your project directory is: ${ctx.rootDir}
All file paths you use MUST be relative to this project root.

You have tools to read files, write files, patch files, list directories, execute commands, search files, search the web, and read web pages.
Use these tools to accomplish the subtask assigned to you.

IMPORTANT: When working with a framework, library, or API you're not 100% certain about, use web_search to look up the correct usage and web_reader to read the relevant documentation page. This prevents incorrect imports, wrong API calls, and outdated patterns.

Rules:
- Always use relative paths (e.g., "src/index.js", not absolute paths)
- Create directories as needed by writing files (directories are auto-created)
- Do NOT modify files outside your assigned scope unless absolutely necessary
- Write clean, production-quality code
- If existing files are referenced, READ them first before modifying to understand context

Strategy:
1. Plan your approach before writing any code
2. Read any existing files you need to understand or modify
3. Write files one at a time, verifying each is correct
4. After writing all files, use execute_command to verify your work (e.g., run a syntax check, build, or test)
5. If a command fails, read the error output, fix the issue, and retry

When you finish, provide a detailed summary that includes:
- Each file you created or modified and its purpose
- Any commands you ran and their results
- Any issues you encountered and how you resolved them
- What someone working on dependent subtasks needs to know${limitationsSection}`;
}

function buildSubtaskPrompt(subtask: Subtask, completedSiblings: Subtask[], projectFileTree?: string): string {
  let prompt = `## Your Task\n\n**${subtask.title}**\n\n${subtask.description}`;

  // Inject project file tree so workers know what exists
  if (projectFileTree) {
    prompt += `\n\n## Existing Project Files\nThe project directory already contains these files. Use read_file or glob_files to examine any you need before modifying:\n\`\`\`\n${projectFileTree.slice(0, 3000)}\n\`\`\``;
  }

  if (subtask.feedback) {
    prompt += `\n\n## Feedback from Review\nThe orchestrator reviewed your previous attempt and provided this feedback:\n${subtask.feedback}`;
  }

  // Cross-worker visibility: show what other completed subtasks produced
  if (completedSiblings.length > 0) {
    prompt += `\n\n## Context: Completed Work by Other Workers\nThe following subtasks have already been completed. You can read the files they created if needed:\n`;
    for (const sibling of completedSiblings) {
      prompt += `\n- **${sibling.title}**: ${sibling.result?.slice(0, 600) ?? '(no summary)'}`;
      if (sibling.artifacts.length > 0) {
        prompt += `\n  Files: ${sibling.artifacts.join(', ')}`;
      }
    }
  }

  return prompt;
}

export async function runWorker(
  workerIndex: number,
  subtask: Subtask,
  ctx: ProjectContext,
  rateLimiter: RateLimiter
): Promise<WorkerResult> {
  // Gather completed subtasks for cross-visibility
  const completedSiblings = ctx.subtasks.filter(
    (t) => t.id !== subtask.id && t.status === 'completed'
  );

  // Load limitations file (cached after first load)
  const limitations = await loadLimitations(ctx.rootDir);

  const messages: ChatMessage[] = [
    { role: 'system', content: buildWorkerSystemPrompt(workerIndex, ctx, limitations) },
    { role: 'user', content: buildSubtaskPrompt(subtask, completedSiblings, ctx.projectFileTree) },
  ];

  const artifacts: string[] = [];

  for (let step = 0; step < getRuntimeConfig().MAX_WORKER_TOOL_LOOPS; step++) {
    let response;
    try {
      response = await chatCompletionStream(
        messages,
        WORKER_TOOLS,
        (token) => {
          messageBus.emit('worker:token', { workerIndex, token });
        },
        { rateLimiter }
      );
    } catch (err: any) {
      return {
        subtaskId: subtask.id,
        status: 'failed',
        summary: `LLM call failed: ${err.message}`,
        artifacts,
        error: err.message,
      };
    }

    const choice = response.choices[0];
    if (!choice) {
      return {
        subtaskId: subtask.id,
        status: 'failed',
        summary: 'No response from LLM',
        artifacts,
        error: 'empty_response',
      };
    }

    const assistantMessage = choice.message;
    messages.push(assistantMessage as ChatMessage);

    // If no tool calls, the worker is done
    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      return {
        subtaskId: subtask.id,
        status: 'completed',
        summary: assistantMessage.content ?? '(no summary provided)',
        artifacts,
      };
    }

    // Execute each tool call
    for (const toolCall of assistantMessage.tool_calls) {
      messageBus.emit('subtask:progress', {
        subtaskId: subtask.id,
        workerIndex,
        step,
        toolName: toolCall.function.name,
      });

      let result: string;
      try {
        result = await executeTool(toolCall, ctx.rootDir, artifacts, workerIndex);
      } catch (err: any) {
        // Retry once on tool execution failure (transient filesystem errors, locks, etc.)
        try {
          result = await executeTool(toolCall, ctx.rootDir, artifacts, workerIndex);
        } catch (retryErr: any) {
          result = `Tool execution failed after retry: ${retryErr.message}`;
        }
      }
      messages.push({
        role: 'tool' as const,
        tool_call_id: toolCall.id,
        content: result,
      });
    }
  }

  return {
    subtaskId: subtask.id,
    status: 'failed',
    summary: `Exceeded maximum tool call iterations (${getRuntimeConfig().MAX_WORKER_TOOL_LOOPS})`,
    artifacts,
    error: 'max_iterations',
  };
}

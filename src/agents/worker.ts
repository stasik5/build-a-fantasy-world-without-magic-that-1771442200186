import type { Subtask, ProjectContext, WorkerResult, ChatMessage } from '../types.js';
import { chatCompletionStream } from '../llm/client.js';
import { WORKER_TOOLS, executeTool } from '../tools/index.js';
import { getRuntimeConfig } from '../runtime-config.js';
import { messageBus } from '../swarm/message-bus.js';
import type { RateLimiter } from '../llm/rate-limiter.js';

function buildWorkerSystemPrompt(workerIndex: number, ctx: ProjectContext): string {
  return `You are Worker ${workerIndex}, a coding agent in a multi-agent builder swarm.

Your project directory is: ${ctx.rootDir}
All file paths you use MUST be relative to this project root.

You have tools to read files, write files, list directories, execute commands, and search files.
Use these tools to accomplish the subtask assigned to you.

Rules:
- Always use relative paths (e.g., "src/index.js", not absolute paths)
- Create directories as needed by writing files (directories are auto-created)
- After completing your work, provide a clear summary of what you did and what files you created or modified
- If you encounter an error, try to fix it. If you truly cannot proceed, explain what went wrong
- Do NOT modify files outside your assigned scope unless absolutely necessary
- Write clean, production-quality code
- If existing files are referenced, READ them first before modifying to understand context`;
}

function buildSubtaskPrompt(subtask: Subtask, completedSiblings: Subtask[]): string {
  let prompt = `## Your Task\n\n**${subtask.title}**\n\n${subtask.description}`;

  if (subtask.feedback) {
    prompt += `\n\n## Feedback from Review\nThe orchestrator reviewed your previous attempt and provided this feedback:\n${subtask.feedback}`;
  }

  // Cross-worker visibility: show what other completed subtasks produced
  if (completedSiblings.length > 0) {
    prompt += `\n\n## Context: Completed Work by Other Workers\nThe following subtasks have already been completed. You can read the files they created if needed:\n`;
    for (const sibling of completedSiblings) {
      prompt += `\n- **${sibling.title}**: ${sibling.result?.slice(0, 200) ?? '(no summary)'}`;
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

  const messages: ChatMessage[] = [
    { role: 'system', content: buildWorkerSystemPrompt(workerIndex, ctx) },
    { role: 'user', content: buildSubtaskPrompt(subtask, completedSiblings) },
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

      const result = await executeTool(toolCall, ctx.rootDir, artifacts, workerIndex);
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

/**
 * Interactive pre-execution chat session.
 * The planner is a tool-calling agent that extracts intent from natural speech
 * and takes actions like setting directories, updating tasks, and starting builds.
 */

import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import type { ChatMessage } from '../types.js';
import { chatCompletionStream } from '../llm/client.js';
import { analyzeProject, formatProjectMap } from '../tools/project-analyzer.js';
import type OpenAI from 'openai';
import {
  PLANNER_TOOLS,
  createPlannerState,
  buildPlannerSystemPrompt,
  executePlannerTool,
  buildPlanningContext,
  type PlannerState,
  type PlannerToolResult,
} from '../swarm/planner.js';

function createReadline(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
}

function promptUser(rl: readline.Interface, prefix: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prefix, (answer) => {
      resolve(answer);
    });
  });
}

function showHelp(): void {
  console.log(chalk.cyan('\n  Commands:'));
  console.log(chalk.white('    /build') + chalk.dim('   — Force start building'));
  console.log(chalk.white('    /status') + chalk.dim('  — Show current task and directory'));
  console.log(chalk.white('    /reset') + chalk.dim('   — Clear conversation and start over'));
  console.log(chalk.white('    /help') + chalk.dim('    — Show this help'));
  console.log(chalk.white('    /quit') + chalk.dim('    — Exit without building'));
  console.log(chalk.dim('\n  Or just talk naturally — the planner understands plain English.\n'));
}

export interface InteractiveResult {
  action: 'build' | 'quit';
  taskDescription: string;
  projectDir: string | null;
  planningContext: string;
}

export async function runInteractiveSession(
  initialTask?: string,
  initialDir?: string,
): Promise<InteractiveResult> {
  const rl = createReadline();

  const state: PlannerState = createPlannerState();
  state.taskDescription = initialTask ?? '';
  state.projectDir = initialDir ?? null;

  state.messages = [{ role: 'system', content: buildPlannerSystemPrompt(state) }];

  console.log(chalk.cyan.bold('\n  Interactive Planning Mode'));
  console.log(chalk.dim('  Just describe what you want. Type /help for commands.\n'));

  // If we already have a task/dir from CLI args, process them
  if (initialTask || initialDir) {
    let initMsg = '';
    if (initialTask && initialDir) {
      initMsg = `I want to ${initialTask} in the project at ${initialDir}`;
    } else if (initialTask) {
      initMsg = initialTask;
    } else if (initialDir) {
      initMsg = `I want to work on the project at ${initialDir}`;
    }
    if (initMsg) {
      await processUserMessage(initMsg, state);
    }
  } else {
    console.log(chalk.cyan('  Planner: ') + chalk.white('What would you like to build? Just describe it — mention a folder path if you want to work on an existing project.\n'));
  }

  // Main chat loop
  while (!state.ready) {
    const input = await promptUser(rl, chalk.green('  You: '));
    const trimmed = input.trim();

    if (!trimmed) continue;

    // Handle slash commands
    if (trimmed.startsWith('/')) {
      const result = handleSlashCommand(trimmed, state);
      if (result === 'build') {
        if (!state.taskDescription) {
          console.log(chalk.yellow('  No task set yet. Describe what you want first.\n'));
          continue;
        }
        state.ready = true;
        break;
      }
      if (result === 'quit') {
        rl.close();
        return { action: 'quit', taskDescription: state.taskDescription, projectDir: state.projectDir, planningContext: '' };
      }
      continue;
    }

    await processUserMessage(trimmed, state);
  }

  rl.close();

  console.log(chalk.green.bold('\n  Starting build...'));
  if (state.taskDescription) console.log(chalk.green('  Task: ') + chalk.white(state.taskDescription));
  if (state.projectDir) console.log(chalk.green('  Directory: ') + chalk.white(state.projectDir));
  console.log('');

  const planningContext = buildPlanningContext(state);

  return {
    action: 'build',
    taskDescription: state.taskDescription,
    projectDir: state.projectDir,
    planningContext,
  };
}

async function processUserMessage(input: string, state: PlannerState): Promise<void> {
  // Update system prompt with current state
  state.messages[0] = { role: 'system', content: buildPlannerSystemPrompt(state) };
  state.messages.push({ role: 'user', content: input });

  // Agent loop: keep calling until no more tool calls
  for (let step = 0; step < 5; step++) {
    let response;
    try {
      response = await chatCompletionStream(
        state.messages,
        PLANNER_TOOLS,
        () => {}, // no streaming display needed for planner
        { temperature: 0.3, maxTokens: 1024 },
      );
    } catch (err: any) {
      console.log(chalk.red(`  (Error: ${err.message})\n`));
      return;
    }

    const choice = response.choices[0];
    if (!choice) return;

    const msg = choice.message;
    state.messages.push(msg as ChatMessage);

    // Process tool calls
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      for (const toolCall of msg.tool_calls) {
        const result = await executePlannerToolCLI(toolCall, state);
        state.messages.push({
          role: 'tool' as const,
          tool_call_id: toolCall.id,
          content: result.message,
        });

        // Apply state updates
        if (result.stateUpdate) {
          Object.assign(state, result.stateUpdate);
        }
      }

      // If start_build was called, we're done
      if (state.ready) return;

      // Continue the loop so the LLM can respond after tool results
      continue;
    }

    // No tool calls — just a text response
    if (msg.content) {
      console.log(chalk.cyan('  Planner: ') + chalk.white(msg.content) + '\n');
    }
    return;
  }
}

/**
 * CLI-specific wrapper for planner tool execution with console output.
 */
async function executePlannerToolCLI(
  toolCall: OpenAI.Chat.Completions.ChatCompletionMessageToolCall,
  state: PlannerState,
): Promise<PlannerToolResult> {
  const result = await executePlannerTool(toolCall, state);

  // CLI-specific output
  if (result.success) {
    if (toolCall.function.name === 'set_directory') {
      console.log(chalk.dim(`  → Directory set to: ${state.projectDir}`));
    } else if (toolCall.function.name === 'set_task') {
      console.log(chalk.dim(`  → Task: ${state.taskDescription}`));
    } else if (toolCall.function.name === 'scan_directory') {
      // Extract summary from message if it's a scan result
      const summaryMatch = result.message.match(/Project analysis:\n([^\n]+)/);
      if (summaryMatch) {
        console.log(chalk.dim(`  → Scanned: ${summaryMatch[1]}`));
      }
    }
  } else {
    console.log(chalk.red(`  ${result.message}\n`));
  }

  return result;
}

function handleSlashCommand(input: string, state: PlannerState): 'build' | 'quit' | 'continue' {
  const cmd = input.split(/\s+/)[0]!.toLowerCase();

  switch (cmd) {
    case '/build':
      return 'build';
    case '/status':
      console.log(chalk.cyan('\n  Current State:'));
      console.log(chalk.white(`    Task: ${state.taskDescription || '(not set)'}`));
      console.log(chalk.white(`    Directory: ${state.projectDir || '(not set — will create new)'}\n`));
      return 'continue';
    case '/reset':
      state.taskDescription = '';
      state.projectDir = null;
      state.messages = [{ role: 'system', content: buildPlannerSystemPrompt(state) }];
      console.log(chalk.yellow('  Session reset.\n'));
      return 'continue';
    case '/help':
      showHelp();
      return 'continue';
    case '/quit':
    case '/exit':
      return 'quit';
    default:
      console.log(chalk.dim(`  Unknown command: ${cmd}. Type /help for commands.\n`));
      return 'continue';
  }
}

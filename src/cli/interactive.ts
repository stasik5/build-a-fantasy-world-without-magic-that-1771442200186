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

interface SessionState {
  taskDescription: string;
  projectDir: string | null;
  messages: ChatMessage[];
  ready: boolean;
}

const PLANNER_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'set_directory',
      description: 'Set the project working directory to an existing folder on the user\'s machine. Call this when the user mentions a path, folder, or project location they want to work in. Also call this if the user says things like "go to", "look at", "open", "work on the project in", etc.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the directory' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_task',
      description: 'Set or update the task description. Call this when the user describes what they want built or changed. Extract a clear, concise task description from their words. Call this on the very first user message if they describe a task, and again if they refine it later.',
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'Clear task description extracted from the user\'s words' },
        },
        required: ['description'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'scan_directory',
      description: 'Scan a directory to see what files and technologies are in it. Call this after set_directory to understand the project, or when the user asks to look at or examine a folder.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to scan. If not provided, scans the current project directory.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'start_build',
      description: 'Start the build process. Call this ONLY when the user explicitly says to start, build, go, execute, run it, do it, make it, let\'s go, ship it, or similar clear intent to begin. Do NOT call this just because the task seems ready — wait for the user to say they want to start.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
];

const PLANNER_SYSTEM_PROMPT = `You are the planning assistant for a multi-agent coding swarm (1 orchestrator + 3 workers powered by GLM-5).

You chat with the user BEFORE any code is written. Your job:
1. Understand what they want to build or change
2. Use your tools to set the project directory and task based on what they say
3. Ask 1-2 clarifying questions if requirements are unclear
4. When they're ready, use start_build to kick off execution

IMPORTANT BEHAVIORS:
- When the user mentions ANY file path or directory, immediately call set_directory with it, then scan_directory to see what's there
- When the user describes what to build/fix/change, call set_task with a clear version of their request
- You can call multiple tools at once (e.g., set_directory + set_task from a single message)
- Don't ask unnecessary questions. If the user is clear about what they want, confirm and ask if they're ready to build
- When the user says "go", "build it", "start", "do it", "let's go", "ship it", or similar → call start_build
- Keep responses SHORT (2-3 sentences max). No walls of text
- If you set_directory and scan finds an existing project, incorporate that knowledge into your planning

CURRENT STATE:
- Task: {{TASK}}
- Directory: {{DIR}}`;

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

  const state: SessionState = {
    taskDescription: initialTask ?? '',
    projectDir: initialDir ?? null,
    messages: [],
    ready: false,
  };

  // Build system prompt with current state
  function getSystemPrompt(): string {
    return PLANNER_SYSTEM_PROMPT
      .replace('{{TASK}}', state.taskDescription || '(not set)')
      .replace('{{DIR}}', state.projectDir || '(not set — will create new)');
  }

  state.messages = [{ role: 'system', content: getSystemPrompt() }];

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

async function processUserMessage(input: string, state: SessionState): Promise<void> {
  // Update system prompt with current state
  state.messages[0] = { role: 'system', content: PLANNER_SYSTEM_PROMPT
    .replace('{{TASK}}', state.taskDescription || '(not set)')
    .replace('{{DIR}}', state.projectDir || '(not set — will create new)') };

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
        const result = await executeplannerTool(toolCall, state);
        state.messages.push({
          role: 'tool' as const,
          tool_call_id: toolCall.id,
          content: result,
        });
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

async function executeplannerTool(
  toolCall: OpenAI.Chat.Completions.ChatCompletionMessageToolCall,
  state: SessionState,
): Promise<string> {
  let args: Record<string, any>;
  try {
    args = JSON.parse(toolCall.function.arguments);
  } catch {
    return 'Error: invalid arguments';
  }

  switch (toolCall.function.name) {
    case 'set_directory': {
      const dirPath = args.path as string;
      const resolved = path.resolve(dirPath);

      if (!fs.existsSync(resolved)) {
        console.log(chalk.red(`  Directory not found: ${resolved}\n`));
        return `Error: directory does not exist: ${resolved}`;
      }
      if (!fs.statSync(resolved).isDirectory()) {
        console.log(chalk.red(`  Not a directory: ${resolved}\n`));
        return `Error: not a directory: ${resolved}`;
      }

      state.projectDir = resolved;
      console.log(chalk.dim(`  → Directory set to: ${resolved}`));
      return `Directory set to: ${resolved}`;
    }

    case 'set_task': {
      const desc = args.description as string;
      state.taskDescription = desc;
      console.log(chalk.dim(`  → Task: ${desc}`));
      return `Task set to: "${desc}"`;
    }

    case 'scan_directory': {
      const scanPath = args.path ? path.resolve(args.path as string) : state.projectDir;
      if (!scanPath) {
        return 'No directory set. Ask the user for a path.';
      }

      const projectMap = await analyzeProject(scanPath);
      if (!projectMap) {
        console.log(chalk.dim(`  → Scanned ${scanPath}: empty directory`));
        return 'Directory is empty (no files found).';
      }

      console.log(chalk.dim(`  → Scanned: ${projectMap.summary}`));
      return `Project analysis:\n${projectMap.summary}\n\nFile structure:\n${projectMap.fileTree}\n\nKey files:\n${Object.keys(projectMap.keyFileContents).join(', ') || 'none'}`;
    }

    case 'start_build': {
      if (!state.taskDescription) {
        return 'Cannot start: no task description set. Ask the user what they want to build.';
      }
      state.ready = true;
      return 'Build started.';
    }

    default:
      return `Unknown tool: ${toolCall.function.name}`;
  }
}

function handleSlashCommand(input: string, state: SessionState): 'build' | 'quit' | 'continue' {
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
      state.messages = [{ role: 'system', content: PLANNER_SYSTEM_PROMPT
        .replace('{{TASK}}', '(not set)')
        .replace('{{DIR}}', '(not set — will create new)') }];
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

function buildPlanningContext(state: SessionState): string {
  const userAssistantMessages = state.messages.filter(
    (m) => (m as any).role === 'user' || (m as any).role === 'assistant'
  );

  if (userAssistantMessages.length <= 1) return '';

  const lines: string[] = ['Planning conversation summary:'];
  for (const msg of userAssistantMessages) {
    const role = (msg as any).role === 'user' ? 'User' : 'Planner';
    const content = (msg as any).content;
    if (typeof content === 'string' && content.length > 0) {
      lines.push(`${role}: ${content.slice(0, 500)}`);
    }
  }

  return lines.join('\n').slice(0, 5000);
}

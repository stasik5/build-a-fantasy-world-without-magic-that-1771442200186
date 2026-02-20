/**
 * Shared planner logic for interactive planning mode.
 * Used by both CLI (interactive.ts) and web dashboard (server.ts).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ChatMessage } from '../types.js';
import { chatCompletionStream } from '../llm/client.js';
import { analyzeProject, formatProjectMap } from '../tools/project-analyzer.js';
import type OpenAI from 'openai';

export interface PlannerState {
  taskDescription: string;
  projectDir: string | null;
  messages: ChatMessage[];
  ready: boolean;
}

export interface PlannerToolResult {
  success: boolean;
  message: string;
  stateUpdate?: Partial<PlannerState>;
}

export const PLANNER_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'get_system_info',
      description: 'Get system information including home directory, current working directory, platform, and username. Use this to understand the user\'s environment and to construct valid paths. Call this FIRST when the user mentions relative paths or you need to explore the filesystem.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List contents of a directory. Shows folders and files with their types. Use this to explore the filesystem. Supports ~ for home directory and relative paths.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to list. Use ~ for home, . for current dir, or any relative/absolute path. Defaults to current working directory.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_directory',
      description: 'Set the project working directory to an existing folder on the user\'s machine. Call this when the user mentions a path, folder, or project location they want to work in. Also call this if the user says things like "go to", "look at", "open", "work on the project in", etc.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the directory. Can be absolute, relative, or use ~ for home.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_directory',
      description: 'Create a new directory for a project. Use this when the user wants to build something NEW and needs a fresh folder. Creates parent directories as needed. Automatically sets the new directory as the project directory.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path for the new directory. Can be absolute, relative, or use ~ for home. Example: "~/Desktop/projects/my-new-app"' },
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
      description: 'Deep scan a directory to understand a project. Shows file tree, detects technologies (package.json, etc.), and reads key files. Call this after set_directory to understand the project structure.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to scan. If not provided, scans the current project directory.' },
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

// Helper to resolve paths (handles ~, relative paths, etc.)
function resolvePath(inputPath: string | undefined, baseDir: string | null): string | null {
  if (!inputPath) {
    return baseDir || process.cwd();
  }

  // Handle ~ for home directory
  if (inputPath.startsWith('~/') || inputPath === '~') {
    const home = os.homedir();
    return inputPath === '~' ? home : path.join(home, inputPath.slice(2));
  }

  // Handle . for current directory
  if (inputPath === '.' || inputPath.startsWith('./')) {
    const base = baseDir || process.cwd();
    return inputPath === '.' ? base : path.join(base, inputPath.slice(2));
  }

  // Handle .. for parent directory
  if (inputPath === '..' || inputPath.startsWith('../')) {
    const base = baseDir || process.cwd();
    const resolved = inputPath === '..' ? path.dirname(base) : path.join(base, inputPath);
    return resolved;
  }

  // If it's already absolute, use as-is
  if (path.isAbsolute(inputPath)) {
    return inputPath;
  }

  // Relative path - resolve from base or cwd
  const base = baseDir || process.cwd();
  return path.resolve(base, inputPath);
}

export function createPlannerState(): PlannerState {
  // Try to find a sensible default project directory
  const home = os.homedir();
  const cwd = process.cwd();
  let defaultDir: string | null = null;

  // Try common project folder locations in order
  const candidates = [
    path.join(cwd, 'projects'),           // Repo's projects folder
    path.join(home, 'Desktop', 'projects'),
    path.join(home, 'projects'),
    path.join(home, 'dev'),
    path.join(home, 'code'),
    cwd,                                  // Current working directory
    home,
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      defaultDir = candidate;
      break;
    }
  }

  return {
    taskDescription: '',
    projectDir: defaultDir,
    messages: [],
    ready: false,
  };
}

export function buildPlannerSystemPrompt(state: PlannerState): string {
  const PLANNER_SYSTEM_PROMPT = `You are the planning assistant for a multi-agent coding swarm (1 orchestrator + 3 workers powered by GLM-5).

You chat with the user BEFORE any code is written. Your job:
1. Understand what they want to build or change
2. Use your tools to explore the filesystem and set the project directory
3. Ask 1-2 clarifying questions if requirements are unclear
4. When they're ready, use start_build to kick off execution

YOUR TOOLS:
- get_system_info: Get home directory, platform, current directory. CALL THIS FIRST when you need to explore.
- list_directory: Browse folders and files. Use ~ for home dir (e.g., ~/Desktop/projects).
- set_directory: Choose an existing project folder to work in.
- create_directory: Create a NEW folder for a new project. Use this when starting fresh.
- scan_directory: Deep analyze a project (file tree, tech stack, key files).
- set_task: Record what the user wants to build.
- start_build: Begin execution when user says "go".

IMPORTANT BEHAVIORS:
- When the user mentions a vague location ("my projects folder", "desktop"), use get_system_info then list_directory to find it
- You CAN explore the filesystem freely using list_directory with ~ for home
- For EXISTING projects: use set_directory, then scan_directory to understand it
- For NEW projects: use create_directory to make a fresh folder (e.g., ~/Desktop/projects/my-app)
- When the user describes what to build/fix/change, call set_task with a clear version
- You can call multiple tools at once (e.g., create_directory + set_task from a single message)
- Don't ask unnecessary questions. If the user is clear, confirm and ask if they're ready to build
- When the user says "go", "build it", "start", "do it", "let's go", "ship it", or similar → call start_build
- Keep responses SHORT (2-3 sentences max). No walls of text

CURRENT STATE:
- Task: {{TASK}}
- Directory: {{DIR}}`;

  return PLANNER_SYSTEM_PROMPT
    .replace('{{TASK}}', state.taskDescription || '(not set)')
    .replace('{{DIR}}', state.projectDir || '(not set — will create new)');
}

export async function executePlannerTool(
  toolCall: OpenAI.Chat.Completions.ChatCompletionMessageToolCall,
  state: PlannerState
): Promise<PlannerToolResult> {
  let args: Record<string, any>;
  try {
    args = JSON.parse(toolCall.function.arguments);
  } catch {
    return { success: false, message: 'Error: invalid arguments' };
  }

  switch (toolCall.function.name) {
    case 'get_system_info': {
      const home = os.homedir();
      const cwd = process.cwd();
      const platform = process.platform;
      const username = os.userInfo().username;
      const hostname = os.hostname();

      return {
        success: true,
        message: `System Information:
- Home directory: ${home}
- Current working directory: ${cwd}
- Platform: ${platform}
- Username: ${username}
- Hostname: ${hostname}
- Use ~ as shorthand for home directory: ${home}`,
      };
    }

    case 'list_directory': {
      const inputPath = args.path as string | undefined;
      const resolved = resolvePath(inputPath, state.projectDir);

      if (!resolved) {
        return { success: false, message: 'Could not resolve path. Try using get_system_info first.' };
      }

      if (!fs.existsSync(resolved)) {
        return { success: false, message: `Directory not found: ${resolved}` };
      }

      if (!fs.statSync(resolved).isDirectory()) {
        return { success: false, message: `Not a directory: ${resolved}` };
      }

      try {
        const entries = fs.readdirSync(resolved, { withFileTypes: true });
        const folders = entries.filter(e => e.isDirectory()).map(e => `📁 ${e.name}/`);
        const files = entries.filter(e => e.isFile()).map(e => `📄 ${e.name}`);

        // Filter out common noise
        const hiddenFolders = folders.filter(f => !f.startsWith('📁 .') || f === '📁 .git/');
        const visibleFolders = folders.filter(f => f.startsWith('📁 .') && f !== '📁 .git/');
        const displayFolders = [...hiddenFolders, ...visibleFolders.slice(0, 3)];

        // Limit output
        const maxItems = 50;
        const allItems = [...displayFolders, ...files];
        const truncated = allItems.length > maxItems;
        const displayItems = allItems.slice(0, maxItems);

        const result = `Contents of ${resolved}:\n\n${displayItems.join('\n')}${truncated ? `\n\n... and ${allItems.length - maxItems} more items` : ''}`;

        return { success: true, message: result };
      } catch (err: any) {
        return { success: false, message: `Error reading directory: ${err.message}` };
      }
    }

    case 'set_directory': {
      const inputPath = args.path as string;
      const resolved = resolvePath(inputPath, state.projectDir);

      if (!resolved) {
        return { success: false, message: `Could not resolve path: ${inputPath}` };
      }

      if (!fs.existsSync(resolved)) {
        return { success: false, message: `Directory not found: ${resolved}. Use create_directory if you want to create a new project folder.` };
      }
      if (!fs.statSync(resolved).isDirectory()) {
        return { success: false, message: `Not a directory: ${resolved}` };
      }

      return {
        success: true,
        message: `Directory set to: ${resolved}`,
        stateUpdate: { projectDir: resolved },
      };
    }

    case 'create_directory': {
      const inputPath = args.path as string;
      const resolved = resolvePath(inputPath, state.projectDir);

      if (!resolved) {
        return { success: false, message: `Could not resolve path: ${inputPath}` };
      }

      // Check if already exists
      if (fs.existsSync(resolved)) {
        // If it's a directory, just set it
        if (fs.statSync(resolved).isDirectory()) {
          return {
            success: true,
            message: `Directory already exists, set as project directory: ${resolved}`,
            stateUpdate: { projectDir: resolved },
          };
        }
        return { success: false, message: `Path exists but is not a directory: ${resolved}` };
      }

      // Create the directory (and parents)
      try {
        fs.mkdirSync(resolved, { recursive: true });
        return {
          success: true,
          message: `Created new project directory: ${resolved}`,
          stateUpdate: { projectDir: resolved },
        };
      } catch (err: any) {
        return { success: false, message: `Failed to create directory: ${err.message}` };
      }
    }

    case 'set_task': {
      const desc = args.description as string;
      return {
        success: true,
        message: `Task set to: "${desc}"`,
        stateUpdate: { taskDescription: desc },
      };
    }

    case 'scan_directory': {
      const inputPath = args.path as string | undefined;
      const scanPath = resolvePath(inputPath, state.projectDir);

      if (!scanPath) {
        return { success: false, message: 'No directory set. Use list_directory to explore, or set_directory to choose a project.' };
      }

      const projectMap = await analyzeProject(scanPath);
      if (!projectMap) {
        return { success: true, message: `Scanned ${scanPath}: empty directory` };
      }

      return {
        success: true,
        message: `Project analysis:\n${projectMap.summary}\n\nFile structure:\n${projectMap.fileTree}\n\nKey files:\n${Object.keys(projectMap.keyFileContents).join(', ') || 'none'}`,
      };
    }

    case 'start_build': {
      if (!state.taskDescription) {
        return { success: false, message: 'Cannot start: no task description set. Ask the user what they want to build.' };
      }
      return {
        success: true,
        message: 'Build started.',
        stateUpdate: { ready: true },
      };
    }

    default:
      return { success: false, message: `Unknown tool: ${toolCall.function.name}` };
  }
}

export async function processPlannerMessage(
  state: PlannerState,
  userInput: string,
  onToken?: (token: string) => void,
  onToolCall?: (toolName: string, result: PlannerToolResult) => void
): Promise<{ response: string; stateUpdate: Partial<PlannerState> }> {
  // Update system prompt with current state
  state.messages[0] = { role: 'system', content: buildPlannerSystemPrompt(state) };
  state.messages.push({ role: 'user', content: userInput });

  const stateUpdate: Partial<PlannerState> = {};
  let responseText = '';

  // Agent loop: keep calling until no more tool calls
  for (let step = 0; step < 5; step++) {
    let response;
    try {
      response = await chatCompletionStream(
        state.messages,
        PLANNER_TOOLS,
        onToken,
        { temperature: 0.3, maxTokens: 1024 },
      );
    } catch (err: any) {
      return { response: `Error: ${err.message}`, stateUpdate: {} };
    }

    const choice = response.choices[0];
    if (!choice) return { response: 'No response from planner', stateUpdate: {} };

    const msg = choice.message;
    state.messages.push(msg as ChatMessage);

    // Process tool calls
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      for (const toolCall of msg.tool_calls) {
        const result = await executePlannerTool(toolCall, state);
        onToolCall?.(toolCall.function.name, result);

        state.messages.push({
          role: 'tool' as const,
          tool_call_id: toolCall.id,
          content: result.message,
        });

        if (result.stateUpdate) {
          Object.assign(state, result.stateUpdate);
          Object.assign(stateUpdate, result.stateUpdate);
        }
      }

      // If start_build was called, we're done
      if (state.ready) {
        return { response: 'Build started!', stateUpdate: { ready: true, ...stateUpdate } };
      }

      // Continue the loop so the LLM can respond after tool results
      continue;
    }

    // No tool calls — just a text response
    if (msg.content) {
      responseText = msg.content;
    }
    break;
  }

  return { response: responseText, stateUpdate };
}

export function buildPlanningContext(state: PlannerState): string {
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

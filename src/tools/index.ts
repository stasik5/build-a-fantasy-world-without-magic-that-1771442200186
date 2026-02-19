import type OpenAI from 'openai';
import type { ToolDefinition } from '../types.js';
import { readFileTool } from './read-file.js';
import { writeFileTool } from './write-file.js';
import { listDirectoryTool } from './list-directory.js';
import { executeCommandTool } from './execute-command.js';
import { searchFilesTool } from './search-files.js';

export const WORKER_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file. Returns the file content as a string.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path from project root' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a file. Creates parent directories as needed. Overwrites existing files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path from project root' },
          content: { type: 'string', description: 'Full file content to write' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List files and directories at a given path. Shows [DIR] or [FILE] prefix for each entry.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path from project root. Defaults to root.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'execute_command',
      description: 'Execute a shell command in the project directory. Only allowed commands: node, npm, npx, git, tsc, ls, mkdir, cp, mv, rm, touch, python, pip.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command to execute (e.g., "npm init -y", "node index.js")' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Search for a text pattern in all files recursively. Returns matching lines with file paths and line numbers.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Text pattern to search for (plain text, not regex)' },
          path: { type: 'string', description: 'Subdirectory to search in. Defaults to project root.' },
        },
        required: ['pattern'],
      },
    },
  },
];

export async function executeTool(
  toolCall: OpenAI.Chat.Completions.ChatCompletionMessageToolCall,
  projectRoot: string,
  artifacts: string[],
  workerIndex?: number
): Promise<string> {
  let args: Record<string, any>;
  try {
    args = JSON.parse(toolCall.function.arguments);
  } catch {
    return `Error: Failed to parse tool arguments: ${toolCall.function.arguments}`;
  }

  switch (toolCall.function.name) {
    case 'read_file':
      return readFileTool(projectRoot, args as { path: string });
    case 'write_file':
      return writeFileTool(projectRoot, args as { path: string; content: string }, artifacts, workerIndex);
    case 'list_directory':
      return listDirectoryTool(projectRoot, args as { path?: string });
    case 'execute_command':
      return executeCommandTool(projectRoot, args as { command: string });
    case 'search_files':
      return searchFilesTool(projectRoot, args as { pattern: string; path?: string });
    default:
      return `Error: Unknown tool "${toolCall.function.name}"`;
  }
}

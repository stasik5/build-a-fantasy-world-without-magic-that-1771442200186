import type OpenAI from 'openai';
import type { ToolDefinition } from '../types.js';
import { readFileTool } from './read-file.js';
import { writeFileTool } from './write-file.js';
import { listDirectoryTool } from './list-directory.js';
import { executeCommandTool } from './execute-command.js';
import { searchFilesTool } from './search-files.js';
import { patchFileTool } from './patch-file.js';
import { webSearchTool } from './web-search.js';
import { webReaderTool } from './web-reader.js';
import { globFilesTool } from './glob-files.js';
import { executeSqlTool, listTablesTool, initDatabaseTool } from './execute-sql.js';

export const WORKER_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file. Optionally specify a line range for large files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path from project root' },
          startLine: { type: 'number', description: 'Optional: first line to read (1-based). If omitted, reads from start.' },
          endLine: { type: 'number', description: 'Optional: last line to read (1-based). If omitted, reads to end.' },
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
  {
    type: 'function',
    function: {
      name: 'patch_file',
      description: 'Replace a specific text section in an existing file. Use this for small edits instead of rewriting the entire file with write_file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path from project root' },
          search: { type: 'string', description: 'Exact text to find in the file (must match exactly, including whitespace)' },
          replace: { type: 'string', description: 'Text to replace it with' },
        },
        required: ['path', 'search', 'replace'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web for documentation, API references, tutorials, or error solutions. Use this when you need information about a library, framework, or technique you are unsure about.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query (e.g., "express.js middleware tutorial", "react useState hook API")' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_reader',
      description: 'Read the content of a web page. Use this to fetch documentation pages, README files, or API reference URLs found via web_search.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Full URL of the web page to read' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'glob_files',
      description: 'Find files matching a glob pattern. Use this to discover project structure, find all files of a type, or locate specific files. Examples: "src/**/*.ts", "**/*.test.js", "*.json"',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern to match files against. Supports *, **, and ? wildcards.' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'init_database',
      description: 'Create a new SQLite database with the given schema. Use this to set up a local database for the project. Creates the file and runs CREATE TABLE statements.',
      parameters: {
        type: 'object',
        properties: {
          dbPath: { type: 'string', description: 'Path for the database file (e.g., "data/app.db") or ":memory:" for in-memory' },
          schema: { type: 'string', description: 'SQL schema statements (CREATE TABLE, CREATE INDEX, etc.). Separate multiple statements with semicolons.' },
        },
        required: ['dbPath', 'schema'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'execute_sql',
      description: 'Execute SQL queries on a SQLite database. Supports SELECT, INSERT, UPDATE, DELETE, and DDL statements. Use parameterized queries for safety.',
      parameters: {
        type: 'object',
        properties: {
          dbPath: { type: 'string', description: 'Path to the database file (e.g., "data/app.db") or ":memory:"' },
          query: { type: 'string', description: 'SQL query to execute' },
          params: { type: 'array', description: 'Optional: parameters for parameterized queries. Use ? as placeholder. Example: ["SELECT * FROM users WHERE id = ?", [1]]', items: {} },
        },
        required: ['dbPath', 'query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_tables',
      description: 'List all tables and views in a SQLite database with their schemas and row counts. Use this to explore an existing database.',
      parameters: {
        type: 'object',
        properties: {
          dbPath: { type: 'string', description: 'Path to the database file (e.g., "data/app.db") or ":memory:"' },
        },
        required: ['dbPath'],
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
      return readFileTool(projectRoot, args as { path: string; startLine?: number; endLine?: number });
    case 'write_file':
      return writeFileTool(projectRoot, args as { path: string; content: string }, artifacts, workerIndex);
    case 'list_directory':
      return listDirectoryTool(projectRoot, args as { path?: string });
    case 'execute_command':
      return executeCommandTool(projectRoot, args as { command: string });
    case 'search_files':
      return searchFilesTool(projectRoot, args as { pattern: string; path?: string });
    case 'patch_file':
      return patchFileTool(projectRoot, args as { path: string; search: string; replace: string }, artifacts, workerIndex);
    case 'web_search':
      return webSearchTool(args as { query: string; count?: number });
    case 'web_reader':
      return webReaderTool(args as { url: string });
    case 'glob_files':
      return globFilesTool(projectRoot, args as { pattern: string });
    case 'init_database':
      return initDatabaseTool(projectRoot, args as { dbPath: string; schema: string });
    case 'execute_sql':
      return executeSqlTool(projectRoot, args as { dbPath: string; query: string; params?: any[] });
    case 'list_tables':
      return listTablesTool(projectRoot, args as { dbPath: string });
    default:
      return `Error: Unknown tool "${toolCall.function.name}"`;
  }
}

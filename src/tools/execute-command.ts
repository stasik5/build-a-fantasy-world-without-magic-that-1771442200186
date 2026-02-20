import { execFile } from 'node:child_process';

// Allowlist of base commands
const ALLOWED_COMMANDS = new Set([
  'node', 'npm', 'npx', 'git', 'tsc', 'ls', 'dir',
  'mkdir', 'cp', 'mv', 'rm', 'touch', 'python', 'python3', 'pip',
]);

// Patterns that should never appear in arguments
const DANGEROUS_PATTERNS = [
  /[;&|`$]/,          // Shell operators
  /\$\(/,             // Command substitution
  />\s*/,             // Output redirection
  /<\s*/,             // Input redirection
  /\.\.\//,           // Path traversal
  /\/etc\//,          // Sensitive system paths
  /\/proc\//,
];

const TIMEOUT_MS = 30_000;
const MAX_BUFFER = 1024 * 1024;

export async function executeCommandTool(
  projectRoot: string,
  args: { command: string }
): Promise<string> {
  try {
    const parts = parseCommandParts(args.command);
    const cmd = parts[0];
    const cmdArgs = parts.slice(1);

    if (!cmd || !ALLOWED_COMMANDS.has(cmd)) {
      return `Error: Command "${cmd}" is not allowed. Allowed: ${[...ALLOWED_COMMANDS].join(', ')}`;
    }

    // Check for dangerous patterns in the full command
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(args.command)) {
        return `Error: Command contains a disallowed pattern: ${pattern.source}`;
      }
    }

    return await new Promise<string>((resolve) => {
      execFile(
        cmd,
        cmdArgs,
        {
          cwd: projectRoot,
          timeout: TIMEOUT_MS,
          maxBuffer: MAX_BUFFER,
          // No shell: true - execFile directly avoids shell injection
          env: { ...process.env },
        },
        (error, stdout, stderr) => {
          const output: string[] = [];
          if (stdout) output.push(`STDOUT:\n${truncate(stdout, 15000)}`);
          if (stderr) output.push(`STDERR:\n${truncate(stderr, 5000)}`);
          if (error) output.push(`EXIT CODE: ${error.code ?? 1}`);
          else output.push(`EXIT CODE: 0`);
          resolve(output.join('\n'));
        }
      );
    });
  } catch (err: any) {
    return `Error executing command: ${err.message}`;
  }
}

function parseCommandParts(command: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuote: string | null = null;

  for (const ch of command) {
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === ' ' || ch === '\t') {
      if (current) {
        parts.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  return parts;
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max) + `\n... [truncated, ${str.length} total chars]`;
}

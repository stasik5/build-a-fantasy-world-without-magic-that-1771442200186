/**
 * Project verification: automatically detect and run build/test commands,
 * then return structured error information for the orchestrator.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';

const TIMEOUT_MS = 60_000; // 60s for builds
const MAX_BUFFER = 2 * 1024 * 1024; // 2MB

export interface VerificationResult {
  passed: boolean;
  commands: Array<{
    command: string;
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
  summary: string;
}

/**
 * Detect what verification commands to run based on project files.
 */
async function detectCommands(projectDir: string): Promise<string[][]> {
  const commands: string[][] = [];

  // Check for package.json
  try {
    const pkgJson = await fs.readFile(path.join(projectDir, 'package.json'), 'utf-8');
    const pkg = JSON.parse(pkgJson);
    const scripts = pkg.scripts ?? {};
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };

    // Always install dependencies first if package.json exists and node_modules doesn't
    try {
      await fs.access(path.join(projectDir, 'node_modules'));
    } catch {
      commands.push(['npm', 'install']);
    }

    // TypeScript check
    if (deps['typescript'] || scripts['build']?.includes('tsc')) {
      if (scripts['build']) {
        commands.push(['npm', 'run', 'build']);
      } else {
        commands.push(['npx', 'tsc', '--noEmit']);
      }
    }

    // Lint
    if (scripts['lint']) {
      commands.push(['npm', 'run', 'lint']);
    }

    // Test
    if (scripts['test'] && scripts['test'] !== 'echo "Error: no test specified" && exit 1') {
      commands.push(['npm', 'run', 'test']);
    }

    // If no build/lint/test, at least check syntax with node
    if (commands.length <= 1) {
      // Find the main entry point
      const main = pkg.main ?? 'index.js';
      try {
        await fs.access(path.join(projectDir, main));
        commands.push(['node', '--check', main]);
      } catch {
        // Try index.js
        try {
          await fs.access(path.join(projectDir, 'index.js'));
          commands.push(['node', '--check', 'index.js']);
        } catch { /* no entry point to check */ }
      }
    }
  } catch {
    // No package.json — check for other project types
  }

  // Check for Python
  try {
    await fs.access(path.join(projectDir, 'requirements.txt'));
    commands.push(['python', '-m', 'py_compile', 'main.py']);
  } catch { /* not python */ }

  // If we found nothing at all, try to at least verify HTML
  if (commands.length === 0) {
    try {
      const entries = await fs.readdir(projectDir);
      const htmlFile = entries.find(e => e.endsWith('.html'));
      if (htmlFile) {
        // Can't really "build" HTML, but we can check the file exists and isn't empty
        const content = await fs.readFile(path.join(projectDir, htmlFile), 'utf-8');
        if (content.trim().length > 0) {
          return []; // HTML project, nothing to verify via commands
        }
      }
    } catch { /* skip */ }
  }

  return commands;
}

function runCommand(cmd: string, args: string[], cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, {
      cwd,
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      env: { ...process.env },
    }, (error, stdout, stderr) => {
      resolve({
        exitCode: error?.code as number ?? (error ? 1 : 0),
        stdout: typeof stdout === 'string' ? stdout : '',
        stderr: typeof stderr === 'string' ? stderr : '',
      });
    });
  });
}

/**
 * Run verification commands on the project and return results.
 */
export async function verifyProject(projectDir: string): Promise<VerificationResult> {
  const commandSets = await detectCommands(projectDir);

  if (commandSets.length === 0) {
    return {
      passed: true,
      commands: [],
      summary: 'No verification commands detected (static project).',
    };
  }

  const results: VerificationResult['commands'] = [];
  let allPassed = true;

  for (const [cmd, ...args] of commandSets) {
    const result = await runCommand(cmd!, args, projectDir);
    const commandStr = [cmd, ...args].join(' ');

    results.push({
      command: commandStr,
      exitCode: result.exitCode,
      stdout: result.stdout.slice(0, 5000),
      stderr: result.stderr.slice(0, 5000),
    });

    if (result.exitCode !== 0) {
      allPassed = false;
      // Don't stop on first failure — collect all results
    }
  }

  const failedCommands = results.filter(r => r.exitCode !== 0);
  const summary = allPassed
    ? `All ${results.length} verification command(s) passed.`
    : `${failedCommands.length}/${results.length} command(s) failed: ${failedCommands.map(r => r.command).join(', ')}`;

  return { passed: allPassed, commands: results, summary };
}

/**
 * Format verification results into a string for the orchestrator.
 */
export function formatVerificationResult(result: VerificationResult): string {
  if (result.commands.length === 0) {
    return result.summary;
  }

  const sections: string[] = [`Verification: ${result.summary}`];

  for (const cmd of result.commands) {
    const status = cmd.exitCode === 0 ? 'PASS' : 'FAIL';
    sections.push(`\n[${status}] ${cmd.command} (exit ${cmd.exitCode})`);
    if (cmd.exitCode !== 0) {
      if (cmd.stderr) sections.push(`STDERR:\n${cmd.stderr}`);
      if (cmd.stdout) sections.push(`STDOUT:\n${cmd.stdout}`);
    }
  }

  return sections.join('\n');
}

import chalk from 'chalk';
import ora, { type Ora } from 'ora';
import type { Subtask, ReviewDecision, WorkerResult } from '../types.js';
import { messageBus } from '../swarm/message-bus.js';

const WORKER_COLORS = [chalk.yellow, chalk.magenta, chalk.blue] as const;

let activeSpinner: Ora | null = null;

function stopSpinner(): void {
  if (activeSpinner) {
    activeSpinner.stop();
    activeSpinner = null;
  }
}

export const ui = {
  showWelcome(): void {
    console.log('');
    console.log(chalk.cyan.bold('  Builder Swarm v2'));
    console.log(chalk.dim('  1 orchestrator + 3 workers powered by GLM-5'));
    console.log(chalk.dim('  Streaming | Checkpoints | Context Management'));
    console.log(chalk.dim('  ─'.repeat(30)));
    console.log('');
  },

  showProjectDir(dir: string): void {
    console.log(chalk.green('  Project folder: ') + chalk.white(dir));
    console.log('');
  },

  showResuming(dir: string): void {
    console.log(chalk.yellow('  Resuming from checkpoint: ') + chalk.white(dir));
    console.log('');
  },

  showProjectAnalysis(summary: string): void {
    stopSpinner();
    console.log(chalk.cyan.bold('\n  Project Analysis:'));
    for (const line of summary.split('\n')) {
      console.log(chalk.white(`    ${line}`));
    }
    console.log('');
  },

  showPlan(subtasks: Subtask[]): void {
    stopSpinner();
    console.log(chalk.cyan.bold('\n  Orchestrator Plan:'));
    for (let i = 0; i < subtasks.length; i++) {
      const s = subtasks[i]!;
      const statusIcon =
        s.status === 'completed' ? chalk.green('  ') :
        s.status === 'failed' ? chalk.red('  ') :
        s.status === 'in_progress' ? chalk.yellow('  ') : chalk.dim('  ');
      const deps = s.dependencies.length > 0 ? chalk.dim(` (depends on: ${s.dependencies.length} tasks)`) : '';
      console.log(statusIcon + chalk.white(`${i + 1}. ${s.title}`) + deps);
    }
    console.log('');
  },

  showDispatching(assignments: Array<{ workerIndex: number; subtask: Subtask }>): void {
    stopSpinner();
    console.log(chalk.cyan('\n  Dispatching workers:'));
    for (const { workerIndex, subtask } of assignments) {
      const color = WORKER_COLORS[workerIndex] ?? chalk.white;
      console.log(color(`    Worker ${workerIndex} -> "${subtask.title}"`));
    }
    activeSpinner = ora({
      text: chalk.dim('Workers executing...'),
      prefixText: '  ',
    }).start();
  },

  showWorkerProgress(workerIndex: number, taskTitle: string, step: number, toolName: string): void {
    if (activeSpinner) {
      const color = WORKER_COLORS[workerIndex] ?? chalk.white;
      activeSpinner.text = color(`Worker ${workerIndex}: step ${step + 1} - ${toolName}`) + chalk.dim(` (${taskTitle})`);
    }
  },

  showWorkerResults(results: WorkerResult[]): void {
    stopSpinner();
    console.log(chalk.cyan('\n  Worker Results:'));
    for (const result of results) {
      const icon = result.status === 'completed' ? chalk.green('OK') : chalk.red('FAIL');
      console.log(`    [${icon}] ${result.summary.slice(0, 120)}`);
      if (result.artifacts.length > 0) {
        console.log(chalk.dim(`         Files: ${result.artifacts.join(', ')}`));
      }
    }
  },

  showReview(decisions: ReviewDecision[]): void {
    console.log(chalk.cyan('\n  Orchestrator Review:'));
    for (const d of decisions) {
      const icon =
        d.verdict === 'accept' ? chalk.green('ACCEPT') :
        d.verdict === 'revise' ? chalk.yellow('REVISE') :
        chalk.red('REASSIGN');
      console.log(`    [${icon}] ${d.subtaskId.slice(0, 8)}...`);
      if (d.feedback) {
        console.log(chalk.dim(`         ${d.feedback.slice(0, 100)}`));
      }
    }
  },

  showIterationSummary(iteration: number, total: number, completed: number, pending: number, failed: number): void {
    const bar = '█'.repeat(completed) + '░'.repeat(total - completed);
    console.log(
      chalk.dim(`\n  Iteration ${iteration + 1}: `) +
      chalk.white(`[${bar}] ${completed}/${total}`) +
      (failed > 0 ? chalk.red(` (${failed} failed)`) : '') +
      (pending > 0 ? chalk.yellow(` (${pending} pending)`) : '')
    );
  },

  showVerification(passed: boolean, report: string): void {
    stopSpinner();
    const icon = passed ? chalk.green.bold('PASS') : chalk.red.bold('FAIL');
    console.log(chalk.cyan.bold(`\n  Build/Test Verification: `) + icon);
    // Show truncated report
    const lines = report.split('\n').slice(0, 20);
    for (const line of lines) {
      if (line.includes('[FAIL]')) {
        console.log(chalk.red(`    ${line}`));
      } else if (line.includes('[PASS]')) {
        console.log(chalk.green(`    ${line}`));
      } else {
        console.log(chalk.dim(`    ${line}`));
      }
    }
    if (report.split('\n').length > 20) {
      console.log(chalk.dim(`    ... (${report.split('\n').length - 20} more lines)`));
    }
    console.log('');
  },

  showCompletion(summary: string, projectDir: string): void {
    stopSpinner();
    console.log('');
    console.log(chalk.green.bold('  Project Complete!'));
    console.log(chalk.white(`  ${summary}`));
    console.log('');
    console.log(chalk.green('  Output: ') + chalk.white(projectDir));
    console.log('');
  },

  showError(msg: string): void {
    stopSpinner();
    console.log(chalk.red(`\n  Error: ${msg}\n`));
  },

  showRateLimitWait(waitMs: number): void {
    const secs = Math.ceil(waitMs / 1000);
    if (activeSpinner) {
      activeSpinner.text = chalk.dim.yellow(`Rate limit: waiting ${secs}s...`);
    } else {
      console.log(chalk.dim.yellow(`  Rate limit: waiting ${secs}s...`));
    }
  },

  showRetry(attempt: number, maxRetries: number, delayMs: number, error: string): void {
    const secs = Math.ceil(delayMs / 1000);
    const msg = `LLM retry ${attempt}/${maxRetries} in ${secs}s (${error})`;
    if (activeSpinner) {
      activeSpinner.text = chalk.dim.yellow(msg);
    } else {
      console.log(chalk.dim.yellow(`  ${msg}`));
    }
  },

  showMaxIterationsReached(): void {
    stopSpinner();
    console.log(chalk.yellow('\n  Max orchestrator iterations reached. Stopping.'));
    console.log(chalk.dim('  The project may be incomplete. Run with --resume to continue.\n'));
  },

  showOrchestratorThinking(phase: string): void {
    stopSpinner();
    activeSpinner = ora({
      text: chalk.cyan(`Orchestrator: ${phase}`),
      prefixText: '  ',
    }).start();
  },

  showTokenStats(stats: { promptTokens: number; completionTokens: number; totalTokens: number; callCount: number }): void {
    console.log(
      chalk.dim(`\n  Token usage: ${stats.totalTokens.toLocaleString()} total `) +
      chalk.dim(`(${stats.promptTokens.toLocaleString()} prompt + ${stats.completionTokens.toLocaleString()} completion) `) +
      chalk.dim(`across ${stats.callCount} API calls`)
    );
  },

  showContextStats(stats: { messageCount: number; estimatedTokens: number; budgetUsedPercent: number }): void {
    const color = stats.budgetUsedPercent > 80 ? chalk.red : chalk.yellow;
    console.log(
      color(`  Context: ${stats.budgetUsedPercent}% used `) +
      chalk.dim(`(~${stats.estimatedTokens.toLocaleString()} tokens, ${stats.messageCount} messages)`)
    );
  },

  stopSpinner,

  setupEventListeners(): void {
    messageBus.on('rate-limit:wait', ({ waitMs }: { waitMs: number }) => {
      ui.showRateLimitWait(waitMs);
    });

    messageBus.on('subtask:progress', ({ workerIndex, subtaskId, step, toolName }: any) => {
      const shortId = subtaskId.slice(0, 8);
      ui.showWorkerProgress(workerIndex, shortId, step, toolName);
    });

    messageBus.on('llm:retry', ({ attempt, maxRetries, delayMs, error }: any) => {
      ui.showRetry(attempt, maxRetries, delayMs, error);
    });

    // Streaming: show a dot for each chunk to indicate activity
    let tokenCount = 0;
    messageBus.on('worker:token', () => {
      tokenCount++;
      if (activeSpinner && tokenCount % 20 === 0) {
        // Update spinner periodically to show streaming activity
        activeSpinner.text = activeSpinner.text?.replace(/ \.+$/, '') + ' ' + '.'.repeat((tokenCount / 20) % 4 + 1);
      }
    });
  },
};

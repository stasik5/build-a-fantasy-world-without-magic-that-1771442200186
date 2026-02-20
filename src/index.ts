#!/usr/bin/env node
import { Command } from 'commander';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config.js';
import { getRuntimeConfig } from './runtime-config.js';
import { createProjectDir } from './swarm/project-manager.js';
import { loadCheckpoint } from './swarm/checkpoint.js';
import { runOrchestrator } from './agents/orchestrator.js';
import { ui } from './cli/ui.js';
import { runInteractiveSession } from './cli/interactive.js';
import type { ProjectContext } from './types.js';

const program = new Command()
  .name('swarm')
  .description('Multi-agent builder swarm powered by GLM-5')
  .version('2.0.0')
  .argument('[task]', 'Task description (in quotes). If omitted, enters interactive planning mode.')
  .option('--max-iterations <n>', 'Max orchestrator iterations', '50')
  .option('--resume <dir>', 'Resume from a previous project checkpoint')
  .option('--dir <path>', 'Use an existing directory as the project root (instead of creating a new one)')
  .option('--no-interactive', 'Skip interactive planning mode (requires task argument)')
  .option('--web [port]', 'Start web dashboard on given port', '3456')
  .action(async (task: string | undefined, options: { maxIterations: string; resume?: string; dir?: string; interactive?: boolean; web?: string }) => {
    ui.showWelcome();
    ui.setupEventListeners();

    const isWebStandalone = options.web !== undefined && !task && !options.resume;

    // In standalone web mode, API key is optional at startup (can be set via dashboard)
    if (!isWebStandalone && !getRuntimeConfig().ZAI_API_KEY) {
      ui.showError('ZAI_API_KEY not set. Create a .env file with your API key.');
      process.exit(1);
    }

    // Standalone web mode: start server and wait for browser input
    if (isWebStandalone) {
      const { startWebServer } = await import('./web/server.js');
      const webPort = parseInt(options.web!, 10) || 3456;
      await startWebServer(webPort);
      console.log(`  Web dashboard: http://localhost:${webPort}`);
      console.log(`  Waiting for task from browser...\n`);
      return; // Server keeps process alive
    }

    const maxIterations = parseInt(options.maxIterations, 10);

    let ctx: ProjectContext;

    if (options.resume) {
      // Resume from checkpoint
      const loaded = loadCheckpoint(options.resume);
      if (!loaded) {
        ui.showError(`No checkpoint found at: ${options.resume}`);
        process.exit(1);
      }
      ctx = loaded;
      ui.showResuming(ctx.rootDir);
    } else if (!task || (options.interactive !== false && !options.web)) {
      // Interactive planning mode: chat before building
      // Enters when: no task given, OR task given but --no-interactive not set
      const result = await runInteractiveSession(task, options.dir);

      if (result.action === 'quit') {
        process.exit(0);
      }

      // Determine project directory
      let projectDir: string;
      if (result.projectDir) {
        projectDir = result.projectDir;
      } else {
        projectDir = await createProjectDir(result.taskDescription);
      }
      ui.showProjectDir(projectDir);

      ctx = {
        id: crypto.randomUUID(),
        rootDir: projectDir,
        taskDescription: result.taskDescription,
        subtasks: [],
        orchestratorMessages: [],
        planningContext: result.planningContext || undefined,
      };
    } else {
      // Direct mode: --no-interactive with a task, or --web with a task
      let projectDir: string;
      if (options.dir) {
        projectDir = path.resolve(options.dir);
        if (!fs.existsSync(projectDir)) {
          ui.showError(`Directory does not exist: ${projectDir}`);
          process.exit(1);
        }
        if (!fs.statSync(projectDir).isDirectory()) {
          ui.showError(`Not a directory: ${projectDir}`);
          process.exit(1);
        }
      } else {
        projectDir = await createProjectDir(task);
      }
      ui.showProjectDir(projectDir);

      ctx = {
        id: crypto.randomUUID(),
        rootDir: projectDir,
        taskDescription: task,
        subtasks: [],
        orchestratorMessages: [],
      };
    }

    // Start web dashboard if --web flag is set (with a task)
    if (options.web !== undefined) {
      const { startWebServer, setContext } = await import('./web/server.js');
      const webPort = parseInt(options.web, 10) || 3456;
      setContext(ctx);
      await startWebServer(webPort);
      console.log(`  Web dashboard: http://localhost:${webPort}\n`);
    }

    try {
      await runOrchestrator(ctx, maxIterations);
    } catch (err: any) {
      ui.showError(`Fatal error: ${err.message}`);
      process.exit(1);
    }
  });

program.parse();

#!/usr/bin/env node
import { Command } from 'commander';
import crypto from 'node:crypto';
import { CONFIG } from './config.js';
import { getRuntimeConfig } from './runtime-config.js';
import { createProjectDir } from './swarm/project-manager.js';
import { loadCheckpoint } from './swarm/checkpoint.js';
import { runOrchestrator } from './agents/orchestrator.js';
import { ui } from './cli/ui.js';
import type { ProjectContext } from './types.js';

const program = new Command()
  .name('swarm')
  .description('Multi-agent builder swarm powered by GLM-5')
  .version('2.0.0')
  .argument('[task]', 'Task description (in quotes)')
  .option('--max-iterations <n>', 'Max orchestrator iterations', '50')
  .option('--resume <dir>', 'Resume from a previous project checkpoint')
  .option('--web [port]', 'Start web dashboard on given port', '3456')
  .action(async (task: string | undefined, options: { maxIterations: string; resume?: string; web?: string }) => {
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

    if (!task && !options.resume) {
      ui.showError('Task description is required unless --web is used alone or --resume is specified.');
      process.exit(1);
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
    } else {
      // Fresh run
      const projectDir = createProjectDir(task!);
      ui.showProjectDir(projectDir);

      ctx = {
        id: crypto.randomUUID(),
        rootDir: projectDir,
        taskDescription: task!,
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

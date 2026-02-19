import fs from 'node:fs';
import path from 'node:path';
import type { ProjectContext } from '../types.js';

const CHECKPOINT_FILE = '.swarm-checkpoint.json';

export function saveCheckpoint(ctx: ProjectContext): void {
  const checkpointPath = path.join(ctx.rootDir, CHECKPOINT_FILE);
  const data = {
    id: ctx.id,
    rootDir: ctx.rootDir,
    taskDescription: ctx.taskDescription,
    subtasks: ctx.subtasks,
    // Don't save orchestratorMessages - they'll be rebuilt from the summary
    savedAt: new Date().toISOString(),
  };
  fs.writeFileSync(checkpointPath, JSON.stringify(data, null, 2), 'utf-8');
}

export function loadCheckpoint(projectDir: string): ProjectContext | null {
  const checkpointPath = path.join(projectDir, CHECKPOINT_FILE);
  if (!fs.existsSync(checkpointPath)) return null;

  try {
    const raw = fs.readFileSync(checkpointPath, 'utf-8');
    const data = JSON.parse(raw);

    // Reset any in_progress subtasks back to pending (they were interrupted)
    for (const subtask of data.subtasks) {
      if (subtask.status === 'in_progress') {
        subtask.status = 'pending';
      }
    }

    return {
      id: data.id,
      rootDir: data.rootDir,
      taskDescription: data.taskDescription,
      subtasks: data.subtasks,
      orchestratorMessages: [], // Will be rebuilt
    };
  } catch {
    return null;
  }
}

export function checkpointExists(projectDir: string): boolean {
  return fs.existsSync(path.join(projectDir, CHECKPOINT_FILE));
}

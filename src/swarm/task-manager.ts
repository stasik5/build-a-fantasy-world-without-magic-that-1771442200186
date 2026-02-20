import { v4 as uuidv4 } from 'uuid';
import type { ProjectContext, Subtask, TaskPlan, ReviewDecision, WorkerResult, FinalReview } from '../types.js';
import { getRuntimeConfig } from '../runtime-config.js';

export class TaskManager {
  constructor(private ctx: ProjectContext) {}

  addSubtasksFromPlan(plan: TaskPlan): void {
    const idMap = new Map<number, string>(); // index -> uuid

    for (let i = 0; i < plan.subtasks.length; i++) {
      const id = uuidv4();
      idMap.set(i, id);
    }

    for (let i = 0; i < plan.subtasks.length; i++) {
      const s = plan.subtasks[i]!;
      const subtask: Subtask = {
        id: idMap.get(i)!,
        title: s.title,
        description: s.description,
        dependencies: s.dependencies
          .map((dep) => {
            // Prefer title-based matching (among current plan's subtasks)
            const planMatch = plan.subtasks.findIndex((t, j) => t.title === dep && j !== i);
            if (planMatch !== -1 && idMap.has(planMatch)) {
              return idMap.get(planMatch)!;
            }
            // Then check existing subtasks by title
            const existingMatch = this.ctx.subtasks.find((t) => t.title === dep);
            if (existingMatch) return existingMatch.id;
            // Fallback to index-based (for backward compatibility)
            const depIndex = parseInt(dep, 10);
            if (!isNaN(depIndex) && idMap.has(depIndex)) {
              return idMap.get(depIndex)!;
            }
            return '';
          })
          .filter(Boolean),
        assignedWorker: null,
        status: 'pending',
        result: null,
        artifacts: [],
        attempts: 0,
        feedback: null,
      };
      this.ctx.subtasks.push(subtask);
    }
  }

  addMoreSubtasks(additional: FinalReview['additionalSubtasks']): void {
    if (!additional) return;
    this.addSubtasksFromPlan({ subtasks: additional });
  }

  getReadySubtasks(): Subtask[] {
    return this.ctx.subtasks.filter((subtask) => {
      if (subtask.status !== 'pending') return false;
      // Check that all dependencies are completed
      return subtask.dependencies.every((depId) => {
        const dep = this.ctx.subtasks.find((t) => t.id === depId);
        return dep?.status === 'completed';
      });
    });
  }

  allCompleted(): boolean {
    return this.ctx.subtasks.every((t) => t.status === 'completed');
  }

  anyFailed(): boolean {
    return this.ctx.subtasks.some(
      (t) => t.status === 'failed' && t.attempts >= getRuntimeConfig().MAX_SUBTASK_ATTEMPTS
    );
  }

  applyWorkerResult(result: WorkerResult): void {
    const subtask = this.ctx.subtasks.find((t) => t.id === result.subtaskId);
    if (!subtask) return;

    // Cap stored result to avoid context bloat in orchestrator messages
    subtask.result = result.summary.slice(0, 2000);
    subtask.artifacts = [...subtask.artifacts, ...result.artifacts];

    if (result.status === 'completed') {
      subtask.status = 'completed'; // Tentatively; orchestrator review may override
    } else {
      subtask.attempts++;
      if (subtask.attempts >= getRuntimeConfig().MAX_SUBTASK_ATTEMPTS) {
        subtask.status = 'failed';
      } else {
        subtask.status = 'pending';
        subtask.feedback = result.error ?? 'Worker failed, please retry';
      }
    }
  }

  applyReviewDecisions(decisions: ReviewDecision[]): void {
    for (const decision of decisions) {
      const subtask = this.ctx.subtasks.find((t) => t.id === decision.subtaskId);
      if (!subtask) continue;

      switch (decision.verdict) {
        case 'accept':
          subtask.status = 'completed';
          break;
        case 'revise':
          subtask.status = 'pending';
          subtask.feedback = decision.feedback ?? 'Please revise your work.';
          subtask.attempts++;
          if (subtask.attempts >= getRuntimeConfig().MAX_SUBTASK_ATTEMPTS) {
            subtask.status = 'failed';
          }
          break;
        case 'reassign':
          subtask.status = 'pending';
          subtask.assignedWorker = null;
          subtask.feedback = decision.feedback ?? 'Reassigned to a different worker.';
          break;
      }
    }
  }

  getStatusSummary(): string {
    const total = this.ctx.subtasks.length;
    const completed = this.ctx.subtasks.filter((t) => t.status === 'completed').length;
    const failed = this.ctx.subtasks.filter((t) => t.status === 'failed').length;
    const pending = this.ctx.subtasks.filter((t) => t.status === 'pending').length;
    const inProgress = this.ctx.subtasks.filter((t) => t.status === 'in_progress').length;

    const lines = [`Progress: ${completed}/${total} completed, ${pending} pending, ${inProgress} in-progress, ${failed} failed\n`];

    for (const subtask of this.ctx.subtasks) {
      const statusIcon =
        subtask.status === 'completed' ? '[DONE]' :
        subtask.status === 'failed' ? '[FAIL]' :
        subtask.status === 'in_progress' ? '[WORK]' : '[PEND]';

      lines.push(`${statusIcon} ${subtask.title} (id: ${subtask.id})`);
      if (subtask.result) {
        lines.push(`  Result: ${subtask.result.slice(0, 400)}`);
      }
      if (subtask.artifacts.length > 0) {
        lines.push(`  Files: ${subtask.artifacts.join(', ')}`);
      }
    }

    return lines.join('\n');
  }
}

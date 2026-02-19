import type { ProjectContext, TaskPlan, ReviewDecision, FinalReview, WorkerResult, ChatMessage } from '../types.js';
import { chatCompletion } from '../llm/client.js';
import { parseJSON } from '../llm/json-parser.js';
import { manageContext, getContextStats } from '../llm/context-manager.js';
import { tokenTracker } from '../llm/token-tracker.js';
import { createWorkerRateLimiter } from '../llm/rate-limiter.js';
import type { RateLimiter } from '../llm/rate-limiter.js';
import { TaskManager } from '../swarm/task-manager.js';
import { saveCheckpoint } from '../swarm/checkpoint.js';
import { runWorker } from './worker.js';
import { ui } from '../cli/ui.js';
import { messageBus } from '../swarm/message-bus.js';

const ORCHESTRATOR_SYSTEM_PROMPT = `You are the Orchestrator of a multi-agent coding swarm. You manage a team of 3 worker agents that can read/write files, execute commands, and search code.

Your responsibilities:
1. Break down the user's task into concrete subtasks
2. Assign subtasks to workers
3. Review worker output and iterate until the project is complete

IMPORTANT: You must respond ONLY with valid JSON. No markdown, no code fences, no extra text.

When planning, respond with this exact JSON format:
{
  "subtasks": [
    {
      "title": "Short task title",
      "description": "Detailed instructions for the worker. Be specific about what files to create, what code to write, etc.",
      "dependencies": []
    }
  ]
}

Dependencies should be indices (0-based) of subtasks that must complete first. For example, if subtask 2 depends on subtask 0, use "dependencies": ["0"].

Guidelines for planning:
- Create 2-8 subtasks (not too many, not too few)
- Each subtask should be self-contained enough for one worker
- Order them logically with dependencies
- Be very specific in descriptions - workers are coding agents that need clear instructions
- Include setup tasks (package.json, configs) as early subtasks if needed
- Avoid assigning subtasks that modify the same files to run concurrently`;

const REVIEW_PROMPT = `Review the worker results below. For each completed subtask, decide whether to:
- "accept": The work is satisfactory
- "revise": The work needs changes (provide specific feedback)
- "reassign": The work should be redone by a different worker

Respond with ONLY this JSON format:
{
  "decisions": [
    {
      "subtaskId": "the-subtask-id",
      "verdict": "accept",
      "feedback": null
    }
  ]
}`;

const FINAL_REVIEW_PROMPT = `All subtasks are marked as completed. Review the overall project state below.

If the project is truly complete, respond with:
{
  "status": "done",
  "summary": "Brief description of what was built"
}

If more work is needed, respond with:
{
  "status": "needs_more",
  "summary": "What's still missing",
  "additionalSubtasks": [
    {
      "title": "...",
      "description": "...",
      "dependencies": []
    }
  ]
}

Respond with ONLY valid JSON.`;

const CHAT_SYSTEM_PROMPT = `You are the Orchestrator of a multi-agent coding swarm. The user is chatting with you about the current project.

You can see the project's current state below. Answer questions, explain decisions, and provide insight into the project's progress. Respond in natural, conversational language (NOT JSON).

If the user requests changes or new features for the project, respond with a JSON block that plans new subtasks:
{
  "action": "add_subtasks",
  "subtasks": [
    { "title": "...", "description": "...", "dependencies": [] }
  ]
}

If the user is just asking a question or chatting, respond in plain text. Only use JSON when they explicitly want changes made to the project.`;

// --- Chat state ---

let chatMessages: ChatMessage[] = [];

function getChatContextBlock(ctx: ProjectContext): string {
  const total = ctx.subtasks.length;
  const completed = ctx.subtasks.filter(t => t.status === 'completed').length;
  const failed = ctx.subtasks.filter(t => t.status === 'failed').length;
  const pending = ctx.subtasks.filter(t => t.status === 'pending').length;
  const inProgress = ctx.subtasks.filter(t => t.status === 'in_progress').length;

  const subtaskLines = ctx.subtasks.map((s, i) => {
    const icon = s.status === 'completed' ? '[DONE]' : s.status === 'failed' ? '[FAIL]' : s.status === 'in_progress' ? '[WORK]' : '[PEND]';
    return `  ${icon} ${i + 1}. ${s.title}${s.result ? ' — ' + s.result.slice(0, 100) : ''}`;
  }).join('\n');

  return `PROJECT: ${ctx.taskDescription}
DIRECTORY: ${ctx.rootDir}
PROGRESS: ${completed}/${total} done, ${inProgress} working, ${pending} pending, ${failed} failed

SUBTASKS:
${subtaskLines}`;
}

export function resetChat(): void {
  chatMessages = [];
}

export async function chatWithOrchestrator(
  ctx: ProjectContext,
  userMessage: string,
  serverMode: string,
): Promise<{ reply: string; newSubtasks?: TaskPlan['subtasks'] }> {
  // Build fresh system context each time so state is current
  const systemContent = `${CHAT_SYSTEM_PROMPT}\n\n--- CURRENT PROJECT STATE ---\n${getChatContextBlock(ctx)}\n\nServer mode: ${serverMode}`;

  if (chatMessages.length === 0 || (chatMessages[0] as any).role !== 'system') {
    chatMessages = [{ role: 'system', content: systemContent }];
  } else {
    chatMessages[0] = { role: 'system', content: systemContent };
  }

  chatMessages.push({ role: 'user', content: userMessage });

  // Trim chat history to last 20 messages + system
  if (chatMessages.length > 21) {
    chatMessages = [chatMessages[0]!, ...chatMessages.slice(-20)];
  }

  const response = await chatCompletion(chatMessages, undefined, {
    temperature: 0.4,
    maxTokens: 2048,
  });

  const reply = response.choices[0]?.message?.content ?? '';
  chatMessages.push({ role: 'assistant', content: reply });

  // Check if the reply contains a subtask plan (for change requests)
  const parsed = parseJSON<{ action: string; subtasks: TaskPlan['subtasks'] }>(reply);
  if (parsed?.action === 'add_subtasks' && parsed.subtasks?.length) {
    return { reply, newSubtasks: parsed.subtasks };
  }

  return { reply };
}

// --- Continue project (post-completion change requests) ---

export async function continueProject(
  ctx: ProjectContext,
  changeRequest: string,
  maxIterations?: number,
): Promise<void> {
  // Re-enter the orchestrator loop with additional subtasks
  const taskManager = new TaskManager(ctx);

  const workerRateLimiters: Map<number, RateLimiter> = new Map();
  for (let i = 0; i < 3; i++) {
    workerRateLimiters.set(i, createWorkerRateLimiter());
  }

  // Rebuild orchestrator messages with continuation context
  ctx.orchestratorMessages = [
    { role: 'system', content: ORCHESTRATOR_SYSTEM_PROMPT },
  ];

  const statusSummary = taskManager.getStatusSummary();

  messageBus.emit('orchestrator:phase', { phase: 'executing' });
  ui.showOrchestratorThinking('Planning changes...');

  const planResponse = await askOrchestrator(
    ctx,
    `[CONTINUATION]\nOriginal task: ${ctx.taskDescription}\n\nCurrent project state:\n${statusSummary}\n\nThe user has requested additional changes:\n${changeRequest}\n\nBreak these changes into new subtasks. Existing completed subtasks should NOT be repeated.`,
  );

  const plan = parseJSON<TaskPlan>(planResponse);

  if (!plan || !plan.subtasks || plan.subtasks.length === 0) {
    ui.stopSpinner();
    messageBus.emit('project:error', { message: 'Orchestrator could not plan changes.' });
    return;
  }

  taskManager.addMoreSubtasks(plan.subtasks);
  ui.showPlan(ctx.subtasks);
  messageBus.emit('orchestrator:plan', { subtasks: ctx.subtasks });
  saveCheckpoint(ctx);

  // Run the main loop for the new subtasks
  const iterationLimit = maxIterations ?? 50;

  for (let iteration = 0; iteration < iterationLimit; iteration++) {
    const ready = taskManager.getReadySubtasks();

    if (ready.length === 0 && taskManager.allCompleted()) {
      messageBus.emit('orchestrator:phase', { phase: 'final_review' });
      ui.showOrchestratorThinking('Final review...');

      const statusSummary = taskManager.getStatusSummary();
      const finalResponse = await askOrchestrator(
        ctx,
        `${FINAL_REVIEW_PROMPT}\n\nProject status:\n${statusSummary}`,
      );

      const finalReview = parseJSON<FinalReview>(finalResponse);

      if (finalReview?.status === 'done') {
        saveCheckpoint(ctx);
        messageBus.emit('project:done', { summary: finalReview.summary, projectDir: ctx.rootDir });
        ui.showCompletion(finalReview.summary, ctx.rootDir);
        ui.showTokenStats(tokenTracker.getStats());
        return;
      }

      if (finalReview?.status === 'needs_more' && finalReview.additionalSubtasks) {
        taskManager.addMoreSubtasks(finalReview.additionalSubtasks);
        ui.showPlan(ctx.subtasks);
        saveCheckpoint(ctx);
        continue;
      }

      saveCheckpoint(ctx);
      ui.showCompletion(finalResponse.slice(0, 200), ctx.rootDir);
      ui.showTokenStats(tokenTracker.getStats());
      return;
    }

    if (ready.length === 0) {
      if (taskManager.anyFailed()) {
        ui.showError('Some subtasks failed after max attempts. Stopping.');
        saveCheckpoint(ctx);
        ui.showTokenStats(tokenTracker.getStats());
        return;
      }
      ui.showError('No subtasks are ready and not all completed. Possible dependency deadlock.');
      saveCheckpoint(ctx);
      return;
    }

    const batch = ready.slice(0, 3);
    const assignments = batch.map((subtask, i) => {
      subtask.status = 'in_progress';
      subtask.assignedWorker = i;
      return { workerIndex: i, subtask };
    });

    messageBus.emit('orchestrator:phase', { phase: 'dispatching' });
    for (const { workerIndex, subtask } of assignments) {
      messageBus.emit('subtask:assigned', { subtaskId: subtask.id, title: subtask.title, workerIndex });
    }
    ui.showDispatching(assignments);

    const settledResults = await Promise.allSettled(
      assignments.map(({ workerIndex, subtask }) =>
        runWorker(workerIndex, subtask, ctx, workerRateLimiters.get(workerIndex)!),
      ),
    );

    const results: WorkerResult[] = settledResults.map((settled, i) => {
      if (settled.status === 'fulfilled') return settled.value;
      return {
        subtaskId: assignments[i]!.subtask.id,
        status: 'failed' as const,
        summary: `Worker crashed: ${settled.reason}`,
        artifacts: [],
        error: String(settled.reason),
      };
    });

    ui.showWorkerResults(results);

    for (const result of results) {
      messageBus.emit('subtask:completed', {
        subtaskId: result.subtaskId,
        status: result.status,
        summary: result.summary,
        artifacts: result.artifacts,
      });
      taskManager.applyWorkerResult(result);
    }

    saveCheckpoint(ctx);

    messageBus.emit('orchestrator:phase', { phase: 'reviewing' });
    ui.showOrchestratorThinking('Reviewing results...');

    const reviewStatus = taskManager.getStatusSummary();
    const reviewInput = results
      .map((r) => `Subtask ${r.subtaskId}:\n  Status: ${r.status}\n  Summary: ${r.summary}\n  Files: ${r.artifacts.join(', ') || 'none'}`)
      .join('\n\n');

    const reviewResponse = await askOrchestrator(
      ctx,
      `${REVIEW_PROMPT}\n\nWorker results:\n${reviewInput}\n\nOverall status:\n${reviewStatus}`,
    );

    const review = parseJSON<{ decisions: ReviewDecision[] }>(reviewResponse);

    if (review?.decisions) {
      taskManager.applyReviewDecisions(review.decisions);
      messageBus.emit('orchestrator:review', { decisions: review.decisions });
      ui.showReview(review.decisions);
    }

    saveCheckpoint(ctx);

    const total = ctx.subtasks.length;
    const completed = ctx.subtasks.filter((t) => t.status === 'completed').length;
    const pending = ctx.subtasks.filter((t) => t.status === 'pending').length;
    const failed = ctx.subtasks.filter((t) => t.status === 'failed').length;
    messageBus.emit('orchestrator:iteration', { iteration: iteration + 1, total, completed, pending, failed });
    ui.showIterationSummary(iteration, total, completed, pending, failed);

    const ctxStats = getContextStats(ctx.orchestratorMessages);
    if (ctxStats.budgetUsedPercent > 50) {
      ui.showContextStats(ctxStats);
    }
  }

  saveCheckpoint(ctx);
  ui.showMaxIterationsReached();
  ui.showTokenStats(tokenTracker.getStats());
}

// --- Original orchestrator run ---

async function askOrchestrator(
  ctx: ProjectContext,
  userMessage: string,
  maxJsonRetries = 2
): Promise<string> {
  ctx.orchestratorMessages.push({ role: 'user', content: userMessage });

  // Manage context window before each call
  ctx.orchestratorMessages = await manageContext(ctx.orchestratorMessages);

  for (let attempt = 0; attempt <= maxJsonRetries; attempt++) {
    const response = await chatCompletion(ctx.orchestratorMessages, undefined, {
      temperature: 0.2,
      maxTokens: 4096,
    });

    const content = response.choices[0]?.message?.content ?? '';

    if (attempt < maxJsonRetries && content.trim() === '') {
      continue;
    }

    // If the response isn't valid JSON and we have retries left, ask again
    if (attempt < maxJsonRetries && !parseJSON(content)) {
      ctx.orchestratorMessages.push({ role: 'assistant', content });
      ctx.orchestratorMessages.push({
        role: 'user',
        content: 'Your response was not valid JSON. Please respond with ONLY valid JSON, no other text.',
      });
      continue;
    }

    ctx.orchestratorMessages.push({ role: 'assistant', content });
    return content;
  }

  return '';
}

export async function runOrchestrator(
  ctx: ProjectContext,
  maxIterations?: number
): Promise<void> {
  const iterationLimit = maxIterations ?? 50;
  const taskManager = new TaskManager(ctx);

  // Create dedicated rate limiters for each worker (0, 1, 2) to enable parallel execution
  const workerRateLimiters: Map<number, RateLimiter> = new Map();
  for (let i = 0; i < 3; i++) {
    workerRateLimiters.set(i, createWorkerRateLimiter());
  }

  // If resuming from checkpoint, skip planning if subtasks exist
  const isResume = ctx.subtasks.length > 0;

  ctx.orchestratorMessages = [
    { role: 'system', content: ORCHESTRATOR_SYSTEM_PROMPT },
  ];

  if (isResume) {
    const statusSummary = taskManager.getStatusSummary();
    ctx.orchestratorMessages.push({
      role: 'user',
      content: `[RESUMED FROM CHECKPOINT]\nOriginal task: ${ctx.taskDescription}\n\nCurrent state:\n${statusSummary}\n\nContinue from where we left off. Review the current state and dispatch remaining subtasks.`,
    });
    ctx.orchestratorMessages.push({
      role: 'assistant',
      content: JSON.stringify({ status: 'resumed', message: 'Continuing from checkpoint.' }),
    });
    ui.showPlan(ctx.subtasks);
  } else {
    // PHASE 1: PLAN
    ui.showOrchestratorThinking('Breaking down task...');

    const planResponse = await askOrchestrator(
      ctx,
      `Break this task into subtasks:\n\n${ctx.taskDescription}`
    );

    const plan = parseJSON<TaskPlan>(planResponse);

    if (!plan || !plan.subtasks || plan.subtasks.length === 0) {
      ui.stopSpinner();
      ui.showError('Orchestrator failed to create a plan. Response:\n' + planResponse.slice(0, 500));
      return;
    }

    taskManager.addSubtasksFromPlan(plan);
    ui.showPlan(ctx.subtasks);
    messageBus.emit('orchestrator:plan', { subtasks: ctx.subtasks });
  }

  messageBus.emit('orchestrator:phase', { phase: 'executing' });
  saveCheckpoint(ctx);

  // MAIN LOOP
  for (let iteration = 0; iteration < iterationLimit; iteration++) {
    const ready = taskManager.getReadySubtasks();

    // Check if we're done
    if (ready.length === 0 && taskManager.allCompleted()) {
      messageBus.emit('orchestrator:phase', { phase: 'final_review' });
      ui.showOrchestratorThinking('Final review...');

      const statusSummary = taskManager.getStatusSummary();
      const finalResponse = await askOrchestrator(
        ctx,
        `${FINAL_REVIEW_PROMPT}\n\nProject status:\n${statusSummary}`
      );

      const finalReview = parseJSON<FinalReview>(finalResponse);

      if (finalReview?.status === 'done') {
        saveCheckpoint(ctx);
        messageBus.emit('project:done', { summary: finalReview.summary, projectDir: ctx.rootDir });
        ui.showCompletion(finalReview.summary, ctx.rootDir);
        ui.showTokenStats(tokenTracker.getStats());
        return;
      }

      if (finalReview?.status === 'needs_more' && finalReview.additionalSubtasks) {
        taskManager.addMoreSubtasks(finalReview.additionalSubtasks);
        ui.showPlan(ctx.subtasks);
        saveCheckpoint(ctx);
        continue;
      }

      saveCheckpoint(ctx);
      ui.showCompletion(finalResponse.slice(0, 200), ctx.rootDir);
      ui.showTokenStats(tokenTracker.getStats());
      return;
    }

    // Deadlock check
    if (ready.length === 0) {
      if (taskManager.anyFailed()) {
        ui.showError('Some subtasks failed after max attempts. Stopping.');
        saveCheckpoint(ctx);
        ui.showTokenStats(tokenTracker.getStats());
        return;
      }
      ui.showError('No subtasks are ready and not all completed. Possible dependency deadlock.');
      saveCheckpoint(ctx);
      return;
    }

    // PHASE 2: DISPATCH
    const batch = ready.slice(0, 3);
    const assignments = batch.map((subtask, i) => {
      subtask.status = 'in_progress';
      subtask.assignedWorker = i;
      return { workerIndex: i, subtask };
    });

    messageBus.emit('orchestrator:phase', { phase: 'dispatching' });
    for (const { workerIndex, subtask } of assignments) {
      messageBus.emit('subtask:assigned', { subtaskId: subtask.id, title: subtask.title, workerIndex });
    }
    ui.showDispatching(assignments);

    const settledResults = await Promise.allSettled(
      assignments.map(({ workerIndex, subtask }) =>
        runWorker(workerIndex, subtask, ctx, workerRateLimiters.get(workerIndex)!)
      )
    );

    const results: WorkerResult[] = settledResults.map((settled, i) => {
      if (settled.status === 'fulfilled') {
        return settled.value;
      }
      return {
        subtaskId: assignments[i]!.subtask.id,
        status: 'failed' as const,
        summary: `Worker crashed: ${settled.reason}`,
        artifacts: [],
        error: String(settled.reason),
      };
    });

    ui.showWorkerResults(results);

    for (const result of results) {
      messageBus.emit('subtask:completed', {
        subtaskId: result.subtaskId,
        status: result.status,
        summary: result.summary,
        artifacts: result.artifacts,
      });
      taskManager.applyWorkerResult(result);
    }

    saveCheckpoint(ctx);

    // PHASE 3: REVIEW
    messageBus.emit('orchestrator:phase', { phase: 'reviewing' });
    ui.showOrchestratorThinking('Reviewing results...');

    const statusSummary = taskManager.getStatusSummary();
    const reviewInput = results
      .map((r) => `Subtask ${r.subtaskId}:\n  Status: ${r.status}\n  Summary: ${r.summary}\n  Files: ${r.artifacts.join(', ') || 'none'}`)
      .join('\n\n');

    const reviewResponse = await askOrchestrator(
      ctx,
      `${REVIEW_PROMPT}\n\nWorker results:\n${reviewInput}\n\nOverall status:\n${statusSummary}`
    );

    const review = parseJSON<{ decisions: ReviewDecision[] }>(reviewResponse);

    if (review?.decisions) {
      taskManager.applyReviewDecisions(review.decisions);
      messageBus.emit('orchestrator:review', { decisions: review.decisions });
      ui.showReview(review.decisions);
    }

    saveCheckpoint(ctx);

    const total = ctx.subtasks.length;
    const completed = ctx.subtasks.filter((t) => t.status === 'completed').length;
    const pending = ctx.subtasks.filter((t) => t.status === 'pending').length;
    const failed = ctx.subtasks.filter((t) => t.status === 'failed').length;
    messageBus.emit('orchestrator:iteration', { iteration: iteration + 1, total, completed, pending, failed });
    ui.showIterationSummary(iteration, total, completed, pending, failed);

    // Show context stats when usage is getting high
    const ctxStats = getContextStats(ctx.orchestratorMessages);
    if (ctxStats.budgetUsedPercent > 50) {
      ui.showContextStats(ctxStats);
    }
  }

  saveCheckpoint(ctx);
  ui.showMaxIterationsReached();
  ui.showTokenStats(tokenTracker.getStats());
}

import { EventEmitter } from 'node:events';

// Central event bus for UI observation.
// Events:
//   'orchestrator:phase'     { phase: 'executing'|'dispatching'|'reviewing'|'final_review' }
//   'orchestrator:plan'      { subtasks }
//   'orchestrator:review'    { decisions }
//   'orchestrator:iteration' { iteration, total, completed, pending, failed }
//   'subtask:assigned'       { subtaskId, title, workerIndex }
//   'subtask:progress'       { subtaskId, workerIndex, step, toolName }
//   'subtask:completed'      { subtaskId, status, summary, artifacts }
//   'worker:token'           { workerIndex, token }
//   'file:written'           { path, workerIndex }
//   'project:done'           { summary, projectDir }
//   'rate-limit:wait'        { waitMs }
//   'llm:retry'              { attempt, maxRetries, delayMs, error }
//   'tokens:update'          { promptTokens, completionTokens, totalTokens, callCount }
//   'chat:response'          { reply }
//   'chat:error'             { error }
//   'deploy:started'         { repoName }
//   'deploy:complete'        { repoUrl, pagesUrl, repoName }
//   'deploy:failed'          { error }
//   'deploy:warning'         { message }

export const messageBus = new EventEmitter();

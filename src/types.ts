import type OpenAI from 'openai';

export type SubtaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'needs_revision';

export interface Subtask {
  id: string;
  title: string;
  description: string;
  dependencies: string[];
  assignedWorker: number | null;
  status: SubtaskStatus;
  result: string | null;
  artifacts: string[];
  attempts: number;
  feedback: string | null;
}

export interface ProjectContext {
  id: string;
  rootDir: string;
  taskDescription: string;
  subtasks: Subtask[];
  orchestratorMessages: ChatMessage[];
  /** Structured map of existing project files, set during pre-planning analysis */
  projectFileTree?: string;
}

export type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export interface WorkerResult {
  subtaskId: string;
  status: 'completed' | 'failed';
  summary: string;
  artifacts: string[];
  error?: string;
}

export interface TaskPlan {
  subtasks: Array<{
    title: string;
    description: string;
    dependencies: string[];
  }>;
}

export interface ReviewDecision {
  subtaskId: string;
  verdict: 'accept' | 'revise' | 'reassign';
  feedback?: string;
}

export interface FinalReview {
  status: 'done' | 'needs_more';
  summary: string;
  additionalSubtasks?: Array<{
    title: string;
    description: string;
    dependencies: string[];
  }>;
}

export type ToolDefinition = OpenAI.Chat.Completions.ChatCompletionTool;

export interface ChatEntry {
  role: 'user' | 'orchestrator' | 'system';
  content: string;
  ts: number;
}

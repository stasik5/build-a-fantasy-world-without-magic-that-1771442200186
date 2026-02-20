import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ProjectContext } from '../types.js';
import { messageBus } from '../swarm/message-bus.js';
import { tokenTracker } from '../llm/token-tracker.js';
import { getRuntimeConfig, updateRuntimeConfig, saveSettingsToEnv, getMaskedSettings } from '../runtime-config.js';
import { CONFIG } from '../config.js';
import { createProjectDir } from '../swarm/project-manager.js';
import { loadCheckpoint } from '../swarm/checkpoint.js';
import { rateLimiter } from '../llm/rate-limiter.js';
import {
  createPlannerState,
  processPlannerMessage,
  buildPlanningContext,
  type PlannerState,
} from '../swarm/planner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let projectContext: ProjectContext | null = null;
let wss: WebSocketServer | null = null;
let serverMode: 'idle' | 'running' | 'completed' | 'failed' | 'planning' = 'idle';

// Planner state for interactive planning mode
let plannerState: PlannerState | null = null;

// Deploy state
let deployResult: { repoUrl?: string; pagesUrl?: string } | null = null;

// Project registry - tracks all built projects including those outside PROJECTS_ROOT
const REGISTRY_PATH = path.join(CONFIG.PROJECTS_ROOT, '.project-registry.json');

interface RegistryEntry {
  dirName: string;
  fullPath: string;
  taskDescription: string;
  lastBuiltAt: string;
  source: 'planner' | 'direct';
}

function loadProjectRegistry(): RegistryEntry[] {
  try {
    if (fs.existsSync(REGISTRY_PATH)) {
      return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8'));
    }
  } catch { /* ignore */ }
  return [];
}

function saveProjectRegistry(registry: RegistryEntry[]): void {
  try {
    if (!fs.existsSync(CONFIG.PROJECTS_ROOT)) {
      fs.mkdirSync(CONFIG.PROJECTS_ROOT, { recursive: true });
    }
    fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2));
  } catch { /* ignore */ }
}

function addToRegistry(projectDir: string, taskDescription: string, source: 'planner' | 'direct'): void {
  const registry = loadProjectRegistry();
  const dirName = path.basename(projectDir);
  const existingIdx = registry.findIndex(e => e.fullPath === projectDir);

  const entry: RegistryEntry = {
    dirName,
    fullPath: projectDir,
    taskDescription,
    lastBuiltAt: new Date().toISOString(),
    source,
  };

  if (existingIdx >= 0) {
    registry[existingIdx] = entry;
  } else {
    registry.unshift(entry); // Add to front
  }

  // Keep only last 100 projects
  saveProjectRegistry(registry.slice(0, 100));
}

function removeFromRegistry(projectDir: string): void {
  const registry = loadProjectRegistry();
  const filtered = registry.filter(e => e.fullPath !== projectDir);
  saveProjectRegistry(filtered);
}

function deleteProject(projectDir: string): { success: boolean; error?: string } {
  try {
    // Safety check: only allow deleting within PROJECTS_ROOT or known registry paths
    const registry = loadProjectRegistry();
    const isInRegistry = registry.some(e => e.fullPath === projectDir);
    const isInProjectsRoot = projectDir.startsWith(CONFIG.PROJECTS_ROOT);

    if (!isInRegistry && !isInProjectsRoot) {
      return { success: false, error: 'Can only delete projects in the projects folder or created via planner' };
    }

    // Stop any running backend for this project
    stopBackend(projectDir);

    // Remove directory
    if (fs.existsSync(projectDir)) {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }

    // Remove from registry
    removeFromRegistry(projectDir);

    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// Backend preview state
interface BackendProcess {
  process: ChildProcess;
  projectDir: string;
  projectName: string;
  port: number;
  type: string;
  logs: string[];
  ready: boolean;
}
const activeBackends: Map<string, BackendProcess> = new Map();
const backendsByProjectName: Map<string, BackendProcess> = new Map(); // Quick lookup by project name
let nextBackendPort = 3100;

// Batch worker:token events to avoid flooding
let pendingTokens = 0;
let tokenFlushTimer: ReturnType<typeof setTimeout> | null = null;

// --- Broadcasting ---

function broadcastEvent(event: string, data: unknown): void {
  if (!wss) return;
  const msg = JSON.stringify({ event, data, ts: Date.now() });
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(msg);
    }
  }
}

function sendTo(ws: WebSocket, event: string, data: unknown): void {
  ws.send(JSON.stringify({ event, data, ts: Date.now() }));
}

function flushTokens(): void {
  if (pendingTokens > 0) {
    broadcastEvent('worker:tokens', { count: pendingTokens });
    pendingTokens = 0;
  }
  tokenFlushTimer = null;
}

// --- State ---

function getStateSnapshot(): object {
  if (!projectContext) {
    return { status: 'idle', mode: serverMode };
  }
  return {
    status: serverMode,
    mode: serverMode,
    id: projectContext.id,
    rootDir: projectContext.rootDir,
    taskDescription: projectContext.taskDescription,
    subtasks: projectContext.subtasks,
    tokenStats: tokenTracker.getStats(),
    deployResult,
  };
}

function getFileList(): string[] {
  if (!projectContext) return [];
  const files: string[] = [];
  function walk(dir: string, prefix: string): void {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walk(path.join(dir, entry.name), rel);
        } else {
          files.push(rel);
        }
      }
    } catch { /* ignore */ }
  }
  walk(projectContext.rootDir, '');
  return files;
}

function readProjectFile(filePath: string): string | null {
  if (!projectContext) return null;
  const resolved = path.resolve(projectContext.rootDir, filePath);
  if (!resolved.startsWith(projectContext.rootDir)) return null;
  try {
    return fs.readFileSync(resolved, 'utf-8');
  } catch {
    return null;
  }
}

// --- Project Management ---

interface ProjectSummary {
  dirName: string;
  fullPath: string;
  taskDescription: string;
  status: string;
  subtaskStats: { total: number; completed: number; failed: number };
  savedAt: string | null;
}

function listProjects(): ProjectSummary[] {
  const root = CONFIG.PROJECTS_ROOT;
  const seenPaths = new Set<string>();
  const results: ProjectSummary[] = [];

  // First, add projects from registry (includes external projects)
  const registry = loadProjectRegistry();
  for (const entry of registry) {
    if (fs.existsSync(entry.fullPath)) {
      const checkpointPath = path.join(entry.fullPath, '.swarm-checkpoint.json');
      let status = 'unknown';
      let savedAt: string | null = entry.lastBuiltAt;
      const subtaskStats = { total: 0, completed: 0, failed: 0 };

      if (fs.existsSync(checkpointPath)) {
        try {
          const data = JSON.parse(fs.readFileSync(checkpointPath, 'utf-8'));
          savedAt = data.savedAt || entry.lastBuiltAt;
          const subtasks = data.subtasks || [];
          subtaskStats.total = subtasks.length;
          subtaskStats.completed = subtasks.filter((s: any) => s.status === 'completed').length;
          subtaskStats.failed = subtasks.filter((s: any) => s.status === 'failed').length;

          if (subtaskStats.total > 0 && subtaskStats.completed === subtaskStats.total) {
            status = 'completed';
          } else if (subtaskStats.failed > 0) {
            status = 'partial';
          } else {
            status = 'in-progress';
          }
        } catch {
          status = 'corrupted';
        }
      } else {
        status = 'completed'; // Assume completed if no checkpoint
      }

      results.push({
        dirName: entry.dirName,
        fullPath: entry.fullPath,
        taskDescription: entry.taskDescription,
        status,
        subtaskStats,
        savedAt,
      });
      seenPaths.add(entry.fullPath);
    }
  }

  // Then, scan PROJECTS_ROOT for any projects not in registry
  if (fs.existsSync(root)) {
    const dirs = fs.readdirSync(root, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name !== '.')
      .sort((a, b) => b.name.localeCompare(a.name));

    for (const d of dirs) {
      const fullPath = path.join(root, d.name);
      if (seenPaths.has(fullPath)) continue; // Already in results from registry

      const checkpointPath = path.join(fullPath, '.swarm-checkpoint.json');
      let status = 'unknown';
      let taskDescription = '';
      let savedAt: string | null = null;
      const subtaskStats = { total: 0, completed: 0, failed: 0 };

      if (fs.existsSync(checkpointPath)) {
        try {
          const data = JSON.parse(fs.readFileSync(checkpointPath, 'utf-8'));
          taskDescription = data.taskDescription || '';
          savedAt = data.savedAt || null;
          const subtasks = data.subtasks || [];
          subtaskStats.total = subtasks.length;
          subtaskStats.completed = subtasks.filter((s: any) => s.status === 'completed').length;
          subtaskStats.failed = subtasks.filter((s: any) => s.status === 'failed').length;

          if (subtaskStats.total > 0 && subtaskStats.completed === subtaskStats.total) {
            status = 'completed';
          } else if (subtaskStats.failed > 0) {
            status = 'partial';
          } else {
            status = 'in-progress';
          }
        } catch {
          status = 'corrupted';
        }
      }

      results.push({ dirName: d.name, fullPath, taskDescription, status, subtaskStats, savedAt });
    }
  }

  // Sort by savedAt (most recent first)
  return results.sort((a, b) => {
    const aTime = a.savedAt ? new Date(a.savedAt).getTime() : 0;
    const bTime = b.savedAt ? new Date(b.savedAt).getTime() : 0;
    return bTime - aTime;
  });
}

async function startProject(task: string, maxIterations?: number, existingDir?: string): Promise<void> {
  if (serverMode === 'running') {
    broadcastEvent('project:error', { message: 'A project is already running.' });
    return;
  }

  const cfg = getRuntimeConfig();
  if (!cfg.ZAI_API_KEY) {
    broadcastEvent('project:error', { message: 'API key not set. Configure it in Settings first.' });
    return;
  }

  const iterations = maxIterations ?? cfg.MAX_ORCHESTRATOR_ITERATIONS;

  let projectDir: string;
  if (existingDir) {
    projectDir = path.resolve(existingDir);
    if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
      broadcastEvent('project:error', { message: `Directory does not exist: ${projectDir}` });
      return;
    }
  } else {
    projectDir = await createProjectDir(task);
  }
  const ctx: ProjectContext = {
    id: crypto.randomUUID(),
    rootDir: projectDir,
    taskDescription: task,
    subtasks: [],
    orchestratorMessages: [],
  };

  projectContext = ctx;
  deployResult = null;
  tokenTracker.reset();
  serverMode = 'running';
  broadcastEvent('server:status', { mode: 'running' });
  broadcastEvent('project:created', { id: ctx.id, rootDir: ctx.rootDir, task });
  broadcastEvent('state:snapshot', getStateSnapshot());

  // Reset chat state for the new project
  const { resetChat } = await import('../agents/orchestrator.js');
  resetChat();

  // Import and run orchestrator non-blocking
  const { runOrchestrator } = await import('../agents/orchestrator.js');
  runOrchestrator(ctx, iterations)
    .then(async () => {
      serverMode = 'completed';
      broadcastEvent('server:status', { mode: 'completed' });

      // Auto-deploy to GitHub Pages if enabled
      const cfg = getRuntimeConfig();
      if (cfg.AUTO_DEPLOY_GITHUB_PAGES && cfg.GITHUB_PAT && cfg.GITHUB_USERNAME) {
        await triggerDeploy();
      }
    })
    .catch((err: any) => {
      serverMode = 'failed';
      broadcastEvent('server:status', { mode: 'failed' });
      broadcastEvent('project:error', { message: `Orchestrator error: ${err.message}` });
    });
}

async function resumeProject(dirPath: string): Promise<void> {
  if (serverMode === 'running') {
    broadcastEvent('project:error', { message: 'A project is already running.' });
    return;
  }

  const cfg = getRuntimeConfig();
  if (!cfg.ZAI_API_KEY) {
    broadcastEvent('project:error', { message: 'API key not set. Configure it in Settings first.' });
    return;
  }

  const ctx = loadCheckpoint(dirPath);
  if (!ctx) {
    broadcastEvent('project:error', { message: `No checkpoint found at: ${dirPath}` });
    return;
  }

  projectContext = ctx;
  deployResult = null;
  tokenTracker.reset();
  serverMode = 'running';
  broadcastEvent('server:status', { mode: 'running' });
  broadcastEvent('project:created', { id: ctx.id, rootDir: ctx.rootDir, task: ctx.taskDescription });
  broadcastEvent('state:snapshot', getStateSnapshot());

  const { resetChat } = await import('../agents/orchestrator.js');
  resetChat();

  const { runOrchestrator } = await import('../agents/orchestrator.js');
  runOrchestrator(ctx, cfg.MAX_ORCHESTRATOR_ITERATIONS)
    .then(async () => {
      serverMode = 'completed';
      broadcastEvent('server:status', { mode: 'completed' });

      const cfg = getRuntimeConfig();
      if (cfg.AUTO_DEPLOY_GITHUB_PAGES && cfg.GITHUB_PAT && cfg.GITHUB_USERNAME) {
        await triggerDeploy();
      }
    })
    .catch((err: any) => {
      serverMode = 'failed';
      broadcastEvent('server:status', { mode: 'failed' });
      broadcastEvent('project:error', { message: `Orchestrator error: ${err.message}` });
    });
}

// View a project (load without running orchestrator)
function viewProject(dirPath: string): void {
  const ctx = loadCheckpoint(dirPath);
  if (!ctx) {
    broadcastEvent('project:error', { message: `No checkpoint found at: ${dirPath}` });
    return;
  }

  projectContext = ctx;
  deployResult = null;
  tokenTracker.reset();
  serverMode = 'completed'; // Mark as completed since we're just viewing
  broadcastEvent('server:status', { mode: 'completed' });
  broadcastEvent('project:viewed', { id: ctx.id, rootDir: ctx.rootDir, task: ctx.taskDescription, subtasks: ctx.subtasks });
  broadcastEvent('state:snapshot', getStateSnapshot());
  broadcastEvent('file:list', getFileList());
}

// --- Chat ---

async function handleChat(ws: WebSocket, message: string): Promise<void> {
  if (!projectContext) {
    sendTo(ws, 'chat:response', { reply: 'No project is active. Start or resume a project first.' });
    return;
  }

  broadcastEvent('chat:user', { message, ts: Date.now() });

  try {
    const { chatWithOrchestrator } = await import('../agents/orchestrator.js');
    const result = await chatWithOrchestrator(projectContext, message, serverMode);

    broadcastEvent('chat:response', { reply: result.reply, ts: Date.now() });

    // If the orchestrator planned new subtasks from the chat (change request)
    if (result.newSubtasks && result.newSubtasks.length > 0 && (serverMode === 'completed' || serverMode === 'failed')) {
      // Trigger continuation
      await handleContinue(message);
    }
  } catch (err: any) {
    broadcastEvent('chat:error', { error: err.message });
  }
}

// --- Continue project ---

async function handleContinue(changeRequest: string): Promise<void> {
  if (!projectContext) {
    broadcastEvent('project:error', { message: 'No project context available.' });
    return;
  }

  if (serverMode === 'running') {
    broadcastEvent('project:error', { message: 'Project is still running. Wait for completion.' });
    return;
  }

  const cfg = getRuntimeConfig();
  if (!cfg.ZAI_API_KEY) {
    broadcastEvent('project:error', { message: 'API key not set.' });
    return;
  }

  deployResult = null;
  serverMode = 'running';
  broadcastEvent('server:status', { mode: 'running' });

  const { continueProject } = await import('../agents/orchestrator.js');
  continueProject(projectContext, changeRequest, cfg.MAX_ORCHESTRATOR_ITERATIONS)
    .then(async () => {
      serverMode = 'completed';
      broadcastEvent('server:status', { mode: 'completed' });

      const cfg = getRuntimeConfig();
      if (cfg.AUTO_DEPLOY_GITHUB_PAGES && cfg.GITHUB_PAT && cfg.GITHUB_USERNAME) {
        await triggerDeploy();
      }
    })
    .catch((err: any) => {
      serverMode = 'failed';
      broadcastEvent('server:status', { mode: 'failed' });
      broadcastEvent('project:error', { message: `Continue error: ${err.message}` });
    });
}

// --- Deploy ---

async function triggerDeploy(): Promise<void> {
  if (!projectContext) {
    broadcastEvent('deploy:failed', { error: 'No project context.' });
    return;
  }

  const dirName = path.basename(projectContext.rootDir);
  try {
    const { deployToGitHubPages } = await import('../deploy/github-pages.js');
    const result = await deployToGitHubPages(projectContext.rootDir, dirName);
    if (result.success) {
      deployResult = { repoUrl: result.repoUrl, pagesUrl: result.pagesUrl };
      broadcastEvent('deploy:complete', { repoUrl: result.repoUrl, pagesUrl: result.pagesUrl });
    } else {
      broadcastEvent('deploy:failed', { error: result.error });
    }
  } catch (err: any) {
    broadcastEvent('deploy:failed', { error: err.message });
  }
}

// --- HTTP Helpers ---

function parseBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function jsonResponse(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function serveStaticFile(res: http.ServerResponse, filePath: string): void {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.html': 'text/html',
    '.htm': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.mjs': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.eot': 'application/vnd.ms-fontobject',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
    '.webp': 'image/webp',
    '.webm': 'video/webm',
  };
  const contentType = mimeTypes[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': contentType });
  fs.createReadStream(filePath).pipe(res);
}

// --- Backend Preview Management ---

interface BackendInfo {
  type: 'node' | 'python' | 'static';
  command?: string;
  args?: string[];
  port?: number;
  startScript?: string;
  isVite?: boolean;
}

// Resolve project path - handles both URL paths (/projects/name) and full filesystem paths
function resolveProjectPath(projectDir: string): string {
  // If it's a URL-style path like "/projects/project-name", extract the name and resolve
  if (projectDir.startsWith('/projects/')) {
    const projectName = projectDir.slice('/projects/'.length);
    return path.join(CONFIG.PROJECTS_ROOT, projectName);
  }
  // Otherwise assume it's already a filesystem path
  return projectDir;
}

function detectBackend(projectDir: string): BackendInfo {
  // Check for package.json (Node.js)
  const packageJsonPath = path.join(projectDir, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      // Check if it's a Vite project
      const isVite = fs.existsSync(path.join(projectDir, 'vite.config.js')) ||
                     fs.existsSync(path.join(projectDir, 'vite.config.ts')) ||
                     pkg.devDependencies?.vite ||
                     pkg.dependencies?.vite;

      if (pkg.scripts?.start) {
        return { type: 'node', startScript: 'start', port: nextBackendPort, isVite };
      }
      if (pkg.scripts?.dev) {
        return { type: 'node', startScript: 'dev', port: nextBackendPort, isVite };
      }
      if (pkg.scripts?.serve) {
        return { type: 'node', startScript: 'serve', port: nextBackendPort, isVite };
      }
      // Check for common server files
      const serverFiles = ['server.js', 'app.js', 'index.js', 'main.js', 'server.ts', 'app.ts', 'index.ts', 'main.ts'];
      for (const file of serverFiles) {
        if (fs.existsSync(path.join(projectDir, file))) {
          return { type: 'node', command: 'node', args: [file], port: nextBackendPort };
        }
      }
    } catch { /* ignore */ }
  }

  // Check for Python
  const pythonFiles = ['app.py', 'main.py', 'server.py', 'run.py'];
  for (const file of pythonFiles) {
    if (fs.existsSync(path.join(projectDir, file))) {
      // Check for requirements.txt or venv
      const hasVenv = fs.existsSync(path.join(projectDir, 'venv', 'Scripts', 'python.exe')) ||
                      fs.existsSync(path.join(projectDir, 'venv', 'bin', 'python'));
      const pythonCmd = hasVenv
        ? (process.platform === 'win32' ? 'venv\\Scripts\\python.exe' : 'venv/bin/python')
        : 'python';
      return { type: 'python', command: pythonCmd, args: [file], port: nextBackendPort };
    }
  }

  // Check for requirements.txt without main files
  if (fs.existsSync(path.join(projectDir, 'requirements.txt'))) {
    return { type: 'python', command: 'python', args: ['-m', 'http.server', String(nextBackendPort)], port: nextBackendPort };
  }

  // Static site - just serve files
  return { type: 'static' };
}

function getBackendStatus(projectDir: string): { running: boolean; port?: number; url?: string; type: string; logs?: string[] } {
  const backend = activeBackends.get(projectDir);
  if (backend) {
    return {
      running: true,
      port: backend.port,
      url: `http://localhost:${backend.port}/`,
      type: backend.type,
      logs: backend.logs.slice(-50),
    };
  }
  const info = detectBackend(projectDir);
  return { running: false, type: info.type };
}

function startBackend(projectDir: string, projectName: string): { success: boolean; port?: number; error?: string } {
  // Stop existing backend for this project
  stopBackend(projectDir);

  const info = detectBackend(projectDir);
  if (info.type === 'static') {
    return { success: false, error: 'No backend detected - static site only' };
  }

  const port = nextBackendPort++;
  let cmd: string;
  let args: string[];
  const logs: string[] = [];

  if (info.type === 'node') {
    if (info.startScript) {
      cmd = 'npm';
      args = ['run', info.startScript];
      // For Vite projects, pass --port and --no-open flags
      if (info.isVite) {
        args.push('--', '--port', String(port), '--no-open');
      }
    } else {
      cmd = info.command || 'node';
      args = info.args || [];
    }
  } else if (info.type === 'python') {
    cmd = info.command || 'python';
    args = info.args || [];
  } else {
    return { success: false, error: 'Unknown backend type' };
  }

  try {
    const proc = spawn(cmd, args, {
      cwd: projectDir,
      env: { ...process.env, PORT: String(port) },
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.stdout?.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) logs.push(`[out] ${msg}`);
    });

    proc.stderr?.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) logs.push(`[err] ${msg}`);
    });

    proc.on('close', (code) => {
      logs.push(`Process exited with code ${code}`);
      activeBackends.delete(projectDir);
      backendsByProjectName.delete(projectName);
      broadcastEvent('backend:stopped', { projectDir });
    });

    proc.on('error', (err) => {
      logs.push(`Error: ${err.message}`);
    });

    const backendInfo: BackendProcess = {
      process: proc,
      projectDir,
      projectName,
      port,
      type: info.type,
      logs,
      ready: true, // Assume ready - user can refresh if needed
    };

    activeBackends.set(projectDir, backendInfo);
    backendsByProjectName.set(projectName, backendInfo);

    return { success: true, port };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

function stopBackend(projectDir: string): boolean {
  const backend = activeBackends.get(projectDir);
  if (backend) {
    backend.process.kill();
    activeBackends.delete(projectDir);
    backendsByProjectName.delete(backend.projectName);
    return true;
  }
  return false;
}

function stopAllBackends(): void {
  for (const [dir, backend] of activeBackends) {
    backend.process.kill();
  }
  activeBackends.clear();
}

// --- WebSocket Handler ---

async function handleClientMessage(ws: WebSocket, raw: string): Promise<void> {
  try {
    const msg = JSON.parse(raw);
    switch (msg.type) {
      case 'get:state':
        sendTo(ws, 'state:snapshot', getStateSnapshot());
        break;
      case 'get:files':
        sendTo(ws, 'file:list', getFileList());
        break;
      case 'get:file':
        if (msg.path) {
          const content = readProjectFile(msg.path);
          sendTo(ws, 'file:content', { path: msg.path, content });
        }
        break;
      case 'get:projects':
        sendTo(ws, 'project:list', listProjects());
        break;
      case 'create:project':
        if (msg.task) {
          startProject(msg.task, msg.maxIterations, msg.dir);
        }
        break;
      case 'resume:project':
        if (msg.dirPath) {
          resumeProject(msg.dirPath);
        }
        break;
      case 'view:project':
        if (msg.dirPath) {
          viewProject(msg.dirPath);
        }
        break;
      case 'delete:project':
        if (msg.dirPath) {
          const result = deleteProject(msg.dirPath);
          if (result.success) {
            broadcastEvent('project:list', listProjects());
          } else {
            sendTo(ws, 'delete:error', { error: result.error });
          }
        }
        break;
      case 'get:settings':
        sendTo(ws, 'settings:current', getMaskedSettings());
        break;
      case 'update:settings': {
        if (msg.settings) {
          updateRuntimeConfig(msg.settings);
          const cfg = getRuntimeConfig();
          rateLimiter.updateLimits(cfg.MAX_CONCURRENT, cfg.MAX_CALLS_PER_HOUR);
          if (msg.persist) {
            saveSettingsToEnv();
          }
          broadcastEvent('settings:updated', getMaskedSettings());
        }
        break;
      }
      case 'chat:send':
        if (msg.message) {
          handleChat(ws, msg.message);
        }
        break;
      case 'continue:project':
        if (msg.changeRequest) {
          handleContinue(msg.changeRequest);
        }
        break;
      case 'deploy:trigger':
        triggerDeploy();
        break;
      case 'backend:detect':
        if (msg.projectDir) {
          const resolvedPath = resolveProjectPath(msg.projectDir);
          const info = detectBackend(resolvedPath);
          sendTo(ws, 'backend:info', { projectDir: msg.projectDir, ...info, port: info.port || nextBackendPort });
        }
        break;
      case 'backend:start':
        if (msg.projectDir) {
          const resolvedPath = resolveProjectPath(msg.projectDir);
          const projectName = msg.projectDir.startsWith('/projects/')
            ? msg.projectDir.slice('/projects/'.length)
            : path.basename(msg.projectDir);
          const result = startBackend(resolvedPath, projectName);
          if (result.success) {
            const directUrl = `http://localhost:${result.port}/`;
            broadcastEvent('backend:started', { projectDir: msg.projectDir, projectName, port: result.port, url: directUrl });
          } else {
            sendTo(ws, 'backend:error', { projectDir: msg.projectDir, error: result.error });
          }
        }
        break;
      case 'backend:stop':
        if (msg.projectDir) {
          const resolvedPath = resolveProjectPath(msg.projectDir);
          stopBackend(resolvedPath);
          broadcastEvent('backend:stopped', { projectDir: msg.projectDir });
        }
        break;
      case 'backend:status':
        if (msg.projectDir) {
          const resolvedPath = resolveProjectPath(msg.projectDir);
          const status = getBackendStatus(resolvedPath);
          sendTo(ws, 'backend:status', { projectDir: msg.projectDir, ...status });
        }
        break;

      // --- Planner handlers ---
      case 'planner:start':
        plannerState = createPlannerState();
        serverMode = 'planning';
        broadcastEvent('server:status', { mode: 'planning' });
        sendTo(ws, 'planner:started', { state: plannerState });
        break;

      case 'planner:send':
        if (!plannerState) {
          // Auto-start planner if not already in planning mode
          plannerState = createPlannerState();
          serverMode = 'planning';
          broadcastEvent('server:status', { mode: 'planning' });
        }

        if (msg.message) {
          // Broadcast user message immediately
          broadcastEvent('planner:user', { message: msg.message, ts: Date.now() });

          // Process with planner
          try {
            const result = await processPlannerMessage(
              plannerState,
              msg.message,
              (token) => {
                // Stream tokens to clients
                broadcastEvent('planner:token', { token });
              },
              (toolName, toolResult) => {
                // Broadcast tool calls
                broadcastEvent('planner:tool', {
                  tool: toolName,
                  success: toolResult.success,
                  message: toolResult.message,
                  ts: Date.now(),
                });
              }
            );

            // Broadcast response
            broadcastEvent('planner:response', {
              response: result.response,
              state: {
                taskDescription: plannerState.taskDescription,
                projectDir: plannerState.projectDir,
                ready: plannerState.ready,
              },
              ts: Date.now(),
            });

            // If build is ready, transition
            if (plannerState.ready && plannerState.taskDescription) {
              const planningContext = buildPlanningContext(plannerState);
              // Store for later use when starting project
              (plannerState as any).planningContext = planningContext;
              broadcastEvent('planner:ready', {
                taskDescription: plannerState.taskDescription,
                projectDir: plannerState.projectDir,
                planningContext,
              });
            }
          } catch (err: any) {
            broadcastEvent('planner:error', { error: err.message });
          }
        }
        break;

      case 'planner:build':
        if (!plannerState || !plannerState.taskDescription) {
          sendTo(ws, 'planner:error', { error: 'No task description set' });
          break;
        }

        // Start the project with planning context
        const pState = plannerState;
        plannerState = null; // Clear planner state

        await startProject(
          pState.taskDescription,
          msg.maxIterations || getRuntimeConfig().MAX_ORCHESTRATOR_ITERATIONS,
          pState.projectDir || undefined
        );

        // Set planning context on the project context
        if (projectContext && (pState as any).planningContext) {
          projectContext.planningContext = (pState as any).planningContext;
        }
        break;

      case 'planner:cancel':
        plannerState = null;
        serverMode = 'idle';
        broadcastEvent('server:status', { mode: 'idle' });
        broadcastEvent('planner:cancelled', {});
        break;

      case 'planner:state':
        if (plannerState) {
          sendTo(ws, 'planner:state', {
            state: {
              taskDescription: plannerState.taskDescription,
              projectDir: plannerState.projectDir,
              ready: plannerState.ready,
            },
          });
        } else {
          sendTo(ws, 'planner:state', { state: null });
        }
        break;
    }
  } catch { /* ignore malformed messages */ }
}

// --- Exports ---

export function setContext(ctx: ProjectContext): void {
  projectContext = ctx;
  serverMode = 'running';
}

export function startWebServer(port: number): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const dashboardPath = path.join(__dirname, 'dashboard.html');

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);
      const pathname = url.pathname;

      // Static
      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        fs.createReadStream(dashboardPath).pipe(res);
        return;
      }

      // REST API
      try {
        if (req.method === 'GET' && pathname === '/api/state') {
          jsonResponse(res, 200, getStateSnapshot());
        } else if (req.method === 'GET' && pathname === '/api/files') {
          jsonResponse(res, 200, getFileList());
        } else if (req.method === 'GET' && pathname === '/api/projects') {
          jsonResponse(res, 200, listProjects());
        } else if (req.method === 'POST' && pathname === '/api/projects') {
          const body = await parseBody(req);
          if (!body.task) {
            jsonResponse(res, 400, { error: 'task is required' });
            return;
          }
          await startProject(body.task, body.maxIterations, body.dir);
          jsonResponse(res, 202, { status: 'started', task: body.task, dir: body.dir });
        } else if (req.method === 'POST' && pathname === '/api/projects/resume') {
          const body = await parseBody(req);
          if (!body.dirPath) {
            jsonResponse(res, 400, { error: 'dirPath is required' });
            return;
          }
          await resumeProject(body.dirPath);
          jsonResponse(res, 202, { status: 'resuming', dirPath: body.dirPath });
        } else if (req.method === 'GET' && pathname === '/api/settings') {
          jsonResponse(res, 200, getMaskedSettings());
        } else if (req.method === 'PUT' && pathname === '/api/settings') {
          const body = await parseBody(req);
          if (body.settings) {
            updateRuntimeConfig(body.settings);
            const cfg = getRuntimeConfig();
            rateLimiter.updateLimits(cfg.MAX_CONCURRENT, cfg.MAX_CALLS_PER_HOUR);
            if (body.persist) {
              saveSettingsToEnv();
            }
          }
          jsonResponse(res, 200, getMaskedSettings());
        } else if (req.method === 'GET' && pathname === '/api/status') {
          jsonResponse(res, 200, { mode: serverMode });
        } else if (req.method === 'GET' && pathname.startsWith('/preview/')) {
          // Serve static files from project directory for preview
          const previewPath = pathname.slice('/preview/'.length);
          const parts = previewPath.split('/');
          if (parts.length < 1) {
            res.writeHead(400);
            res.end('Invalid preview path');
            return;
          }
          const projectName = decodeURIComponent(parts[0]);
          const filePath = parts.slice(1).join('/');
          const projectDir = path.join(CONFIG.PROJECTS_ROOT, projectName);

          if (!fs.existsSync(projectDir)) {
            res.writeHead(404);
            res.end('Project not found');
            return;
          }

          const fullPath = filePath ? path.join(projectDir, filePath) : path.join(projectDir, 'index.html');

          // Security: ensure path doesn't escape project directory
          const resolved = path.resolve(projectDir, filePath || 'index.html');
          if (!resolved.startsWith(path.resolve(projectDir))) {
            res.writeHead(403);
            res.end('Access denied');
            return;
          }

          if (!fs.existsSync(resolved)) {
            // If file not found, try index.html for SPA support
            const indexPath = path.join(projectDir, 'index.html');
            if (fs.existsSync(indexPath)) {
              serveStaticFile(res, indexPath);
            } else {
              res.writeHead(404);
              res.end('File not found');
            }
            return;
          }

          serveStaticFile(res, resolved);
        } else if (pathname.startsWith('/backend-proxy/')) {
          // Proxy requests to running backend servers
          const proxyPath = pathname.slice('/backend-proxy/'.length);
          const parts = proxyPath.split('/');
          const projectName = decodeURIComponent(parts[0]);
          const backendPath = '/' + parts.slice(1).join('/');

          const backend = backendsByProjectName.get(projectName);
          if (!backend) {
            res.writeHead(502);
            res.end('Backend not running');
            return;
          }

          // Forward request to backend
          const backendUrl = `http://localhost:${backend.port}${backendPath}${url.search || ''}`;

          // Collect request body for non-GET methods
          let body = '';
          for await (const chunk of req) body += chunk;

          try {
            const response = await fetch(backendUrl, {
              method: req.method,
              headers: {
                'Content-Type': req.headers['content-type'] || 'application/json',
              },
              body: body || undefined,
            });

            // Copy response headers
            const headers: Record<string, string> = {};
            response.headers.forEach((value, key) => {
              // Skip hop-by-hop headers
              if (!['connection', 'keep-alive', 'transfer-encoding'].includes(key.toLowerCase())) {
                headers[key] = value;
              }
            });

            res.writeHead(response.status, headers);
            const responseBody = await response.text();
            res.end(responseBody);
          } catch (err: any) {
            res.writeHead(502);
            res.end(`Backend error: ${err.message}`);
          }
        } else {
          res.writeHead(404);
          res.end('Not found');
        }
      } catch (err: any) {
        jsonResponse(res, 500, { error: err.message });
      }
    });

    wss = new WebSocketServer({ server });

    wss.on('connection', (ws) => {
      sendTo(ws, 'state:snapshot', getStateSnapshot());
      sendTo(ws, 'server:status', { mode: serverMode });

      ws.on('message', (raw) => {
        handleClientMessage(ws, raw.toString());
      });
    });

    // Bridge messageBus events to WebSocket clients
    const events = [
      'orchestrator:phase',
      'orchestrator:plan',
      'orchestrator:review',
      'orchestrator:iteration',
      'subtask:assigned',
      'subtask:progress',
      'subtask:completed',
      'file:written',
      'project:done',
      'rate-limit:wait',
      'llm:retry',
      'tokens:update',
      'chat:response',
      'chat:user',
      'chat:error',
      'deploy:started',
      'deploy:complete',
      'deploy:failed',
      'deploy:warning',
    ];

    for (const eventName of events) {
      messageBus.on(eventName, (data: unknown) => {
        broadcastEvent(eventName, data);
      });
    }

    // When project completes via messageBus, update server mode and add to registry
    messageBus.on('project:done', () => {
      serverMode = 'completed';
      // Add to registry so it appears in project history
      if (projectContext) {
        addToRegistry(
          projectContext.rootDir,
          projectContext.taskDescription,
          plannerState ? 'planner' : 'direct'
        );
      }
    });

    // Throttle worker:token events
    messageBus.on('worker:token', () => {
      pendingTokens++;
      if (!tokenFlushTimer) {
        tokenFlushTimer = setTimeout(flushTokens, 100);
      }
    });

    server.listen(port, '127.0.0.1', () => {
      resolve(server);
    });

    server.on('error', reject);
  });
}

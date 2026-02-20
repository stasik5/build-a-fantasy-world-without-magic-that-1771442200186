/**
 * Pre-planning project analysis.
 * Scans an existing project directory to build a structured "project map"
 * so the orchestrator and workers understand the codebase before planning.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', '.cache',
  'coverage', '.turbo', '.vercel', '__pycache__', '.venv', 'venv',
]);

const KEY_FILES = new Set([
  'package.json', 'tsconfig.json', 'vite.config.ts', 'vite.config.js',
  'next.config.js', 'next.config.ts', 'next.config.mjs',
  'webpack.config.js', 'rollup.config.js',
  'tailwind.config.js', 'tailwind.config.ts',
  'postcss.config.js', 'postcss.config.cjs',
  '.eslintrc.json', '.eslintrc.js', 'eslint.config.js',
  'requirements.txt', 'pyproject.toml', 'setup.py',
  'Cargo.toml', 'go.mod', 'Makefile', 'Dockerfile',
  'docker-compose.yml', 'docker-compose.yaml',
  '.env.example', 'README.md',
]);

// Files that are likely entry points
const ENTRY_PATTERNS = [
  'index.ts', 'index.js', 'index.tsx', 'index.jsx',
  'main.ts', 'main.js', 'main.tsx', 'main.jsx',
  'app.ts', 'app.js', 'app.tsx', 'app.jsx',
  'server.ts', 'server.js',
];

interface FileEntry {
  relativePath: string;
  type: 'file' | 'dir';
  size?: number;
}

interface ProjectMap {
  fileTree: string;
  keyFileContents: Record<string, string>;
  entryPointSnippets: Record<string, string>;
  summary: string;
}

async function walkDirectory(
  dir: string,
  root: string,
  entries: FileEntry[],
  depth = 0,
  maxDepth = 5,
  maxEntries = 200
): Promise<void> {
  if (depth > maxDepth || entries.length >= maxEntries) return;

  let dirEntries;
  try {
    dirEntries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  // Sort: directories first, then files
  dirEntries.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });

  for (const entry of dirEntries) {
    if (entries.length >= maxEntries) return;

    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(root, fullPath).replace(/\\/g, '/');

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      entries.push({ relativePath: relPath, type: 'dir' });
      await walkDirectory(fullPath, root, entries, depth + 1, maxDepth, maxEntries);
    } else if (entry.isFile()) {
      let size: number | undefined;
      try {
        const stat = await fs.stat(fullPath);
        size = stat.size;
      } catch { /* skip */ }
      entries.push({ relativePath: relPath, type: 'file', size });
    }
  }
}

function buildFileTree(entries: FileEntry[]): string {
  const lines: string[] = [];
  for (const entry of entries) {
    const depth = entry.relativePath.split('/').length - 1;
    const indent = '  '.repeat(depth);
    const name = path.basename(entry.relativePath);
    if (entry.type === 'dir') {
      lines.push(`${indent}${name}/`);
    } else {
      const sizeStr = entry.size !== undefined ? ` (${formatSize(entry.size)})` : '';
      lines.push(`${indent}${name}${sizeStr}`);
    }
  }
  return lines.join('\n');
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

async function readFileSafe(filePath: string, maxChars = 3000): Promise<string | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    if (content.length > maxChars) {
      return content.slice(0, maxChars) + `\n... [truncated at ${maxChars} chars, total ${content.length}]`;
    }
    return content;
  } catch {
    return null;
  }
}

function detectProjectType(keyFiles: Record<string, string>): string {
  const parts: string[] = [];

  const pkg = keyFiles['package.json'];
  if (pkg) {
    try {
      const parsed = JSON.parse(pkg);
      const deps = { ...parsed.dependencies, ...parsed.devDependencies };
      if (deps['next']) parts.push('Next.js');
      else if (deps['react']) parts.push('React');
      if (deps['vue']) parts.push('Vue');
      if (deps['svelte'] || deps['@sveltejs/kit']) parts.push('Svelte');
      if (deps['express']) parts.push('Express');
      if (deps['fastify']) parts.push('Fastify');
      if (deps['hono']) parts.push('Hono');
      if (deps['typescript']) parts.push('TypeScript');
      if (deps['tailwindcss']) parts.push('Tailwind CSS');
      if (deps['prisma'] || deps['@prisma/client']) parts.push('Prisma');
      if (deps['drizzle-orm']) parts.push('Drizzle');
      if (deps['mongoose'] || deps['mongodb']) parts.push('MongoDB');
      if (!parts.length) parts.push('Node.js');
    } catch { /* skip */ }
  }

  if (keyFiles['requirements.txt'] || keyFiles['pyproject.toml']) parts.push('Python');
  if (keyFiles['Cargo.toml']) parts.push('Rust');
  if (keyFiles['go.mod']) parts.push('Go');

  return parts.length > 0 ? parts.join(' + ') : 'Unknown';
}

/**
 * Analyze a project directory and return a structured map.
 * Returns null if the directory is empty (new project).
 */
export async function analyzeProject(projectDir: string): Promise<ProjectMap | null> {
  // Check if directory has any files
  let rootEntries;
  try {
    rootEntries = await fs.readdir(projectDir);
  } catch {
    return null;
  }

  // Filter out hidden files and common non-essential files
  const meaningful = rootEntries.filter(e => !e.startsWith('.') && e !== 'node_modules');
  if (meaningful.length === 0) return null;

  // Walk the directory tree
  const entries: FileEntry[] = [];
  await walkDirectory(projectDir, projectDir, entries);

  if (entries.length === 0) return null;

  const fileTree = buildFileTree(entries);

  // Read key configuration files
  const keyFileContents: Record<string, string> = {};
  for (const entry of entries) {
    const basename = path.basename(entry.relativePath);
    if (entry.type === 'file' && KEY_FILES.has(basename)) {
      const content = await readFileSafe(path.join(projectDir, entry.relativePath));
      if (content) {
        keyFileContents[entry.relativePath] = content;
      }
    }
  }

  // Read entry point files (first 80 lines as a snippet)
  const entryPointSnippets: Record<string, string> = {};
  for (const entry of entries) {
    const basename = path.basename(entry.relativePath);
    if (entry.type === 'file' && ENTRY_PATTERNS.includes(basename)) {
      // Only read entry points in src/ or root, not deeply nested
      const depth = entry.relativePath.split('/').length;
      if (depth <= 3) {
        const content = await readFileSafe(path.join(projectDir, entry.relativePath), 2000);
        if (content) {
          entryPointSnippets[entry.relativePath] = content;
        }
      }
    }
  }

  const projectType = detectProjectType(keyFileContents);
  const fileCount = entries.filter(e => e.type === 'file').length;
  const dirCount = entries.filter(e => e.type === 'dir').length;

  const summary = `Project type: ${projectType}\nFiles: ${fileCount}, Directories: ${dirCount}`;

  return { fileTree, keyFileContents, entryPointSnippets, summary };
}

/**
 * Format the project map into a string suitable for injecting into the orchestrator prompt.
 */
export function formatProjectMap(map: ProjectMap): string {
  const sections: string[] = [];

  sections.push(`## Existing Project Analysis\n\n${map.summary}`);

  sections.push(`### File Structure\n\`\`\`\n${map.fileTree}\n\`\`\``);

  if (Object.keys(map.keyFileContents).length > 0) {
    sections.push('### Configuration Files');
    for (const [filePath, content] of Object.entries(map.keyFileContents)) {
      sections.push(`**${filePath}:**\n\`\`\`\n${content}\n\`\`\``);
    }
  }

  if (Object.keys(map.entryPointSnippets).length > 0) {
    sections.push('### Entry Points');
    for (const [filePath, content] of Object.entries(map.entryPointSnippets)) {
      sections.push(`**${filePath}:**\n\`\`\`\n${content}\n\`\`\``);
    }
  }

  return sections.join('\n\n');
}

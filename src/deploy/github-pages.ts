import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getRuntimeConfig } from '../runtime-config.js';
import { messageBus } from '../swarm/message-bus.js';

export interface DeployResult {
  success: boolean;
  repoUrl?: string;
  pagesUrl?: string;
  error?: string;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf-8', timeout: 30_000, stdio: 'pipe' }).trim();
}

export async function deployToGitHubPages(projectDir: string, projectName: string): Promise<DeployResult> {
  const cfg = getRuntimeConfig();
  const { GITHUB_PAT, GITHUB_USERNAME, GITHUB_EMAIL } = cfg;

  if (!GITHUB_PAT || !GITHUB_USERNAME) {
    return { success: false, error: 'GitHub PAT or username not configured.' };
  }

  const repoName = slugify(projectName);
  if (!repoName) {
    return { success: false, error: 'Could not derive a valid repo name from project.' };
  }

  messageBus.emit('deploy:started', { repoName });

  try {
    // 1. Create the GitHub repo via API
    const createRes = await fetch('https://api.github.com/user/repos', {
      method: 'POST',
      headers: {
        Authorization: `token ${GITHUB_PAT}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: repoName,
        description: `Auto-deployed by Builder Swarm`,
        private: false,
        auto_init: false,
      }),
    });

    if (!createRes.ok) {
      const body = await createRes.json().catch(() => ({}));
      // 422 = repo already exists, try to use it
      if (createRes.status !== 422) {
        return { success: false, error: `GitHub API error ${createRes.status}: ${(body as any).message ?? 'Unknown'}` };
      }
    }

    const repoUrl = `https://github.com/${GITHUB_USERNAME}/${repoName}`;
    const remoteUrl = `https://${GITHUB_PAT}@github.com/${GITHUB_USERNAME}/${repoName}.git`;

    // 2. Init git, add, commit, push
    try {
      run('git rev-parse --git-dir', projectDir);
    } catch {
      run('git init -b main', projectDir);
    }

    run(`git config user.email "${GITHUB_EMAIL || 'swarm@builder.local'}"`, projectDir);
    run(`git config user.name "${GITHUB_USERNAME}"`, projectDir);

    // Ensure a .gitignore exists so sensitive / irrelevant files never get committed
    const gitignorePath = path.join(projectDir, '.gitignore');
    const requiredIgnores = [
      'node_modules/',
      '.env',
      '.claude/',
      '.swarm-checkpoint.json',
      '.DS_Store',
      'Thumbs.db',
    ];
    let existing = '';
    try { existing = fs.readFileSync(gitignorePath, 'utf-8'); } catch { /* no file yet */ }
    const missing = requiredIgnores.filter(entry => !existing.split('\n').map(l => l.trim()).includes(entry));
    if (missing.length) {
      const append = (existing && !existing.endsWith('\n') ? '\n' : '') + missing.join('\n') + '\n';
      fs.appendFileSync(gitignorePath, append, 'utf-8');
    }

    // Force-remove .claude from the index if it was previously tracked
    try { run('git rm -rf --cached .claude', projectDir); } catch { /* not tracked */ }

    run('git add -A', projectDir);

    try {
      run('git commit -m "Deploy via Builder Swarm"', projectDir);
    } catch {
      // Nothing to commit — files may already be committed
    }

    // Set remote
    try {
      run(`git remote set-url origin ${remoteUrl}`, projectDir);
    } catch {
      run(`git remote add origin ${remoteUrl}`, projectDir);
    }

    // Ensure we're on main branch
    try {
      run('git branch -M main', projectDir);
    } catch { /* already on main */ }

    run('git push -u origin main --force', projectDir);

    // 3. Enable GitHub Pages via API (deploy from main branch root)
    const pagesRes = await fetch(`https://api.github.com/repos/${GITHUB_USERNAME}/${repoName}/pages`, {
      method: 'POST',
      headers: {
        Authorization: `token ${GITHUB_PAT}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        build_type: 'legacy',
        source: { branch: 'main', path: '/' },
      }),
    });

    if (!pagesRes.ok && pagesRes.status !== 409) {
      // 409 = pages already enabled
      const body = await pagesRes.json().catch(() => ({}));
      // Non-fatal — push succeeded, pages might just need manual enable
      messageBus.emit('deploy:warning', { message: `Pages API: ${(body as any).message ?? pagesRes.status}` });
    }

    const pagesUrl = `https://${GITHUB_USERNAME}.github.io/${repoName}/`;

    messageBus.emit('deploy:complete', { repoUrl, pagesUrl, repoName });
    return { success: true, repoUrl, pagesUrl };
  } catch (err: any) {
    const msg = err.message ?? String(err);
    messageBus.emit('deploy:failed', { error: msg });
    return { success: false, error: msg };
  }
}

import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../config.js';
import { chatCompletion } from '../llm/client.js';
import type { ChatMessage } from '../types.js';

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
}

async function generateProjectName(taskDescription: string): Promise<string> {
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        'You are a concise naming assistant. Given a project description, reply with ONLY a short, clean project name (2-4 words, lowercase, separated by hyphens). No explanation, no quotes, no extra text. Examples: "habit-tracker", "pixel-art-editor", "markdown-notes", "midi-piano", "recipe-finder", "budget-dashboard".',
    },
    { role: 'user', content: taskDescription },
  ];

  const response = await chatCompletion(messages, undefined, {
    temperature: 0.7,
    maxTokens: 30,
  });

  const raw = response.choices[0]?.message.content?.trim() ?? '';
  // Sanitize whatever the LLM returns into a valid folder slug
  const name = slugify(raw);
  if (name.length < 2) throw new Error('LLM returned empty name');
  return name;
}

export async function createProjectDir(taskDescription: string): Promise<string> {
  let dirName: string;

  try {
    const name = await generateProjectName(taskDescription);
    // Append a short random suffix to avoid collisions
    const suffix = Math.random().toString(36).slice(2, 6);
    dirName = `${name}-${suffix}`;
  } catch {
    // Fallback: slugified description + timestamp
    const slug = slugify(taskDescription);
    dirName = `${slug}-${Date.now()}`;
  }

  const fullPath = path.join(CONFIG.PROJECTS_ROOT, dirName);
  fs.mkdirSync(fullPath, { recursive: true });

  return fullPath;
}

/**
 * Lightweight MCP (Model Context Protocol) client for Z.ai's hosted MCP services.
 * Uses the streamable-http transport with session initialization.
 */

import { getRuntimeConfig } from '../runtime-config.js';

const MCP_BASE = 'https://api.z.ai/api/mcp';

let requestId = 0;

// Cache sessions per service to avoid re-initializing on every call
const sessions = new Map<string, { sessionId: string; expiresAt: number }>();
const SESSION_TTL_MS = 5 * 60 * 1000; // 5 minutes

function parseSSEData(text: string): any | null {
  for (const line of text.split('\n')) {
    if (line.startsWith('data:')) {
      const data = line.slice(5).trim();
      if (!data) continue;
      try {
        return JSON.parse(data);
      } catch {
        continue;
      }
    }
  }
  return null;
}

async function getSession(service: string, apiKey: string): Promise<string> {
  const cached = sessions.get(service);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.sessionId;
  }

  const url = `${MCP_BASE}/${service}/mcp`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: ++requestId,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'builder-swarm', version: '1.0.0' },
      },
    }),
  });

  const sessionId = response.headers.get('mcp-session-id');
  if (!sessionId) {
    const text = await response.text();
    throw new Error(`MCP ${service} init failed: no session ID. Response: ${text.slice(0, 300)}`);
  }

  sessions.set(service, { sessionId, expiresAt: Date.now() + SESSION_TTL_MS });
  // Consume the response body
  await response.text();
  return sessionId;
}

export async function mcpCall(
  service: string,
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs = 20_000
): Promise<string> {
  const apiKey = getRuntimeConfig().ZAI_API_KEY;
  if (!apiKey) {
    return 'Error: ZAI_API_KEY not configured, cannot use web tools.';
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Get or create session
    const sessionId = await getSession(service, apiKey);
    const url = `${MCP_BASE}/${service}/mcp`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${apiKey}`,
        'mcp-session-id': sessionId,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++requestId,
        method: 'tools/call',
        params: { name: toolName, arguments: args },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      // Session may have expired, clear it so next call re-initializes
      sessions.delete(service);
      return `Error: MCP ${service} returned ${response.status}: ${text.slice(0, 500)}`;
    }

    const rawText = await response.text();
    const json = parseSSEData(rawText);

    if (!json) {
      return rawText.slice(0, 10_000);
    }

    if (json.result?.isError) {
      const errText = json.result.content?.[0]?.text ?? JSON.stringify(json.result);
      return `Error: MCP ${service}: ${errText}`;
    }

    if (json.result?.content && Array.isArray(json.result.content)) {
      return json.result.content
        .map((c: any) => c.text ?? '')
        .filter(Boolean)
        .join('\n')
        .slice(0, 15_000);
    }

    if (json.error) {
      return `Error: MCP ${service}: ${json.error.message ?? JSON.stringify(json.error)}`;
    }

    return JSON.stringify(json.result ?? json).slice(0, 15_000);
  } catch (err: any) {
    // Clear session on errors so next call re-initializes
    sessions.delete(service);
    if (err.name === 'AbortError') {
      return `Error: MCP ${service} timed out after ${timeoutMs}ms`;
    }
    return `Error: MCP ${service} failed: ${err.message}`;
  } finally {
    clearTimeout(timer);
  }
}

import { mcpCall } from './mcp-client.js';

export async function webSearchTool(
  args: { query: string; count?: number }
): Promise<string> {
  if (!args.query || args.query.trim().length === 0) {
    return 'Error: search query is required.';
  }

  return mcpCall('web_search_prime', 'webSearchPrime', {
    search_query: args.query,
    content_size: 'medium',
    location: 'us',
  });
}

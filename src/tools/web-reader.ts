import { mcpCall } from './mcp-client.js';

export async function webReaderTool(
  args: { url: string }
): Promise<string> {
  if (!args.url || args.url.trim().length === 0) {
    return 'Error: url is required.';
  }

  return mcpCall('web_reader', 'webReader', {
    url: args.url,
  });
}

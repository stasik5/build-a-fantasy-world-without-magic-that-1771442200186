import path from 'node:path';

export function resolveSafe(root: string, relativePath: string): string {
  const resolved = path.resolve(root, relativePath);
  const normalizedRoot = path.resolve(root);
  if (!resolved.startsWith(normalizedRoot)) {
    throw new Error(`Path traversal blocked: "${relativePath}" resolves outside project root`);
  }
  return resolved;
}

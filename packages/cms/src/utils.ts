import { join } from 'node:path';

/**
 * Resolve the content data directory.
 * Uses the path from virtual:mimsy/config, falling back to cwd + src/data.
 */
export function resolveContentDir(configContentDir?: string): string {
  if (configContentDir) return configContentDir;
  return join(process.cwd(), 'src', 'data');
}

/** Generate a URL-safe slug from a title */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

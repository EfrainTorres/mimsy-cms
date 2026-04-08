import { existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { resolveContentDir } from '../utils.js';
import config from 'virtual:mimsy/config';

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Find the absolute path of the content file. Returns null if not found or outside content dir. */
export function resolveAbsPath(collection: string, slug: string): string | null {
  // resolve() normalizes away double slashes, symlinks, etc. before comparison
  const contentDir = resolve(resolveContentDir(config.contentDir));
  const base = contentDir + sep;
  for (const ext of ['.md', '.mdx', '.json']) {
    const p = join(contentDir, collection, `${slug}${ext}`);
    // Path confinement: resolved path must stay within contentDir
    if (!p.startsWith(base)) continue;
    if (existsSync(p)) return p;
  }
  return null;
}

/** Convert absolute path to cwd-relative path (for git log -- <path>). */
export function toRelPath(absPath: string): string {
  const cwd = process.cwd();
  return absPath.startsWith(cwd + sep) ? absPath.slice(cwd.length + 1) : absPath;
}

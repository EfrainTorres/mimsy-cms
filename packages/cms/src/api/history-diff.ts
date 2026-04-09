import type { APIRoute } from 'astro';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sep } from 'node:path';
import matter from 'gray-matter';
import { getEnv } from '../adapters/factory.js';
import { json, resolveAbsPath, toRelPath } from './history-utils.js';

const execFileAsync = promisify(execFile);

// Cached once per process — repo root never changes at runtime.
// undefined = not yet tried, null = tried and no git repo found (failure also cached).
let cachedRepoRoot: string | null | undefined = undefined;
export async function getRepoRoot(cwd: string): Promise<string | null> {
  if (cachedRepoRoot !== undefined) return cachedRepoRoot;
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd });
    cachedRepoRoot = stdout.trim();
    return cachedRepoRoot;
  } catch {
    cachedRepoRoot = null; // cache the failure — no git repo, don't retry per request
    return null;
  }
}

// Bounded SHA content cache — SHA content is immutable so TTL is not needed.
// Evict oldest when full (simple FIFO bounded cache).
export const shaCache = new Map<string, string>(); // `${sha}:${relPath}` → raw content
const MAX_SHA_CACHE = 100;

export function cacheSha(key: string, content: string) {
  if (shaCache.size >= MAX_SHA_CACHE) {
    shaCache.delete(shaCache.keys().next().value!);
  }
  shaCache.set(key, content);
}

/** Parse a raw file string into { frontmatter, body }. Handles .json too. */
export function parseRaw(raw: string, isJson: boolean): { frontmatter: Record<string, unknown>; body: string } {
  if (isJson) {
    try {
      return { frontmatter: JSON.parse(raw), body: '' };
    } catch {
      return { frontmatter: {}, body: '' };
    }
  }
  const { data, content } = matter(raw);
  return { frontmatter: data as Record<string, unknown>, body: content.trim() };
}

/** Compute human-readable changes between two frontmatter objects. */
function diffFrontmatter(
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
): Array<{ key: string; type: 'added' | 'removed' | 'changed'; before?: string; after?: string }> {
  const bf = before ?? {};
  const allKeys = new Set([...Object.keys(bf), ...Object.keys(after)]);
  const changes: Array<{ key: string; type: 'added' | 'removed' | 'changed'; before?: string; after?: string }> = [];

  for (const key of allKeys) {
    const bStr = stringify(bf[key]);
    const aStr = stringify(after[key]);
    if (!(key in bf)) {
      changes.push({ key, type: 'added', after: aStr });
    } else if (!(key in after)) {
      changes.push({ key, type: 'removed', before: bStr });
    } else if (bStr !== aStr) {
      changes.push({ key, type: 'changed', before: bStr, after: aStr });
    }
  }
  return changes;
}

function stringify(val: unknown): string {
  if (val === undefined || val === null) return '';
  if (typeof val === 'string') return val;
  if (val instanceof Date) return val.toISOString();
  return JSON.stringify(val);
}

export const GET: APIRoute = async ({ url, cookies }) => {
  const collection = url.searchParams.get('collection');
  const slug = url.searchParams.get('slug');
  const sha = url.searchParams.get('sha');
  const prevSha = url.searchParams.get('prevSha') ?? undefined;

  if (!collection || !slug || !sha) return json({ error: 'Missing params' }, 400);

  // Validate inputs — no traversal
  if (!/^[\w-]+$/.test(collection) || !/^[\w./\-]+$/.test(slug) || slug.includes('..')) {
    return json({ error: 'Invalid params' }, 400);
  }
  if (!/^[0-9a-f]{7,64}$/.test(sha)) return json({ error: 'Invalid sha' }, 400);
  if (prevSha && !/^[0-9a-f]{7,64}$/.test(prevSha)) return json({ error: 'Invalid prevSha' }, 400);

  const isGitHub = !!getEnv('MIMSY_GITHUB_REPO');

  if (isGitHub) {
    return getGitHubDiff(collection, slug, sha, prevSha, cookies.get('mimsy_token')?.value ?? '');
  } else {
    return getLocalDiff(collection, slug, sha, prevSha);
  }
};

async function getLocalDiff(
  collection: string,
  slug: string,
  sha: string,
  prevSha: string | undefined,
) {
  const absPath = resolveAbsPath(collection, slug);
  if (!absPath) return json({ error: 'File not found' }, 404);

  const cwd = process.cwd();
  const isJson = absPath.endsWith('.json');

  // git show <sha>:<path> requires a path relative to the repo root, not cwd.
  // cwd and the git repo root may differ (e.g. running from a monorepo subdir).
  const repoRoot = await getRepoRoot(cwd);
  const gitRelPath = repoRoot && absPath.startsWith(repoRoot + sep)
    ? absPath.slice(repoRoot.length + 1)
    : toRelPath(absPath);

  async function getContentAtSha(targetSha: string): Promise<string | null> {
    const cacheKey = `${targetSha}:${gitRelPath}`;
    if (shaCache.has(cacheKey)) return shaCache.get(cacheKey)!;
    try {
      const { stdout } = await execFileAsync('git', ['show', `${targetSha}:${gitRelPath}`], { cwd });
      cacheSha(cacheKey, stdout);
      return stdout;
    } catch {
      return null;
    }
  }

  const rawAfter = await getContentAtSha(sha);
  if (!rawAfter) return json({ error: 'SHA not found' }, 404);

  const rawBefore = prevSha ? await getContentAtSha(prevSha) : null;

  const { frontmatter: fmAfter, body: bodyAfter } = parseRaw(rawAfter, isJson);
  const { frontmatter: fmBefore, body: bodyBefore } = rawBefore
    ? parseRaw(rawBefore, isJson)
    : { frontmatter: null, body: '' };

  return json({
    sha,
    frontmatter: fmAfter,
    body: bodyAfter,
    frontmatterChanges: diffFrontmatter(fmBefore, fmAfter),
    bodyChanged: bodyBefore !== bodyAfter,
    bodyBefore: bodyBefore.slice(0, 300),
    bodyAfter: bodyAfter.slice(0, 300),
  });
}

async function getGitHubDiff(
  collection: string,
  slug: string,
  sha: string,
  prevSha: string | undefined,
  token: string,
) {
  const repo = getEnv('MIMSY_GITHUB_REPO') ?? '';
  const contentPath = getEnv('MIMSY_GITHUB_CONTENT_PATH') ?? 'src/data';
  const [owner, repoName] = repo.split('/');
  if (!owner || !repoName) return json({ error: 'GitHub not configured' }, 500);

  // Try to find the file — determine extension by trying to fetch at this SHA
  const exts = ['.md', '.mdx', '.json'];
  let filePath = '';
  let rawAfter: string | null = null;
  let isJson = false;

  for (const ext of exts) {
    const candidate = `${contentPath}/${collection}/${slug}${ext}`;
    const cacheKey = `${sha}:${candidate}`;
    if (shaCache.has(cacheKey)) {
      rawAfter = shaCache.get(cacheKey)!;
      filePath = candidate;
      isJson = ext === '.json';
      break;
    }

    const content = await fetchGitHubFileAtSha(owner, repoName, candidate, sha, token);
    if (content !== null) {
      cacheSha(cacheKey, content);
      rawAfter = content;
      filePath = candidate;
      isJson = ext === '.json';
      break;
    }
  }

  if (!rawAfter || !filePath) return json({ error: 'File not found at SHA' }, 404);

  let rawBefore: string | null = null;
  if (prevSha) {
    const cacheKey = `${prevSha}:${filePath}`;
    if (shaCache.has(cacheKey)) {
      rawBefore = shaCache.get(cacheKey)!;
    } else {
      rawBefore = await fetchGitHubFileAtSha(owner, repoName, filePath, prevSha, token);
      if (rawBefore) cacheSha(cacheKey, rawBefore);
    }
  }

  const { frontmatter: fmAfter, body: bodyAfter } = parseRaw(rawAfter, isJson);
  const { frontmatter: fmBefore, body: bodyBefore } = rawBefore
    ? parseRaw(rawBefore, isJson)
    : { frontmatter: null, body: '' };

  return json({
    sha,
    frontmatter: fmAfter,
    body: bodyAfter,
    frontmatterChanges: diffFrontmatter(fmBefore, fmAfter),
    bodyChanged: bodyBefore !== bodyAfter,
    bodyBefore: bodyBefore.slice(0, 300),
    bodyAfter: bodyAfter.slice(0, 300),
  });
}

export async function fetchGitHubFileAtSha(
  owner: string,
  repo: string,
  filePath: string,
  sha: string,
  token: string,
): Promise<string | null> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}?ref=${sha}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    );
    if (!res.ok) return null;
    const data = await res.json() as any;
    if (data.type !== 'file' || !data.content) return null;
    // Decode base64 (GitHub returns base64 with embedded newlines)
    const cleaned = data.content.replace(/\n/g, '');
    const bytes = Uint8Array.from(atob(cleaned), (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

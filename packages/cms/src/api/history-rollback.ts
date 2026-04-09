import type { APIRoute } from 'astro';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sep } from 'node:path';
import { getEnv, createAdapter } from '../adapters/factory.js';
import { json, resolveAbsPath, toRelPath } from './history-utils.js';
import { parseRaw, getRepoRoot, shaCache, cacheSha, fetchGitHubFileAtSha } from './history-diff.js';

const execFileAsync = promisify(execFile);

/** POST /api/mimsy/history/rollback — restore a previous version by writing it to disk */
export const POST: APIRoute = async ({ request, locals, cookies }) => {
  let body: any;
  try { body = await request.json(); } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const { collection, slug, sha, date } = body;
  if (!collection || !slug || !sha) return json({ error: 'Missing params' }, 400);
  if (!/^[\w-]+$/.test(collection) || !/^[a-z0-9](?:[a-z0-9\-/]*[a-z0-9])?$/.test(slug) || slug.includes('..')) {
    return json({ error: 'Invalid params' }, 400);
  }
  if (!/^[0-9a-f]{7,64}$/.test(sha)) return json({ error: 'Invalid sha' }, 400);

  const isGitHub = !!getEnv('MIMSY_GITHUB_REPO');
  let raw: string | null = null;
  let isJson = false;

  if (isGitHub) {
    const repo = getEnv('MIMSY_GITHUB_REPO') ?? '';
    const contentPath = getEnv('MIMSY_GITHUB_CONTENT_PATH') ?? 'src/data';
    const [owner, repoName] = repo.split('/');
    if (!owner || !repoName) return json({ error: 'GitHub not configured' }, 500);

    const token = cookies.get('mimsy_token')?.value ?? '';
    const exts = ['.md', '.mdx', '.json'];
    for (const ext of exts) {
      const candidate = `${contentPath}/${collection}/${slug}${ext}`;
      const cacheKey = `${sha}:${candidate}`;
      if (shaCache.has(cacheKey)) {
        raw = shaCache.get(cacheKey)!;
        isJson = ext === '.json';
        break;
      }
      const content = await fetchGitHubFileAtSha(owner, repoName, candidate, sha, token);
      if (content !== null) {
        cacheSha(cacheKey, content);
        raw = content;
        isJson = ext === '.json';
        break;
      }
    }
  } else {
    const absPath = resolveAbsPath(collection, slug);
    if (!absPath) return json({ error: 'File not found' }, 404);

    isJson = absPath.endsWith('.json');
    const cwd = process.cwd();
    const repoRoot = await getRepoRoot(cwd);
    const gitRelPath = repoRoot && absPath.startsWith(repoRoot + sep)
      ? absPath.slice(repoRoot.length + 1)
      : toRelPath(absPath);

    const cacheKey = `${sha}:${gitRelPath}`;
    if (shaCache.has(cacheKey)) {
      raw = shaCache.get(cacheKey)!;
    } else {
      try {
        const { stdout } = await execFileAsync('git', ['show', `${sha}:${gitRelPath}`], { cwd });
        cacheSha(cacheKey, stdout);
        raw = stdout;
      } catch {
        raw = null;
      }
    }
  }

  if (!raw) return json({ error: 'Could not retrieve content at this SHA' }, 404);

  const { frontmatter, body: entryBody } = parseRaw(raw, isJson);
  const adapter = await createAdapter(request, locals);

  const dateStr = date ? new Date(date).toISOString().split('T')[0] : sha.slice(0, 7);
  const commitMsg = `Rollback: ${collection}/${slug} to ${dateStr}`;

  try {
    await adapter.updateEntry(collection, slug, frontmatter, entryBody, commitMsg);
  } catch (err: any) {
    return json({ error: err?.message ?? 'Rollback failed' }, 500);
  }

  return json({ ok: true });
};

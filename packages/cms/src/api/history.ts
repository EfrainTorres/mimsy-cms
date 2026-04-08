import type { APIRoute } from 'astro';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getEnv } from '../adapters/factory.js';
import { json, resolveAbsPath, toRelPath } from './history-utils.js';

const execFileAsync = promisify(execFile);

// Short-TTL, bounded cache for history lists (new commits can arrive)
const listCache = new Map<string, { data: unknown; expires: number }>();
const LIST_TTL = 30_000;
const MAX_LIST_CACHE = 50;

export const GET: APIRoute = async ({ url, cookies }) => {
  const collection = url.searchParams.get('collection');
  const slug = url.searchParams.get('slug');
  const isDataCollection = url.searchParams.get('data') === '1';

  if (!collection || !slug) return json({ error: 'Missing collection or slug' }, 400);

  // Strict validation — no traversal, only word chars + common slug chars
  if (!/^[\w-]+$/.test(collection) || !/^[\w./\-]+$/.test(slug) || slug.includes('..')) {
    return json({ error: 'Invalid params' }, 400);
  }

  const bust = url.searchParams.get('bust') === '1';
  const isGitHub = !!getEnv('MIMSY_GITHUB_REPO');
  const cacheKey = `${isGitHub ? 'gh' : 'local'}:${isDataCollection ? 'data:' : ''}${collection}/${slug}`;
  const cached = listCache.get(cacheKey);
  if (!bust && cached && cached.expires > Date.now()) return json(cached.data);

  const result = isGitHub
    ? await getGitHubHistory(collection, slug, isDataCollection, cookies.get('mimsy_token')?.value ?? '')
    : await getLocalHistory(collection, slug);

  if (listCache.size >= MAX_LIST_CACHE) listCache.delete(listCache.keys().next().value!);
  listCache.set(cacheKey, { data: result, expires: Date.now() + LIST_TTL });
  return json(result);
};

async function getLocalHistory(collection: string, slug: string) {
  const absPath = resolveAbsPath(collection, slug);
  if (!absPath) return { versions: [], hasMore: false, noGit: false };

  const relPath = toRelPath(absPath);
  const cwd = process.cwd();

  // Check for git repo
  try {
    await execFileAsync('git', ['rev-parse', '--git-dir'], { cwd });
  } catch {
    return { versions: [], hasMore: false, noGit: true };
  }

  try {
    const LIMIT = 30;
    // %H = sha, %ai = ISO date, %an = author name, %aE = author email, %P = parent sha(s)
    const { stdout } = await execFileAsync('git', [
      'log', '--follow', '--format=%H|%ai|%an|%aE|%P',
      `-n`, String(LIMIT + 1), '--', relPath,
    ], { cwd });

    const lines = stdout.trim().split('\n').filter(Boolean);
    const hasMore = lines.length > LIMIT;
    const versions = lines.slice(0, LIMIT).map((line: string, i: number) => {
      const [sha, date, name, email, parents] = line.split('|');
      const parentSha = parents?.trim().split(' ')[0] || undefined;
      return {
        sha: sha.trim(),
        date: date.trim(),
        author: { name: name.trim(), email: email.trim() },
        isCurrent: i === 0,
        parentSha: parentSha || undefined,
      };
    });

    return { versions, hasMore, noGit: false };
  } catch {
    return { versions: [], hasMore: false, noGit: false };
  }
}

async function getGitHubHistory(
  collection: string,
  slug: string,
  isDataCollection: boolean,
  token: string,
) {
  const repo = getEnv('MIMSY_GITHUB_REPO') ?? '';
  const branch = getEnv('MIMSY_GITHUB_BRANCH') ?? 'main';
  const contentPath = getEnv('MIMSY_GITHUB_CONTENT_PATH') ?? 'src/data';
  const [owner, repoName] = repo.split('/');
  if (!owner || !repoName) return { versions: [], hasMore: false, noGit: false };

  // Try extensions in likely order; pick first that returns commits
  const exts = isDataCollection ? ['.json', '.md', '.mdx'] : ['.md', '.mdx', '.json'];
  const LIMIT = 30;

  for (const ext of exts) {
    const filePath = `${contentPath}/${collection}/${slug}${ext}`;
    try {
      const res = await fetch(
        `https://api.github.com/repos/${owner}/${repoName}/commits?path=${encodeURIComponent(filePath)}&per_page=${LIMIT + 1}&sha=${branch}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        },
      );
      if (!res.ok) continue;

      const commits = await res.json() as any[];
      if (commits.length === 0) continue;

      const hasMore = commits.length > LIMIT;
      const versions = commits.slice(0, LIMIT).map((c: any, i: number) => ({
        sha: c.sha,
        date: c.commit.author.date,
        author: {
          name: c.commit.author.name,
          login: c.author?.login ?? undefined,
          avatar: c.author?.avatar_url ?? undefined,
        },
        isCurrent: i === 0,
        parentSha: c.parents?.[0]?.sha ?? undefined,
      }));

      return { versions, hasMore, noGit: false };
    } catch {
      continue;
    }
  }

  return { versions: [], hasMore: false, noGit: false };
}

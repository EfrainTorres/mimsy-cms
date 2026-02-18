import { LocalContentAdapter } from './local.js';
import type { ContentAdapter, MimsyUser } from '../types.js';
import { resolveContentDir } from '../utils.js';

/** Read an env var. Checks import.meta.env (Astro/Vite) then process.env (Node/Vercel/Netlify). */
export function getEnv(key: string): string | undefined {
  // Vite/Astro loads .env into import.meta.env (dev SSR + build)
  const metaVal = (import.meta as any).env?.[key];
  if (metaVal !== undefined && metaVal !== '') return metaVal;
  // Fallback to process.env for Node runtimes / deployment platforms
  if (typeof process !== 'undefined') return process.env[key];
  return undefined;
}

/** Returns true when GitHub mode env vars are configured. */
export function isGitHubMode(): boolean {
  return !!getEnv('MIMSY_GITHUB_REPO');
}

/**
 * Create the appropriate content adapter for the current request.
 * In local mode: returns LocalContentAdapter (no auth needed).
 * In GitHub mode: returns GitHubContentAdapter using the OAuth token from cookies.
 */
export async function createAdapter(
  request?: Request,
  locals?: { mimsyUser?: MimsyUser },
): Promise<ContentAdapter> {
  const repo = getEnv('MIMSY_GITHUB_REPO');
  if (!repo) {
    return new LocalContentAdapter(resolveContentDir());
  }

  // GitHub mode — dynamic import to avoid loading octokit in local mode
  const { GitHubContentAdapter } = await import('./github.js');

  const token = extractCookie(request, 'mimsy_token') ?? '';
  const branch = getEnv('MIMSY_GITHUB_BRANCH') ?? 'main';
  const contentPath = getEnv('MIMSY_GITHUB_CONTENT_PATH') ?? 'src/data';
  const user = locals?.mimsyUser;

  return new GitHubContentAdapter({
    repo,
    branch,
    contentPath,
    token,
    author: user ? { name: user.name, email: user.email } : undefined,
  });
}

function extractCookie(request: Request | undefined, name: string): string | undefined {
  if (!request) return undefined;
  const header = request.headers.get('cookie') ?? '';
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match?.[1];
}

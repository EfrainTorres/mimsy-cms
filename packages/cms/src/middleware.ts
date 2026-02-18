import { defineMiddleware } from 'astro:middleware';
import config from 'virtual:mimsy/config';
import { getEnv } from './adapters/factory.js';

interface CachedUser {
  user: { login: string; name: string; email: string; avatar: string };
  expires: number;
}

const tokenCache = new Map<string, CachedUser>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export const onRequest = defineMiddleware(async (context, next) => {
  // Local mode — no auth required
  if (!getEnv('MIMSY_GITHUB_REPO')) {
    return next();
  }

  const { pathname } = context.url;
  const basePath: string = config.basePath;

  // Only protect admin pages and API routes
  const isAdminPage = pathname === basePath || pathname.startsWith(basePath + '/');
  const isApiRoute = pathname.startsWith('/api/mimsy/');

  if (!isAdminPage && !isApiRoute) {
    return next();
  }

  // Exempt auth routes — they must be accessible without a token
  const authRoutes = [
    '/api/mimsy/auth/login',
    '/api/mimsy/auth/callback',
    '/api/mimsy/auth/logout',
  ];
  if (authRoutes.includes(pathname)) {
    return next();
  }

  // Read the auth token from the cookie
  const token = context.cookies.get('mimsy_token')?.value;

  if (!token) {
    if (isApiRoute) {
      return new Response(
        JSON.stringify({ error: 'Not authenticated' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return context.redirect('/api/mimsy/auth/login');
  }

  // Check in-memory cache first
  const cached = tokenCache.get(token);
  if (cached && cached.expires > Date.now()) {
    context.locals.mimsyUser = cached.user;
    return next();
  }

  // Validate token against GitHub API
  try {
    const res = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
      },
    });

    if (!res.ok) {
      // Token is invalid or expired — clear it
      tokenCache.delete(token);
      context.cookies.delete('mimsy_token', { path: '/' });

      if (isApiRoute) {
        return new Response(
          JSON.stringify({ error: 'Invalid or expired token' }),
          { status: 401, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return context.redirect('/api/mimsy/auth/login');
    }

    const ghUser = await res.json();
    const user = {
      login: ghUser.login,
      name: ghUser.name ?? ghUser.login,
      email: ghUser.email ?? `${ghUser.login}@users.noreply.github.com`,
      avatar: ghUser.avatar_url,
    };

    // Cache the validated user
    tokenCache.set(token, { user, expires: Date.now() + CACHE_TTL });

    context.locals.mimsyUser = user;
    return next();
  } catch (err) {
    console.error('[mimsy] GitHub token validation failed:', err);

    if (isApiRoute) {
      return new Response(
        JSON.stringify({ error: 'Authentication check failed' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return context.redirect('/api/mimsy/auth/login');
  }
});

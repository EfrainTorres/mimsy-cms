import { defineMiddleware } from 'astro:middleware';
import config from 'virtual:mimsy/config';
import { getEnv } from './adapters/factory.js';
import { OVERLAY_SCRIPT } from './overlay/overlay-script.js';
import { cacheToken, getCachedUser, isTokenCached, invalidateToken } from './auth-cache.js';

export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname } = context.url;
  const basePath: string = config.basePath;

  // Visual editing overlay injection — only for non-admin, non-API pages.
  // In GitHub mode, require a *cached-valid* session: token must be in the auth-cache
  // with a non-expired entry. A fake or expired cookie has no cache entry → denied.
  const overlayAllowed = !getEnv('MIMSY_GITHUB_REPO') || (() => {
    const tok = context.cookies.get('mimsy_token')?.value;
    return !!tok && isTokenCached(tok);
  })();

  if (
    context.url.searchParams.has('__mimsy') &&
    !pathname.startsWith(basePath) &&
    !pathname.startsWith('/api/mimsy/') &&
    overlayAllowed
  ) {
    const response = await next();
    if (!response.ok) return response;
    const ct = response.headers.get('content-type') || '';
    if (!ct.includes('text/html')) return response;
    const html = await response.text();
    if (!html.includes('</body>')) return new Response(html, { status: response.status, headers: response.headers });
    const injected = html.replace(
      '</body>',
      `<script data-mimsy-overlay>${OVERLAY_SCRIPT}</script></body>`,
    );
    return new Response(injected, { status: response.status, headers: response.headers });
  }

  // Local mode — no auth required
  if (!getEnv('MIMSY_GITHUB_REPO')) {
    return next();
  }

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
  const cachedUser = getCachedUser(token);
  if (cachedUser) {
    context.locals.mimsyUser = cachedUser;
    return next();
  }

  // Validate token against GitHub API and verify repo access + write permission (parallel)
  try {
    const ghHeaders = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
    };

    const [userRes, repoRes] = await Promise.all([
      fetch('https://api.github.com/user', { headers: ghHeaders }),
      fetch(`https://api.github.com/repos/${getEnv('MIMSY_GITHUB_REPO')}`, { headers: ghHeaders }),
    ]);

    if (!userRes.ok) {
      // Token is invalid or expired — clear it
      invalidateToken(token);
      context.cookies.delete('mimsy_token', { path: '/' });

      if (isApiRoute) {
        return new Response(
          JSON.stringify({ error: 'Invalid or expired token' }),
          { status: 401, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return context.redirect('/api/mimsy/auth/login');
    }

    // Require push access to the configured repo. Read-only access or no collaboration
    // relationship means the user can see the repo but not write content through the CMS.
    const repoData = repoRes.ok ? await repoRes.json() : null;
    if (!repoData || repoData.permissions?.push !== true) {
      if (isApiRoute) {
        return new Response(
          JSON.stringify({ error: 'Not authorized for this repository' }),
          { status: 403, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(
        '<html><body style="font-family:sans-serif;padding:2rem"><h1>Access Denied</h1><p>Your GitHub account does not have write access to the configured repository.</p><a href="/api/mimsy/auth/logout">Sign out</a></body></html>',
        { status: 403, headers: { 'Content-Type': 'text/html' } },
      );
    }

    const ghUser = await userRes.json();
    const user = {
      login: ghUser.login,
      name: ghUser.name ?? ghUser.login,
      email: ghUser.email ?? `${ghUser.login}@users.noreply.github.com`,
      avatar: ghUser.avatar_url,
    };

    // Cache the validated user
    cacheToken(token, user);

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

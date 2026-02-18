import type { APIRoute } from 'astro';
import { getEnv } from '../../adapters/factory.js';

export const GET: APIRoute = async ({ cookies, url }) => {
  const clientId = getEnv('MIMSY_GITHUB_CLIENT_ID');

  if (!clientId) {
    return new Response(
      JSON.stringify({ error: 'MIMSY_GITHUB_CLIENT_ID is not configured' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // Generate CSRF state token (Web Crypto API — cross-runtime compatible)
  const state = crypto.randomUUID();

  // Store state in a short-lived cookie for CSRF validation
  cookies.set('mimsy_oauth_state', state, {
    httpOnly: true,
    secure: import.meta.env.PROD,
    sameSite: 'lax',
    path: '/',
    maxAge: 600, // 10 minutes
  });

  // Build the redirect URI from the current request origin
  const redirectUri = `${url.origin}/api/mimsy/auth/callback`;

  // Redirect to GitHub's OAuth authorization page
  const params = new URLSearchParams({
    client_id: clientId,
    scope: 'repo',
    state,
    redirect_uri: redirectUri,
  });

  const githubAuthUrl = `https://github.com/login/oauth/authorize?${params.toString()}`;

  return Response.redirect(githubAuthUrl, 302);
};

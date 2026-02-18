import type { APIRoute } from 'astro';
import config from 'virtual:mimsy/config';
import { getEnv } from '../../adapters/factory.js';

export const GET: APIRoute = async ({ url, cookies }) => {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  // Validate required params
  if (!code || !state) {
    return new Response(
      JSON.stringify({ error: 'Missing code or state parameter' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // CSRF validation: compare state param with stored cookie
  const storedState = cookies.get('mimsy_oauth_state')?.value;

  // Delete the state cookie regardless of outcome
  cookies.delete('mimsy_oauth_state', { path: '/' });

  if (!storedState || state !== storedState) {
    return new Response(
      JSON.stringify({ error: 'Invalid OAuth state — possible CSRF attack' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const clientId = getEnv('MIMSY_GITHUB_CLIENT_ID');
  const clientSecret = getEnv('MIMSY_GITHUB_CLIENT_SECRET');

  if (!clientId || !clientSecret) {
    return new Response(
      JSON.stringify({ error: 'GitHub OAuth credentials are not configured' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // Exchange the authorization code for an access token
  let accessToken: string;
  try {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
      }),
    });

    const tokenData = await tokenRes.json();

    if (tokenData.error || !tokenData.access_token) {
      console.error('[mimsy] Token exchange failed:', tokenData.error_description ?? tokenData.error);
      return new Response(
        JSON.stringify({
          error: 'Failed to exchange code for token',
          detail: tokenData.error_description ?? tokenData.error,
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }

    accessToken = tokenData.access_token;
  } catch (err) {
    console.error('[mimsy] Token exchange request failed:', err);
    return new Response(
      JSON.stringify({ error: 'Failed to communicate with GitHub' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // Verify the token works by fetching the user profile
  try {
    const userRes = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
      },
    });

    if (!userRes.ok) {
      console.error('[mimsy] User verification failed:', userRes.status);
      return new Response(
        JSON.stringify({ error: 'Failed to verify GitHub token' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // Token is valid — set the auth cookie
    cookies.set('mimsy_token', accessToken, {
      httpOnly: true,
      secure: import.meta.env.PROD,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 7, // 7 days
    });

    // Redirect to the admin dashboard
    return Response.redirect(new URL(config.basePath, url.origin).toString(), 302);
  } catch (err) {
    console.error('[mimsy] User verification request failed:', err);
    return new Response(
      JSON.stringify({ error: 'Failed to verify GitHub token' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
};

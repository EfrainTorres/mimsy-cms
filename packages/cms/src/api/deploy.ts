import type { APIRoute } from 'astro';
import { getEnv } from '../adapters/factory.js';

/** POST /api/mimsy/deploy — trigger deploy webhook (server-side proxy) */
export const POST: APIRoute = async () => {
  const hookUrl = getEnv('MIMSY_DEPLOY_HOOK_URL');
  if (!hookUrl) {
    return new Response(
      JSON.stringify({ error: 'Deploy hook not configured' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    );
  }

  try {
    const res = await fetch(hookUrl, { method: 'POST', signal: AbortSignal.timeout(15_000) });
    if (res.ok) {
      return new Response(
        JSON.stringify({ ok: true }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response(
      JSON.stringify({ error: `Deploy hook returned ${res.status}` }),
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    );
  } catch (e) {
    console.error('[mimsy] Deploy hook failed:', e);
    return new Response(
      JSON.stringify({ error: 'Failed to reach deploy hook' }),
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    );
  }
};

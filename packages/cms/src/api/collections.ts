import type { APIRoute } from 'astro';
import { LocalContentAdapter } from '../adapters/local.js';
import { resolveContentDir } from '../utils.js';

export const GET: APIRoute = async () => {
  const adapter = new LocalContentAdapter(resolveContentDir());
  const collections = await adapter.listCollections();
  return new Response(JSON.stringify({ collections }), {
    headers: { 'Content-Type': 'application/json' },
  });
};

import type { APIRoute } from 'astro';
import { createAdapter } from '../adapters/factory.js';

export const GET: APIRoute = async ({ request, locals }) => {
  const adapter = await createAdapter(request, locals);
  const collections = await adapter.listCollections();
  return new Response(JSON.stringify({ collections }), {
    headers: { 'Content-Type': 'application/json' },
  });
};

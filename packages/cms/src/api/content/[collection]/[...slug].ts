import type { APIRoute } from 'astro';
import { LocalContentAdapter } from '../../../adapters/local.js';
import { resolveContentDir } from '../../../utils.js';

/** GET /api/mimsy/content/[collection]/[slug] — get single entry with body */
export const GET: APIRoute = async ({ params }) => {
  const { collection, slug } = params;
  if (!collection || !slug) {
    return new Response(JSON.stringify({ error: 'Missing params' }), { status: 400 });
  }

  const adapter = new LocalContentAdapter(resolveContentDir());
  const entry = await adapter.getEntry(collection, slug);

  if (!entry) {
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
  }

  return new Response(JSON.stringify(entry), {
    headers: { 'Content-Type': 'application/json' },
  });
};

/** PUT /api/mimsy/content/[collection]/[slug] — update entry */
export const PUT: APIRoute = async ({ params, request }) => {
  const { collection, slug } = params;
  if (!collection || !slug) {
    return new Response(JSON.stringify({ error: 'Missing params' }), { status: 400 });
  }

  const body = await request.json();
  const { frontmatter, content } = body;

  if (!frontmatter) {
    return new Response(JSON.stringify({ error: 'Missing frontmatter' }), { status: 400 });
  }

  const adapter = new LocalContentAdapter(resolveContentDir());
  await adapter.updateEntry(collection, slug, frontmatter, content ?? '');

  return new Response(JSON.stringify({ slug, collection }), {
    headers: { 'Content-Type': 'application/json' },
  });
};

/** DELETE /api/mimsy/content/[collection]/[slug] — delete entry */
export const DELETE: APIRoute = async ({ params }) => {
  const { collection, slug } = params;
  if (!collection || !slug) {
    return new Response(JSON.stringify({ error: 'Missing params' }), { status: 400 });
  }

  const adapter = new LocalContentAdapter(resolveContentDir());
  await adapter.deleteEntry(collection, slug);

  return new Response(null, { status: 204 });
};

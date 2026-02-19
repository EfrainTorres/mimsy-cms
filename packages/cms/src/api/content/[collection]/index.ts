import type { APIRoute } from 'astro';
import { createAdapter } from '../../../adapters/factory.js';
import validators from 'virtual:mimsy/validators';
import { validateFrontmatter } from '../../../schema-validation.js';

/** GET /api/mimsy/content/[collection] — list entries (lightweight, no body) */
export const GET: APIRoute = async ({ params, request, locals }) => {
  const { collection } = params;
  if (!collection) {
    return new Response(JSON.stringify({ error: 'Missing collection' }), { status: 400 });
  }

  const adapter = await createAdapter(request, locals);
  const entries = await adapter.listEntries(collection);

  const list = entries.map((e) => ({
    slug: e.slug,
    collection: e.collection,
    frontmatter: e.frontmatter,
  }));

  return new Response(JSON.stringify({ entries: list }), {
    headers: { 'Content-Type': 'application/json' },
  });
};

/** POST /api/mimsy/content/[collection] — create entry */
export const POST: APIRoute = async ({ params, request, locals }) => {
  const { collection } = params;
  if (!collection) {
    return new Response(JSON.stringify({ error: 'Missing collection' }), { status: 400 });
  }

  let body: any;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400 });
  }
  const { slug, frontmatter, content } = body;

  if (!slug || !frontmatter) {
    return new Response(JSON.stringify({ error: 'Missing slug or frontmatter' }), { status: 400 });
  }

  const schema = validators[collection];
  if (schema) {
    const validation = await validateFrontmatter(schema, frontmatter);
    if (!validation.success) {
      return new Response(JSON.stringify({
        error: validation.error,
        fieldErrors: validation.fieldErrors,
      }), { status: 400 });
    }
  }

  const adapter = await createAdapter(request, locals);

  const existing = await adapter.getEntry(collection, slug);
  if (existing) {
    return new Response(JSON.stringify({ error: 'Entry already exists' }), { status: 409 });
  }

  await adapter.createEntry(collection, slug, frontmatter, content ?? '');

  return new Response(JSON.stringify({ slug, collection }), {
    status: 201,
    headers: { 'Content-Type': 'application/json' },
  });
};

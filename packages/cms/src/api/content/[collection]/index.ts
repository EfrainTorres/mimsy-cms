import type { APIRoute } from 'astro';
import { createAdapter } from '../../../adapters/factory.js';
import validators from 'virtual:mimsy/validators';
import { validateFrontmatter } from '../../../schema-validation.js';

// Collection names must be simple identifiers — no path separators or traversal sequences.
const VALID_COLLECTION = /^[a-zA-Z0-9_-]+$/;

/** GET /api/mimsy/content/[collection] — list entries (lightweight, no body) */
export const GET: APIRoute = async ({ params, request, locals }) => {
  const { collection } = params;
  if (!collection || !VALID_COLLECTION.test(collection)) {
    return new Response(JSON.stringify({ error: 'Invalid collection' }), { status: 400 });
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
  if (!collection || !VALID_COLLECTION.test(collection)) {
    return new Response(JSON.stringify({ error: 'Invalid collection' }), { status: 400 });
  }

  let body: any;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400 });
  }
  const { slug, frontmatter, content, isJson } = body;

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

  const validCollections = await adapter.listCollections();
  if (!validCollections.includes(collection)) {
    return new Response(JSON.stringify({ error: 'Collection not found' }), { status: 404 });
  }

  const existing = await adapter.getEntry(collection, slug);
  if (existing) {
    return new Response(JSON.stringify({ error: 'Entry already exists' }), { status: 409 });
  }

  try {
    await adapter.createEntry(collection, slug, frontmatter, content ?? '', isJson === true ? 'json' : undefined);
  } catch (err: any) {
    if (err?.status === 400) {
      return new Response(JSON.stringify({ error: 'Invalid path' }), { status: 400 });
    }
    throw err;
  }

  return new Response(JSON.stringify({ slug, collection }), {
    status: 201,
    headers: { 'Content-Type': 'application/json' },
  });
};

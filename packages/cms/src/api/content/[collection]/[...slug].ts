import type { APIRoute } from 'astro';
import { createAdapter } from '../../../adapters/factory.js';
import { ConflictError } from '../../../types.js';
import validators from 'virtual:mimsy/validators';
import { validateFrontmatter } from '../../../schema-validation.js';

// Collection names must be simple identifiers — no path separators or traversal sequences.
const VALID_COLLECTION = /^[a-zA-Z0-9_-]+$/;

/** GET /api/mimsy/content/[collection]/[slug] — get single entry with body */
export const GET: APIRoute = async ({ params, request, locals }) => {
  const { collection, slug } = params;
  if (!collection || !slug || !VALID_COLLECTION.test(collection)) {
    return new Response(JSON.stringify({ error: 'Missing params' }), { status: 400 });
  }

  const adapter = await createAdapter(request, locals);
  const entry = await adapter.getEntry(collection, slug);

  if (!entry) {
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
  }

  return new Response(JSON.stringify(entry), {
    headers: { 'Content-Type': 'application/json' },
  });
};

/** PUT /api/mimsy/content/[collection]/[slug] — update entry */
export const PUT: APIRoute = async ({ params, request, locals }) => {
  const { collection, slug } = params;
  if (!collection || !slug || !VALID_COLLECTION.test(collection)) {
    return new Response(JSON.stringify({ error: 'Missing params' }), { status: 400 });
  }

  let body: any;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400 });
  }
  const { frontmatter, content } = body;

  if (!frontmatter) {
    return new Response(JSON.stringify({ error: 'Missing frontmatter' }), { status: 400 });
  }

  let cleanedFrontmatter = frontmatter;
  const schema = validators[collection];
  if (schema) {
    const validation = await validateFrontmatter(schema, frontmatter);
    if (!validation.success) {
      return new Response(JSON.stringify({
        error: validation.error,
        fieldErrors: validation.fieldErrors,
      }), { status: 400 });
    }
    cleanedFrontmatter = validation.data;
  }

  const adapter = await createAdapter(request, locals);

  try {
    await adapter.updateEntry(collection, slug, cleanedFrontmatter, content ?? '');
  } catch (err: any) {
    if (err instanceof ConflictError) {
      return new Response(JSON.stringify({ error: err.message }), { status: 409 });
    }
    if (err?.status === 400) {
      return new Response(JSON.stringify({ error: 'Invalid path' }), { status: 400 });
    }
    throw err;
  }

  return new Response(JSON.stringify({ slug, collection }), {
    headers: { 'Content-Type': 'application/json' },
  });
};

/** DELETE /api/mimsy/content/[collection]/[slug] — delete entry */
export const DELETE: APIRoute = async ({ params, request, locals }) => {
  const { collection, slug } = params;
  if (!collection || !slug || !VALID_COLLECTION.test(collection)) {
    return new Response(JSON.stringify({ error: 'Missing params' }), { status: 400 });
  }

  const adapter = await createAdapter(request, locals);

  try {
    await adapter.deleteEntry(collection, slug);
  } catch (err: any) {
    if (err instanceof ConflictError) {
      return new Response(JSON.stringify({ error: err.message }), { status: 409 });
    }
    if (err?.status === 400) {
      return new Response(JSON.stringify({ error: 'Invalid path' }), { status: 400 });
    }
    throw err;
  }

  return new Response(null, { status: 204 });
};

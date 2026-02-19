import type { APIRoute } from 'astro';
import { createAdapter } from '../../adapters/factory.js';
import { extractTextFields, extractCollectionRefs, applyTextEdits } from '../../page-scanner.js';
import { ConflictError } from '../../types.js';

function validatePagePath(path: string | undefined): string | null {
  if (!path) return null;
  const normalized = path.replace(/\\/g, '/');
  if (!normalized.endsWith('.astro')) return null;
  if (normalized.includes('..')) return null;
  if (!/^[\w\-\/.]+\.astro$/.test(normalized)) return null;
  return normalized;
}

/** GET /api/mimsy/page-text/[...path] — extract editable text fields from a page */
export const GET: APIRoute = async ({ params, request, locals }) => {
  const pagePath = validatePagePath(params.path);
  if (!pagePath) {
    return new Response(JSON.stringify({ error: 'Invalid path' }), { status: 400 });
  }

  const adapter = await createAdapter(request, locals);
  const source = await adapter.getProjectFile(`src/pages/${pagePath}`);
  if (!source) {
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
  }

  const fields = await extractTextFields(source);
  const collectionRefs = extractCollectionRefs(source);

  return new Response(JSON.stringify({ fields, collectionRefs }), {
    headers: { 'Content-Type': 'application/json' },
  });
};

/** PUT /api/mimsy/page-text/[...path] — apply text edits to a page */
export const PUT: APIRoute = async ({ params, request, locals }) => {
  const pagePath = validatePagePath(params.path);
  if (!pagePath) {
    return new Response(JSON.stringify({ error: 'Invalid path' }), { status: 400 });
  }

  let body: any;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400 });
  }
  const { edits } = body;
  if (!Array.isArray(edits) || edits.length === 0) {
    return new Response(JSON.stringify({ error: 'No edits' }), { status: 400 });
  }

  const adapter = await createAdapter(request, locals);
  const fullPath = `src/pages/${pagePath}`;
  const source = await adapter.getProjectFile(fullPath);
  if (!source) {
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
  }

  const updated = await applyTextEdits(source, edits);

  try {
    await adapter.writeProjectFile(fullPath, updated);
  } catch (err) {
    if (err instanceof ConflictError) {
      return new Response(JSON.stringify({ error: err.message }), { status: 409 });
    }
    throw err;
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
};

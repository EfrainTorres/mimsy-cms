import type { APIRoute } from 'astro';
import { createAdapter } from '../../../adapters/factory.js';
import { ConflictError } from '../../../types.js';
import type { SchemaField } from '../../../types.js';
import validators from 'virtual:mimsy/validators';
import schemas from 'virtual:mimsy/schemas';
import { validateFrontmatter } from '../../../schema-validation.js';

// Collection names must be simple identifiers — no path separators or traversal sequences.
const VALID_COLLECTION = /^[a-zA-Z0-9_-]+$/;
const VALID_SLUG = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

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

/** PATCH /api/mimsy/content/[collection]/[slug] — rename or partial frontmatter update */
export const PATCH: APIRoute = async ({ params, request, locals }) => {
  const { collection, slug } = params;
  if (!collection || !slug || !VALID_COLLECTION.test(collection)) {
    return new Response(JSON.stringify({ error: 'Missing params' }), { status: 400 });
  }

  let body: any;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400 });
  }

  const adapter = await createAdapter(request, locals);

  // --- Rename operation ---
  if (body.newSlug) {
    const newSlug: string = body.newSlug;
    if (!VALID_SLUG.test(newSlug)) {
      return new Response(JSON.stringify({ error: 'Invalid slug format' }), { status: 400 });
    }
    if (newSlug === slug) {
      return new Response(JSON.stringify({ error: 'New slug is the same as current' }), { status: 400 });
    }

    const existing = await adapter.getEntry(collection, newSlug);
    if (existing) {
      return new Response(JSON.stringify({ error: 'An entry with this slug already exists' }), { status: 409 });
    }

    const entry = await adapter.getEntry(collection, slug);
    if (!entry) {
      return new Response(JSON.stringify({ error: 'Entry not found' }), { status: 404 });
    }

    try {
      // Create new entry first
      await adapter.createEntry(collection, newSlug, entry.frontmatter, entry.body);

      // Scan and update references if requested
      let referencesUpdated = 0;
      if (body.updateReferences !== false) {
        try {
          referencesUpdated = await updateReferences(adapter, collection, slug, newSlug);
        } catch {
          // Non-fatal: references not updated, but rename still proceeds
        }
      }

      // Delete old entry — if this fails, clean up the new entry
      try {
        await adapter.deleteEntry(collection, slug);
      } catch (delErr) {
        // Rollback: remove the newly created entry to avoid duplicates
        try { await adapter.deleteEntry(collection, newSlug); } catch {}
        throw delErr;
      }

      return new Response(JSON.stringify({ slug: newSlug, collection, referencesUpdated }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err: any) {
      if (err instanceof ConflictError) {
        return new Response(JSON.stringify({ error: err.message }), { status: 409 });
      }
      if (err?.status === 400) {
        return new Response(JSON.stringify({ error: 'Invalid path' }), { status: 400 });
      }
      throw err;
    }
  }

  // --- Partial frontmatter update ---
  if (body.frontmatter && typeof body.frontmatter === 'object') {
    const entry = await adapter.getEntry(collection, slug);
    if (!entry) {
      return new Response(JSON.stringify({ error: 'Entry not found' }), { status: 404 });
    }

    let merged = { ...entry.frontmatter, ...body.frontmatter };

    // Validate merged frontmatter against schema if available
    const schema = validators[collection];
    if (schema) {
      const validation = await validateFrontmatter(schema, merged);
      if (!validation.success) {
        return new Response(JSON.stringify({
          error: validation.error,
          fieldErrors: validation.fieldErrors,
        }), { status: 400 });
      }
      merged = validation.data;
    }

    try {
      await adapter.updateEntry(collection, slug, merged, entry.body);
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
  }

  return new Response(JSON.stringify({ error: 'Must provide newSlug or frontmatter' }), { status: 400 });
};

/**
 * Scan all collections for reference fields pointing to the renamed collection,
 * and update entries that reference the old slug to use the new slug.
 */
async function updateReferences(
  adapter: any,
  targetCollection: string,
  oldSlug: string,
  newSlug: string,
): Promise<number> {
  let updated = 0;

  // Find all reference fields across all collections that point to the target collection
  for (const [colName, colSchema] of Object.entries(schemas as Record<string, SchemaField[]>)) {
    const refFields = findReferenceFields(colSchema, targetCollection);
    if (refFields.length === 0) continue;

    const entries = await adapter.listEntries(colName);
    for (const entry of entries) {
      let changed = false;
      const fm = { ...entry.frontmatter };

      for (const { path, isArray } of refFields) {
        const val = getNestedValue(fm, path);
        if (isArray && Array.isArray(val)) {
          const idx = val.indexOf(oldSlug);
          if (idx !== -1) {
            val[idx] = newSlug;
            changed = true;
          }
        } else if (val === oldSlug) {
          setNestedValue(fm, path, newSlug);
          changed = true;
        }
      }

      if (changed) {
        const full = await adapter.getEntry(colName, entry.slug);
        if (full) {
          await adapter.updateEntry(colName, entry.slug, fm, full.body);
          updated++;
        }
      }
    }
  }

  return updated;
}

/** Find all reference field paths in a schema that point to a given collection. */
function findReferenceFields(
  fields: SchemaField[],
  targetCollection: string,
  prefix = '',
): Array<{ path: string; isArray: boolean }> {
  const result: Array<{ path: string; isArray: boolean }> = [];
  for (const f of fields) {
    const path = prefix ? `${prefix}.${f.name}` : f.name;
    if (f.type === 'reference' && f.referenceCollection === targetCollection) {
      result.push({ path, isArray: false });
    }
    if (f.type === 'array' && f.arrayItemType?.type === 'reference' && f.arrayItemType.referenceCollection === targetCollection) {
      result.push({ path, isArray: true });
    }
    if (f.type === 'array' && f.arrayItemType?.objectFields) {
      result.push(...findReferenceFields(f.arrayItemType.objectFields, targetCollection, `${path}[]`));
    }
    if (f.objectFields) {
      result.push(...findReferenceFields(f.objectFields, targetCollection, path));
    }
  }
  return result;
}

function getNestedValue(obj: any, path: string): unknown {
  return path.split('.').reduce((o, k) => o?.[k], obj);
}

function setNestedValue(obj: any, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null) return;
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

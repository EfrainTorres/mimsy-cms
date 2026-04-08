import type { APIRoute } from 'astro';
import { readdirSync, statSync } from 'node:fs';
import { join, basename, sep } from 'node:path';
import config from 'virtual:mimsy/config';
import { getEnv } from '../../adapters/factory.js';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' },
  });
}

// --- GET: List media objects ---
export const GET: APIRoute = async ({ url, locals }) => {
  const cursor = url.searchParams.get('cursor') ?? undefined;
  const prefix = config.media?.prefix ?? 'uploads/';
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 200);

  const bucketName = config.media?.bucket ?? '';
  const bucket = bucketName ? (locals as any)?.runtime?.env?.[bucketName] ?? null : null;
  const useR2 = config.media?.storage === 'r2' && bucket !== null;

  // GitHub mode without R2 — library unavailable
  if (getEnv('MIMSY_GITHUB_REPO') && !useR2) {
    return json({ objects: [], cursor: null, hasMore: false, unavailable: true });
  }

  if (useR2) {
    try {
      const listed = await bucket.list({
        prefix,
        limit: limit + 1,
        cursor: cursor || undefined,
      });

      const hasMore = listed.objects.length > limit;
      const objects = listed.objects.slice(0, limit).map((obj: any) => ({
        key: obj.key,
        url: `${config.media!.publicUrl.replace(/\/$/, '')}/${obj.key.split('/').map(encodeURIComponent).join('/')}`,
        filename: basename(obj.key),
        size: obj.size ?? 0,
        contentType: obj.httpMetadata?.contentType ?? 'image/jpeg',
        uploaded: obj.uploaded?.toISOString() ?? new Date(0).toISOString(),
      }));

      return json({
        objects,
        cursor: hasMore ? (listed.cursor ?? null) : null,
        hasMore,
      });
    } catch (err) {
      console.error('[mimsy] R2 list error:', err);
      return json({ error: 'Failed to list media' }, 500);
    }
  }

  // Local filesystem — single page, no cursor needed
  try {
    const uploadsDir = join(process.cwd(), 'src', 'assets', 'uploads');
    let files: string[] = [];
    try {
      files = readdirSync(uploadsDir);
    } catch {
      // Directory doesn't exist yet — empty library
    }

    const objects = files
      .filter(f => !f.startsWith('.'))
      .map(f => {
        const filePath = join(uploadsDir, f);
        let size = 0;
        let mtime = new Date(0);
        try {
          const stat = statSync(filePath);
          size = stat.size;
          mtime = stat.mtime;
        } catch {}
        const ext = f.split('.').pop()?.toLowerCase() ?? '';
        const mimeMap: Record<string, string> = {
          png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
          gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
          avif: 'image/avif',
        };
        return {
          key: `src/assets/uploads/${f}`,
          url: `/src/assets/uploads/${f}`,
          filename: f,
          size,
          contentType: mimeMap[ext] ?? 'image/jpeg',
          uploaded: mtime.toISOString(),
        };
      })
      .sort((a, b) => b.uploaded.localeCompare(a.uploaded)); // newest first

    return json({ objects, cursor: null, hasMore: false });
  } catch (err) {
    console.error('[mimsy] Local media list error:', err);
    return json({ error: 'Failed to list media' }, 500);
  }
};

// --- DELETE: Delete a media object ---
export const DELETE: APIRoute = async ({ url, locals }) => {
  const raw = url.searchParams.get('key') ?? '';
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return json({ error: 'Invalid key' }, 400);
  }
  const normalized = decoded.replace(/\\/g, '/').replace(/\/+/g, '/');
  const bucketName = config.media?.bucket ?? '';
  const bucket = bucketName ? (locals as any)?.runtime?.env?.[bucketName] ?? null : null;
  const useR2 = config.media?.storage === 'r2' && bucket !== null;

  // Key validation — prefix differs by mode. Trailing slash required to prevent
  // startsWith boundary bypass (e.g. 'src/assets/uploads-evil/' passing 'src/assets/uploads').
  const expectedPrefix = useR2
    ? (config.media?.prefix ?? 'uploads/').replace(/\/$/, '') + '/'
    : 'src/assets/uploads/';
  if (!normalized || normalized.includes('..') || !normalized.startsWith(expectedPrefix)) {
    return json({ error: 'Invalid key' }, 400);
  }

  if (useR2) {
    try {
      await bucket.delete(normalized);
      return new Response(null, { status: 204 });
    } catch (err) {
      console.error('[mimsy] R2 delete error:', err);
      return json({ error: 'Delete failed' }, 500);
    }
  }

  // Local filesystem
  try {
    const { unlink } = await import('node:fs/promises');
    const filename = basename(normalized);
    const filePath = join(process.cwd(), 'src', 'assets', 'uploads', filename);
    // Confirm the resolved path stays within uploads dir
    if (!filePath.startsWith(join(process.cwd(), 'src', 'assets', 'uploads') + sep)) {
      return json({ error: 'Invalid key' }, 400);
    }
    await unlink(filePath);
    return new Response(null, { status: 204 });
  } catch (err: any) {
    if (err.code === 'ENOENT') return new Response(null, { status: 204 }); // already gone
    console.error('[mimsy] Local delete error:', err);
    return json({ error: 'Delete failed' }, 500);
  }
};

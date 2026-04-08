import type { APIRoute } from 'astro';
import { createAdapter } from '../adapters/factory.js';
import { mediaUrl } from '../utils/media-url.js';
import config from 'virtual:mimsy/config';

const DEFAULT_MAX_FILE_SIZE_LOCAL = 10 * 1024 * 1024;  // 10MB
const DEFAULT_MAX_FILE_SIZE_R2    = 50 * 1024 * 1024;  // 50MB

function err(message: string, status: number): Response {
  return new Response(
    JSON.stringify({ error: message }),
    { status, headers: { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' } },
  );
}

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    // Determine storage mode early for size limit
    const bucketName = config.media?.bucket ?? '';
    const bucket = bucketName ? (locals as any)?.runtime?.env?.[bucketName] ?? null : null;
    const useR2 = config.media?.storage === 'r2' && bucket !== null;
    const defaultMax = useR2 ? DEFAULT_MAX_FILE_SIZE_R2 : DEFAULT_MAX_FILE_SIZE_LOCAL;
    const maxFileSize: number = config.media?.maxFileSize ?? defaultMax;

    // Require Content-Length — browsers always send it for file uploads.
    // Rejecting absent/oversized headers prevents buffering unknown-size bodies.
    const contentLength = request.headers.get('content-length');
    if (!contentLength) {
      return err('Content-Length header required', 411);
    }
    if (Number(contentLength) > maxFileSize) {
      return err(`File too large. Maximum size is ${Math.round(maxFileSize / 1024 / 1024)}MB.`, 400);
    }

    const contentType = request.headers.get('content-type') ?? '';
    if (!contentType.includes('multipart/form-data')) {
      return err('Expected multipart/form-data', 400);
    }

    const formData = await request.formData();
    const file = formData.get('file');

    if (!file || !(file instanceof File)) {
      return err('Missing file field', 400);
    }

    // Validate MIME type — image/* only, SVG excluded (can contain executable JavaScript)
    if (!file.type.startsWith('image/') || file.type === 'image/svg+xml') {
      return err('Only raster image files are allowed (PNG, JPEG, WebP, GIF, AVIF).', 400);
    }

    // Validate file size (post-parse, catches mismatched Content-Length)
    if (file.size > maxFileSize) {
      return err(`File too large. Maximum size is ${Math.round(maxFileSize / 1024 / 1024)}MB.`, 400);
    }

    // Collision-safe filename: timestamp + uuid8 + sanitized name
    const uid = crypto.randomUUID().slice(0, 8);
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const filename = `${Date.now()}-${uid}-${safeName}`;

    const bytes = new Uint8Array(await file.arrayBuffer());

    let url: string;
    let key: string;

    if (useR2) {
      const prefix = config.media!.prefix ?? 'uploads/';
      key = prefix.replace(/\/$/, '') + '/' + filename;
      await bucket.put(key, bytes, {
        httpMetadata: {
          contentType: file.type,
          cacheControl: 'public, max-age=31536000, immutable',
        },
      });
      url = mediaUrl(config.media!.publicUrl, prefix, filename);
    } else {
      // Fallback: local filesystem via adapter
      const adapter = await createAdapter(request, locals);
      url = await adapter.writeAsset(`src/assets/uploads/${filename}`, bytes, filename);
      key = `src/assets/uploads/${filename}`;
    }

    return new Response(
      JSON.stringify({ url, key }),
      { status: 200, headers: { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' } },
    );
  } catch (e) {
    console.error('Upload error:', e);
    return err('Upload failed', 500);
  }
};

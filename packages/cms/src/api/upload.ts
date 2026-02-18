import type { APIRoute } from 'astro';
import { resolveContentDir } from '../utils.js';
import { join, dirname } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

const ALLOWED_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
]);

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

export const POST: APIRoute = async ({ request }) => {
  try {
    const contentType = request.headers.get('content-type') ?? '';
    if (!contentType.includes('multipart/form-data')) {
      return new Response(
        JSON.stringify({ error: 'Expected multipart/form-data' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }

    const formData = await request.formData();
    const file = formData.get('file');

    if (!file || !(file instanceof File)) {
      return new Response(
        JSON.stringify({ error: 'Missing file field' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // Validate MIME type
    if (!ALLOWED_MIME_TYPES.has(file.type)) {
      return new Response(
        JSON.stringify({ error: `Invalid file type: ${file.type}. Allowed: ${[...ALLOWED_MIME_TYPES].join(', ')}` }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      return new Response(
        JSON.stringify({ error: `File too large. Maximum size is 10MB.` }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // Derive upload directory from content dir.
    // Content dir is {projectRoot}/src/data — go up two levels to {projectRoot}, then into src/assets/uploads
    const contentDir = resolveContentDir();
    const projectRoot = dirname(dirname(contentDir)); // up from src/data to projectRoot
    const uploadDir = join(projectRoot, 'src', 'assets', 'uploads');

    // Ensure upload directory exists
    await mkdir(uploadDir, { recursive: true });

    // Generate unique filename: {timestamp}-{originalName}
    const timestamp = Date.now();
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const filename = `${timestamp}-${safeName}`;

    // Write file to disk
    const buffer = Buffer.from(await file.arrayBuffer());
    const filePath = join(uploadDir, filename);
    await writeFile(filePath, buffer);

    // Return Vite root-relative path
    const url = `/src/assets/uploads/${filename}`;

    return new Response(
      JSON.stringify({ url }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    console.error('Upload error:', err);
    return new Response(
      JSON.stringify({ error: 'Upload failed' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
};

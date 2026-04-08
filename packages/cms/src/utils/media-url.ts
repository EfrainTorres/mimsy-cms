/**
 * Build a media URL from its parts, avoiding double-slash bugs.
 * Works for both R2 public URLs and local paths.
 */
export function mediaUrl(publicUrl: string, prefix: string, filename: string): string {
  const base = publicUrl.replace(/\/$/, '');
  const pfx = prefix.replace(/^\//, '').replace(/\/$/, '');
  const path = [pfx, filename].filter(Boolean).join('/');
  return `${base}/${path}`;
}

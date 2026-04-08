import type { APIRoute } from 'astro';
import config from 'virtual:mimsy/config';
import { invalidateToken } from '../../auth-cache.js';

export const GET: APIRoute = async ({ cookies, url }) => {
  const token = cookies.get('mimsy_token')?.value;
  if (token) invalidateToken(token);
  cookies.delete('mimsy_token', { path: '/' });

  // Redirect to the admin base path (will hit middleware -> login redirect)
  return Response.redirect(new URL(config.basePath, url.origin).toString(), 302);
};

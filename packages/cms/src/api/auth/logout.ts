import type { APIRoute } from 'astro';
import config from 'virtual:mimsy/config';

export const GET: APIRoute = async ({ cookies, url }) => {
  // Delete the auth cookie
  cookies.delete('mimsy_token', { path: '/' });

  // Redirect to the admin base path (will hit middleware -> login redirect)
  return Response.redirect(new URL(config.basePath, url.origin).toString(), 302);
};

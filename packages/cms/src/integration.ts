import type { AstroIntegration } from 'astro';
import type { MimsyConfig, ResolvedMimsyConfig } from './types.js';
import { vitePluginMimsy } from './vite-plugin.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL as NodeURL } from 'node:url';

function resolveConfig(userConfig: MimsyConfig): ResolvedMimsyConfig {
  return {
    basePath: userConfig.basePath ?? '/admin',
    contentDir: userConfig.contentDir,
  };
}

/** Parse a .env file into key-value pairs. Returns empty object if file doesn't exist. */
function readDotEnv(filePath: string): Record<string, string> {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const env: Record<string, string> = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      // Strip surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      env[key] = val;
    }
    return env;
  } catch {
    return {};
  }
}

export function createMimsyIntegration(userConfig: MimsyConfig): AstroIntegration {
  const config = resolveConfig(userConfig);
  const base = config.basePath;

  return {
    name: '@mimsy/cms',
    hooks: {
      'astro:config:setup': ({ injectRoute, updateConfig, config: astroConfig, logger, addMiddleware }) => {
        logger.info('Setting up MimsyCMS...');

        // Read .env for startup validation — Vite hasn't populated process.env yet
        const env = readDotEnv(fileURLToPath(new NodeURL('.env', astroConfig.root)));

        // Validate GitHub mode config
        const ghRepo = env.MIMSY_GITHUB_REPO ?? process.env.MIMSY_GITHUB_REPO;
        if (ghRepo) {
          const missing: string[] = [];
          if (!env.MIMSY_GITHUB_CLIENT_ID && !process.env.MIMSY_GITHUB_CLIENT_ID) missing.push('MIMSY_GITHUB_CLIENT_ID');
          if (!env.MIMSY_GITHUB_CLIENT_SECRET && !process.env.MIMSY_GITHUB_CLIENT_SECRET) missing.push('MIMSY_GITHUB_CLIENT_SECRET');
          if (missing.length > 0) {
            logger.warn(
              `GitHub mode is enabled (MIMSY_GITHUB_REPO=${ghRepo}) but missing env vars: ${missing.join(', ')}. ` +
              `Auth will fail at runtime unless these are set in your deployment environment.`
            );
          }
          logger.info('GitHub mode enabled');
        }

        // Inject admin pages
        injectRoute({ pattern: base, entrypoint: '@mimsy/cms/src/pages/admin/index.astro', prerender: false });
        injectRoute({ pattern: `${base}/_page/[...path]`, entrypoint: '@mimsy/cms/src/pages/admin/_page/[...path].astro', prerender: false });
        injectRoute({ pattern: `${base}/[collection]`, entrypoint: '@mimsy/cms/src/pages/admin/[collection]/index.astro', prerender: false });
        injectRoute({ pattern: `${base}/[collection]/new`, entrypoint: '@mimsy/cms/src/pages/admin/[collection]/new.astro', prerender: false });
        injectRoute({ pattern: `${base}/[collection]/[...slug]`, entrypoint: '@mimsy/cms/src/pages/admin/[collection]/[...slug].astro', prerender: false });

        // Inject content API routes
        injectRoute({ pattern: '/api/mimsy/collections', entrypoint: '@mimsy/cms/src/api/collections.ts', prerender: false });
        injectRoute({ pattern: '/api/mimsy/content/[collection]', entrypoint: '@mimsy/cms/src/api/content/[collection]/index.ts', prerender: false });
        injectRoute({ pattern: '/api/mimsy/content/[collection]/[...slug]', entrypoint: '@mimsy/cms/src/api/content/[collection]/[...slug].ts', prerender: false });
        injectRoute({ pattern: '/api/mimsy/upload', entrypoint: '@mimsy/cms/src/api/upload.ts', prerender: false });
        injectRoute({ pattern: '/api/mimsy/page-text/[...path]', entrypoint: '@mimsy/cms/src/api/page-text/[...path].ts', prerender: false });

        // Inject auth API routes
        injectRoute({ pattern: '/api/mimsy/auth/login', entrypoint: '@mimsy/cms/src/api/auth/login.ts', prerender: false });
        injectRoute({ pattern: '/api/mimsy/auth/callback', entrypoint: '@mimsy/cms/src/api/auth/callback.ts', prerender: false });
        injectRoute({ pattern: '/api/mimsy/auth/logout', entrypoint: '@mimsy/cms/src/api/auth/logout.ts', prerender: false });
        injectRoute({ pattern: '/api/mimsy/auth/me', entrypoint: '@mimsy/cms/src/api/auth/me.ts', prerender: false });

        // Add auth middleware (passes through in local mode)
        addMiddleware({
          entrypoint: '@mimsy/cms/src/middleware.ts',
          order: 'pre',
        });

        // Register Vite plugin for virtual modules
        updateConfig({
          vite: {
            plugins: [vitePluginMimsy(config, astroConfig)],
          },
        });

        logger.info(`Admin UI will be at ${base}`);
      },
    },
  };
}

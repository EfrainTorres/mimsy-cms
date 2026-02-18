import type { AstroIntegration } from 'astro';
import type { MimsyConfig, ResolvedMimsyConfig } from './types.js';
import { vitePluginMimsy } from './vite-plugin.js';

function resolveConfig(userConfig: MimsyConfig): ResolvedMimsyConfig {
  return {
    basePath: userConfig.basePath ?? '/admin',
    contentDir: userConfig.contentDir,
  };
}

export function createMimsyIntegration(userConfig: MimsyConfig): AstroIntegration {
  const config = resolveConfig(userConfig);
  const base = config.basePath;

  return {
    name: '@mimsy/cms',
    hooks: {
      'astro:config:setup': ({ injectRoute, updateConfig, config: astroConfig, logger }) => {
        logger.info('Setting up MimsyCMS...');

        // Inject admin pages
        injectRoute({ pattern: base, entrypoint: '@mimsy/cms/src/pages/admin/index.astro', prerender: false });
        injectRoute({ pattern: `${base}/[collection]`, entrypoint: '@mimsy/cms/src/pages/admin/[collection]/index.astro', prerender: false });
        injectRoute({ pattern: `${base}/[collection]/new`, entrypoint: '@mimsy/cms/src/pages/admin/[collection]/new.astro', prerender: false });
        injectRoute({ pattern: `${base}/[collection]/[...slug]`, entrypoint: '@mimsy/cms/src/pages/admin/[collection]/[...slug].astro', prerender: false });

        // Inject API routes
        injectRoute({ pattern: '/api/mimsy/collections', entrypoint: '@mimsy/cms/src/api/collections.ts', prerender: false });
        injectRoute({ pattern: '/api/mimsy/content/[collection]', entrypoint: '@mimsy/cms/src/api/content/[collection]/index.ts', prerender: false });
        injectRoute({ pattern: '/api/mimsy/content/[collection]/[...slug]', entrypoint: '@mimsy/cms/src/api/content/[collection]/[...slug].ts', prerender: false });
        injectRoute({ pattern: '/api/mimsy/upload', entrypoint: '@mimsy/cms/src/api/upload.ts', prerender: false });

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

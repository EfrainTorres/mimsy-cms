import type { Plugin } from 'vite';
import type { AstroConfig } from 'astro';
import type { ResolvedMimsyConfig } from './types.js';

const VIRTUAL_CONFIG = 'virtual:mimsy/config';
const RESOLVED_CONFIG = '\0' + VIRTUAL_CONFIG;

const VIRTUAL_SCHEMAS = 'virtual:mimsy/schemas';
const RESOLVED_SCHEMAS = '\0' + VIRTUAL_SCHEMAS;

export function vitePluginMimsy(
  mimsyConfig: ResolvedMimsyConfig,
  astroConfig: AstroConfig
): Plugin {
  const srcDir = astroConfig.srcDir ? new URL('.', astroConfig.srcDir).pathname : './src';
  const contentDir = mimsyConfig.contentDir ?? `${srcDir}/data`;

  const configModule = `export default {
  basePath: ${JSON.stringify(mimsyConfig.basePath)},
  contentDir: ${JSON.stringify(contentDir)},
  get isGitHubMode() { return !!import.meta.env.MIMSY_GITHUB_REPO; },
};`;

  // virtual:mimsy/schemas generates code that imports the user's content config
  // and runs schema introspection at build/dev time
  const schemasModule = `
import { introspectCollections } from '@mimsy/cms/src/schema-introspection.js';
let schemas = {};
try {
  const mod = await import('/src/content.config.ts');
  if (mod.collections) {
    schemas = introspectCollections(mod.collections);
  }
} catch (e) {
  console.warn('[mimsy] Could not introspect content schemas:', e?.message ?? e);
}
export default schemas;
`;

  return {
    name: 'vite-plugin-mimsy',
    resolveId(id) {
      if (id === VIRTUAL_CONFIG) return RESOLVED_CONFIG;
      if (id === VIRTUAL_SCHEMAS) return RESOLVED_SCHEMAS;
    },
    load(id) {
      if (id === RESOLVED_CONFIG) return configModule;
      if (id === RESOLVED_SCHEMAS) return schemasModule;
    },
  };
}

import type { Plugin, ViteDevServer } from 'vite';
import type { AstroConfig } from 'astro';
import type { ResolvedMimsyConfig } from './types.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';

const VIRTUAL_CONFIG = 'virtual:mimsy/config';
const RESOLVED_CONFIG = '\0' + VIRTUAL_CONFIG;

const VIRTUAL_SCHEMAS = 'virtual:mimsy/schemas';
const RESOLVED_SCHEMAS = '\0' + VIRTUAL_SCHEMAS;

const VIRTUAL_VALIDATORS = 'virtual:mimsy/validators';
const RESOLVED_VALIDATORS = '\0' + VIRTUAL_VALIDATORS;

const VIRTUAL_PAGES = 'virtual:mimsy/pages';
const RESOLVED_PAGES = '\0' + VIRTUAL_PAGES;

export function vitePluginMimsy(
  mimsyConfig: ResolvedMimsyConfig,
  astroConfig: AstroConfig
): Plugin {
  // Use fileURLToPath to avoid percent-encoding of spaces in project paths
  const srcDir = astroConfig.srcDir ? fileURLToPath(new URL('.', astroConfig.srcDir)) : './src';
  const contentDir = mimsyConfig.contentDir ?? `${srcDir}/data`;

  const configModule = `export default {
  basePath: ${JSON.stringify(mimsyConfig.basePath)},
  contentDir: ${JSON.stringify(contentDir)},
  media: ${JSON.stringify(mimsyConfig.media ?? null)},
  get isGitHubMode() { return !!import.meta.env.MIMSY_GITHUB_REPO; },
};`;

  // virtual:mimsy/schemas generates code that imports the user's content config
  // and runs schema introspection at build/dev time.
  // Tries multiple extensions to match validatorsModule behavior.
  const schemasModule = `
import { introspectCollections } from '@mimsy/cms/src/schema-introspection.js';
let schemas = {};
try {
  let mod = null;
  try { mod = await import('/src/content.config.ts'); } catch {}
  if (!mod) try { mod = await import('/src/content.config.mts'); } catch {}
  if (!mod) try { mod = await import('/src/content.config.js'); } catch {}
  if (!mod) try { mod = await import('/src/content.config.mjs'); } catch {}
  if (mod?.collections) {
    schemas = introspectCollections(mod.collections);
  }
} catch (e) {
  console.warn('[mimsy] Could not introspect content schemas:', e?.message ?? e);
}
export default schemas;
`;

  // virtual:mimsy/validators exports raw Zod schemas (with references cleaned)
  // for server-side validation in API routes.
  // Static import paths so Vite can resolve them (no string concatenation).
  const validatorsModule = `
import { extractValidators } from '@mimsy/cms/src/schema-validation.js';
let validators = {};
try {
  let mod = null;
  try { mod = await import('/src/content.config.ts'); } catch {}
  if (!mod) try { mod = await import('/src/content.config.mts'); } catch {}
  if (!mod) try { mod = await import('/src/content.config.js'); } catch {}
  if (!mod) try { mod = await import('/src/content.config.mjs'); } catch {}
  if (mod?.collections) {
    validators = extractValidators(mod.collections);
  }
} catch (e) {
  console.warn('[mimsy] Could not extract validators:', e?.message ?? e);
}
export default validators;
`;

  const pagesDir = `${srcDir}/pages`;
  const pagesModule = `
import { scanPagesDirectory } from '@mimsy/cms/src/page-scanner.js';
let pages = [];
try {
  pages = scanPagesDirectory(${JSON.stringify(pagesDir)}, ${JSON.stringify(mimsyConfig.basePath)});
} catch (e) {
  console.warn('[mimsy] Could not scan pages:', e?.message ?? e);
}
export default pages;
`;

  return {
    name: 'vite-plugin-mimsy',
    resolveId(id) {
      if (id === VIRTUAL_CONFIG) return RESOLVED_CONFIG;
      if (id === VIRTUAL_SCHEMAS) return RESOLVED_SCHEMAS;
      if (id === VIRTUAL_VALIDATORS) return RESOLVED_VALIDATORS;
      if (id === VIRTUAL_PAGES) return RESOLVED_PAGES;
    },
    load(id) {
      if (id === RESOLVED_CONFIG) return configModule;
      if (id === RESOLVED_SCHEMAS) return schemasModule;
      if (id === RESOLVED_VALIDATORS) return validatorsModule;
      if (id === RESOLVED_PAGES) return pagesModule;
    },
  };
}

// --- Mutation Probing: Vite-level content injection ---
//
// Instead of writing probe sentinels to content files (which triggers Astro's
// full-reload broadcast to ALL pages, nuking admin state), this plugin injects
// probed data at the getEntry()/getCollection() level. No file writes, no HMR,
// no validation — the admin panel stays mounted and probe state is preserved.

let probeTimeout: ReturnType<typeof setTimeout> | null = null;

const PROBE_TIMEOUT_MS = 30_000; // Auto-clear safety net

function clearProbe() {
  (globalThis as any).__mimsyProbe = null;
  if (probeTimeout) { clearTimeout(probeTimeout); probeTimeout = null; }
}

/** Read a JSON body from an IncomingMessage. */
function readJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

/**
 * Vite plugin for mutation probing. Separate from vitePluginMimsy so
 * enforce: 'post' doesn't affect virtual module resolution order.
 *
 * - configureServer: adds /__mimsy_probe POST endpoint
 * - transform: wraps getEntry/getCollection in astro:content to inject
 *   probe sentinels at render time (dev mode only)
 */
export function vitePluginMimsyProbe(): Plugin {
  let isDev = false;

  return {
    name: 'vite-plugin-mimsy-probe',
    enforce: 'post',

    configureServer(_server: ViteDevServer) {
      isDev = true;

      _server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
        if (req.url !== '/__mimsy_probe' || req.method !== 'POST') return next();

        readJsonBody(req).then((data) => {
          if (data.action === 'start') {
            if (!data.collection || !data.slug || !data.probeMap) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Missing collection, slug, or probeMap' }));
              return;
            }
            (globalThis as any).__mimsyProbe = {
              collection: data.collection,
              slug: data.slug,
              probeMap: data.probeMap,
            };
            // Safety net: auto-clear if client never sends 'stop'
            if (probeTimeout) clearTimeout(probeTimeout);
            probeTimeout = setTimeout(clearProbe, PROBE_TIMEOUT_MS);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } else if (data.action === 'stop') {
            clearProbe();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } else {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unknown action' }));
          }
        }).catch(() => {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        });
      });
    },

    transform(code: string, id: string) {
      // Only transform in dev mode, only target Astro's content virtual module
      if (!isDev) return null;
      if (id !== '\0astro:content') return null;
      if (!code.includes('export const getEntry')) return null;

      // Replace 'export const' with 'export let' for all data-returning functions
      // so our appended wrapper can reassign them.
      const fns = ['getEntry', 'getCollection', 'getEntries', 'getEntryBySlug', 'getDataEntryById'];
      let modified = code;
      for (const fn of fns) {
        modified = modified.replace(
          new RegExp(`export const ${fn}\\b`),
          `export let ${fn}`,
        );
      }

      // Append the runtime probe wrapper
      modified += PROBE_WRAPPER;
      return { code: modified, map: null };
    },
  };
}

/**
 * Runtime code appended to astro:content module.
 * Wraps all data-returning functions to inject probe sentinels when active.
 * When globalThis.__mimsyProbe is falsy (99.99% of the time), each wrapper
 * does a single falsy check and returns the original result — zero overhead.
 */
const PROBE_WRAPPER = `
;(function __mimsyProbeInit() {
  function __setDeep(obj, path, val) {
    var parts = path.replace(/\\[(\\d+)\\]/g, '.\$1').split('.');
    var cur = obj;
    for (var i = 0; i < parts.length - 1; i++) {
      var k = /^\\d+\$/.test(parts[i]) ? parseInt(parts[i]) : parts[i];
      if (cur[k] == null) return;
      cur = cur[k];
    }
    var last = /^\\d+\$/.test(parts[parts.length - 1]) ? parseInt(parts[parts.length - 1]) : parts[parts.length - 1];
    cur[last] = val;
  }

  function __probeEntry(entry) {
    var p = globalThis.__mimsyProbe;
    if (!p || !entry) return entry;
    var collection = entry.collection;
    var id = entry.id ?? entry.slug;
    if (collection !== p.collection || id !== p.slug) return entry;
    var data = structuredClone(entry.data);
    for (var pid in p.probeMap) {
      __setDeep(data, p.probeMap[pid], pid);
    }
    return Object.assign({}, entry, { data: data });
  }

  var __ge = getEntry;
  getEntry = async function() {
    return __probeEntry(await __ge.apply(this, arguments));
  };

  if (typeof getCollection !== 'undefined') {
    var __gc = getCollection;
    getCollection = async function() {
      var entries = await __gc.apply(this, arguments);
      if (!globalThis.__mimsyProbe || !Array.isArray(entries)) return entries;
      return entries.map(__probeEntry);
    };
  }

  if (typeof getEntries !== 'undefined') {
    var __ges = getEntries;
    getEntries = async function() {
      var entries = await __ges.apply(this, arguments);
      if (!globalThis.__mimsyProbe || !Array.isArray(entries)) return entries;
      return entries.map(__probeEntry);
    };
  }

  if (typeof getEntryBySlug !== 'undefined') {
    var __gebs = getEntryBySlug;
    getEntryBySlug = async function() {
      return __probeEntry(await __gebs.apply(this, arguments));
    };
  }

  if (typeof getDataEntryById !== 'undefined') {
    var __gdbi = getDataEntryById;
    getDataEntryById = async function() {
      return __probeEntry(await __gdbi.apply(this, arguments));
    };
  }
})();
`;

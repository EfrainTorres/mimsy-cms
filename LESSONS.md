# Lessons Learned (Breaking Issues)

> These are living rules, not gospel. Update or remove any entry when new evidence disproves it.

## Paths & URLs
- `URL.pathname` percent-encodes spaces (`Ron%20Simon%20Website`). Use `fileURLToPath()` from `node:url` for filesystem paths. (vite-plugin.ts)
- `factory.ts` must read `contentDir` from `virtual:mimsy/config` — not call `resolveContentDir()` with no arg.

## Astro Config
- Playground uses `output: 'server'` — required because user pages have dynamic routes without `getStaticPaths`. Don't change to `static` or `hybrid`.
- MimsyCMS injects all its routes with `prerender: false` so it works in any output mode.

## Svelte 5
- `$` prefix is reserved. Can't destructure ProseMirror's `$from` — use `selection.$from` inline or assign to `resolved`.

## Validation
- `validateFrontmatter()` returns `{ data }` on success — callers must write the parsed data, not the raw input.
- Slug regex must allow `/` for nested content paths (e.g. `subdir/post`).
- `createEntry()` must `mkdir(dirname(filePath))` for nested slugs.

## NewEntryForm
- Only inject `draft: true` when schema defines a draft field.
- Escape key must check dirty state before navigating (no autosave on this form).

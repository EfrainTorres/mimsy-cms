# MimsyCMS

Astro 5 integration CMS. Monorepo: `packages/cms` (the integration) + `playground` (dev/test app). It's February 2026.

## Code Guidelines

- **Lean and minimal**: Zero unnecessary dependencies. Vanilla JS over new libraries. Least code that works well.
- **DRY first**: Before creating new styles or components, check what already exists in `packages/cms/src/pages/layouts/AdminLayout.astro` `<style is:global>` for shared `mimsy-*` CSS classes and CSS custom properties. Reuse over reinvent.
- **No `@apply`**: Tailwind v4 breaks with `@apply` in `<style is:global>`. Use plain CSS.
- **Svelte islands**: One island per page is better than multiple islands needing cross-component communication.
- **Toast API**: Use `window.dispatchEvent(new CustomEvent('mimsy:toast', { detail: { message, type } }))` for user feedback. Never create inline status/error UI.
- **Tiptap**: Use `@tiptap/core` directly (no `@tiptap/svelte`). Always set `immediatelyRender: false`.
- **API routes over Actions**: Astro integrations can't inject Actions. Use `/api/mimsy/*` route handlers.
- **Dev server**: Run from `playground/`, not root. `cd playground && npx astro dev`

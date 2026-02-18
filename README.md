# Mimsy CMS

A git-based content management system built as an [Astro](https://astro.build) integration. Drop it into any Astro 5 project and get a full admin UI at `/admin` — WYSIWYG editor, schema-driven forms, image uploads, and more.

**No database. No external services. Your content stays in your repo.**

## Features

- **WYSIWYG editor** — Tiptap-powered rich text with markdown output
- **Schema-driven forms** — Auto-generates frontmatter fields from your Zod content schemas
- **Image uploads** — Paste or drag images directly into the editor
- **Draft/publish workflow** — Toggle entries between draft and published states
- **SEO preview** — Live Google SERP and social card preview while editing
- **Content templates** — Pre-fill new entries from `_templates/` files
- **Slug validation** — Auto-generated slugs with real-time uniqueness checks
- **Search, filter, pagination** — Full-featured content list with keyboard shortcuts
- **View Transitions** — SPA-like navigation across admin pages

## Quick Start

### 1. Install

```bash
npm install @mimsy/cms
```

Mimsy also requires Svelte and Tailwind CSS v4 as peers:

```bash
npm install @astrojs/svelte svelte @tailwindcss/vite tailwindcss
```

### 2. Configure

```js
// astro.config.mjs
import { defineConfig } from 'astro/config';
import svelte from '@astrojs/svelte';
import tailwindcss from '@tailwindcss/vite';
import mimsy from '@mimsy/cms';

export default defineConfig({
  output: 'server',
  integrations: [svelte(), mimsy()],
  vite: {
    plugins: [tailwindcss()],
  },
});
```

### 3. Add Tailwind with source directive

Create a CSS file (e.g. `src/styles/global.css`):

```css
@import "tailwindcss";
@source "../../node_modules/@mimsy/cms/src";
```

> The `@source` directive tells Tailwind v4 to scan the CMS package for utility classes.

### 4. Add content collections

Mimsy works with Astro's built-in content collections using the glob loader. Place your content in `src/data/`:

```ts
// src/content.config.ts
import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const blog = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/data/blog' }),
  schema: z.object({
    title: z.string(),
    draft: z.boolean().default(false),
  }),
});

export const collections = { blog };
```

### 5. Start the dev server

```bash
npx astro dev
```

Visit `http://localhost:4321/admin` to open the CMS.

## Configuration

```js
mimsy({
  basePath: '/admin',     // Admin UI route prefix (default: '/admin')
  contentDir: 'src/data', // Content directory (default: 'src/data')
})
```

## Supported Field Types

Mimsy auto-generates form fields from your Zod schemas:

| Zod Type | Form Field |
|----------|-----------|
| `z.string()` | Text input |
| `z.number()` | Number input |
| `z.boolean()` | Toggle switch |
| `z.coerce.date()` | Date picker |
| `z.enum([...])` | Dropdown select |
| `z.array(z.string())` | Comma-separated tag input |
| `reference('collection')` | Reference dropdown |

Optional fields are marked automatically. Default values are pre-filled.

## Content Templates

Create `_templates/{collection}.md` in your content directory to pre-fill new entries:

```markdown
---
draft: true
tags: []
---

Start writing here...
```

## Development

This is a pnpm monorepo with two packages:

- `packages/cms` — The Astro integration (`@mimsy/cms`)
- `playground` — Dev/test Astro app

```bash
git clone https://github.com/EfrainTorres/mimsy-cms.git
cd mimsy-cms
pnpm install
pnpm dev
```

The dev server runs the playground at `http://localhost:4321`. Changes to `packages/cms` are picked up immediately — no build step needed.

## Roadmap

- [ ] GitHub adapter — edit content via GitHub API in production (no local filesystem needed)
- [ ] GitHub OAuth — multi-user authentication for editors
- [ ] Media library — browse and manage uploaded images

## License

[AGPL-3.0](LICENSE)

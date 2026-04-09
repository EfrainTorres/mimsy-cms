---
title: Getting Started with MimsyCMS
description: Learn how to set up MimsyCMS in your Astro project in under five minutes
author: john-smith
tags:
  - tutorial
  - setup
draft: false
publishedAt: '2025-02-01T00:00:00.000Z'
coverImage: https://images.unsplash.com/photo-1555066931-4365d14bab8c?w=600&q=80
---

# Getting Started

Follow these steps to add MimsyCMS to your Astro project.

## Installation

Add the integration to your `astro.config.mjs`:

```js
import mimsy from '@mimsy/cms';

export default defineConfig({
  integrations: [mimsy()],
});
```

That's it. Navigate to `/admin` and start editing.

## Content Collections

MimsyCMS reads your existing Astro content collections. Define your schema with Zod:

```ts
const blog = defineCollection({
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    coverImage: z.string().optional(),
  }),
});
```

The admin UI automatically generates forms from your schema. Image fields get a media picker. Enum fields become dropdowns. Arrays become sortable lists.

## Visual Editing

Open the preview panel in the editor to see your site with the visual overlay. Hover over any text to see which field it maps to. Click to edit inline, or Ctrl+click to jump to the form field.

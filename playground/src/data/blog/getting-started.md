---
title: Getting Started with MimsyCMS
description: Learn how to set up MimsyCMS in your Astro project
author: john-smith
tags:
  - tutorial
  - setup
draft: true
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

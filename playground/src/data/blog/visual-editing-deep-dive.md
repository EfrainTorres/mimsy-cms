---
title: "Visual Editing: A Deep Dive"
description: How MimsyCMS maps your frontmatter fields to the rendered DOM without any developer markup
author: jane-doe
tags:
  - visual-editing
  - technical
  - matching-engine
draft: false
publishedAt: '2025-03-10T00:00:00.000Z'
coverImage: https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=600&q=80
---

# Visual Editing: A Deep Dive

The visual editing overlay is the core innovation in MimsyCMS. It maps your frontmatter fields to the rendered DOM elements without requiring any `data-*` attributes or special markup.

## The Matching Engine

When the preview iframe loads, MimsyCMS sends your content entry's field candidates to the overlay script. The matching engine uses a five-signal heuristic to pair each field with its rendered DOM element:

1. **Text match** — exact, normalized, or substring comparison
2. **Tag appropriateness** — headings match title fields, paragraphs match descriptions
3. **Uniqueness** — fields appearing once in the DOM score higher
4. **String length** — longer strings are more reliable matches
5. **Specificity** — deeper DOM elements are more precise targets

## Co-occurrence Matching

For array items (like blog cards or feature lists), the engine uses an anchor-first strategy. It finds the strongest match per array item, establishes a DOM region, then constrains weaker matches to that region. This eliminates false positives from short strings like "Free" or "Learn More" appearing multiple times.

## Confidence Tiers

Not all matches are created equal. The engine assigns confidence scores and gates interaction accordingly:

- **HIGH (0.7+)** — solid highlight, inline edit available
- **MEDIUM (0.4+)** — dashed highlight, click routes to form
- **LOW (<0.4)** — invisible, no interaction

This is the safety model. A missed field routes to the form (safe). A wrong inline edit corrupts data (catastrophic).

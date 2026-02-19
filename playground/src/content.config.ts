import { defineCollection, reference } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const blog = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/data/blog' }),
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    author: reference('authors'),
    tags: z.array(z.string()).default([]),
    draft: z.boolean().default(false),
    publishedAt: z.coerce.date().optional(),
    metaTitle: z.string().optional(),
    metaDescription: z.string().optional(),
    ogImage: z.string().optional(),
  }),
});

const authors = defineCollection({
  loader: glob({ pattern: '**/*.json', base: './src/data/authors' }),
  schema: z.object({
    name: z.string(),
    email: z.string().email(),
    bio: z.string().optional(),
    avatar: z.string().optional(),
  }),
});

const heroBlock = z.object({
  type: z.literal('hero'),
  heading: z.string(),
  subheading: z.string().optional(),
  image: z.string().optional(),
});

const featuresBlock = z.object({
  type: z.literal('features'),
  heading: z.string().optional(),
  items: z.array(z.object({
    title: z.string(),
    description: z.string().optional(),
  })),
});

const ctaBlock = z.object({
  type: z.literal('cta'),
  heading: z.string(),
  buttonText: z.string(),
  buttonUrl: z.string(),
});

const pages = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/data/pages' }),
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    draft: z.boolean().default(false),
    sections: z.array(z.discriminatedUnion('type', [
      heroBlock,
      featuresBlock,
      ctaBlock,
    ])).default([]),
  }),
});

export const collections = { blog, authors, pages };

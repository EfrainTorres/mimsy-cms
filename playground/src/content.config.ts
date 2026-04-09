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
    coverImage: z.string().optional().describe('Cover image URL for the post card'),
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
    avatar: z.string().optional().describe('Author avatar image URL'),
  }),
});

// --- Page block variants ---

const heroBlock = z.object({
  type: z.literal('hero'),
  heading: z.string(),
  subheading: z.string().optional(),
  image: z.string().optional().describe('Hero background or side image'),
  buttonText: z.string().optional(),
  buttonUrl: z.string().optional(),
});

const featuresBlock = z.object({
  type: z.literal('features'),
  heading: z.string().optional(),
  items: z.array(z.object({
    title: z.string(),
    description: z.string().optional(),
    icon: z.string().optional().describe('Icon image URL'),
  })),
});

const ctaBlock = z.object({
  type: z.literal('cta'),
  heading: z.string(),
  description: z.string().optional(),
  buttonText: z.string(),
  buttonUrl: z.string(),
});

const testimonialsBlock = z.object({
  type: z.literal('testimonials'),
  heading: z.string().optional(),
  items: z.array(z.object({
    quote: z.string(),
    name: z.string(),
    role: z.string().optional(),
    avatar: z.string().optional().describe('Testimonial author avatar'),
  })),
});

const pricingBlock = z.object({
  type: z.literal('pricing'),
  heading: z.string().optional(),
  items: z.array(z.object({
    plan: z.string(),
    price: z.string(),
    description: z.string().optional(),
    buttonText: z.string(),
    buttonUrl: z.string(),
    featured: z.boolean().default(false),
  })),
});

const imageBlock = z.object({
  type: z.literal('image'),
  src: z.string().describe('Full-width image URL'),
  alt: z.string().optional(),
  caption: z.string().optional(),
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
      testimonialsBlock,
      pricingBlock,
      imageBlock,
    ])).default([]),
  }),
});

// --- Case study collection (probe stress-test) ---

const caseStudies = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/data/case-studies' }),
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    author: reference('authors'),
    publishedAt: z.coerce.date(),
    coverImage: z.string().describe('Hero image for the case study'),
    tags: z.array(z.string()).default([]),
    client: z.object({
      name: z.string(),
      logo: z.string().describe('Client company logo URL'),
      industry: z.string(),
      url: z.string().optional(),
    }),
    metrics: z.array(z.object({
      label: z.string(),
      value: z.string(),
    })).default([]),
    testimonialQuote: z.string().optional(),
    testimonialAuthor: z.string().optional(),
    relatedLinks: z.array(z.object({
      title: z.string(),
      url: z.string(),
      buttonText: z.string(),
    })).default([]),
    metaTitle: z.string().optional(),
    metaDescription: z.string().optional(),
  }),
});

export const collections = { blog, authors, pages, 'case-studies': caseStudies };

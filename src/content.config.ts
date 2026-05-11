import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

export const CATEGORIES = [
  'SCCM',
  'Intune',
  'PowerShell',
  'WinPE',
  'Imaging',
  'AI Lab',
  'Homelab',
  'Packaging',
] as const;

export const BBQ_CATEGORIES = [
  'Cook Log',
  'Technique',
  'Gear',
  'Opinion',
] as const;

const blog = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/blog' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    pubDate: z.coerce.date(),
    updatedDate: z.coerce.date().optional(),
    category: z.enum(CATEGORIES),
    tags: z.array(z.string()).default([]),
    draft: z.boolean().default(false),
    author: z.string().default('JD'),
    heroImage: z.string().optional(),
  }),
});

const bbq = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/bbq' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    pubDate: z.coerce.date(),
    updatedDate: z.coerce.date().optional(),
    category: z.enum(BBQ_CATEGORIES),
    tags: z.array(z.string()).default([]),
    draft: z.boolean().default(false),
    author: z.string().default('JD'),
    heroImage: z.string().optional(),
    // BBQ-specific fields (all optional)
    cook: z.string().optional(),      // e.g. "Brisket", "St. Louis ribs"
    cookTime: z.string().optional(),  // e.g. "16h"
    smoker: z.string().optional(),    // e.g. "Offset, oak + post oak"
    rating: z.number().min(1).max(5).optional(),
  }),
});

export const collections = { blog, bbq };

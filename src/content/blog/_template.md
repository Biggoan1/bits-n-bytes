---
title: "Your Post Title"
description: "One sentence used for SEO and the post card."
pubDate: 2026-01-01
category: "SCCM"
tags: ["example"]
author: "JD"
draft: true
---

This file is a starter template. Because `draft: true` is set, it never appears on
the site, in the sitemap, category pages, or tag pages.

To publish a real post:

1. Copy this file to a new filename (the filename becomes the URL slug).
2. Fill in the frontmatter — `pubDate` should be today, `category` must be one of
   the values in `src/content.config.ts`, and `draft` should be `false`.
3. Write the body in Markdown below the frontmatter. Fenced code blocks are
   syntax-highlighted automatically.

```powershell
Get-CMApplication -Name 'Example'
```

Keep this file in place so Astro always sees the collection as non-empty.

---
title: "Cook or Opinion Title"
description: "One sentence used for SEO and the post card."
pubDate: 2026-01-01
category: "Cook Log"
tags: ["example"]
cook: "What you cooked"
cookTime: "Total time"
smoker: "Pit + fuel"
rating: 4
author: "JD"
draft: true
---

This file is a starter template. Because `draft: true` is set, it never appears
on the site or in the BBQ index.

To publish a real BBQ post:

1. Copy this file to a new filename (the filename becomes the URL slug).
2. Fill in the frontmatter — `category` must be one of `Cook Log`, `Technique`,
   `Gear`, or `Opinion`. The `cook`, `cookTime`, `smoker`, and `rating` fields
   are optional but render a "cook stats" panel when present.
3. Set `draft: false` and write the body in Markdown.

Keep this file in place so Astro always sees the collection as non-empty.

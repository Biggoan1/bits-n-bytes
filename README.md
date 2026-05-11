# Bits-N-Bytes

Static technical blog built with [Astro](https://astro.build). Focused on SCCM, Intune, PowerShell, endpoint engineering, WinPE/imaging, homelab, and AI infrastructure.

- **Domain:** https://bits-n-bytes.org
- **Hosting:** Cloudflare Pages (static)
- **Generator:** Astro 5 (static output, no SSR adapter)

## Requirements

- Node.js 20 or later (Node 22 recommended)
- npm 10+ (or pnpm / yarn — adjust commands accordingly)

Check your version:

```bash
node --version
npm --version
```

## Install dependencies

From the project root:

```bash
npm install
```

This installs Astro plus the MDX and sitemap integrations.

## Run locally

Start the dev server with hot reload:

```bash
npm run dev
```

Then open the URL it prints (default: `http://localhost:4321`).

## Build for production

Generate the static site into `dist/`:

```bash
npm run build
```

Preview the production build locally:

```bash
npm run preview
```

The `dist/` folder contains the entire site — plain HTML, CSS, JS, and sitemap. Nothing else is required at runtime.

## Deploy to Cloudflare Pages

This site is configured for **static hosting** on Cloudflare Pages. No Cloudflare adapter or Worker is required.

### One-time setup

1. Push this repository to GitHub.
2. In the Cloudflare dashboard, go to **Workers & Pages → Create → Pages → Connect to Git**.
3. Select the repository and click **Begin setup**.
4. Use these build settings:

   | Setting               | Value           |
   | --------------------- | --------------- |
   | Framework preset      | Astro           |
   | Build command         | `npm run build` |
   | Build output directory| `dist`          |
   | Root directory        | *(leave empty)* |
   | Node version          | `20` (env var `NODE_VERSION=20`) |

5. Click **Save and Deploy**.

### Custom domain

After the first deploy succeeds:

1. Open the Pages project → **Custom domains → Set up a custom domain**.
2. Enter `bits-n-bytes.org` (and `www.bits-n-bytes.org` if you want it).
3. Cloudflare will create the DNS records automatically if the zone is managed in the same account.

### Ongoing deploys

Every push to the production branch (`main`) triggers a new build and deploy. Pull requests get preview URLs automatically.

## Add a new blog post

Posts live in `src/content/blog/` as `.md` or `.mdx` files. The filename becomes the URL slug (`my-post.md` → `/blog/my-post/`).

Create a file like `src/content/blog/my-post.md` with this frontmatter:

```markdown
---
title: "Your Post Title"
description: "One sentence used for SEO and the post card."
pubDate: 2026-05-11
category: "SCCM"
tags: ["sccm", "packaging"]
author: "JD"
draft: false
---

Write the body in Markdown. Fenced code blocks get syntax-highlighted automatically.

\`\`\`powershell
Get-CMApplication -Name 'MyApp'
\`\`\`
```

### Frontmatter reference

| Field          | Required | Notes                                                       |
| -------------- | -------- | ----------------------------------------------------------- |
| `title`        | yes      | Shown in the post header, `<title>`, and OG meta.           |
| `description`  | yes      | Used for SEO and the post card.                             |
| `pubDate`      | yes      | ISO date. Posts are sorted newest first.                    |
| `updatedDate`  | no       | Optional. Shown on the post when present.                   |
| `category`     | yes      | Must be one of: `SCCM`, `Intune`, `PowerShell`, `WinPE`, `Imaging`, `AI Lab`, `Homelab`, `Packaging`. |
| `tags`         | no       | Array of strings. Each tag gets its own listing page.       |
| `draft`        | no       | `true` hides the post from the site.                        |
| `author`       | no       | Defaults to `JD`.                                           |

### Adding a new category

Edit `src/content.config.ts` and add the new value to the `CATEGORIES` array. Category pages and the home page topic grid update automatically.

## Add a new BBQ post

BBQ posts are a separate content collection (so a brisket post never lands next to an SCCM post). They live in `src/content/bbq/`.

Create `src/content/bbq/my-cook.md`:

```markdown
---
title: "Pork Butt: First Cook on the New Pit"
description: "Breaking in a new offset with a forgiving cook."
pubDate: 2026-05-11
category: "Cook Log"
tags: ["pork-butt", "offset", "hickory"]
cook: "9 lb bone-in pork butt"
cookTime: "11h"
smoker: "Offset, hickory + post oak"
rating: 4
draft: false
---

Body in Markdown.
```

### BBQ frontmatter reference

| Field         | Required | Notes                                                       |
| ------------- | -------- | ----------------------------------------------------------- |
| `title`       | yes      | Post title.                                                 |
| `description` | yes      | One sentence — used for SEO and the post listing.           |
| `pubDate`     | yes      | ISO date.                                                   |
| `category`    | yes      | One of: `Cook Log`, `Technique`, `Gear`, `Opinion`.         |
| `tags`        | no       | Free-form strings (meat, wood, technique).                  |
| `cook`        | no       | What you cooked (`14 lb packer brisket`).                   |
| `cookTime`    | no       | Total time (`16h, 8 PM → 12 PM`).                           |
| `smoker`      | no       | Pit + fuel (`Offset, post oak splits`).                     |
| `rating`      | no       | Integer 1–5. Renders as stars in the post header.           |
| `draft`       | no       | `true` hides the post.                                      |

When any of `cook`, `cookTime`, `smoker`, or `rating` are set, the BBQ post layout renders a compact "cook stats" panel below the title.

### Adding a new BBQ category

Edit `src/content.config.ts` and add the new value to `BBQ_CATEGORIES`.

## Pre-publish checklist

Before you point DNS at this site, walk through these. Most are quick.

- [ ] Replace `JD` author defaults in `src/consts.ts` (`SITE_AUTHOR`) and update the About page (`src/pages/about.astro`) with your real bio and links.
- [ ] Add contact details to the About page (email, GitHub, Bluesky/Mastodon).
- [ ] Replace the placeholder OG image. Currently OG uses `/favicon.svg` — drop a real 1200×630 PNG at `public/og-default.png` and update `BaseHead.astro` to default `image` to `/og-default.png`.
- [ ] (Optional) Add **Cloudflare Web Analytics**. It's free, privacy-friendly, and one snippet — paste the token script into `src/components/BaseHead.astro` near the bottom of `<head>`.
- [ ] Push the repo to GitHub.
- [ ] Connect Cloudflare Pages (see the Deploy section above).
- [ ] Add `bits-n-bytes.org` as a custom domain in the Pages project.
- [ ] Verify the live site: home, blog index, a post, `/bbq/`, a BBQ post, `/sitemap-index.xml`, `/robots.txt`.
- [ ] Submit the sitemap to Google Search Console (and Bing if you care).

### MDX

To use components inside a post, save it as `.mdx` instead of `.md` and import what you need:

```mdx
---
title: "MDX example"
description: "..."
pubDate: 2026-05-11
category: "AI Lab"
---

import SomeComponent from '../../components/SomeComponent.astro';

<SomeComponent />
```

## Project structure

```
.
├── astro.config.mjs        # Astro config (static output, integrations)
├── package.json
├── public/                 # Static assets served as-is
│   ├── favicon.svg
│   └── robots.txt
├── src/
│   ├── components/         # Header, Footer, PostCard, ThemeToggle, ...
│   ├── content/
│   │   ├── blog/           # Markdown / MDX tech blog posts
│   │   └── bbq/            # Markdown / MDX BBQ posts
│   ├── content.config.ts   # Content collection schemas + categories
│   ├── consts.ts           # Site metadata (title, tagline, URL, nav)
│   ├── layouts/            # BaseLayout, BlogPost, BbqPost
│   ├── pages/
│   │   ├── index.astro
│   │   ├── about.astro
│   │   ├── projects.astro
│   │   ├── blog/
│   │   ├── bbq/
│   │   ├── categories/
│   │   └── tags/
│   └── styles/global.css
└── tsconfig.json
```

## License

Content © the author. Code in this repo is provided as-is for personal use and learning.

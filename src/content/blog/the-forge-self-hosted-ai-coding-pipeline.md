---
title: "The Forge: A Self-Hosted AI Coding Pipeline Where Apps Rebuild Themselves"
description: "How I built a centralized coding service for my homelab — a kanban board, git-worktree isolation, a bounded plan/patch loop, a robot code reviewer that gates every merge, and a drop-in widget that puts a Request-a-feature button in every app."
pubDate: 2026-08-05
category: "AI Lab"
tags: ["ai", "local-llm", "codex", "qwen", "automation", "kanban", "git", "code-review", "homelab", "self-hosting"]
author: "JD"
draft: false
---

In [the last post](/blog/how-the-fafo-lab-fits-together/) I mentioned, almost in passing, that the apps in my lab are "learning to modify themselves, with a robot code-reviewer standing between the idea and production," and promised that piece its own write-up. This is it.

The thing is called the **Forge**. It's a centralized, self-hosted coding service: a person clicks *"Request a feature"* inside one of my web apps, types a sentence in plain English, and — if everything goes right — a few minutes later the change is written, reviewed by an independent AI, merged, and deployed to the live site. No human touches an editor. This post is how it works, end to end: the board, the plan/patch loop, the reviewer gate, and the little plugin that bolts the whole experience onto any app in about ten lines.

## The problem it solves

I started where a lot of people do: I embedded a small "feature coder" script directly in one app. It worked. So I copied it into a second app. Now I had two divergent copies of the same idea, two queues, two sets of prompts to keep in sync, and each one hammering a GPU on its own schedule with no coordination. The third app was going to make it three.

That's the classic mistake — solving a platform problem per-app. The fix was to build **one service every app talks to as a client**, and let the apps carry nothing but a thin relay and a status mirror. One board, one coder, one place to improve prompts, one set of GPU limits protecting the fleet.

## The shape

```text
  App (in-browser)                 The Forge (its own box)
  ┌───────────────────┐            ┌──────────────────────────────┐
  │ "Request feature" │            │  Board (kanban + SQLite)     │
  │   ↓ plain English │  submit    │      ↓ dispatch              │
  │  ForgePanel widget├───────────►│  Coder (plan/patch loop)     │
  │   ↑ status mirror │◄───────────┤      ↓ diff                  │
  │  kanban + detail  │  list/get  │  Reviewer (independent model)│
  └───────────────────┘            │      ↓ pass → merge+deploy   │
                                   │        hold → wait for human │
                                   └──────────────────────────────┘
```

Four moving parts: a **board** that owns the lifecycle, a **coder** that writes the change, a **reviewer** that judges it, and a **widget** that gives every app the same front end. Let's take them in order.

## 1. The board and the kanban lifecycle

The board is a small Node service with a SQLite database, and every request is a row that moves through a fixed set of states:

```text
  new → queued → building → needs_review → done
                                  │
                                  └── (rejected / failed)
```

- **new / queued** — the request exists and is waiting for a worker. There's a strict WIP limit here, and it's the single most important design choice in the whole system: **one build at a time.** The models run on my own GPUs; letting five requests build at once doesn't make them faster, it makes them all slow and occasionally makes the box fall over. WIP-1 keeps the fleet sane.
- **building** — a worker has picked it up and the coder is actually editing files.
- **needs_review** — the diff exists and is waiting on a verdict. In the happy path an AI reviewer resolves this in seconds; when the reviewer isn't sure, it parks here for a human.
- **done** — merged and deployed. (`rejected`/`failed` are the unhappy terminals.)

That lifecycle is deliberately identical for every app. An app doesn't get to invent its own states — it just mirrors these. Which is what makes a single shared widget possible.

## 2. The coder: a bounded plan/patch loop

Here's the part people expect to be magic and is actually engineering. You cannot hand a whole repository to a model, say "add dark mode," and trust the wall of code that comes back. It won't fit in context, it'll rewrite files it shouldn't, and it'll hallucinate a function or two. So the coder is a **bounded loop**, and the bounds are the whole trick:

1. **Isolate.** Every build happens in its own **git worktree** cut fresh from `origin/main`. Concurrent projects can never collide, and a botched build is thrown away by deleting a directory — the real branch is never touched until a human (or the reviewer) approves.
2. **Constrain the surface.** Each project declares an **editable file list** — the handful of files the coder is allowed to touch. Everything else is off-limits. This is both a safety rail (the coder can't wander into secrets or server internals) and a context saver.
3. **Outline, then patch.** The coder first produces a short plan of *which regions of which files* need to change, then emits edits as **SEARCH/REPLACE blocks** — "find this exact snippet, replace it with that one" — rather than regenerating whole files. Small, reviewable, and it keeps the model inside its context window even on big files.
4. **Commit and hand off the diff.** On success it commits to a throwaway branch, pushes it, and reports a one-line result. It never merges. Merging is a separate, gated decision.

There are two engines behind that loop, and which one runs is a per-request setting. The default is a hosted frontier coding model (flat-rate subscription, so cost isn't per-token); the fallback is a **local Qwen coder** running entirely on my own GPUs, so sensitive projects never leave the building. The loop is identical either way — the engine is just who fills in the SEARCH/REPLACE blocks.

## 3. The reviewer: a robot standing between the idea and production

This is the part I'm proudest of, and it's almost embarrassingly simple in concept: **the thing that writes the code does not get to decide whether the code ships.**

After the coder produces a diff, an *independent* reviewer looks at it — a different model (a local Qwen, so it's free and private), with **no filesystem access at all**. It can read the diff and nothing else; it literally cannot edit its way to a passing grade. Its instructions are strict, and biased toward failure: PASS only if the change correctly and completely implements the request, introduces no bug or syntax break, no security issue (injection, leaked secret, auth bypass, path traversal), no scope creep, and preserves existing behavior. **When in doubt, FAIL.** Because a pass here can auto-ship to a live website, the asymmetry matters — a false hold costs a human a glance; a false pass costs an incident.

The outcomes:

- **PASS** → the board auto-approves: merge the branch to `main`, push, run the project's deploy hook (restart the container, redeploy the site), mark it done. Idea to production, no human in the path.
- **FAIL** → the reviewer's specific objections are fed back to the coder for **one bounded fix round**, then it re-reviews. Still failing? The request lands in `needs_review` with the reviewer's notes attached, and a human decides.
- **Any error in the reviewer itself** → **hold.** The fail-safe is always to *not* ship. An unreviewed change never reaches production because the reviewer crashed.

I tested it the way you should test a gate: by trying to sneak things past it. A diff that added a SQL-injection hole and leaked a secret was correctly failed, with both problems named specifically. A clean one-line change passed and shipped end to end without me. That's the bar — it has to catch the bad one *and* not get precious about the good one.

## 4. The plugin: one file, every app

Now the front end — the part the user asked most about. I wanted every app to have the *same* experience: a **Request** button, a **kanban board** showing live status, and a **detail popup** you can click into. Rather than build that three times, it's a single self-contained JavaScript widget called **ForgePanel** — one file, CSS injected inline, everything namespaced so it can't collide with the host page's styles. Dropping it into an app is about ten lines:

```html
<div id="forge-panel"></div>
<script src="/forge-panel.js"></script>
<script>
  ForgePanel.mount({
    el: "#forge-panel",
    base: "/api/features",          // the app's own endpoints
    forgeUrl: "https://<the-forge>", // deep-link for managers
    canRequest: true,                // false = read-only board
    project: "my-app"
  });
</script>
```

It renders the New / Queued / Building / Review / Done columns, a read-only detail popup (the request, the AI's restatement of what it understood, the reviewer's verdict, the diffstat, and a live-tailing build log), and a request modal that submits on Enter. Managers get an "Open in the Forge" deep link; everyone else gets the board.

The important design rule is in that snippet: **the widget only ever talks to the host app's own endpoints** (`base`), same-origin. It never calls the Forge directly. That means the app's existing login and session automatically apply — the widget has no auth of its own to get wrong. The app implements three thin routes that relay to the central Forge behind the scenes:

```text
  GET  /api/features        → list this project's requests  (mirror)
  GET  /api/features/:id     → one request's live status     (mirror)
  POST /api/features         → submit a new request          (relay)
```

Behind those routes, the app relays to the Forge over a **locked-down SSH key** — a forced-command key that can *only* submit or list, nothing else. So even a fully-compromised app can't do anything to the Forge except ask it to build something (which then still has to pass review). The blast radius stays tiny.

The widget is tolerant on purpose — it accepts a bare array or a wrapped object, `detail` or `description`, `restatement` or `ai_summary` — so a new app can adopt it without matching an exact schema. New app onboards to the Forge? Vendor the one file, add the three routes, drop in the ten lines. Done.

## What it feels like

A manager on one of the sites clicks **Request a feature**, types *"add a CSV export button to the orders table,"* and hits Enter. A card appears in **New**. Within a tick it's **Building** — I can open the card and watch the coder's log stream by as it plans the edit and writes the SEARCH/REPLACE blocks in an isolated worktree. It commits, and the card flips to **Review**. The reviewer reads the diff, decides the export is correct and safe, and the board merges and redeploys. The card lands in **Done**, and the button is on the live site. Elapsed human effort: one sentence.

And when the reviewer *doesn't* like it — say the coder's CSV escaping is sketchy — the card sits in **Review** with a note that says exactly why, and waits for me. That's the whole point. The robot is happy to do the work and happy to admit when it shouldn't ship.

## The lessons, condensed

- **Centralize the platform, thin out the clients.** The apps carry a widget and three relay routes. Everything hard lives in one service you improve once.
- **Bound the coder or it wanders.** Worktree isolation, an explicit editable-file allowlist, and SEARCH/REPLACE-not-rewrite are what make an LLM safe to point at a real repo.
- **The author never grades its own homework.** An independent, filesystem-less reviewer biased toward "no" is the difference between a demo and something you'll let touch production.
- **Fail safe, always.** Reviewer error, ambiguity, anything unexpected → hold, don't ship. The expensive mistake is auto-merging garbage; make that the hard path.

Next in this little series: the coder engines themselves — running a frontier model and a local Qwen behind the same loop, and when it's worth keeping the whole thing on your own silicon.

FAFO delivers.

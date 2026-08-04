---
title: "The FAFO Lab, End to End: Proxmox, Active Directory, Cloudflare, and One Login for Everything"
description: "The full-stack tour of my homelab — how a Proxmox substrate, a Windows AD domain that also owns the Linux boxes, Cloudflare Zero Trust, and an AI operator stack up into a system you can drive from a phone with nothing installed."
pubDate: 2026-08-04
category: "Homelab"
tags: ["homelab", "proxmox", "active-directory", "cloudflare", "zero-trust", "sso", "kerberos", "entra", "sssd", "identity"]
author: "JD"
draft: false
---

Last time I wrote up the FAFO Lab, it was a hardware brag: two 2019 Mac Pros, six GPUs, a 25-gigabit link between them, and a 397B-parameter model running entirely on VRAM in a basement. That post — [Anatomy of the FAFO Lab](/blog/anatomy-of-the-fafo-lab/) — ended with a promise to come back and cover the *other* half: the identity and access stack that lets one account sign in from Windows to Linux to the web without a single password typed twice.

This is that post. It's the tour from the bottom up — the boring, load-bearing layers that turn a pile of machines into a **system**. Networking, Proxmox, Active Directory, Cloudflare, and the AI that runs the whole thing. Very little of this is exotic on its own. The point is how the layers *stack*, and the few opinionated decisions that make the seams disappear.

## The shape of the thing

Before the layers, the doctrine — because every good homelab is really a set of standing decisions you stop re-litigating:

- **Every service gets its own container.** New app? New unprivileged LXC on the debian template, DHCP address, DNS reservation by MAC. Never a static IP baked into config, never two apps sharing a box. Blast radius stays the size of one container.
- **Secrets live in exactly one place**, mode `600`, and never in the wiki or a repo.
- **If it isn't written down, it didn't happen.** Every machine, convention, and postmortem lives in a plaintext "brain" the lab reads and writes. More on that at the end.

Those three rules do more for reliability than any amount of clever automation.

## Layer 0 — the network (the two-second recap)

The [previous post](/blog/anatomy-of-the-fafo-lab/) covers the fabric in detail, so here's just the load-bearing idea: **the house and the lab must not be able to hurt each other.**

The untagged/Default network is the *management* VLAN — switches, APs, the stuff that manages itself. The lab is its own tagged VLAN on its own subnet, and everything real lives there. The one rule that keeps it sane: a switch port facing a *lab* device gets its native VLAN set to the lab; a port facing *infrastructure* stays native-Default. Get that backward and devices silently DHCP onto the wrong network and half-work in maximally confusing ways. Ask me how I know.

Underneath that, a pair of dumb-on-purpose Mikrotik switches carry a jumbo-frame storage-and-compute fabric, and a direct 25G DAC between the two Mac Pros carries model tensors at line rate. That's the whole networking story; the rest of this post is what rides on top.

## Layer 1 — Proxmox, the substrate

Everything that isn't a bare-metal AI box is a guest on **Proxmox VE**, running on a Dell workstation. Windows Server VMs carry the domain controller, the ConfigMgr site server, and SQL. A stack of Linux LXC containers carry the apps, the dashboard, the tunnel, and the trading and shipping tools. LXC where I can (cheap, fast, dense), full VMs where I must (anything Windows, anything that wants its own kernel).

Next to it sits a twin workstation running **Proxmox Backup Server**. This is the part people skip and regret. PBS gives you deduplicated, incremental, *verifiable* backups, and the two boxes talk over their own dedicated 10G fabric link so backup traffic never touches the house network.

Two details that turn "I have backups" into "I can actually sleep":

1. **Config backups, not just guest images.** A nightly job pushes the hypervisor's own `/etc` and its cluster database to PBS. The live cluster config — every guest definition, storage config, user and ACL table — lives in that database, so a bare-metal loss of the hypervisor is a restore, not an archaeology project.
2. **Wake-on-LAN and AC-power-recovery**, set in firmware via the vendor's config tool. A power blip can't strand the lab in the off state; the boxes come back, and I can wake a sleeping node with a magic packet from anywhere inside.

The AI boxes are deliberately *not* backed up — they're stock Ubuntu and re-downloadable model weights. Knowing what you *don't* need to protect is half of a backup strategy.

## Layer 2 — Active Directory, the identity spine

Here's the decision that makes the whole lab feel like one computer instead of twenty: **one Windows AD domain owns everything, Windows and Linux alike.**

The Windows side is unremarkable — a domain controller, DNS, group policy, the usual. Group Policy does real work: a single domain-linked policy drops an OpenSSH server and my fleet key onto *every* domain-joined Windows box on its next reboot, so a fresh Windows VM becomes SSH-manageable with zero hand-holding.

The Linux side is where it gets fun. Every Linux box — containers and bare metal — is **domain-joined via SSSD and realmd**. The result: my account, `jd`, resolves to the *same UID on every machine in the lab*, authenticates against the domain, gets a home directory auto-created on first login, and gets sudo — all governed by a single AD security group. Add me to the group on the domain controller and I have root on the entire Linux fleet. Remove me and I don't. One source of truth for "who is allowed where."

A few scars worth sharing, because domain-joining Linux inside unprivileged containers is where the tutorials go quiet:

- **`realmd` refuses to work without `packagekit` installed** — and lies about why, claiming packages are missing when they're right there.
- Default AD UIDs land around 786 million, which is *outside* an unprivileged container's ID-mapping range, so Kerberos face-plants with a cryptic GID error. Fix: pin a low `idmap` range in SSSD and use a file-based credential cache instead of the kernel keyring (which containers don't get). Do that and it Just Works — no special container privileges required.
- Kerberos wants clock skew under five minutes, and containers inherit the host clock, so a drifting hypervisor breaks auth for every guest at once.

That last one is the theme of AD: it's finicky to stand up and *wonderful* once it's up. The finicky is a one-time tax.

## Layer 3 — Cloudflare, the front door

Nothing in the lab has a port open to the internet. Not one. Inbound access rides a **Cloudflare Tunnel** — a daemon in a container makes an *outbound* connection to Cloudflare's edge, and public hostnames get mapped to internal services through it. No port forwards, no exposed IP, no attack surface pointed at my house.

In front of the tunnel sits **Cloudflare Access** (their Zero Trust product). Every public hostname is gated by policy *before* a request ever reaches the origin. And the policies don't check a static list of emails — they check **group membership**, because Access is federated to **Entra ID** (Azure AD) as its identity provider.

Follow the chain, because this is the payoff of all the earlier layers:

```text
  I create a user in Active Directory on the domain controller
        │
        │  Entra Cloud Sync (every couple of minutes)
        ▼
  User + their security-group membership appear in Entra ID
        │
        │  Entra is Cloudflare Access's identity provider
        ▼
  Cloudflare Access lets them hit the dashboard — or doesn't
```

Granting someone access to the lab's web apps is *one command on the domain controller*: add them to a group. Two minutes later cloud sync carries it to Entra, Cloudflare honors it, and they can sign in with SSO. Revoking is the same command in reverse. The hybrid setup means on-prem AD users inherit cloud SSO automatically, and the same `https://` URLs work identically inside and outside the house (internal DNS mirrors the public names to Cloudflare's edge, so traffic hairpins cleanly either way).

Open ports: still zero. Accounts to manage in three separate places: also zero. It's one account, one group, one front door.

## Layer 4 — the part where you drive it from a phone

All of that converges in a single home-grown **dashboard** — a Node app in a container, published through the tunnel, gated by Access. It's the cockpit, and it does three things that make the lab genuinely operable from a phone on the couch:

**It knows the fleet.** The dashboard asks Proxmox for live guest state and backup freshness and renders every machine as a card — running or stopped, backed-up or stale — grouped by role. New VM or container? It appears automatically; I never edit a config to add a box.

**It gives you a terminal in the browser — with no password anywhere.** This is my favorite trick in the whole lab. When you sign in (verified by the Cloudflare Access token), you "unlock" by entering your AD password *once*; the server uses it to grab a short-lived Kerberos ticket, then **immediately discards the password** and keeps only the ticket. From then on, every browser terminal to a Linux box opens over `ssh -K` using that Kerberos credential — GSSAPI single-sign-on, no key, no password, expires on its own in a few hours. A full xterm to any machine in the lab, from any device with a browser, authenticated by a ticket that can't be replayed and dies on its own.

**It runs AI, as you.** The same unlock lets the dashboard's chat run a coding CLI *as the signed-in user*, in the lab's knowledge base, using that user's own subscription. Ask it a question about the lab and it answers from the wiki; ask it to change something and it can.

Nothing installed. No VPN client, no RDP, no keys on the device. A browser and an identity.

## Layer 5 — the lab runs itself

Which brings me to the thread running through every layer above: **most of this is operated by an AI.**

The lab keeps a plaintext "brain" — a wiki of every machine, every convention, every postmortem — that a Claude agent reads and writes. It arms Wake-on-LAN, benchmarks models, writes the incident reports, and updates its own documentation when it learns something. When I pull a cable to test a failover, it watches DHCP leases and MAC tables and tells me which port to look at. The [first post's](/blog/anatomy-of-the-fafo-lab/) "attention on the Intel card collapses generation" finding? That's a wiki entry the agent wrote so neither of us wastes another evening on it.

The newest piece is a centralized **coding Forge**: in-app "request a feature" buttons on the lab's web apps hand a plain-English request to a local model running on the AI fleet, which plans a change, edits the code in an isolated git worktree, gets the diff **reviewed by a second independent model pass**, and — if that review passes — auto-merges and redeploys. Fails the review, it parks for a human. The apps are learning to modify themselves, with a robot code-reviewer standing between the idea and production. That one deserves its own post, and it'll get one.

## What it feels like from the outside

Here's the whole stack in one motion. I'm on my phone, away from home. I open a lab URL:

1. **Cloudflare** intercepts it, sees no session, bounces me to **Entra** SSO.
2. I sign in; Entra confirms my **AD group** membership; Access lets me through to the tunnel.
3. The **tunnel** carries the request inbound to a **container on Proxmox** — no open port involved.
4. The **dashboard** renders the fleet live from the hypervisor. I unlock with my AD password once; it becomes a **Kerberos ticket**.
5. I open a browser terminal to a Mac Pro over **GSSAPI SSO**, kick off a model benchmark, and close the tab.

Five products, five layers, one identity, zero things installed on the phone. Every layer is off-the-shelf and boring by itself. Stacked, they're a lab I can run from a bus.

Total cost of the identity-and-access tier, given the machines already existed: some patience with `realmd`, a Cloudflare account, and an evening reading Kerberos error messages.

FAFO delivers.

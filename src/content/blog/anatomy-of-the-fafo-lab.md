---
title: "Anatomy of the FAFO Lab: Two Mac Pros, Six GPUs, and a 397B Model in the Basement"
description: "A full tour of my homelab — the VLAN design, the Mikrotik 10G fabric, a 25-gig link between two Mac Pros, and the GPU pooling setup that runs frontier-class open models locally."
pubDate: 2026-07-28
category: "Homelab"
tags: ["homelab", "networking", "vlan", "mikrotik", "llama-cpp", "gpu", "moe", "local-llm", "proxmox"]
author: "JD"
draft: false
---

I call it the FAFO Lab, because that's the operating principle: mess around and find out. This week the finding-out peaked — the lab now runs **Qwen3.5-397B**, the largest open-weight Qwen in existence, entirely on GPUs, split across two 2019 Mac Pros over a 25-gigabit link. In a basement. This post is the tour of everything underneath that sentence.

## The cast

**The hypervisor.** A Dell Precision 5820 running Proxmox VE carries the boring-but-critical stuff: a Windows AD domain (two DCs' worth of identity for both Windows and Linux — the Linux boxes are domain-joined through SSSD), a ConfigMgr site server, SQL, and a stack of LXC containers for apps and services. A twin 5820 next to it runs Proxmox Backup Server. Everything backs up nightly; both boxes have Wake-on-LAN and AC-power-recovery configured via Dell's CCTK so a power event can't strand them.

**The twins.** Two identical 2019 Mac Pros — yes, the $50k-when-new cheese graters — running Ubuntu. Apple shipped these for video editors; mine run tensor math. Each has three 32GB GPUs: two AMD Radeon Pro Vega IIs on the proprietary MPX modules, plus an Intel Arc Pro B70. That's 96GB of VRAM per box, **192GB across the pair**. One twin runs a ROCm stack, the other runs Vulkan — deliberately different, which turned out to matter (more on that below).

**The switching.** UniFi backbone (UDM Pro Max at the core), plus two Mikrotik CRS305-1G-4S+ units doing a very specific job I'll get to.

## The network: two worlds, one wire

```text
                          ┌────────────────────┐
          Internet ──────►│    UDM Pro Max     │
                          │      (router)      │
                          └──┬──────┬──────┬───┘
          ┌──────────────────┘      │      └──────────────────┐
          │ 1G (mgmt)               │ 10G SFP+1               │ 10G SFP+2
          │                         │ (lab-native)            │ (lab-native)
  ┌───────▼──────┐          ┌───────▼───────┐         ┌───────▼───────┐
  │ USW Pro Max  │          │   CRS305 #1   │         │   CRS305 #2   │
  │ 16-port core │          │ fabric, jumbo │         │ fabric, jumbo │
  └─┬────────────┘          └──┬──────────┬─┘         └──┬─────────┬──┘
    ├─ APs & infra             │          │              │         │
    ├─ twins 1G mgmt           │ 10G      │ 10G          │ 10G     │ 10G
    └─ PBS 1G mgmt             │          │              │         │
                          ┌────▼──────┐ ┌─▼─────┐    ┌───▼───┐ ┌───▼───┐
                          │ Proxmox VE│ │  PBS  │    │  AI2  │ │  AI3  │
                          │  VMs/CTs  │ │backups│    │Mac Pro│ │Mac Pro│
                          └───────────┘ └───────┘    │ 96GB  │ │ 96GB  │
                                                     └───┬───┘ └───┬───┘
                                                         ╞══ 25G ══╡
                                                     (direct twin link)
```

The design principle after some hard lessons: **the house and the lab must not be able to hurt each other.**

- The **Default network** (untagged) is the *management* VLAN — network infrastructure lives there, and everything else is segmented into its own VLANs.
- The **lab** is its own tagged VLAN with its own /24. Every lab box — hypervisor, backup server, the twins, the Windows fleet — lives there.

The rule that keeps you sane: any switch port that faces a *lab* device gets its **native VLAN set to the lab network**, so untagged lab traffic lands where it belongs. Any port that faces *infrastructure* stays native-Default. Get a native VLAN wrong and devices pull DHCP leases from the wrong network — and things half-work in maximally confusing ways.

## The Mikrotiks: dumb on purpose

The two CRS305s are configured as plain hardware-offloaded bridges — no VLAN filtering, no STP, jumbo frames (MTU 9000) on every port. Each one uplinks straight into its own SFP+ port on the UDM, with the native VLAN pinned to the lab network.

Why dumb? Because their job is to be a **storage and compute fabric**, not a network. One CRS lives with the hypervisor and backup server: Proxmox's 10G and PBS's 10G plug into it, and backup traffic between them rides a dedicated /29 subnet at jumbo MTU without touching anything else. The second CRS lives in the rack with the Mac Pros.

Two design notes worth stealing:

1. **Keep the topology a strict tree.** The Mikrotiks run with STP off (hardware offload stays clean that way), so each one gets exactly one uplink and no side paths — simple by design, nothing for spanning tree to argue about.
2. **Traffic between the two fabric switches hairpins through the UDM** — both uplinks are native-lab, so the fabric spans both rooms with zero direct cable between the Mikrotiks. Enable jumbo frames globally on UniFi and the 9000-MTU fabric survives the hairpin end to end. Verified with ping `-s 8972 -M do`, because trust is for people who've never debugged MTU black holes.

## The 25-gig twin link

Each Mac Pro has a dual-port 25G Mellanox ConnectX-4 Lx. Port 1 on each runs at 10G into the fabric switch. Port 2 is the fun one: a **direct 25G DAC between the two machines**. No switch, no VLANs, just a point-to-point /30 with jumbo frames.

`iperf3` says 24.8 Gbit/s. Line rate. The fabric path through the switches does 9.92 Gbit/s — also line rate. When your benchmarks match the physics, the network is done.

## GPU pooling: one model, six GPUs, two machines, three backends

Here's the payoff. llama.cpp ships an RPC mode: a tiny `rpc-server` daemon exposes a machine's GPUs to a `llama-server` running somewhere else, which stitches everything into one pool and spreads a model's layers across all of it.

My topology:

- `rpc-server` on twin #2 offering its three GPUs over the 25G link,
- a second `rpc-server` on twin #1 (localhost) just for its Intel card — because the AMD cards run ROCm and the Intel card only speaks Vulkan, and RPC happily bridges backends,
- the host `llama-server` on twin #1 driving its own AMD cards directly plus the other four GPUs remotely.

One OpenAI-compatible endpoint. Six GPUs. Two machines. Three compute backends. It just works, which still feels illegal.

### Numbers, because bragging requires receipts

| Model | Size | Config | Prompt t/s | Gen t/s |
|---|---|---|---|---|
| Qwen 7B (control) | 4.4 GB | one box, local | 939 | 76.7 |
| Qwen 7B (control) | 4.4 GB | pooled over RPC | 518 | 24.8 |
| GLM-4.5-Air (110B MoE) | 63 GB | 4 GPUs, 2 boxes | 152.8 | 21.7 |
| **Qwen3.5-397B (MoE)** | **131 GB** | **all 6 GPUs** | **87.0** | **10.0** |

Two lessons in that table. First: **RPC is a tax on anything that fits in one box** — the 7B ran three times slower pooled. It exists purely for models too big for one machine's VRAM. Second: MoE models are the entire reason this works. The 397B only activates ~17B parameters per token, so you pay for the parameter count in *memory* (which pooling solves) rather than compute (which nothing in a basement solves).

### The mixed-silicon lesson

Running benchmarks across placements taught us a law we now keep in the lab wiki: **the Intel card never goes in the decode path.** It's genuinely good at prefill (+12% prompt speed — those matrix cores are real) and it donates 32GB to the pool, but token generation is a memory-bandwidth game and the Vegas' HBM2 wins it every time. We even tried the clever thing — attention on the Intel card, expert weights on the AMDs — and generation *collapsed*, because decode-time attention hammers the KV cache just as hard as the experts hammer their weights. Negative results are still results; that one cost an evening and got a wiki entry.

## The part where the lab runs itself

The other thing worth bragging about: most of this is operated by an AI. The lab keeps a wiki (the "brain") that a Claude agent reads and writes — every machine, every convention, every postmortem. The agent does the 2AM diagnostics, writes the incident reports, arms the Wake-on-LAN, benchmarks the models, and updates its own documentation. When something misbehaves, I pull cables while it watches DHCP leases and MAC tables and tells me exactly which port to look at. Highly recommend the arrangement.

## What's next

Deeper dives coming on the individual pieces: converting the Mac Pros to Linux AI boxes (ROCm vs Vulkan on identical hardware), the Claude-driven ConfigMgr packaging pipeline, and the identity stack that gives one account SSO from Windows to Linux to the web. If any of those sound interesting, stick around.

Total cost of the frontier-model tier, given the machines already existed: two Mikrotiks, two NICs, and a handful of DACs.

FAFO delivers.

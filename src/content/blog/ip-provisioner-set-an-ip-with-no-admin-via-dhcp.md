---
title: "IP Provisioner: Setting an IP With No Admin, No UAC, By Being the DHCP Server"
description: "The sequel to IPChanger. Why Network Configuration Operators silently fails on a locked-down Windows 11 desktop, and the trick that sidesteps privilege entirely — let the SYSTEM DHCP client write the address while a tiny user-mode server hands it out."
pubDate: 2026-07-29
category: "PowerShell"
tags: ["powershell", "networking", "dhcp", "uac", "winforms", "ps2exe", "sccm"]
author: "JD"
draft: true
---

> **Companion repo**: [IPProvisioner](https://github.com/Biggoan1/IPProvisioner) — the WinForms + CLI app, build/sign script, and SCCM install/uninstall wrapper.

In the [IPChanger post](/blog/ipchanger-self-elevating-network-config-gui) I built a WinForms tool that let a delegated user change an adapter's IP by leaning on the **Network Configuration Operators** (NCO) group and self-elevating through UAC. It worked on my bench. Then it met a properly hardened Windows 11 image and a real-world constraint — the operators run a separate non-admin **xID**, never a local admin — and it fell flat on its face. This is the story of why, and the frankly more elegant thing that replaced it.

## The wall: NCO is real, but the token throws it away

The premise of IPChanger is sound: `netsh interface ipv4 set address` genuinely succeeds for a plain member of Network Configuration Operators. Remove the membership and the exact same command returns *"The requested operation requires elevation."* So NCO is the capability. Good.

The problem is **UAC token filtering**, and it depends on something I'd never had to think about: **logon type**. When a member of an administrator-equivalent group — and NCO is on that list, alongside Backup Operators and friends — logs on **interactively**, UAC builds a *filtered* token in which that group is marked **deny-only**. The membership is still in the token; it just can't grant anything. Ask the framework and it agrees:

```powershell
# same account, three logon types, one question: is NCO usable?
LOGON_INTERACTIVE (2)  ->  IsInRole(NCO) = False   # deny-only: BLOCKED
LOGON_BATCH       (4)  ->  IsInRole(NCO) = True    # usable
LOGON_NETWORK     (3)  ->  IsInRole(NCO) = True    # usable
```

Every "it works over SSH!" test I ran early on was a **network** logon — unfiltered — which is exactly why it lied to me. On the actual desktop (an interactive logon) the operator's token has NCO neutered, `netsh` refuses, and there is no way around it with a launcher: `runas`, "Run as different user", `Start-Process -Credential`, and the `ncpa.cpl` dialog are *all* interactive logons. And UAC over-the-shoulder elevation only accepts local **Administrators** — so a non-admin xID can never satisfy the prompt (you get `consent.exe` error 740). The IPChanger design simply cannot serve a least-privilege xID. Dead end.

## The reframe: don't hold the right, borrow a service that does

If interactive tokens can't use NCO, and I can't hand the xID admin, then the *user* can't be the one that writes the NIC config. So who can?

The **DHCP Client service** can. It runs as SYSTEM, it configures adapters all day long, and it is completely trusted. The user's job isn't to change the IP — it's to *tell the DHCP client what address to take*. That means running a DHCP server. On the machine. For the machine itself.

I assumed this was impossible — surely a host can't lease an address to its own NIC on the same wire; the broadcast won't loop back. So I tested it instead of assuming, and I was wrong:

```powershell
# a plain UDP/67 listener, then force the NIC to DISCOVER:
pkt #1 from 0.0.0.0  len=300  bootp-op=1  chaddr=BC:24:11:DD:EB:05   # our own DISCOVER!
```

Windows delivers the host's own DHCP broadcast to a local listener. So a user-mode DHCP server on the box *can* answer its own NIC. Wire up the OFFER/ACK and:

```
DISCOVER -> OFFER 192.168.50.100
REQUEST  -> ACK   192.168.50.100
Ethernet 2 address: 192.168.50.100/24 [Dhcp]
```

The NIC self-configured. And critically — this works as a **plain non-admin user**. No NCO, no elevation, no `netsh`. Binding UDP/67 needs no privilege on Windows (there's no low-port restriction like Linux), and the privileged write is done by the SYSTEM DHCP client, not by the user. Everything the operator needs, they already have.

## The one gotcha: pin the egress interface

The first working version leaked. My send socket was bound to `0.0.0.0`, so Windows routed the broadcast OFFER out the **primary** interface — toward the corporate LAN — instead of the isolated bench link. The NIC never got its offer, and I'd briefly become a rogue DHCP server on the wrong network (a stray OFFER with no matching transaction is ignored, so no harm done, but still).

The fix is the `IP_UNICAST_IF` socket option (option 31), which pins outgoing packets to a specific interface index, in network byte order:

```powershell
$noVal = [System.Net.IPAddress]::HostToNetworkOrder([int]$ifIndex)
$udp.Client.SetSocketOption([System.Net.Sockets.SocketOptionLevel]::IP,
                            [System.Net.Sockets.SocketOptionName]31, $noVal)
```

With the egress pinned, the OFFER only ever leaves the chosen adapter.

## Making it safe to run

"Run a DHCP server on an endpoint" is the kind of sentence that makes a security team reach for the fire axe, so the design earns its keep two ways:

- **Own-MAC guard.** The server only ever answers DHCP requests whose client hardware address is the *selected adapter's own MAC*. It physically cannot hand an address to any other device, even if you plug into a live network by mistake. It's not a DHCP server so much as a self-assignment mechanism that happens to speak DHCP.
- **Live-network check.** On start it warns if the chosen adapter already has a gateway and a routable DHCP lease — a sign you're not on the isolated bench link the tool is meant for.

The address is a lease, not a static binding, so the tool holds it only while it's running. Closing the app (or the **Turn Off** button) lets the lease lapse and the adapter returns to normal. The on/off switch is free.

## Shipping it

One `.ps1` gives both a WinForms GUI (adapter picker, IP/mask/gateway fields, a big Turn On/Off button) and a first-class CLI:

```powershell
IPProvisioner.exe -List
IPProvisioner.exe -Cli -Nic "Ethernet 2" -OfferIP 192.168.1.50 -Mask 255.255.255.0 -Gateway 192.168.1.1
```

`ps2exe` compiles it — windowed for the GUI shortcut, or `-Console` for a CLI exe — and the build script Authenticode-signs the exe and installer. The installer's one-time elevated step creates the folders and shortcuts; it grants **no** user rights and touches **no** groups, because the app needs none. It deploys cleanly through SCCM to the bench machines.

## The lesson

I spent a day trying to give a user a right they were allowed to have, and the answer turned out to be to stop trying — and let a service that already has the right do the work, while the user just shapes the request. The capability you're reaching for isn't always yours to wield directly; sometimes it's already running as SYSTEM, waiting to be asked the right question.

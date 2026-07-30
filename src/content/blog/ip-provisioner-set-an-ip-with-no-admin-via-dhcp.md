---
title: "IP Provisioner: Setting an IP With No Admin, No UAC, by Becoming the DHCP Server"
description: "The sequel to IPChanger. Why Network Configuration Operators silently dies on a hardened Windows 11 desktop, every dead end I hit trying to force it, and the counterintuitive fix — let the SYSTEM DHCP client write the address while a tiny user-mode server hands it out to your own NIC."
pubDate: 2026-07-29
category: "PowerShell"
tags: ["powershell", "networking", "dhcp", "uac", "winforms", "ps2exe", "sccm", "adcs"]
author: "JD"
draft: false
---

> **Companion repo**: [IPProvisioner](https://github.com/Biggoan1/IPProvisioner) — the WinForms + CLI app, build/sign script, and SCCM install/uninstall wrapper.

In the [IPChanger post](/blog/ipchanger-self-elevating-network-config-gui) I shipped a tidy little tool that let a delegated user change an adapter's IP by leaning on the **Network Configuration Operators** group and self-elevating through UAC. It worked on my bench. Then it met a properly hardened Windows 11 image and a real-world constraint I hadn't designed for — the field techs run a separate non-admin **xID**, never a local admin — and it fell flat on its face.

This post is the whole autopsy and the rebuild. It's long, because the *wrong turns* are the interesting part: I spent a day trying to grant a user a right they were technically allowed to have, and the answer turned out to be to stop trying and let a service that already had the right do the work. If you've ever fought Windows over "why can't this non-admin just do the one small thing," pull up a chair.

## The requirement

A field technician plugs a laptop into a switch, AP, or router that isn't on the network yet, sets their laptop's Ethernet to a static IP on the device's subnet (say `192.168.1.50` to reach a device sitting at `192.168.1.1`), pushes config or firmware, and flips back to DHCP. Dozens of these people, none of them technical, and — the hard rule — **none of them get local admin.** Privileged work is done under an `xID` account that is *also* not a local admin.

Simple ask. Windows disagrees.

## The obvious answer, and why it's a corpse

Windows ships a built-in group for exactly this: **Network Configuration Operators** (NCO). Members are supposed to be able to change TCP/IP settings without full admin. And they genuinely can — from the right context:

```powershell
# member of Network Configuration Operators, no elevation:
netsh interface ipv4 set address name="Ethernet" source=static address=192.168.1.50 mask=255.255.255.0
# -> exit 0. It works.

# remove the group membership, run the identical command:
# -> "The requested operation requires elevation (Run as administrator)."
```

So NCO *is* the capability. Case closed, right? That's what I thought for about four hours, while every single test lied to me — because I was running them over SSH, and **SSH is a network logon**.

Here's the thing nobody tells you until it ruins your afternoon: **UAC filters group membership by logon type.** When a member of an administrator-equivalent group logs on *interactively*, UAC builds a **filtered token** where those groups are marked "deny-only" — present, but unable to grant anything. NCO is on that list, right alongside Backup Operators and friends. Network and batch logons are **not** filtered.

Don't take my word for it — ask the framework directly. Log the same account on three ways and check whether it can actually *use* NCO:

```powershell
# LogonUser() the same xID under three logon types, then WindowsPrincipal.IsInRole(NCO):
#   IsInRole returns TRUE only if the group is ENABLED in the token.
LOGON_INTERACTIVE (2)  ->  IsInRole('S-1-5-32-556') = False   # deny-only: BLOCKED
LOGON_BATCH       (4)  ->  IsInRole('S-1-5-32-556') = True    # usable
LOGON_NETWORK     (3)  ->  IsInRole('S-1-5-32-556') = True    # usable
```

There it is. The *interactive* desktop session — the one your user is actually sitting in — is the single case where NCO is neutered. `whoami /groups` in that session shows it as literally `Group used for deny only`. And it's not just netsh; the modern `Get-NetAdapter` / `Get-NetIPAddress` CIM cmdlets return `Cannot connect to CIM server. Access denied` for a non-admin too.

Every "it works!" result I'd celebrated came over SSH (network logon, unfiltered). On the actual desktop, it was elevate-or-nothing.

## Every door, and why each one is locked

Fine — if the interactive token can't use NCO, I'll launch the tool some *other* way. I tried them all:

- **`runas /user:xID`** — same interactive logon under the hood (`CreateProcessWithLogonW`). Filtered token. NCO deny-only.
- **Shift-right-click → "Run as different user"** — that *is* `runas`. Same result.
- **`Start-Process -Credential`** — also `CreateProcessWithLogonW`. Same.
- **`ncpa.cpl` adapter properties, interactively** — the classic dialog routes the write through an elevation-gated path. UAC credential prompt for an admin the user doesn't have.
- **Just satisfy the UAC prompt with the xID** — nope. Over-the-shoulder elevation *only* accepts members of local **Administrators**. A non-admin xID gets `consent.exe` error **740** ("The requested operation requires elevation"). There is no "elevate using my NCO rights" path. UAC is binary: admin or nothing.
- **WinRM / a loopback network logon** — a network logon *would* keep NCO enabled, but the box's hardening baseline had WinRM's `AllowNegotiate`/`AllowKerberos` set to `0`, and standing up a listener just to talk to yourself is deranged.

Everything routed back to the same wall. You cannot get a desktop user an unfiltered NCO token without either elevation (admin only) or a non-interactive logon you can't conjure from the desktop.

## The reframe that unlocked it

I'd been asking the wrong question. Not "how do I give the user the right," but "who *already has* the right, that the user can simply ask?"

The **DHCP Client service** has it. It runs as SYSTEM. It configures adapters all day long. It is completely trusted. The user's job was never to write the NIC config — it's to *tell the DHCP client what address to take.* Which means: run a DHCP server. On the machine. For the machine's own NIC.

I assumed this was impossible — surely a host can't lease an address to its own NIC on the same wire; the broadcast won't loop back to a local listener. So (lesson of the day: **test the assumption instead of believing it**) I bound a UDP/67 socket and forced the NIC to DISCOVER:

```
# a plain UDP/67 listener on the box, then trigger the NIC's DHCP DISCOVER:
pkt #1 from 0.0.0.0  len=300  bootp-op=1  chaddr=BC:24:11:DD:EB:05   # <- our OWN DISCOVER
```

Windows delivered the host's own DHCP broadcast to a local listener. The wall wasn't there. Wire up a proper OFFER/ACK and:

```
DISCOVER -> OFFER 192.168.50.100
REQUEST  -> ACK   192.168.50.100
Ethernet 2 address: 192.168.50.100/24 [Dhcp]
```

The NIC configured itself. And — the whole point — it worked **as a plain non-admin user**: no NCO, no elevation, no netsh. Binding UDP/67 needs no privilege on Windows (there's no low-port restriction like Linux), and the privileged write is done by the SYSTEM DHCP client, not the user. The user already has everything required.

## Building it right

A proof of concept that hands out one address is easy. A thing you'd deploy to non-technical people needs to not blow up the network. Three details did the heavy lifting.

**1. Pin the egress interface, or you become a rogue DHCP server.** My first working build "worked" and also leaked — the send socket was bound to `0.0.0.0`, so Windows routed the broadcast OFFER out the *primary* interface (toward the corporate LAN) instead of the bench link. The fix is the `IP_UNICAST_IF` socket option (interface index in network byte order):

```powershell
$noVal = [System.Net.IPAddress]::HostToNetworkOrder([int]$ifIndex)
$udp.Client.SetSocketOption([System.Net.Sockets.SocketOptionLevel]::IP,
                            [System.Net.Sockets.SocketOptionName]31, $noVal)  # IP_UNICAST_IF
```

Now every OFFER leaves only the adapter the user picked.

**2. The own-MAC guard — the thing that makes it safe to hand to humans.** "Run a DHCP server on an endpoint" is a sentence that makes security teams reach for the fire axe. So the server only ever answers requests whose client hardware address is *the selected adapter's own MAC*:

```powershell
if ($mac -ne $cfg.MacStr) { continue }   # never answer any client but our own NIC
```

It physically cannot hand an address to another device, even if the tech mis-plugs into a live network. It isn't really a DHCP server — it's a self-assignment mechanism that happens to speak DHCP. There's also a startup guard that warns if the chosen adapter already has a gateway and a routable DHCP lease (a sign you're *not* on the isolated bench link this is meant for).

**3. The lease is the on/off switch.** The address is a DHCP lease, held only while the tool runs. Close it, or hit **Turn Off**, and the lease lapses and the adapter goes back to normal. No cleanup, no "did I remember to set it back to DHCP." Reads via `System.Net.NetworkInformation` (not CIM, which non-admins can't reach) round it out.

## One exe, two faces

Field techs want a GUI. I want a CLI for scripting and my own sanity. ps2exe makes you choose: windowed (no console — GUI never flashes a black box) or console (CLI output works, but flashes a console for GUI users). I wanted both from one binary.

Trick: build it **windowed**, and in CLI mode attach to the launching console so `Write-Host` lands where the user typed the command:

```powershell
function Use-ParentConsole {
    Add-Type -Name Con -Namespace Fafo -MemberDefinition '[System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern bool AttachConsole(int pid);'
    [void][Fafo.Con]::AttachConsole(-1)   # -1 = ATTACH_PARENT_PROCESS
}
```

Double-click → GUI, no console flash. `IPProvisioner.exe -Cli -Nic "Ethernet" -OfferIP 192.168.1.50` → output right there in your shell. Same signed binary.

## "Configured" is not "working"

Here's a mistake I nearly shipped: I verified the NIC *received the IP* — correct address, right subnet, on-link route in the table — and called it "verified." Then someone asked the obvious question I hadn't actually answered: **does it pass traffic?**

An IP in `ipconfig` and a working interface are different claims. So I put a peer on the other end of the isolated link and moved real packets:

```
W104 (192.168.50.100)  ->  peer (192.168.50.1) :  replies, sub-ms
peer (192.168.50.1)    ->  W104 (192.168.50.100):  3/3 received, 0% loss
```

Bidirectional, clean. *Now* it's verified. Assign an IP and prove nothing flows and you've shipped a demo, not a tool.

## Shipping it like a grown-up

- **Signed.** Stood up an ADCS enterprise CA, issued a code-signing cert, and Authenticode-signed the exe and installer. (Gotcha for another post: enrolling/importing certs over a key-based SSH session fails with `NOT_AUTHENTICATED` / DPAPI errors, because that's a credential-less network logon — enroll locally, import into `LocalMachine\My`.)
- **Version-aware detection.** The installer writes an Add/Remove Programs entry with `DisplayVersion`, and the SCCM detection rule keys on the exe's file version (`>= 1.0.2.0`), not mere file-existence — so an in-place upgrade actually detects as an upgrade instead of "already installed."
- **Deployed via SCCM** to a test collection, then verified the whole chain end to end: an in-place `1.0.0 → 1.0.1 → 1.0.2` upgrade on a real, domain-joined laptop, installed from Software Center, signature valid, and — the final build's job — the adapter picker showing **wired NICs only, no Wi-Fi.**

## The lesson

I burned a day trying to hand a user a right the OS kept snatching back at the door. The fix wasn't a cleverer way to grant the right — it was to notice that a fully-trusted service *already holds it and runs it constantly*, and to give the user a way to shape its input instead of impersonating its power.

The capability you're reaching for isn't always yours to wield directly. Sometimes it's already running as SYSTEM, waiting to be asked the right question. Learn to recognize the difference between "I need this privilege" and "I need this *outcome*" — the second one usually has a door the first one doesn't.

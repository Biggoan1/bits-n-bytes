---
title: "CMPivot Queries That Actually Pay Rent"
description: "A field guide of CMPivot queries I reach for daily — the ones that close tickets at 3 PM on a Friday."
pubDate: 2026-05-11
category: "SCCM"
tags: ["cmpivot", "sccm", "mecm", "fleet-management"]
author: "JD"
draft: false
---

[CMPivot](https://learn.microsoft.com/en-us/intune/configmgr/core/servers/manage/cmpivot) is real-time fleet introspection inside MECM. You write a [KQL](https://learn.microsoft.com/en-us/kusto/query/)-style query, the site server fans it out to every online client in the targeted collection, and the results come back in seconds — live, evaluated by the client agent itself, not a stale hardware-inventory snapshot.

The queries below are the ones I actually paste in when something breaks. Caveat up front: CMPivot only runs against online clients in the targeted collection. Offline machines get skipped.

## Software presence — installed and from the Store

This is the one I run constantly. "Find every machine that has X installed." Hardware inventory will eventually tell you, but CMPivot tells you in 30 seconds:

```kusto
InstalledSoftware | where ProductName startswith 'NVIDIA Graphics'
```

`startswith` over `==` because vendor names drift across versions ("NVIDIA Graphics Driver" vs "NVIDIA Graphics Driver - Display"). `contains` works too but is slower and noisier — use `startswith` when you know the prefix.

For Microsoft Store apps, `InstalledSoftware` doesn't see them. Use `InstalledStoreProgram` instead:

```kusto
InstalledStoreProgram | where Name like 'Microsoft.MSPaint' | order by Version
```

Sort by Version when you're hunting devices stuck on an old build. Sort by Device when you want a clean per-machine list. Useful when a Store app silently rolls out a breaking version and three users open tickets in the same hour.

## Targeting one specific device

CMPivot lets you scope to a single device by name. When a user calls and says "Outlook hangs every time I open it," I want to know what's running on **their** machine specifically:

```kusto
InstalledSoftware | where Device == 'WS-EXAMPLE-001' and ProductName contains 'AcmeAgent'
```

Two things to notice. First, `Device ==` is a hard equality match, no wildcards — get the hostname right. Second, this style of query lets you intersect "everywhere this software exists" with "this one machine," which is how I confirm whether a problematic agent actually deployed where the deployment report claims it did.

## Service state — is it running right now?

Hardware inventory tells you a service exists. CMPivot tells you whether it's running this second:

```kusto
Service | where Name == 'AcmeAgentService' | where State != 'Running'
```

The classic pattern: an agent that's supposed to be running on every endpoint, but isn't. Filter to where State isn't Running and you've got your remediation collection in one query. From there, target with a script deployment that does `Start-Service` and adds a `Set-Service -StartupType Automatic` for good measure.

## Registry — policy state at runtime

This is the killer. Group Policy reports lie occasionally. CMPivot doesn't:

```kusto
Registry('HKLM:\SOFTWARE\Policies\Microsoft\Edge') | where Property == 'ProxySettings'
```

What you get back is the actual value sitting in the registry on every targeted device. When a GPO claims to be applied but Edge is still hitting the wrong proxy, this query closes the loop. Same pattern works for any policy hive — Defender exclusions, Windows Update for Business, BitLocker policy, you name it:

```kusto
Registry('HKLM:\SOFTWARE\Policies\Microsoft\Windows Defender\exclusions\paths')
```

Returns the actual exclusion paths in effect. Crucial when somebody claims an antivirus exception "isn't working" — you can see whether the exclusion landed at all, and where.

## File presence and age

A few times a year I need to know which machines have a specific file on disk. Memory dumps are the classic case:

```kusto
File('c:\\windows\\memory.dmp') | project Device, LastWriteTime
```

That's "which devices crashed recently and left a dump behind." Beat the pattern with `where LastWriteTime > ago(7d)` to scope to a window. Combine with a collection of frequently-crashing machines and you have a real triage list, not a guess.

For checking whether a specific binary is on disk — say, after a manual install of something — the same `File()` operator works against any path you want:

```kusto
File('%ProgramFiles%\\AcmeApp\\bin\\acmeagent.exe') | project Device, LastWriteTime, Size
```

## Hardware shapes — quick model census

```kusto
ComputerSystem | distinct Model
```

Use case: you're about to drop a driver package and want to know every Dell/HP/Lenovo model SKU in your fleet. The full list, deduped, in one second. From there, `| where Model contains 'Latitude'` carves out the slice you care about.

## Triggering an install (use sparingly)

CMPivot supports `EXECUTE` for limited remote actions, and the WMI route also works in the right hands:

```powershell
# Run as a script deployment, not from CMPivot directly
([wmiclass]'ROOT\\ccm\\ClientSdk:CCM_Application').Install(
    '<your-scopeid>/<application-id>',
    17,        # priority (Foreground)
    $true,     # IsRebootIfNeeded
    0,         # reboot deadline
    'Normal',  # Mode
    $false     # AppEnforcePreference (false = enforce now)
)
```

The two opaque IDs come from the application's CI properties (Software Library → Applications → right-click → Properties). The 17 is the priority enum value for Foreground installs. This is the trick for forcing an application to install on a single machine without waiting for the next deployment evaluation — useful when you're hot-fixing one device and you don't want to push a collection-wide change to do it.

A word of caution: this is a hammer. Don't reach for it as a deployment pattern; reach for it when you need a one-off and the standard `Invoke-CMClientNotification` push isn't doing the job.

## What CMPivot won't do

CMPivot is great. It is not magic. Things it won't help with:

- **Offline machines.** No reachable client, no result. If half your fleet is asleep on Saturday, half your fleet doesn't answer.
- **Long-running queries.** There's a built-in timeout, and complex queries that hit slow file paths will return partial results. Keep queries fast and specific.
- **Historical data.** "What was installed two weeks ago?" — that's hardware inventory's job, not CMPivot's. CMPivot is right-now.
- **Cross-collection joins.** You're stuck with one collection per query. Pivot from there.

## Going further

- [CMPivot in Configuration Manager](https://learn.microsoft.com/en-us/intune/configmgr/core/servers/manage/cmpivot) — overview, prerequisites, security model.
- [CMPivot entity and operator reference](https://learn.microsoft.com/en-us/intune/configmgr/core/servers/manage/cmpivot-changes) — the canonical list of what you can query (`InstalledSoftware`, `Service`, `Registry`, `File`, `EventLog`, etc.) and the supported operators.
- [KQL quick reference](https://learn.microsoft.com/en-us/kusto/query/) — the broader query language CMPivot draws from. Not every KQL operator works in CMPivot, but the syntax intuition transfers and the `summarize`, `where`, `project`, and `join` patterns are the same.
- [Configuration Manager PowerShell cmdlet `Invoke-CMScript`](https://learn.microsoft.com/en-us/powershell/module/configurationmanager/invoke-cmscript) — when CMPivot can't do it, an approved script deployed against a collection usually can.

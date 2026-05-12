---
title: "Deploying Visual Studio via SCCM: Layout, Updater, and Add-ins"
description: "End-to-end deployment of Visual Studio via SCCM — building the offline layout, keeping it current, shipping the install, the updater, and add-ins."
pubDate: 2026-05-12
category: "SCCM"
tags: ["visual-studio", "sccm", "powershell", "packaging", "deployment"]
author: "JD"
draft: false
---

> **Companion repo**: [VisualStudioInstallKit](https://github.com/Biggoan1/VisualStudioInstallKit) — parameterized PowerShell scripts and detection-method templates for the pattern below. Clone it, edit paths, ship.

## Background

Visual Studio doesn't deploy like a normal MSI. The installer is a small bootstrapper that wants to talk to a Microsoft CDN, but a managed environment generally can't let every dev machine pull tens of gigabytes of installer payload through the corporate egress on demand. The fix is an **offline layout**: a fully-mirrored copy of the installer plus every workload, hosted on a file share, that becomes the install source AND the update channel for all clients. Once the layout exists, four pieces ride on top of it — the **install** package, the **updater** package, **add-in** packages, and **detection methods** that can tell whether a specific workload or component is on a given machine.

This is the full pipeline: layout creation, layout maintenance, install deployment, update deployment, add-in deployment, and the detection-method pattern that ties it together. All paths shown are placeholder UNC paths; substitute your own file share.

## Create the layout

Run from an elevated prompt on a machine with internet access. Workloads go on the first `--layout` call; the bootstrapper writes a `layout.json` so subsequent updates don't have to re-specify them.

**Path-length constraint:** Microsoft's docs state the layout path must be **fewer than 80 characters** — packages inside the layout extend long enough that exceeding this trips Windows `MAX_PATH` limits and breaks installs in confusing ways. Pick a short root (e.g. `D:\Sources\VS2022\Pro\VSLayout`) or use a symbolic link to mount a deeper share at a shorter path. Reference: [Create a network-based installation of Visual Studio](https://learn.microsoft.com/en-us/visualstudio/install/create-a-network-installation-of-visual-studio).

```powershell
$bootstrapper = 'C:\Temp\vs_professional.exe'   # downloaded from aka.ms/vs/stable/vs_professional.exe
$layoutPath   = 'C:\Temp\VSLayout-2022-Pro'

Start-Process $bootstrapper -Wait -ArgumentList @(
    '--layout', "`"$layoutPath`"",
    '--add', 'Microsoft.VisualStudio.Workload.ManagedDesktop',
    '--add', 'Microsoft.VisualStudio.Workload.NetWeb',
    '--add', 'Microsoft.VisualStudio.Workload.Azure',
    '--add', 'Microsoft.VisualStudio.Workload.NativeDesktop',
    '--add', 'Microsoft.VisualStudio.Workload.Data',
    '--includeRecommended',
    '--lang', 'en-US',
    '--passive', '--wait'
)

Unblock-File "$layoutPath\vs_professional.exe"
```

A few things to notice. The `--layout` switch is the bootstrapper's "download this for offline use" mode — it pulls every package for the workloads you specified into the target directory. `--includeRecommended` brings in the recommended optional components for each workload. `--lang en-US` keeps you from pulling 30 GB of language packs you'll never use; layouts get big enough without them. `Unblock-File` clears the Mark-of-the-Web flag Windows puts on internet-downloaded executables — without it, clients running the bootstrapper from the share will hit SmartScreen warnings.

After the layout finishes, copy it onto the file share. Use `xcopy /e /y` or `robocopy /e /mt:16` — the layout is tens of thousands of small files. PowerShell's `Copy-Item -Recurse` is dramatically slower.

**Plan share capacity.** Microsoft's published guidance is ~40 GB for Community and ~50 GB for Enterprise in a single language, plus ~0.5 GB per additional language. In practice you'll burn far more: multiple editions, multiple language packs, and the accumulated `Archive\` folder that grows each time you update push real-world layouts into the hundreds of gigabytes — and into the terabytes if you maintain layouts for multiple major versions and don't aggressively `--clean`.

```cmd
robocopy "C:\Temp\VSLayout-2022-Pro" "\\<file-share>\Sources\Microsoft\VisualStudio\2022\Pro\VSLayout" /e /mt:16
```

### Pin the channelUri so updates land on the layout, not Microsoft's CDN

The layout creation drops a `Response.json` at the layout root. By default its `channelUri` points at Microsoft's online channel, which means clients installed from your layout will reach back to the public CDN for future updates — defeating the point of having an offline layout. Fix it before the layout ships.

Open `Response.json` after the layout finishes and change one field — set `channelUri` to your share's UNC path:

```json
"channelUri": "\\\\<file-share>\\Sources\\Microsoft\\VisualStudio\\2022\\Pro\\VSLayout"
```

Backslashes are doubled because JSON escapes them. Leave every other field in `Response.json` alone — the bootstrapper writes the rest correctly during layout creation.

## Maintain the layout

The maintenance loop has three operations you'll actually use:

```powershell
# Update — re-runs the layout against layout.json, pulls latest packages
& vs_professional.exe --layout "\\<file-share>\...\VSLayout" --lang en-US --passive --wait

# Verify — checks integrity, doesn't fix
& vs_professional.exe --layout "\\<file-share>\...\VSLayout" --verify

# Fix — verify + redownload bad/missing files (needs internet)
& vs_professional.exe --layout "\\<file-share>\...\VSLayout" --fix

# Clean — remove old cached packages that are no longer in the catalog (saves disk)
& vs_professional.exe --layout "\\<file-share>\...\VSLayout" --clean ".\Archive\<GUID>\Catalog.json"
```

The pattern that works at scale: **update to a staging path on a local disk, then robocopy onto the share.** Updating directly over a UNC is slower and exposes the share to inconsistent state if the update is interrupted.

```powershell
$staging = 'C:\Temp\VSLayout-Staging'
$share   = '\\<file-share>\Sources\Microsoft\VisualStudio\2022\Pro\VSLayout'

& vs_professional.exe --layout $staging --lang en-US --passive --wait
& vs_professional.exe --layout $staging --verify

robocopy $staging $share /mir /mt:16   # /mir mirrors deletes too — careful, but desirable here
```

Run on Patch Tuesday and you'll always be a Patch Tuesday behind production, which is exactly the right place to be.

## Deploy the install

A single PowerShell wrapper handles install, update, and uninstall in one script — branched by an `$Action` parameter. SCCM creates three deployment types (one per action) against the same content source.

```powershell
param(
    [Parameter(Mandatory)][ValidateSet('Install','Update','Uninstall')][string]$Action,
    [Parameter(Mandatory)][ValidateSet('Professional','Enterprise')][string]$Edition
)

$ErrorActionPreference = 'Stop'
$logFile = Join-Path $env:SystemDrive "Distrib\logs\$($MyInvocation.MyCommand.Name).log"
New-Item -ItemType Directory -Path (Split-Path $logFile) -Force | Out-Null
Start-Transcript -Path $logFile -Append

# Map edition to the right layout bootstrapper on the share
$layoutBootstrapper = switch ($Edition) {
    'Professional' { '\\<file-share>\Sources\Microsoft\VisualStudio\2022\Pro\VSLayout\vs_professional.exe' }
    'Enterprise'   { '\\<file-share>\Sources\Microsoft\VisualStudio\2022\Ent\VSLayout\vs_enterprise.exe' }
}

switch ($Action) {
    'Install' {
        $args = @(
            '--noWeb',                     # don't fall back to MS CDN
            '--passive', '--wait',
            '--norestart',
            '--noUpdateInstaller',         # don't auto-upgrade the VS Installer itself during this run
            '--add', 'Microsoft.VisualStudio.Workload.ManagedDesktop',
            '--includeRecommended'
        )
        $proc = Start-Process -FilePath $layoutBootstrapper -ArgumentList $args -Wait -PassThru
    }

    'Update' {
        # Resolve the installed instance's path so --update knows what to operate on
        $vs = Get-CimInstance MSFT_VSInstance -Namespace root/cimv2/vs -ErrorAction Stop
        $args = @(
            '--noWeb', '--update', '--wait', '--passive', '--norestart',
            '--installPath', "`"$($vs.InstallLocation)`""
        )
        $proc = Start-Process -FilePath $layoutBootstrapper -ArgumentList $args -Wait -PassThru
    }

    'Uninstall' {
        $vs = Get-CimInstance MSFT_VSInstance -Namespace root/cimv2/vs -ErrorAction Stop
        $args = @('uninstall', '--installPath', "`"$($vs.InstallLocation)`"")
        $setupExe = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\setup.exe'
        $proc = Start-Process -FilePath $setupExe -ArgumentList $args -Wait -PassThru
    }
}

Stop-Transcript
exit $proc.ExitCode
```

Two pieces worth calling out. `Get-CimInstance MSFT_VSInstance -Namespace root/cimv2/vs` is the official way to find an existing VS install — it's populated by the VS Installer itself and is far more reliable than parsing Add/Remove Programs. The Update branch uses it to point `--installPath` at the right directory; Uninstall uses it for the same reason.

`--noWeb` is the load-bearing flag for fully-offline behavior. Without it, the bootstrapper will silently fall back to the Microsoft CDN if it can't find a package in the layout, which defeats the purpose of running a layout.

**SCCM deployment type settings:**

- Content location: `\\<file-share>\Sources\Microsoft\VisualStudio\2022\Pro\VSLayout` (the layout IS the content; nothing else needed)
- Install command: `powershell.exe -ExecutionPolicy Bypass -File .\Install-VS.ps1 -Action Install -Edition Professional`
- Installation behavior: `InstallForSystem`
- Logon requirement: `WhetherOrNotUserLoggedOn`
- Maximum runtime: `120` minutes (VS installs are slow; don't let SCCM cut them off)
- Exit codes: treat `0`, `3010`, and `1641` as success

## Deploy the updater

The updater is the same script with `-Action Update` — but ships as its own SCCM Application so it can be deployed independently of the install. Useful when:

- VS itself is installed and you only want to refresh existing instances after a layout update
- You want a separate deployment window for updates vs. fresh installs
- You need to deploy the update to a smaller validation collection first

The detection method for the updater is "VS is installed AND the version is at or above the layout's current version." Get the layout's current channel-manifest version from the `ChannelManifest.json` in the share root, then write the detection to compare:

```powershell
# Detect-VSAtLeastVersion.ps1 — for the updater DT
$minVersion = [version]'17.10.0'    # set per layout-refresh release
$vs = Get-CimInstance MSFT_VSInstance -Namespace root/cimv2/vs -ErrorAction SilentlyContinue
if ($vs -and [version]$vs.Version -ge $minVersion) {
    Write-Output 'Installed'
}
```

Update `$minVersion` each time you push a new layout. The detection re-evaluates on the next policy cycle without reinstalling the software, so clients self-report their compliance with the latest layout version.

## Deploy add-ins (workload components)

Add-ins for VS are **workload components** — individual pieces that get added to an existing VS install via `setup.exe modify --add <ComponentId>`. The same one-script-per-add-in pattern works for every component; only the ID changes.

```powershell
# Install-VSAddOn.ps1
param(
    [Parameter(Mandatory)][string]$ComponentId   # e.g. Microsoft.VisualStudio.Component.AspNet
)

$ErrorActionPreference = 'Stop'
$logFile = Join-Path $env:SystemDrive "Distrib\logs\AddOn-$ComponentId.log"
New-Item -ItemType Directory -Path (Split-Path $logFile) -Force | Out-Null
Start-Transcript -Path $logFile -Append

$vs = Get-CimInstance MSFT_VSInstance -Namespace root/cimv2/vs -ErrorAction Stop

# Pick the right layout for the installed edition
$layoutRoot = switch -Wildcard ($vs.Caption) {
    '*Professional*' { '\\<file-share>\Sources\Microsoft\VisualStudio\2022\Pro\VSLayout' }
    '*Enterprise*'   { '\\<file-share>\Sources\Microsoft\VisualStudio\2022\Ent\VSLayout' }
}

$setupExe = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\setup.exe'
$args = @(
    'modify',
    '--noUpdateInstaller', '--norestart', '--passive', '--noweb',
    '--add', $ComponentId,
    '--installPath',       "`"$($vs.InstallLocation)`"",
    '--installChannelUri', "`"$layoutRoot\ChannelManifest.json`"",
    '--channelUri',        "`"$layoutRoot`""
)

$proc = Start-Process -FilePath $setupExe -ArgumentList $args -Wait -PassThru
Stop-Transcript
exit $proc.ExitCode
```

The `--installChannelUri` and `--channelUri` arguments are important — they point the `modify` operation at your layout so it pulls the component bytes from the share rather than the Microsoft CDN. Without them, an add-in install on an air-gapped client will fail trying to reach the internet, even though the bytes are sitting on the share next door.

The uninstaller is the same script with `--Remove` instead of `--add`:

```powershell
$args[4] = '--Remove'   # swap --add for --Remove in the position above
```

### Detection method for add-ins

The detection script for any VS workload component is a single pattern — query the installed instance, ask whether the specific ComponentId is present:

```powershell
# Detect-VSComponent.ps1 — generic, parameter-driven
$ComponentId = 'Microsoft.VisualStudio.Component.AspNet'   # set per detection

$vs = Get-CimInstance MSFT_VSInstance -Namespace root/cimv2/vs -ErrorAction SilentlyContinue
if (-not $vs) { return }

# vswhere returns the list of installed components in JSON
$vswhere = Join-Path (Split-Path (Get-CimInstance MSFT_VSInstance -Namespace root/cimv2/vs).InstallLocation -Parent) 'Installer\vswhere.exe'
if (-not (Test-Path $vswhere)) {
    $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
}

$json = & $vswhere -products '*' -requires $ComponentId -format json -nologo 2>$null
if ($json -and ($json | ConvertFrom-Json)) {
    Write-Output 'Installed'
}
```

`vswhere.exe` is Microsoft's official "tell me what's installed" tool, shipped with VS itself, and it's the right answer for any component-presence question. Its `-requires <ComponentId>` flag filters to installs that have a given component — and if the resulting JSON is non-empty, the component is present.

SCCM detection method rule: **no `exit` statements** in the script. `Write-Output 'Installed'` on success; silent otherwise. The above pattern follows that.

### Finding the right ComponentId

When packaging a new add-in, the question is "what's the ComponentId I should be passing?" Two reliable sources:

1. **Microsoft's component-ID docs.** The canonical list per edition, kept current:
   - Professional: [workload-and-component-ids](https://learn.microsoft.com/en-us/visualstudio/install/workload-component-id-vs-professional)
   - Enterprise: [workload-and-component-ids](https://learn.microsoft.com/en-us/visualstudio/install/workload-component-id-vs-enterprise)
   - Build Tools: [workload-and-component-ids](https://learn.microsoft.com/en-us/visualstudio/install/workload-component-id-vs-build-tools)
2. **Export a `.vsconfig` from a reference install.** Open VS Installer → Modify → More → Export configuration. The resulting JSON lists every workload and component the installed instance has, by ID. If your test machine has the add-in installed correctly, the ID will be in that file.

For SCCM, ship one Application per add-in (with the ComponentId hardcoded into both the install command and the detection script). That gives you a clean per-add-in deployment, per-add-in detection, and a tidy Software Center entry.

## The pieces, deployed

| SCCM Application | Source | Install command | Detection |
|---|---|---|---|
| **Visual Studio Professional 2022** | `\\<share>\...\VSLayout` | `Install-VS.ps1 -Action Install -Edition Professional` | `MSFT_VSInstance` Caption = "Visual Studio Professional 2022" |
| **Visual Studio Update** | Same layout | `Install-VS.ps1 -Action Update -Edition Professional` | `MSFT_VSInstance` Version ≥ `$minVersion` |
| **VS Add-on: ASP.NET** | Layout root | `Install-VSAddOn.ps1 -ComponentId Microsoft.VisualStudio.Component.AspNet` | vswhere `-requires Microsoft.VisualStudio.Component.AspNet` returns non-empty |
| **VS Add-on: Azure** | Layout root | `Install-VSAddOn.ps1 -ComponentId Microsoft.VisualStudio.Workload.Azure` | vswhere `-requires Microsoft.VisualStudio.Workload.Azure` returns non-empty |
| ...one per add-in... | | | |

The base install and the updater point at the same content (the layout). Add-ins are tiny content (no real payload — the bytes come from the layout via the `--channelUri` arg) — the application "content" is just the install script and detection script. SCCM distributes those, the script handles the actual modify.

## Exit codes worth getting right

```text
0     Success
3010  Success, reboot required
1641  Success, reboot initiated
1602  User cancelled
1618  Another installer running
8006  VS processes running — close VS and retry
```

In the SCCM deployment type, configure `0`, `3010`, and `1641` as success and `3010`/`1641` as "soft reboot required." VS routinely returns 3010; if you treat it as failure, every install will look broken.

## Reference

- [Use the command line to install Visual Studio](https://learn.microsoft.com/en-us/visualstudio/install/use-command-line-parameters-to-install-visual-studio)
- [Create a network installation of Visual Studio](https://learn.microsoft.com/en-us/visualstudio/install/create-a-network-installation-of-visual-studio)
- [Deploy a layout to client workstations](https://learn.microsoft.com/en-us/visualstudio/install/deploy-a-layout-onto-a-client-machine)
- [vswhere on GitHub](https://github.com/microsoft/vswhere)
- [Workload and component IDs (Pro / Enterprise / Build Tools)](https://learn.microsoft.com/en-us/visualstudio/install/workload-and-component-ids)

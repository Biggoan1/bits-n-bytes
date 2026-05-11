---
title: "Wrangling Dell BIOS Across 25,000 Endpoints"
description: "BIOS management is the unglamorous half of endpoint engineering. Here's how I handle Dell at scale — provider module, password strategy, OSD-time config, version detection, and the gotchas nobody documents."
pubDate: 2026-05-12
category: "SCCM"
tags: ["dell", "bios", "sccm", "osd", "powershell", "packaging"]
author: "JD"
draft: true
---

Most posts about BIOS management stop at "use the Dell BIOS Provider, it's great." It is great. It's also a quarter of the actual job. When you're running 25,000 Dell endpoints across a half-dozen model families, the real questions are: how do you set the admin password without baking secrets into your task sequence, how do you push BIOS settings deterministically at OSD time, how do you survive Dell's "the version string is a string" decisions, and how do you keep your future self sane.

This is what seven years of doing it has taught me.

## The shape of the problem

A Dell laptop in an enterprise environment needs five things from BIOS, all of them annoying:

1. **An admin password** so end users can't disable Secure Boot, change the boot order, or unlock the BIOS to flash whatever they downloaded from a forum.
2. **A consistent configuration** — Secure Boot on, Legacy ROMs off, virtualization extensions on, USB boot disabled or enabled per policy, the right TPM mode, the right power-on settings.
3. **Up-to-date firmware**, because half the security CVEs you'll see this year start with "a flaw in Dell BIOS."
4. **Detection** — a way to read the version and feed it back to the task sequence so you don't reflash an already-current machine.
5. **Asset tracking** — write the BIOS version, model, and service tag somewhere durable so you can query the fleet without booting WMI on every machine.

The Dell BIOS Provider — a PowerShell module Dell publishes — handles #1, #2, and most of #3. Items #4 and #5 you build yourself. Let's walk through it.

## The Dell BIOS Provider, installed for real

Dell ships the provider as a download. You unpack it, copy it to the PowerShell module path, and `Import-Module` it. The catch: there are *two* module paths that matter on a modern Windows 10/11 endpoint — the Windows PowerShell 5.1 path (`%SystemRoot%\System32\WindowsPowerShell\v1.0\Modules\`) and the PowerShell 7 path (`%ProgramFiles%\PowerShell\7\Modules\`). If you only drop it in one, half your scripts will fail with "module not found" depending on which shell triggered them.

A minimal install script that handles both paths and is idempotent:

```powershell
param(
    [Parameter(Mandatory)][ValidateSet('Install','Uninstall')][string]$Action,
    [string]$SourceVersion = '2.8.0'   # subfolder name where the provider files live
)

$ErrorActionPreference = 'Stop'
$log = Join-Path $env:SystemDrive "Distrib\logs\$($MyInvocation.MyCommand.Name).log"
New-Item -ItemType Directory -Path (Split-Path $log) -Force | Out-Null
Start-Transcript -Path $log -Append

$targets = @(
    "$env:SystemRoot\System32\WindowsPowerShell\v1.0\Modules\DellBIOSProvider",
    "$env:ProgramFiles\PowerShell\7\Modules\DellBIOSProvider"
)

switch ($Action) {
    'Install' {
        foreach ($dest in $targets) {
            New-Item -ItemType Directory -Path $dest -Force | Out-Null
            Copy-Item -Path ".\$SourceVersion" -Destination $dest -Recurse -Force
        }
    }
    'Uninstall' {
        foreach ($dest in $targets) {
            if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
        }
    }
}

Stop-Transcript
```

Package that with the provider payload as a content source. Detection method: the `.psd1` file exists in both module paths. Now it's a regular SCCM application, deployable to your management collection.

## Password strategy at 25K endpoints

Here's the hard problem: you cannot manually manage 25,000 unique BIOS passwords. You also cannot use one universal password without committing professional malpractice. Three options exist, in order of how I rank them:

1. **A privileged vault** — passwords live in CyberArk/Bitwarden/whatever, retrieved at the moment they're needed via API. Most secure, most plumbing.
2. **A deterministic derivation** — the BIOS password is computed from a stable per-machine identifier plus an org-only salt, run through a hash. Less plumbing, weaker if the recipe leaks.
3. **One shared password.** Don't.

I'll describe option 2 because it's the pragmatic middle ground most shops actually land on. The pattern, in pseudocode:

```
identifier = Dell service tag (printed on the chassis)
salt       = some org-only string only known to the build engineers
material   = concatenate(identifier, salt, ...)
password   = take a fixed-length substring of SHA-512(material)
Set-Item DellSMBIOS:/Security/AdminPassword $password
```

Two important properties:

- **Deterministic per machine.** Any tech with the script and the salt can compute the password for a given chassis. No database to keep in sync.
- **Unique per machine.** Cracking one doesn't crack the others, because every machine's input material is different.

The security trade-off you're making is real: anyone who knows the recipe (and has physical access to a laptop) can derive its BIOS password. So the recipe itself becomes a sensitive secret. Store the salt outside the build scripts, rotate it when staff turns over, and **don't post the exact recipe on the internet**.

Setting the password once you've derived it:

```powershell
Import-Module DellBIOSProvider
Set-Location DellSMBIOS:
$isSet = (Get-Item -Path DellSmbios:\Security\IsAdminPasswordSet).CurrentValue

if (-not $isSet) {
    Set-Item -Path DellSMBIOS:\Security\AdminPassword -Value $password
} else {
    # Updating requires the current password
    Set-Item -Path DellSMBIOS:\Security\AdminPassword -Value $password -Password $currentPassword
}
```

Same call for "clear the password" — pass an empty string as the new value, and the current password as the `-Password` argument:

```powershell
Set-Item DellSMBIOS:/Security/AdminPassword -Password $currentPassword ""
```

That empty-string trick is documented poorly. Without it you cannot clear a BIOS password through the provider.

## BIOS configuration at OSD time

The provider exposes BIOS settings as PowerShell paths under `DellSMBIOS:\<category>\<setting>`. So `DellSMBIOS:\BootSequence\BootList`, `DellSMBIOS:\AdvancedBootOptions\LegacyOrom`, `DellSMBIOS:\SystemConfiguration\IntegratedNIC`, etc.

A typical pattern in a task sequence is to run a script step early — after the WinPE-to-OS transition and the Dell provider install — that:

1. Sets the admin password (if not already set) using the derivation above.
2. Applies the standard config in a loop.
3. Verifies and bubbles the result up to the task sequence environment so you can see it in `smsts.log`.

```powershell
$TSEnvironment = New-Object -ComObject Microsoft.SMS.TSEnvironment

Import-Module DellBIOSProvider

# Settings as a list of [path, value] pairs
$settings = @(
    @{ Path = 'DellSMBIOS:\SecureBoot\SecureBoot';                Value = 'Enabled' },
    @{ Path = 'DellSMBIOS:\AdvancedBootOptions\LegacyOrom';       Value = 'Disabled' },
    @{ Path = 'DellSMBIOS:\Virtualization\Virtualization';        Value = 'Enabled' },
    @{ Path = 'DellSMBIOS:\Virtualization\VtForDirectIo';         Value = 'Enabled' },
    @{ Path = 'DellSMBIOS:\TpmSecurity\TpmSecurity';              Value = 'Enabled' },
    @{ Path = 'DellSMBIOS:\TpmSecurity\TpmActivation';            Value = 'Enabled' }
)

foreach ($s in $settings) {
    try {
        Set-Item -Path $s.Path -Value $s.Value -Password $biosPassword
        Write-Host "OK: $($s.Path) = $($s.Value)"
    } catch {
        Write-Warning "Failed: $($s.Path) — $_"
    }
}

$TSEnvironment.Value('SMSTSBiosConfigApplied') = 'True'
```

A few hard-earned notes:

- **Setting names vary by model.** A Latitude 7440 has settings a desktop OptiPlex doesn't, and Dell occasionally renames things between firmware generations. Don't assume a single static settings list works across your whole fleet. Branch by model where needed.
- **Some settings require a reboot to take effect.** Apply, reboot, *then* verify in a subsequent step.
- **Don't catch exceptions silently** in production. Wrap each `Set-Item` in a try/catch and write to `smsts.log`. A silent BIOS-config failure during OSD is a future Sev-2.

## Version detection — the leading-zero trap

You'd think reading the BIOS version is easy:

```powershell
(Get-CimInstance Win32_BIOS).SMBIOSBIOSVersion
```

It is. The trap is what you do *with* the string. SMBIOSBIOSVersion is stored as a string, not a number. So when you have a fleet that's running BIOS versions like `1.4.2`, `1.10.0`, `2.0.1`, and `A09`, a naive string comparison will sort `1.10.0` *before* `1.4.2`. Your "is this machine at or above 1.10.0?" comparison will lie to you.

The fix is to parse the version into integer components and normalize with leading zeros:

```powershell
$raw = (Get-CimInstance Win32_BIOS).SMBIOSBIOSVersion

if ($raw -like 'A*') {
    # Legacy Dell BIOS (e.g. A09). Leave as-is, treat as a special branch.
    $normalized = $raw
}
else {
    [int]$major, [int]$minor, [int]$build = $raw.Split('.')
    $normalized = '{0:000}.{1:000}.{2:000}' -f $major, $minor, $build
}

# Now string comparison works correctly
$TSEnvironment.Value('SMSTSBiosVersion') = $normalized
```

`'001.010.000'` sorts before `'001.004.002'` correctly, because every segment is the same width. This one normalization saves you an entire class of "we shipped a BIOS update and somehow only half the machines took it" tickets.

## Flashing BIOS inside a task sequence

The actual flash is uncomplicated once you've handled the upstream work. `Flash64W.exe` is Dell's flasher; it takes a BIOS executable as a parameter:

```powershell
$Path = $PSScriptRoot
$flasher = Get-ChildItem $Path -Filter 'Flash64W.exe' -Recurse |
           Select-Object -First 1 -ExpandProperty FullName
$biosExe = Get-ChildItem $Path -Filter '*.exe' -Recurse |
           Where-Object { $_.Name -ne 'Flash64W.exe' } |
           Select-Object -First 1 -ExpandProperty FullName

$args = "/b=`"$biosExe`" /s /f"   # silent, force

$TSEnvironment = New-Object -ComObject Microsoft.SMS.TSEnvironment
$p = Start-Process -FilePath $flasher -ArgumentList $args -Wait -PassThru

switch ($p.ExitCode) {
    0  { $TSEnvironment.Value('SMSTSBiosUpdateRebootRequired') = 'True'  }
    2  { $TSEnvironment.Value('SMSTSBiosUpdateRebootRequired') = 'True'  }
    10 { exit 1 }   # password required / wrong password
    default { exit 1 }
}
```

Exit code 2 means "needs reboot" — that's a success, not a failure. Many people miss this and treat anything non-zero as broken. Don't.

For OSD, organize your content like this:

```
.\Dell\Latitude5540\BIOS\1.18.0\
    OSDBIOS-Update.ps1
    Flash64W.exe
    Latitude_5540_1.18.0.exe
```

The script picks up the only non-Flash64W `.exe` in its folder as the BIOS image. Drop in next month's update by adding a new version folder and pointing your task sequence at it. No script changes required.

## Tattooing — write it down where you can read it

The final piece: write key BIOS metadata to a registry hive your fleet management tools can read. The full-deletion-and-rewrite pattern is overkill for something this static; just set the values idempotently:

```powershell
$bios   = Get-CimInstance Win32_BIOS
$cs     = Get-CimInstance Win32_ComputerSystem
$base   = 'HKLM:\SOFTWARE\<YourOrg>\BIOS'

if (-not (Test-Path $base)) { New-Item -Path $base -Force | Out-Null }

$values = @{
    BIOSVersion  = $bios.SMBIOSBIOSVersion
    Model        = $cs.Model
    Manufacturer = $cs.Manufacturer
    SerialNumber = $bios.SerialNumber
}

foreach ($k in $values.Keys) {
    Set-ItemProperty -Path $base -Name $k -Value $values[$k] -Type String
}
```

Now you can extend hardware inventory in MECM to scoop that hive, and you have a queryable BIOS version per device that lives in your reporting database. Useful for compliance checks, useful for figuring out which BIOS family broke after a Patch Tuesday update.

## What I'd change

After seven years and a lot of Dell models:

- **I'd move to vaulted passwords sooner.** The deterministic-derivation approach is fine. A vault is better. The migration cost is real but bounded.
- **I'd treat the BIOS settings list as data, not code.** A JSON or CSV per model family that the OSD script reads in. Adding a setting becomes editing a config file, not editing the script.
- **I'd build a model-aware driver/BIOS matrix** before I built the flash machinery. Knowing exactly which model is on which BIOS in production *before* you start pushing updates is half the battle.

The unglamorous half of endpoint engineering doesn't go away. BIOS is the floor under everything; if it's a mess, the OS deployment built on top of it is a mess too. Spend a couple of weeks getting it right and it pays back for years.

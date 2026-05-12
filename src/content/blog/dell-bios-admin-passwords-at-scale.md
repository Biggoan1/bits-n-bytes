---
title: "Dell BIOS Admin Passwords at Scale"
description: "How to install the Dell BIOS Provider, set and clear admin passwords, and pair per-machine passwords with a fast helpdesk retrieval tool."
pubDate: 2026-05-12
category: "SCCM"
tags: ["dell", "bios", "powershell", "security"]
author: "JD"
draft: true
---

## Background

A unique Dell BIOS admin password per machine is the right answer for fleet security. Manually maintaining a password database at any meaningful scale isn't, and a single shared password compromises every endpoint at once if it leaks. A privileged vault would work if the access pattern allowed it, but in this environment helpdesk needs sub-minute access — vault request/approval latency was the wrong fit. So the approach is a deterministic per-machine derivation that produces a unique password for each chassis, paired with a small internal app that lets helpdesk look up a password without running PowerShell. The derivation details are intentionally kept internal and aren't covered here; what follows is everything around the derivation — install, set, clear, and the helpdesk tool — that you'd build regardless of how the password itself is generated.

## Install the Dell BIOS Provider

Dell ships the [BIOS Provider](https://www.dell.com/support/kbdoc/en-us/000146531/dell-command-powershell-provider) as a downloadable module. Drop it into both the Windows PowerShell 5.1 and PowerShell 7 module paths so scripts work regardless of which shell triggers them:

```powershell
param(
    [Parameter(Mandatory)][ValidateSet('Install','Uninstall')][string]$Action,
    [string]$SourceVersion = '2.8.0'   # subfolder name where the provider payload lives
)

$ErrorActionPreference = 'Stop'

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
```

Two module paths, one idempotent script. Package it with the provider payload, deploy it as a SCCM Application against the management collection. Detection method: the `.psd1` file present in both module paths.

## Set the password

Once the password has been generated for the machine — however your derivation works — the provider exposes a path-style API for setting it. The trick is that the call signature changes depending on whether a password is already set:

```powershell
Import-Module DellBIOSProvider

$password = Get-DerivedBIOSPassword   # your internal derivation function
$isSet    = (Get-Item DellSMBIOS:\Security\IsAdminPasswordSet).CurrentValue

if (-not $isSet) {
    Set-Item -Path DellSMBIOS:\Security\AdminPassword -Value $password
}
else {
    Set-Item -Path DellSMBIOS:\Security\AdminPassword -Value $password -Password $currentPassword
}
```

On a freshly-imaged machine where no password exists yet, the second form fails because `-Password` requires an existing password to validate against. On a machine that already has a password, the first form fails because the provider refuses to overwrite without authentication. The `IsAdminPasswordSet` check picks the right branch.

## Clear the password

This one is documented poorly. To clear a Dell admin password through the provider, pass an empty string as the new value and the current password as `-Password`:

```powershell
Set-Item DellSMBIOS:\Security\AdminPassword -Password $currentPassword ""
```

Without the empty-string-as-value pattern, the call won't actually clear the password — it'll either error or no-op.

## The helpdesk retrieval tool

The internal app is small. A helpdesk operator pastes in a service tag and the tool returns the BIOS admin password for that chassis — it runs the derivation server-side and shows the result. That's the whole interface.

Operators never run PowerShell and never need to know how the derivation works. Every lookup writes an audit record with the operator, the target service tag, and the reason. Clearing a password isn't an operation the tool exposes; that path stays with engineers using the PowerShell call shown above. Without this lookup layer the deterministic-derivation approach is technically correct but operationally painful — building it in the same change as the password rollout is the difference between a working system and a help-desk fire on day one.

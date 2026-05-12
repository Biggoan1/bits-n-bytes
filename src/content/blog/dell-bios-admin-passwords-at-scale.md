---
title: "Dell BIOS Admin Passwords at Scale"
description: "How I set, clear, and manage unique Dell BIOS admin passwords across a fleet — deterministic derivation, the Dell BIOS Provider, and a helpdesk retrieval tool."
pubDate: 2026-05-12
category: "SCCM"
tags: ["dell", "bios", "powershell", "security"]
author: "JD"
draft: true
---

## Background

A unique Dell BIOS admin password per machine is the right answer for fleet security. Manually maintaining a password database at any meaningful scale isn't, and a single shared password compromises every endpoint at once if it leaks. A privileged vault would work if the access pattern allowed it, but in this environment helpdesk needs sub-minute access — vault request/approval latency was the wrong fit. So the approach is **deterministic per-machine derivation** from the Dell service tag plus an org-only salt, paired with a small internal app that lets helpdesk look up or clear a password without running PowerShell or knowing the recipe. The exact derivation parameters stay internal — anyone with the recipe and physical access to a chassis can compute its password — so the sample below is intentionally pseudocode.

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

## Derive the password

The derivation reads the Dell service tag from the BIOS, mixes in an org-only salt, hashes the result, and takes a fixed-length substring as the password. The illustrative shape (using example parameters — see the note below):

```powershell
function Get-DerivedBIOSPassword {
    $serviceTag = (Get-CimInstance Win32_BIOS).SerialNumber
    $salt       = Get-OrgSalt                                  # loaded from a protected store

    # Compose the input. The exact composition is part of the recipe and stays internal.
    $material   = "$serviceTag$salt"

    # Pick a strong cryptographic hash. The specific algorithm is a choice — keep it internal.
    $hashAlgo   = [System.Security.Cryptography.HashAlgorithm]::Create('SHA-256')
    $bytes      = $hashAlgo.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($material))
    $hex        = ([System.BitConverter]::ToString($bytes)).Replace('-', '')

    # Take a fixed window of the hex output. Offset and length are also part of the recipe.
    return $hex.Substring(0, 16)
}
```

Three things to notice. `$serviceTag` comes from `Win32_BIOS.SerialNumber` on a Dell — the same string printed on the chassis sticker. `$salt` is loaded from somewhere protected (vault, encrypted config, or a build-server-only file); it's the secret that turns a publicly-derivable input into a per-org password. The output is deterministic: the same machine produces the same password every time you run it, which is what makes "look up a password by service tag" work without a database.

The specific composition, hash algorithm, and substring window above are example values. In a real deployment, every one of those is a parameter you choose — and they belong in the same protected store as the salt, not in source control or a blog post. Anyone with the full recipe and physical access to a chassis can compute the password.

## Set the password

Once the password is derived, the provider exposes a path-style API for setting it. The trick is that the call signature changes depending on whether a password is already set:

```powershell
Import-Module DellBIOSProvider

$password = Get-DerivedBIOSPassword
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

The internal app is small. It accepts a service tag from a helpdesk operator and exposes two operations:

- **Report password** — runs the derivation against the service tag and returns the result.
- **Clear password** — pushes a script to the target machine that runs the empty-string call above using the derived current password.

Operators never run PowerShell, never see the salt, and never need to know how the derivation works. Every call writes an audit record with the operator, the target service tag, the operation, and the reason. Without this layer the deterministic-derivation approach is technically correct but operationally painful — building it in the same change as the password rollout is the difference between a working system and a help-desk fire on day one.

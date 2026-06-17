---
title: "A Self-Elevating Hosts File Editor in PowerShell"
description: "Editing the Windows hosts file without hand-launching an elevated editor — one self-elevating WinForms app that replaced a two-file launcher-plus-editor design, with timestamped backups, content validation, the Sysnative redirection trick, and a signed ps2exe build."
pubDate: 2026-06-17
category: "PowerShell"
tags: ["powershell", "winforms", "uac", "hosts", "ps2exe", "sccm"]
author: "JD"
draft: false
---

> **Companion repo**: [HostsEditor](https://github.com/Biggoan1/HostsEditor) — the self-elevating WinForms app, build/sign script, and SCCM install/uninstall wrapper.

## The problem: edit `etc\hosts` without hand-launching an elevated editor

The hosts file lives at `%SystemRoot%\System32\drivers\etc\hosts`. Reading it is open to everyone; writing it requires administrator rights, because `System32\drivers\etc` is owned by the system and a standard user has no modify ACE there. So the usual "open it in Notepad and save" fails for exactly the people you most want to let make a quick `127.0.0.1 some.host` entry — and "right-click Notepad → Run as administrator → File → Open → paste the path" is the kind of ritual nobody remembers.

This started life as two files: a tiny `Launch-Hosts.ps1` that relaunched PowerShell elevated and opened Notepad on the file, and a separate WinForms editor. That's the same split [IPChanger](/blog/ipchanger-self-elevating-network-config-gui) started with before it was consolidated — and the lesson carried over. There's no reason to ship a launcher and an app when the app can elevate itself. The result is **one self-elevating WinForms editor**: it relaunches through UAC if it isn't already elevated, then reads and writes the file directly.

## One app, not two: self-elevation that survives compilation

The same source runs as a `.ps1` during testing and as a ps2exe `.exe` in production, and those two relaunch differently. The trick is to look at the *process name* to decide how:

```powershell
$currentIdentity  = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$currentPrincipal = New-Object System.Security.Principal.WindowsPrincipal($currentIdentity)

if (-not $currentPrincipal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $thisProcess = [System.Diagnostics.Process]::GetCurrentProcess()
    # Run as a script -> host is powershell/pwsh; compiled -> host is the app exe itself.
    $runningAsScript = $thisProcess.ProcessName -in @('powershell', 'pwsh', 'powershell_ise')
    try {
        if ($runningAsScript) {
            Start-Process -FilePath $thisProcess.MainModule.FileName -Verb RunAs -ArgumentList @(
                '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
                '-File', "`"$PSCommandPath`""
            )
        }
        else {
            Start-Process -FilePath $thisProcess.MainModule.FileName -Verb RunAs
        }
    }
    catch {
        # User dismissed the UAC prompt (or elevation failed) - nothing to do.
    }
    exit
}
```

`IsInRole(Administrator)` tests the *current token's* integrity, so a split-token admin running un-elevated still falls into this branch. The process name then tells you how to relaunch: under a PowerShell host you restart that host with `-File` pointing back at the script; compiled, `MainModule.FileName` is the app exe itself, so you relaunch it directly. `-Verb RunAs` raises the UAC dialog — a split-token admin gets a consent (Yes/No) prompt, a standard user gets a credential prompt and must enter an administrator account. Either way the relaunched instance comes up at high integrity, and the original `exit`s immediately so you never get two windows. Everything below this block runs knowing it's already elevated.

## Finding the real hosts file from a 32-bit exe

This is the gotcha that's easy to miss. ps2exe produces a **32-bit** binary by default, and a 32-bit process on 64-bit Windows is transparently redirected by WOW64 when it touches `System32` — `…\System32\drivers\etc` becomes `…\SysWOW64\drivers\etc`. Back up and overwrite *that* and you've edited a file the resolver never reads, while the real hosts file sits untouched. The escape hatch is the `Sysnative` alias, which reaches the real 64-bit `System32` from a 32-bit process (and only from one — it doesn't exist for native 64-bit processes):

```powershell
function Get-HostsPath {
    $relative = 'drivers\etc\hosts'
    if (-not [Environment]::Is64BitProcess -and [Environment]::Is64BitOperatingSystem) {
        $native = Join-Path $env:windir (Join-Path 'Sysnative' $relative)
        if (Test-Path $native) { return $native }
    }
    return Join-Path $env:windir (Join-Path 'System32' $relative)
}
```

Gating the `Sysnative` path on `-not [Environment]::Is64BitProcess` matters: probing it from a 64-bit process would just fail `Test-Path` and is meaningless, so the check keeps the native build on the plain `System32` path and only the 32-bit ps2exe build takes the redirect-busting route.

## Validate before writing

A broken hosts file fails quietly — name resolution just behaves strangely. The cheap guard is that every meaningful line needs at least two tokens (an address and a name); blank lines and `#` comments are exempt:

```powershell
function Validate-HostsContent {
    param([string]$text)
    $lines = $text -split "\r?\n"
    $problems = @()
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $line = $lines[$i].Trim()
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        if ($line.StartsWith('#')) { continue }
        $parts = $line -split '\s+'
        if ($parts.Count -lt 2) {
            $problems += @{ LineNumber = $i+1; Text = $line }
        }
    }
    return $problems
}
```

It's intentionally permissive — it doesn't parse IPs or assert a single space — so it warns without blocking power users. On Save, any problems raise a Yes/No "save anyway?" box rather than a hard stop.

## The write: back up, clear attributes, ASCII

Because the whole process is already elevated, the save is direct — no staging, no helper process, no inter-process handshake. Stamp a timestamped backup next to the file, clear any defensive attribute, then overwrite:

```powershell
$timestamp = Get-Date -Format 'yyyyMMddHHmmss'
$backup = "$hostsPath.$timestamp.bak"

# Clear any read-only/hidden attribute an admin may have set to deter edits.
try { (Get-Item $hostsPath).Attributes = 'Normal' } catch { }

if (Test-Path $hostsPath) {
    Copy-Item -Path $hostsPath -Destination $backup -Force -ErrorAction SilentlyContinue
}

# ASCII: the resolver expects a plain-ASCII hosts file; a UTF-8 BOM can make the
# first entry be ignored.
Set-Content -Path $hostsPath -Value $content -Encoding ASCII -Force -ErrorAction Stop
```

Three deliberate choices in five lines: the timestamped `.bak` means every save is reversible; clearing attributes first stops a copy from failing on a read-only flag it could just as easily reset; and ASCII avoids the classic "first hosts entry silently ignored" bug that a UTF-8 BOM causes. An earlier draft of this tool did the write from a *generated, separately-elevated helper script* staged through `ProgramData` (with an `Authenticated Users` ACE so two processes could share the staging files) — all of which evaporated the moment the whole app started running elevated. Worth remembering that the simpler architecture deleted an entire category of code.

## Three WinForms gotchas that bite this kind of tool

**The textbox silently truncates large files.** A multiline `TextBox` defaults to `MaxLength = 32767`. A normal hosts file is a few hundred bytes, but the moment someone pastes in a blocklist-style hosts file (these run to hundreds of KB), the load truncates with no error — and a subsequent Save would then write the *truncated* version back, quietly destroying data. The fix is one line:

```powershell
# Default multiline MaxLength is 32767 chars, which silently truncates large
# (e.g. blocklist) hosts files. 0 = no practical limit.
$txt.MaxLength = 0
```

**Docking is applied in reverse z-order.** With a `Dock = 'Fill'` textbox, a `Dock = 'Top'` toolbar, and a `Dock = 'Bottom'` status strip, they'll fight over the same space unless they're added in the right order. WinForms lays docked controls out from the *last* control in the collection to the first, so the Fill control must be added *before* the edge-docked ones to end up filling what's left:

```powershell
# Toolbar docks top, status strip docks bottom, textbox fills the middle.
# Docked controls lay out in reverse collection order, so the Fill control goes first.
$form.Controls.AddRange(@($txt,$toolbar,$status))
```

**The form has to actually be shown.** This is the one that's easy to lose when you're reconstructing a script from a compiled exe whose source went missing. Building all the controls and wiring the handlers does nothing on its own — without the blocking `ShowDialog()`, a ps2exe build just flashes and exits:

```powershell
[System.Windows.Forms.Application]::EnableVisualStyles()
[void]$form.ShowDialog()
$form.Dispose()
```

## Versioning you can see

The version lives in a `VERSION` file as the single source of truth. A git `pre-commit` hook bumps the patch on every commit, `build.ps1` stamps it into the exe's metadata, and the status strip reads it back so the running build is never a guess:

```powershell
function Get-AppVersion {
    try {
        $proc = [System.Diagnostics.Process]::GetCurrentProcess()
        if ($proc.ProcessName -notin @('powershell', 'pwsh', 'powershell_ise')) {
            $fv = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($proc.MainModule.FileName).FileVersion
            if ($fv) { return $fv }
        }
    }
    catch { }
    $vf = Join-Path $PSScriptRoot 'VERSION'
    if (Test-Path $vf) { return (Get-Content $vf -Raw).Trim() }
    return 'dev'
}
```

Same process-name detection as the elevation block: compiled, it reads the exe's embedded `FileVersion` — exactly what was built and signed in prod; as a script, it falls back to the `VERSION` file.

## Build and sign

[ps2exe](https://github.com/MScholtes/PS2EXE) compiles the script to a windowed (no-console) exe with version metadata and an embedded icon:

```powershell
$ps2exeArgs = @{
    InputFile    = $Source
    OutputFile   = $OutputExe
    noConsole    = $true
    title        = 'Hosts File Editor'
    product      = 'HostsEditor'
    company      = 'Biggoan1'
    copyright    = "(c) $(Get-Date -Format yyyy) Biggoan1"
    version      = $Version
    requireAdmin = $true   # embed a UAC manifest (shield icon + prompt before launch)
}
if (Test-Path $IconFile) { $ps2exeArgs['iconFile'] = $IconFile }
Invoke-ps2exe @ps2exeArgs
```

`requireAdmin = $true` embeds a UAC manifest so the exe carries the shield icon and prompts before launch; the script *also* self-elevates, so a shortcut launch works either way. Then both the exe and the installer get Authenticode-signed, timestamped so the signature outlives the cert:

```powershell
if ($Sign) {
    $cert = Get-SigningCert -Thumbprint $CertThumbprint
    foreach ($file in @($OutputExe, $Installer)) {
        $result = Set-AuthenticodeSignature -FilePath $file -Certificate $cert `
                      -TimestampServer $TimestampUrl -HashAlgorithm SHA256
        if ($result.Status -ne 'Valid') {
            throw "Signing failed for $file : $($result.Status) - $($result.StatusMessage)"
        }
    }
}
```

Signing earns its keep precisely *because* the app self-elevates: an unsigned binary raises a UAC prompt banded "Unknown publisher," which is exactly the dialog you've trained users to refuse. A timestamped signature puts a real publisher name on the elevation prompt and clears SmartScreen. `-Sign` is off by default so the build still runs on a machine without the cert; with no `-CertThumbprint` it grabs the newest code-signing cert in the store.

## Deploy via SCCM

The install/uninstall wrapper is one script with an `-Action` switch — drop the exe into `C:\Program Files\HostsEditor` and create public Desktop and Start Menu shortcuts that inherit the exe's embedded icon:

```powershell
param(
    [Parameter(Mandatory)][ValidateSet('Install','Uninstall')][string]$Action
)

$AppName    = 'HostsEditor'
$InstallDir = Join-Path $env:ProgramFiles $AppName

switch ($Action) {
    'Install' {
        New-Item -Path $InstallDir -ItemType Directory -Force | Out-Null
        Copy-Item -Path (Join-Path $PSScriptRoot 'HostsEditor.exe') -Destination $InstallDir -Force
        New-AppShortcut -Path $DesktopShortcut   -Target $TargetExe -Icon "$TargetExe,0"
        New-AppShortcut -Path $StartMenuShortcut -Target $TargetExe -Icon "$TargetExe,0"
    }
    'Uninstall' {
        foreach ($lnk in @($DesktopShortcut, $StartMenuShortcut)) {
            if (Test-Path $lnk) { Remove-Item $lnk -Force }
        }
        if (Test-Path $InstallDir) { Remove-Item $InstallDir -Recurse -Force }
    }
}
```

Wire it into an SCCM Application: install command `powershell.exe -ExecutionPolicy Bypass -File .\HostsEditor-Install.ps1 -Action Install`, the matching `-Action Uninstall` for removal, and a detection method on `C:\Program Files\HostsEditor\HostsEditor.exe`. The whole thing — source, build script, installer, icon generator — is in the [companion repo](https://github.com/Biggoan1/HostsEditor).

---
title: "IPChanger: A Self-Elevating Network Config GUI in PowerShell"
description: "Delegating IPv4 changes on physical adapters without handing out blanket admin — a WinForms tool gated by Network Configuration Operators, self-elevating through UAC, plus the netsh trick that beats the PolicyStore static-IP error."
pubDate: 2026-05-27
category: "PowerShell"
tags: ["powershell", "winforms", "networking", "uac", "ps2exe", "sccm"]
author: "JD"
draft: false
---

> **Companion repo**: [IPChanger](https://github.com/Biggoan1/IPChanger) — the full WinForms app, build/sign script, and SCCM install/uninstall wrapper.

## The problem: change an IP without handing out admin

The requirement: let a defined set of users set a static IPv4 address — or fall back to DHCP — on a physical adapter, without making them blanket local administrators.

Windows ships a built-in answer, the **Network Configuration Operators** (NCO) group. Members are supposed to be able to modify a connection's TCP/IP settings without full admin. Nesting an AD security group into the local `Network Configuration Operators` group through Group Policy pushes that delegation to every machine in scope, so the membership stays managed centrally in AD.

The wall is the user experience. The native surfaces for changing an IP — the `ncpa.cpl` adapter-properties dialog and the Settings app — route the write through an elevation-gated path. A standard user who opens them gets a UAC **credential** prompt asking for an administrator's username and password they don't have; there is no "use my Network Configuration Operators rights" path in the GUI. It's elevate-or-nothing. The `netsh` and `Net*` cmdlets do honor the delegation from a sufficiently privileged session, but a normal user is never going to open a console and hand-type `netsh interface ipv4 set address`.

So the shipped model is a deliberate **double gate**:

1. **Elevation** — the operator runs the tool with an account that can satisfy UAC, so the write actually goes through.
2. **Group membership** — that account must belong to the NCO-nested AD group, which the app verifies on launch.

Elevation supplies the *rights*; the group check is the *authorization policy*. Reusing Network Configuration Operators for that check means the same GPO-managed group that delegates network config also decides who may launch the tool — one group to administer, not two. Everything below is how those two gates are implemented, and the network-stack gotcha in the middle.

## Self-elevation that survives compilation

Rather than ship a separate launcher, the app relaunches itself through UAC when it starts non-elevated. The complication: the same source runs as a `.ps1` during testing and as a ps2exe `.exe` in production, and those relaunch differently.

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

`IsInRole(Administrator)` tests the *current token's* integrity, so a split-token admin running un-elevated still falls into this branch. The process name then tells you how to relaunch: under a PowerShell host you restart that host with `-File` pointing back at the script; compiled, `MainModule.FileName` is the app exe itself, so you relaunch it directly.

`-Verb RunAs` is what raises the UAC dialog, and which dialog you get depends on the caller. A split-token administrator gets a **consent** prompt (Yes/No) and the relaunched process runs with their elevated, high-integrity token. A standard user gets a **credential** prompt and must enter an administrator account — the relaunched process then runs as *that* account. Either way the second instance comes up at high integrity, and the original non-elevated instance `exit`s immediately so you never end up with two windows.

## The authorization gate: Network Configuration Operators by SID

Elevation gets the write through; it doesn't decide *who's allowed* to run the tool. That's a separate check against the NCO group. Matching by name is fragile — the group is localized (`Netzwerkkonfigurations-Operatoren` on a German build) and can be renamed — so resolve to a SID and compare against the token's groups:

```powershell
function Test-GroupMembership {
    param([string]$GroupName)
    try {
        $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent()
        $groupSid = (New-Object System.Security.Principal.NTAccount($GroupName)).Translate(
                        [System.Security.Principal.SecurityIdentifier])
        foreach ($group in $currentUser.Groups) {
            if ($group.Value -eq $groupSid.Value) { return $true }
        }
        return $false
    }
    catch { return $false }
}
```

`NTAccount.Translate` resolves the friendly name to its SID. `$currentUser.Groups` is the set of group SIDs in the *elevated* caller's token — including ones inherited through AD nesting, which is exactly how the GPO-pushed membership shows up. No match means the app puts up an "Access denied" box and exits before the form is ever built. The built-in `Administrator` role grants the rights; NCO membership grants permission to use the tool.

## The static-IP apply that actually works

This is the part that cost the most time. The obvious cmdlet path — disable DHCP, then `New-NetIPAddress` — throws:

```
Inconsistent parameters PolicyStore PersistentStore and Dhcp Enabled
```

The `Net*` cmdlets write through WMI (`MSFT_NetIPAddress`), and by default a new address lands in the **persistent** store. The cmdlet refuses to commit a persistent static address while the interface is still flagged DHCP-enabled in that same store — and it raises the contradiction *even immediately after* you disable DHCP, because the persistent write is validated as its own transaction against the stored interface state. The fix is to let `netsh` do the disable-and-assign atomically with `source=static`:

```powershell
$nameArg = "name=$AdapterName"
if (Test-IPAddress $Gateway) {
    $out = netsh interface ipv4 set address $nameArg source=static `
               address=$IPAddress mask=$SubnetMask gateway=$Gateway 2>&1
}
else {
    $out = netsh interface ipv4 set address $nameArg source=static `
               address=$IPAddress mask=$SubnetMask 2>&1
}
if ($LASTEXITCODE -ne 0) {
    throw ("Could not set IP address: " + (($out | Out-String).Trim()))
}

# DNS via the cmdlet - reliable, and the PolicyStore conflict only affected the address write.
if ($dnsServers.Count -gt 0) {
    Set-DnsClientServerAddress -InterfaceIndex $netAdapter.InterfaceIndex `
                               -ServerAddresses $dnsServers -ErrorAction Stop
}
```

`source=static` flips the interface off DHCP and assigns the address in one operation, so there's no inconsistent intermediate state for the persistent store to reject. Passing the adapter as a single `name=$AdapterName` token keeps names with spaces (`Ethernet 2`) intact — netsh takes everything after the first `=` as the value. DNS still goes through `Set-DnsClientServerAddress`; the conflict only ever affected the address write, and the cmdlet is cleaner than `netsh ... set dns` for two servers.

Switching back to DHCP is the cmdlet path, which has no such conflict:

```powershell
$adapter | Remove-NetIPAddress -Confirm:$false -ErrorAction SilentlyContinue
$adapter | Remove-NetRoute     -Confirm:$false -ErrorAction SilentlyContinue
$adapter | Set-NetIPInterface  -Dhcp Enabled -ErrorAction Stop
$adapter | Set-DnsClientServerAddress -ResetServerAddresses -ErrorAction Stop
$adapter | Restart-NetAdapter  -Confirm:$false -ErrorAction Stop
```

## Validate the mask, not just the octets

A subnet mask isn't just four numbers in 0–255 — the bits have to be contiguous 1s followed by contiguous 0s. `255.0.255.0` passes a naive per-octet check and is still invalid. Convert the whole thing to a 32-bit binary string and regex it:

```powershell
$binaryString = ""
foreach ($octet in $octets) {
    $binaryString += [Convert]::ToString([int]$octet, 2).PadLeft(8, '0')
}
# Valid mask = contiguous 1s then contiguous 0s.
if ($binaryString -notmatch '^1+0*$') { return $false }
```

The same binary-string trick runs in reverse to convert a CIDR prefix to a dotted mask for the form's `/24`-style input, and to count prefix length when reading an adapter's current config back in.

## The input field that stole its own focus

Each address is four small textboxes that auto-advance: type three digits or a period and focus jumps to the next octet. That part is easy. The bug was subtler — entering one digit in the CIDR field would immediately tab away on its own.

The cause is the WinForms event model. Filling the subnet octets from CIDR, and reading an adapter's current config back into the form, both *write to the textboxes in code*. Those writes raise `TextChanged` just like a keystroke does, which fired the auto-advance, which moved focus. The fix is a one-line guard — only advance when *this* box actually has keyboard focus, which a programmatic write never does:

```powershell
$textBox.Add_TextChanged({
    param($sender, $e)
    # Auto-advance only when the user is typing in THIS box. Without the Focused check,
    # programmatic fills (CIDR -> mask, or reading an adapter's config) trip the advance
    # and steal focus (the CIDR field tabbing away after one digit).
    if ($sender.Focused -and $sender.Text.Length -eq 3) {
        $form.SelectNextControl($sender, $true, $true, $true, $true)
    }
})
```

Two conveniences ride on the same wiring. CIDR auto-fills the subnet mask, and IP + CIDR auto-fill a gateway guess — the network address plus one:

```powershell
$ipB = $ip.Split('.') | ForEach-Object { [int]$_ }
$gw  = @(
    ($ipB[0] -band $mask[0]),
    ($ipB[1] -band $mask[1]),
    ($ipB[2] -band $mask[2]),
    (($ipB[3] -band $mask[3]) + 1)
)
```

A module-level `$script:suppressGatewayAutofill` flag turns that off while an adapter's *real* configuration is being read in, so the actual gateway isn't clobbered by the guess — the same class of programmatic-write problem as the focus bug, solved with an explicit suppression flag instead of a focus check because there's no single control to hang it on.

## Versioning you can see

The version lives in a `VERSION` file as the single source of truth. A git `pre-commit` hook bumps the patch on every commit, `build.ps1` stamps it into the exe's metadata, and the form reads it back so the running build is never a guess:

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

Same process-name detection as the elevation block: compiled, it reads the exe's embedded `FileVersion` — exactly what was built and signed in prod; as a script, it falls back to the `VERSION` file. The result shows in the bottom-right corner of the window.

## Build and sign

[ps2exe](https://github.com/MScholtes/PS2EXE) compiles the script to a windowed (no-console) exe with version metadata, then Authenticode-signs both the exe and the installer, timestamped so the signature outlives the cert:

```powershell
$ps2exeArgs = @{
    InputFile   = $Source
    OutputFile  = $OutputExe
    noConsole   = $true
    title       = 'Network Configuration Tool'
    product     = 'IPChanger'
    company     = 'Biggoan1'
    copyright   = "(c) $(Get-Date -Format yyyy) Biggoan1"
    version     = $Version
}
if (Test-Path $IconFile) { $ps2exeArgs['iconFile'] = $IconFile }
Invoke-ps2exe @ps2exeArgs

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

Signing earns its keep here precisely because the app self-elevates: an unsigned binary raises a UAC prompt banded "Unknown publisher," which is exactly the dialog you've trained users to refuse. A timestamped Authenticode signature puts a real publisher name on the elevation prompt and clears SmartScreen. `-Sign` is off by default so the build still runs on a machine without the cert; with no `-CertThumbprint` it grabs the newest code-signing cert in the store.

## Deploy via SCCM

The install/uninstall wrapper is one script with an `-Action` switch — drop the exe into `C:\Program Files\IPChanger` and create public Desktop and Start Menu shortcuts that inherit the exe's embedded icon:

```powershell
param(
    [Parameter(Mandatory)][ValidateSet('Install','Uninstall')][string]$Action
)

$AppName    = 'IPChanger'
$InstallDir = Join-Path $env:ProgramFiles $AppName

switch ($Action) {
    'Install' {
        New-Item -Path $InstallDir -ItemType Directory -Force | Out-Null
        Copy-Item -Path (Join-Path $PSScriptRoot 'IPChanger.exe') -Destination $InstallDir -Force
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

Wire it into an SCCM Application: install command `powershell.exe -ExecutionPolicy Bypass -File .\SetNet-Install.ps1 -Action Install`, the matching `-Action Uninstall` for removal, and a detection method on `C:\Program Files\IPChanger\IPChanger.exe`. Deploy it to the same population that gets the NCO-nesting GPO, so the tool and the rights that make it work land on the same machines. The whole thing — source, build script, installer — is in the [companion repo](https://github.com/Biggoan1/IPChanger).

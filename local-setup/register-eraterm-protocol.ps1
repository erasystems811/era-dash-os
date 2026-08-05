# One-time setup (per computer): registers the eraterm:// URL protocol so
# clicking a client's "Open terminal" link in the ERA Dash OS panel opens a
# real Windows Terminal window on THIS computer, in that business's local
# folder. No admin rights needed (HKCU, current user only).
#
# Run once: powershell -ExecutionPolicy Bypass -File register-eraterm-protocol.ps1
# Then copy era-terminal-launcher.ps1 to C:\Users\<you>\era-terminal-launcher.ps1
# (or edit $scriptPath below to point at wherever you keep it).

$ErrorActionPreference = "Stop"
$scriptPath = "$env:USERPROFILE\era-terminal-launcher.ps1"

if (-not (Test-Path $scriptPath)) {
    throw "Copy era-terminal-launcher.ps1 to $scriptPath first, or edit `$scriptPath in this script."
}

New-Item -Path "HKCU:\Software\Classes\eraterm" -Force | Out-Null
Set-ItemProperty -Path "HKCU:\Software\Classes\eraterm" -Name "(Default)" -Value "URL:ERA Terminal Launcher"
Set-ItemProperty -Path "HKCU:\Software\Classes\eraterm" -Name "URL Protocol" -Value ""

New-Item -Path "HKCU:\Software\Classes\eraterm\shell\open\command" -Force | Out-Null
$command = "powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scriptPath`" -Url `"%1`""
Set-ItemProperty -Path "HKCU:\Software\Classes\eraterm\shell\open\command" -Name "(Default)" -Value $command

Write-Output "Registered eraterm:// protocol -> $command"

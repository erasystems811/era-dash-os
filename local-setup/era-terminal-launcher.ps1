# Handles eraterm://<folder-name> links. Registered as a custom URL
# protocol (HKCU, no admin needed) so clicking a link in the ERA Dash OS
# panel opens a real local terminal, already in that business's folder --
# not a remote/web-based terminal, this only ever runs on the user's own
# machine via their own browser's protocol-link mechanism.
param([string]$Url)

$LogFile = "$env:USERPROFILE\era-terminal-launcher.log"
function Log($msg) {
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') - $msg" | Out-File -FilePath $LogFile -Append -Encoding utf8
}

Log "Invoked with Url='$Url'"

try {
    # Hardcoded, not $env:USERPROFILE -- when launched by the browser
    # (ShellExecute) rather than an interactive shell, environment
    # variables can resolve differently; this removes that as a variable.
    $BaseDir = "C:\Users\user"

    $FolderName = $Url -replace '^eraterm://', '' -replace '/$', ''
    $TargetPath = Join-Path $BaseDir $FolderName
    Log "Resolved FolderName='$FolderName' TargetPath='$TargetPath'"

    if (-not (Test-Path $TargetPath)) {
        Log "ERROR: folder does not exist: $TargetPath"
        exit 1
    }

    $wt = Get-Command wt.exe -ErrorAction SilentlyContinue
    Log "wt.exe resolved to: $($wt.Source)"

    # -w new forces an actual new, visible window every time -- without
    # it, if Windows Terminal is already open with other tabs (confirmed
    # live: it was, with unrelated existing work in it), `new-tab` just
    # adds a tab to that existing window in the background, which can be
    # minimized/behind other windows/on another desktop -- nothing visibly
    # opens, which is exactly what looked like "opens and closes". Confirmed
    # live 2026-08-05 via a real browser click + window-title enumeration
    # (Get-Process StartTime checks below are unreliable and can read
    # False even on success, since Windows Terminal consolidates all
    # windows into one background host process -- window titles are the
    # only real signal).
    $proc = Start-Process wt.exe -ArgumentList @('-w', 'new', '-d', $TargetPath, '--title', $FolderName) -PassThru
    Log "Start-Process returned PID=$($proc.Id) (this is the wt.exe launcher stub, expected to exit quickly once it hands off)"

    Start-Sleep -Seconds 2
    $newWindow = Get-Process WindowsTerminal -ErrorAction SilentlyContinue | Where-Object { $_.StartTime -gt (Get-Date).AddSeconds(-10) }
    Log "New WindowsTerminal window detected (unreliable signal, see note above): $($null -ne $newWindow)"
}
catch {
    Log "EXCEPTION: $($_.Exception.Message)"
    Log "STACK: $($_.ScriptStackTrace)"
}

Log "Launcher finished."

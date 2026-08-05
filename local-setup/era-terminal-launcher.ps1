# Handles eraterm://<folder-name> links. Registered as a custom URL
# protocol (HKCU, no admin needed) so clicking a link in the ERA Dash OS
# panel opens a real local terminal, already in that business's folder --
# not a remote/web-based terminal, this only ever runs on the user's own
# machine via their own browser's protocol-link mechanism.
param([string]$Url)

# eraterm://bali -> "bali"
$FolderName = $Url -replace '^eraterm://', '' -replace '/$', ''
$TargetPath = Join-Path $env:USERPROFILE $FolderName

if (-not (Test-Path $TargetPath)) {
    Write-Host "No folder found at $TargetPath"
    Start-Sleep -Seconds 4
    exit 1
}

# Title set explicitly so the tab always shows which business this is --
# matters once several of these are open side by side.
Start-Process wt.exe -ArgumentList "new-tab", "-d", "`"$TargetPath`"", "--title", "`"$FolderName`""

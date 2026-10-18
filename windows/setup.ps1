# FollowUp Copilot by Rojie Jardio - one-time Windows setup.
#  1. Installs the shutdown helper (so "When finished: Shut down the computer" works).
#  2. Adds a "FollowUp Chrome" icon to the desktop (Chrome that keeps running after Alt+Tab).
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$dest = Join-Path $env:LOCALAPPDATA 'FollowUpCopilot'
$hostName = 'com.rojie.followup_copilot'

Write-Host ''
Write-Host 'FollowUp Copilot - Windows setup' -ForegroundColor Green
Write-Host '--------------------------------'

New-Item -ItemType Directory -Force -Path $dest | Out-Null
foreach ($f in 'followup-host.ps1', 'followup-host.bat', 'FollowUp-Chrome.ps1') {
    Copy-Item -Path (Join-Path $here $f) -Destination $dest -Force
}

# --- Find the extension's ID in Chrome's settings (it depends on where the folder is) ---
function Get-FollowUpIds {
    $ids = @()
    $userData = Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'
    if (-not (Test-Path $userData)) { return $ids }
    Add-Type -AssemblyName System.Web.Extensions
    $json = New-Object System.Web.Script.Serialization.JavaScriptSerializer
    $json.MaxJsonLength = [int]::MaxValue
    foreach ($profile in Get-ChildItem $userData -Directory) {
        foreach ($name in 'Secure Preferences', 'Preferences') {
            $file = Join-Path $profile.FullName $name
            if (-not (Test-Path $file)) { continue }
            try { $prefs = $json.DeserializeObject([IO.File]::ReadAllText($file)) } catch { continue }
            if (-not $prefs.ContainsKey('extensions')) { continue }
            $ext = $prefs['extensions']
            if (-not $ext.ContainsKey('settings')) { continue }
            foreach ($id in $ext['settings'].Keys) {
                $entry = $ext['settings'][$id]
                if (-not $entry.ContainsKey('path')) { continue }
                $manifest = Join-Path ([string]$entry['path']) 'manifest.json'
                if ((Test-Path $manifest) -and ((Get-Content $manifest -Raw) -match 'FollowUp Copilot')) { $ids += $id }
            }
        }
    }
    return @($ids | Select-Object -Unique)
}

$ids = Get-FollowUpIds
if ($ids.Count -eq 0) {
    Write-Host ''
    Write-Host "Couldn't find FollowUp Copilot in Chrome automatically." -ForegroundColor Yellow
    Write-Host '1. In Chrome, open  chrome://extensions'
    Write-Host '2. On the "FollowUp Copilot by Rojie Jardio" card, copy the ID (32 letters).'
    $typed = (Read-Host '3. Paste the ID here and press Enter').Trim()
    if ($typed -notmatch '^[a-p]{32}$') { Write-Host 'That ID does not look right. Run the setup again.' -ForegroundColor Red; exit 1 }
    $ids = @($typed)
}
Write-Host ("Extension found: " + ($ids -join ', '))

# --- Shutdown helper: tell Chrome where it is and which extension may use it ---
$manifestPath = Join-Path $dest "$hostName.json"
$hostManifest = [ordered]@{
    name            = $hostName
    description     = 'FollowUp Copilot shutdown helper'
    path            = (Join-Path $dest 'followup-host.bat')
    type            = 'stdio'
    allowed_origins = @($ids | ForEach-Object { "chrome-extension://$_/" })
}
$hostManifest | ConvertTo-Json | Set-Content -Path $manifestPath -Encoding ASCII
$key = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
New-Item -Path $key -Force | Out-Null
Set-Item -Path $key -Value $manifestPath
Write-Host 'Shutdown helper installed.' -ForegroundColor Green

# --- Desktop icon: FollowUp Chrome ---
$chrome = @(
    (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'FollowUp Chrome.lnk'))
$link.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$link.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$(Join-Path $dest 'FollowUp-Chrome.ps1')`""
$link.WorkingDirectory = $dest
if ($chrome) { $link.IconLocation = "$chrome,0" }
$link.Description = 'Chrome that keeps FollowUp Copilot running after Alt+Tab'
$link.Save()
Write-Host 'Desktop icon "FollowUp Chrome" added.' -ForegroundColor Green

Write-Host ''
Write-Host 'All done. Next:' -ForegroundColor Green
Write-Host ' - In Chrome, open chrome://extensions and click the reload arrow on FollowUp Copilot.'
Write-Host ' - From now on, open Chrome with the "FollowUp Chrome" desktop icon.'
Write-Host ' - In the side panel: Settings -> When the run is finished -> "Check shutdown helper" should show a check mark.'

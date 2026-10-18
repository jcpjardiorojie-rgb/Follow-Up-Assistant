# Opens your normal Chrome with "keep running when hidden" turned on, so FollowUp Copilot
# keeps working after Alt+Tab or when other windows cover Chrome.
Add-Type -AssemblyName System.Windows.Forms
$flags = @('--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling')
$chrome = @(
    (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $chrome) {
    [System.Windows.Forms.MessageBox]::Show("Google Chrome wasn't found on this computer.", 'FollowUp Chrome') | Out-Null
    exit 1
}
# Chrome only accepts these settings when it starts, so it must not be open already.
if (Get-Process -Name chrome -ErrorAction SilentlyContinue) {
    $answer = [System.Windows.Forms.MessageBox]::Show(
        "Chrome is already open, so it can't start in FollowUp mode.`n`nClose Chrome now and reopen it in FollowUp mode?`nYour tabs will come back.",
        'FollowUp Chrome', 'YesNo', 'Question')
    if ($answer -ne 'Yes') { exit 0 }
    Get-Process -Name chrome -ErrorAction SilentlyContinue | ForEach-Object { $_.CloseMainWindow() | Out-Null }
    $deadline = (Get-Date).AddSeconds(15)
    while ((Get-Process -Name chrome -ErrorAction SilentlyContinue) -and ((Get-Date) -lt $deadline)) { Start-Sleep -Milliseconds 500 }
    # Chrome can keep running in the background (system tray); stop what's left.
    Get-Process -Name chrome -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 1
}
Start-Process -FilePath $chrome -ArgumentList ($flags + '--restore-last-session')

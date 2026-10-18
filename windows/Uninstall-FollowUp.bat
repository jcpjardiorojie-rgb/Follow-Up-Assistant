@echo off
rem Removes the FollowUp Chrome icon and the shutdown helper.
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "Remove-Item 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.rojie.followup_copilot' -Force -ErrorAction SilentlyContinue;" ^
  "Remove-Item (Join-Path ([Environment]::GetFolderPath('Desktop')) 'FollowUp Chrome.lnk') -Force -ErrorAction SilentlyContinue;" ^
  "Remove-Item (Join-Path $env:LOCALAPPDATA 'FollowUpCopilot') -Recurse -Force -ErrorAction SilentlyContinue;" ^
  "Write-Host 'FollowUp Chrome icon and shutdown helper removed.'"
pause

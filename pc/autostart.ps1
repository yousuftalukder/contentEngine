# Starts the PC worker by itself whenever you sign in to Windows, minimised, so the PC takes video work whenever it is on
# without anyone remembering to run start.ps1. It adds one entry to Task Scheduler for your account only, needs no
# administrator rights, and runs nothing until your next sign-in.
#
#   powershell -ExecutionPolicy Bypass -File pc\autostart.ps1            add it
#   powershell -ExecutionPolicy Bypass -File pc\autostart.ps1 -Remove    take it away again
#   powershell -ExecutionPolicy Bypass -File pc\autostart.ps1 -WhatIf    show what it would do, change nothing
param([switch]$Remove, [switch]$WhatIf)
$ErrorActionPreference = "Stop"
$name  = "Content Engine PC worker"
$start = Join-Path $PSScriptRoot "start.ps1"
$root  = Split-Path $PSScriptRoot -Parent

if ($Remove) {
  if ($WhatIf) { Write-Host "Would remove the scheduled task '$name'."; exit 0 }
  if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $name -Confirm:$false; Write-Host "Removed '$name'. The worker no longer starts by itself." }
  else { Write-Host "There was no '$name' task to remove." }
  exit 0
}

if (-not (Test-Path $start)) { Write-Error "Cannot find $start"; exit 1 }
if (-not (Test-Path (Join-Path $root ".env.pc"))) { Write-Error "Missing .env.pc - set the worker up first (pc\setup.ps1, then fill in .env.pc)."; exit 1 }

$args_ = "-NoExit -ExecutionPolicy Bypass -WindowStyle Minimized -File `"$start`""
if ($WhatIf) {
  Write-Host "Would add the scheduled task '$name' for ${env:USERDOMAIN}\${env:USERNAME}:"
  Write-Host "  when:  at sign-in"
  Write-Host "  runs:  powershell.exe $args_"
  Write-Host "  in:    $root"
  exit 0
}
$action   = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $args_ -WorkingDirectory $root
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
# Runs on battery too, and is not stopped after three days, which are Task Scheduler's defaults for a laptop.
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Description "Starts the Content Engine video worker (pc\start.ps1) at sign-in." -Force | Out-Null
Write-Host "Added '$name'. From your next sign-in the worker starts by itself, minimised."
Write-Host "Remove it with: powershell -ExecutionPolicy Bypass -File pc\autostart.ps1 -Remove"

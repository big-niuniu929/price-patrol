# Register login autostart task for Patrol API bridge (no admin needed)
# 矩阵版与双轨版共用 127.0.0.1:18765；已注册双轨版任务时不再重复注册，避免两个进程抢端口。
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$existing = Get-ScheduledTask -TaskName '巡检双轨版API桥' -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host 'OK: 已检测到 [巡检双轨版API桥] 计划任务，矩阵版与它共用同一个 API 桥（127.0.0.1:18765），无需重复注册。'
  exit 0
}
$pywCandidates = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\pythonw.exe'),
  (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python314\pythonw.exe'),
  (Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\pythonw.exe')
)
$pyw = $pywCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $pyw) { Write-Host 'pythonw.exe not found. Install Python 3.12+ first.'; exit 1 }
$script = Join-Path $dir 'api_bridge.py'
if (-not (Test-Path $script)) { Write-Host 'api_bridge.py not found next to this script.'; exit 1 }
$user = "$env:USERDOMAIN\$env:USERNAME"
$action = New-ScheduledTaskAction -Execute $pyw -Argument "`"$script`" --port 18765" -WorkingDirectory $dir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName '巡检矩阵版API桥' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Patrol matrix API bridge on 127.0.0.1:18765 (shared with dual-track)' -Force | Out-Null
Write-Host 'OK: scheduled task [巡检矩阵版API桥] registered.'

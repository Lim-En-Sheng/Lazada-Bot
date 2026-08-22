$ErrorActionPreference = 'Stop'

$taskName = 'LazadaStockBotController'
$projectDirectory = Split-Path -Parent $PSScriptRoot
$controllerPath = Join-Path $projectDirectory 'src\controller.js'
$nodeCommand = Get-Command node.exe -ErrorAction Stop

if (-not (Test-Path -LiteralPath $controllerPath)) {
  throw "Controller not found: $controllerPath"
}

$action = New-ScheduledTaskAction `
  -Execute $nodeCommand.Source `
  -Argument ('"{0}"' -f $controllerPath) `
  -WorkingDirectory $projectDirectory
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew

Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Description 'Keeps the Lazada Telegram controller available after Windows logon.' `
  -Force | Out-Null

Write-Host "Installed Windows startup task: $taskName"
Write-Host 'The controller will start at the next Windows logon. Monitoring remains stopped until /start_monitor is sent.'

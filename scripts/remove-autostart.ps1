$ErrorActionPreference = 'Stop'

$taskName = 'LazadaStockBotController'
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue

if ($null -eq $task) {
  Write-Host "Windows startup task is not installed: $taskName"
  exit 0
}

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
Write-Host "Removed Windows startup task: $taskName"

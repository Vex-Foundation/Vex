# Remove Docker from a GitHub Windows runner for the clean-machine gate
# (.github/workflows/clean-machine.yml). The images run the Docker engine as
# the `docker` service with docker.exe and dockerd.exe on PATH;
# vex-app/scripts/assert-no-docker-host.mjs then proves nothing is left.
$ErrorActionPreference = 'Stop'

Write-Host 'Before:'
Get-Service | Where-Object { $_.Name -match 'docker' } | Format-Table Name, Status, StartType -AutoSize | Out-String | Write-Host
Get-Command docker, dockerd, docker-compose, containerd -All -CommandType Application -ErrorAction SilentlyContinue |
  Format-Table Name, Source -AutoSize | Out-String | Write-Host

foreach ($service in Get-Service | Where-Object { $_.Name -match 'docker' }) {
  Stop-Service -Name $service.Name -Force
  sc.exe delete $service.Name | Write-Host
  if ($LASTEXITCODE -ne 0) { throw "could not delete the $($service.Name) service" }
}
foreach ($program in 'docker', 'dockerd', 'docker-compose', 'containerd') {
  foreach ($command in Get-Command $program -All -CommandType Application -ErrorAction SilentlyContinue) {
    Write-Host "removing $($command.Source)"
    Remove-Item -LiteralPath $command.Source -Force
  }
}

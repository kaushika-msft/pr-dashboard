$ErrorActionPreference = "SilentlyContinue"

Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%serve.ps1%'" |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

Start-Process powershell -ArgumentList @(
  "-NoProfile",
  "-ExecutionPolicy", "Bypass",
  "-File", ".\scripts\serve.ps1",
  "-Port", "5500"
)

Start-Process "http://localhost:5500/index.html"

param(
  [switch]$Help,
  [switch]$SkipBuild,
  [switch]$DoctorOnly,
  [string]$TunnelClientPath,
  [string]$TunnelProfile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Show-Help {
  @(
    "Start the local Scriverse service and ChatGPT Secure MCP Tunnel."
    ""
    "Usage:"
    "  npm run chatgpt:start"
    "  npm run chatgpt:start -- -SkipBuild"
    "  npm run chatgpt:start -- -DoctorOnly"
    ""
    "Required .env.local variables:"
    "  SCRIVERSE_BASE_URL"
    "  SCRIVERSE_API_KEY"
    "  CONTROL_PLANE_API_KEY"
    ""
    "Optional .env.local variables:"
    "  TUNNEL_CLIENT_PATH       Full path to tunnel-client.exe"
    "  TUNNEL_CLIENT_PROFILE    Tunnel Client profile; default: scriverse-local"
    "  TUNNEL_CLIENT_PROFILE_FILE  Full path to the profile YAML file"
    ""
    "Default Tunnel Client path:"
    "  F:\Tool\Tunnel Client\tunnel-client.exe"
    ""
    "After changing MCP tools, rerun this command, refresh the ChatGPT plugin, and start a new chat."
  ) -join [Environment]::NewLine
}

if ($Help) {
  Show-Help
  exit 0
}

function Import-DotEnvFile {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Path was not found. Create .env.local and add the required keys."
  }

  foreach ($rawLine in Get-Content -LiteralPath $Path -Encoding UTF8) {
    $line = $rawLine.Trim()
    if (-not $line -or $line.StartsWith("#")) {
      continue
    }
    if ($line.StartsWith("export ")) {
      $line = $line.Substring(7).TrimStart()
    }

    $separator = $line.IndexOf("=")
    if ($separator -le 0) {
      continue
    }

    $name = $line.Substring(0, $separator).Trim()
    if ($name -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') {
      continue
    }

    $value = $line.Substring($separator + 1).Trim()
    if ($value.Length -ge 2) {
      $first = $value[0]
      $last = $value[$value.Length - 1]
      if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
        $value = $value.Substring(1, $value.Length - 2)
      }
    }
    [Environment]::SetEnvironmentVariable($name, $value, "Process")
  }
}

function Get-RequiredEnvironmentValue {
  param([Parameter(Mandatory = $true)][string]$Name)

  $value = [Environment]::GetEnvironmentVariable($Name, "Process")
  if ([string]::IsNullOrWhiteSpace($value)) {
    throw ".env.local is missing $Name. Add it and try again. Secret values are never printed."
  }
  return $value
}

function Test-HttpEndpoint {
  param([Parameter(Mandatory = $true)][string]$Url)

  try {
    $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
  } catch {
    return $false
  }
}

function Stop-OwnedProcess {
  param([System.Diagnostics.Process]$Process)

  if ($null -eq $Process) {
    return
  }
  try {
    if (-not $Process.HasExited) {
      Stop-Process -Id $Process.Id -Force
      $Process.WaitForExit(5000) | Out-Null
    }
  } catch {
    Write-Warning "Could not stop the Scriverse process started by this script (PID $($Process.Id)). Check it manually."
  }
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $projectRoot ".env.local"
$mcpEntry = Join-Path $projectRoot "dist\scriverse-mcp-server.js"
$serverEntry = Join-Path $projectRoot "dist\server.js"
$ownedServer = $null

try {
  Import-DotEnvFile -Path $envFile

  $scriverseBaseUrl = (Get-RequiredEnvironmentValue -Name "SCRIVERSE_BASE_URL").TrimEnd("/")
  Get-RequiredEnvironmentValue -Name "SCRIVERSE_API_KEY" | Out-Null
  Get-RequiredEnvironmentValue -Name "CONTROL_PLANE_API_KEY" | Out-Null

  if ([string]::IsNullOrWhiteSpace($TunnelClientPath)) {
    $TunnelClientPath = [Environment]::GetEnvironmentVariable("TUNNEL_CLIENT_PATH", "Process")
  }
  if ([string]::IsNullOrWhiteSpace($TunnelClientPath)) {
    $TunnelClientPath = "F:\Tool\Tunnel Client\tunnel-client.exe"
  }
  if ([string]::IsNullOrWhiteSpace($TunnelProfile)) {
    $TunnelProfile = [Environment]::GetEnvironmentVariable("TUNNEL_CLIENT_PROFILE", "Process")
  }
  if ([string]::IsNullOrWhiteSpace($TunnelProfile)) {
    $TunnelProfile = "scriverse-local"
  }

  if (-not (Test-Path -LiteralPath $TunnelClientPath -PathType Leaf)) {
    throw "Tunnel Client was not found at $TunnelClientPath. Set TUNNEL_CLIENT_PATH in .env.local."
  }

  $tunnelProfileFile = [Environment]::GetEnvironmentVariable("TUNNEL_CLIENT_PROFILE_FILE", "Process")
  if ([string]::IsNullOrWhiteSpace($tunnelProfileFile)) {
    $profileCandidates = @()
    $profileDirectory = [Environment]::GetEnvironmentVariable("TUNNEL_CLIENT_PROFILE_DIR", "Process")
    if (-not [string]::IsNullOrWhiteSpace($profileDirectory)) {
      $profileCandidates += Join-Path $profileDirectory "$TunnelProfile.yaml"
    }
    if (-not [string]::IsNullOrWhiteSpace($env:APPDATA)) {
      $profileCandidates += Join-Path $env:APPDATA "tunnel-client\$TunnelProfile.yaml"
    }
    if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
      $profileCandidates += Join-Path $env:USERPROFILE ".config\tunnel-client\$TunnelProfile.yaml"
    }
    $tunnelProfileFile = $profileCandidates |
      Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
      Select-Object -First 1
  }
  if ([string]::IsNullOrWhiteSpace($tunnelProfileFile) -or -not (Test-Path -LiteralPath $tunnelProfileFile -PathType Leaf)) {
    throw "Tunnel profile '$TunnelProfile' was not found. Set TUNNEL_CLIENT_PROFILE_FILE in .env.local."
  }

  $needsBuild = -not (Test-Path -LiteralPath $mcpEntry -PathType Leaf) -or -not (Test-Path -LiteralPath $serverEntry -PathType Leaf)
  if (-not $needsBuild -and -not $SkipBuild) {
    $latestSource = Get-ChildItem -LiteralPath (Join-Path $projectRoot "src") -Recurse -File -Include *.ts,*.js |
      Sort-Object LastWriteTimeUtc -Descending |
      Select-Object -First 1
    $oldestEntryTime = [DateTime]::MinValue
    $mcpEntryTime = (Get-Item -LiteralPath $mcpEntry).LastWriteTimeUtc
    $serverEntryTime = (Get-Item -LiteralPath $serverEntry).LastWriteTimeUtc
    if ($mcpEntryTime -lt $serverEntryTime) {
      $oldestEntryTime = $mcpEntryTime
    } else {
      $oldestEntryTime = $serverEntryTime
    }
    $needsBuild = $null -ne $latestSource -and $latestSource.LastWriteTimeUtc -gt $oldestEntryTime
  }

  if ($needsBuild -and $SkipBuild) {
    throw "The dist build is missing or stale. Retry without -SkipBuild."
  }
  if ($needsBuild) {
    Write-Host "[1/4] Source changes detected. Building dist..."
    Push-Location $projectRoot
    try {
      & npm.cmd run build
      if ($LASTEXITCODE -ne 0) {
        throw "npm run build failed with exit code $LASTEXITCODE."
      }
    } finally {
      Pop-Location
    }
  } else {
    Write-Host "[1/4] dist is current. Skipping build."
  }

  $healthUrl = "$scriverseBaseUrl/api/health"
  if (Test-HttpEndpoint -Url $healthUrl) {
    Write-Host "[2/4] Reusing the running Scriverse service."
  } else {
    $baseUri = [Uri]$scriverseBaseUrl
    if ($baseUri.Host -notin @("127.0.0.1", "localhost", "::1")) {
      throw "SCRIVERSE_BASE_URL is not local and its health check failed: $healthUrl"
    }

    $nodePath = (Get-Command node.exe -ErrorAction Stop).Source
    $logDirectory = Join-Path $projectRoot ".tmp\chatgpt-mcp"
    New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
    $stdoutLog = Join-Path $logDirectory "scriverse-server.stdout.log"
    $stderrLog = Join-Path $logDirectory "scriverse-server.stderr.log"

    Write-Host "[2/4] Starting the local Scriverse service..."
    $ownedServer = Start-Process `
      -FilePath $nodePath `
      -ArgumentList @("--env-file-if-exists=.env.local", "dist/server.js") `
      -WorkingDirectory $projectRoot `
      -PassThru `
      -WindowStyle Hidden `
      -RedirectStandardOutput $stdoutLog `
      -RedirectStandardError $stderrLog

    $ready = $false
    for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
      if ($ownedServer.HasExited) {
        throw "The local Scriverse service failed to start. See $stderrLog"
      }
      if (Test-HttpEndpoint -Url $healthUrl) {
        $ready = $true
        break
      }
      Start-Sleep -Milliseconds 500
      $ownedServer.Refresh()
    }
    if (-not $ready) {
      throw "The local Scriverse service was not ready after 30 seconds. See $stderrLog"
    }
    Write-Host "      Local service ready: $healthUrl"
  }

  if (Test-HttpEndpoint -Url "http://127.0.0.1:8080/readyz") {
    throw "Another Tunnel Client is already running. If ChatGPT shows stale tools, stop it and rerun this command."
  }

  Write-Host "[3/4] Checking Tunnel configuration and access..."
  & $TunnelClientPath doctor --profile-file $tunnelProfileFile --explain
  if ($LASTEXITCODE -ne 0) {
    throw "Tunnel Client doctor failed with exit code $LASTEXITCODE. Fix the FAILED_CHECKS shown above."
  }

  if ($DoctorOnly) {
    Write-Host "[4/4] Checks passed. DoctorOnly mode does not keep the Tunnel connected."
    exit 0
  }

  Write-Host "[4/4] Connecting ChatGPT. Keep this window open; press Ctrl+C to stop."
  Write-Host "      After MCP tool changes, refresh the ChatGPT plugin and start a new chat."
  & $TunnelClientPath run --profile-file $tunnelProfileFile
  if ($LASTEXITCODE -ne 0) {
    throw "Tunnel Client exited with code $LASTEXITCODE."
  }
} catch {
  Write-Error $_.Exception.Message
  exit 1
} finally {
  Stop-OwnedProcess -Process $ownedServer
}

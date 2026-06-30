param(
  [int]$Port = 5500
)

$basePath = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$prefix = "http://localhost:$Port/"

$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add($prefix)

try {
  $listener.Start()
  Write-Host "Serving $basePath at $prefix"
} catch {
  Write-Error "Unable to start server on port $Port. $_"
  exit 1
}

$mimeTypes = @{
  ".html" = "text/html; charset=utf-8"
  ".css" = "text/css; charset=utf-8"
  ".js" = "application/javascript; charset=utf-8"
  ".json" = "application/json; charset=utf-8"
  ".svg" = "image/svg+xml"
  ".png" = "image/png"
  ".jpg" = "image/jpeg"
  ".jpeg" = "image/jpeg"
  ".gif" = "image/gif"
  ".ico" = "image/x-icon"
}

function Write-JsonResponse {
  param(
    [Parameter(Mandatory = $true)]$Context,
    [Parameter(Mandatory = $true)]$Payload,
    [int]$StatusCode = 200
  )

  $json = $Payload | ConvertTo-Json -Depth 10 -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)

  $Context.Response.StatusCode = $StatusCode
  $Context.Response.ContentType = "application/json; charset=utf-8"
  $Context.Response.ContentLength64 = $bytes.Length
  $Context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
}

function Get-GitHubCliToken {
  $ghPath = $null

  try {
    $ghCommand = Get-Command gh -ErrorAction SilentlyContinue
    if ($ghCommand -and $ghCommand.Source) {
      $ghPath = $ghCommand.Source
    }
  } catch {
    $ghPath = $null
  }

  if (-not $ghPath) {
    $candidates = @(
      (Join-Path $env:ProgramFiles "GitHub CLI\gh.exe"),
      (Join-Path $env:LocalAppData "Programs\GitHub CLI\gh.exe"),
      (Join-Path $env:ProgramFiles "GitHub CLI\bin\gh.exe")
    )

    foreach ($candidate in $candidates) {
      if (Test-Path $candidate) {
        $ghPath = $candidate
        break
      }
    }
  }

  if (-not $ghPath) {
    return @{
      token = $null
      authState = "gh-not-found"
    }
  }

  try {
    $token = (& $ghPath auth token 2>$null)
    if ($LASTEXITCODE -ne 0) {
      return @{
        token = $null
        authState = "gh-not-authenticated"
      }
    }

    $trimmed = "$token".Trim()
    if ([string]::IsNullOrWhiteSpace($trimmed)) {
      return @{
        token = $null
        authState = "gh-not-authenticated"
      }
    }

    return @{
      token = $trimmed
      authState = "authenticated"
    }
  } catch {
    return @{
      token = $null
      authState = "gh-token-error"
    }
  }
}

function Handle-GitHubPullsRequest {
  param(
    [Parameter(Mandatory = $true)]$Context,
    [Parameter(Mandatory = $true)][string]$BasePath
  )

  $repo = $Context.Request.QueryString["repo"]
  if ([string]::IsNullOrWhiteSpace($repo) -or $repo -notmatch '^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$') {
    Write-JsonResponse -Context $Context -Payload @{
      message = "Invalid repository format. Use owner/repo."
      status = 400
    } -StatusCode 400
    return
  }

  $auth = Get-GitHubCliToken
  $token = $auth.token
  $headers = @{
    Accept = "application/vnd.github+json"
    "User-Agent" = "pr-dashboard-local"
  }

  if ($token) {
    $headers.Authorization = "Bearer $token"
  }

  $uri = "https://api.github.com/repos/$repo/pulls?state=all&per_page=100"

  try {
    $response = Invoke-WebRequest -Uri $uri -Headers $headers -Method Get -UseBasicParsing
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($response.Content)

    $Context.Response.StatusCode = 200
    $Context.Response.ContentType = "application/json; charset=utf-8"
    $Context.Response.ContentLength64 = $bytes.Length
    $Context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
  } catch {
    $status = 500
    $details = "GitHub request failed"

    if ($_.Exception.Response) {
      try {
        $status = [int]$_.Exception.Response.StatusCode
      } catch {
        $status = 500
      }
    }

    if (-not [string]::IsNullOrWhiteSpace($_.ErrorDetails.Message)) {
      $details = $_.ErrorDetails.Message
    } elseif (-not [string]::IsNullOrWhiteSpace($_.Exception.Message)) {
      $details = $_.Exception.Message
    }

    $hint = if (-not $token) {
      if ($auth.authState -eq "gh-not-found") {
        "GitHub CLI not found by server process. Restart VS Code/task after installing GitHub CLI."
      } elseif ($auth.authState -eq "gh-not-authenticated") {
        "Sign in with GitHub CLI: gh auth login -w -s repo,read:org"
      } else {
        "GitHub CLI auth unavailable. Verify: gh auth status -h github.com"
      }
    } else {
      "Verify repo access in your GitHub account."
    }

    Write-JsonResponse -Context $Context -Payload @{
      message = "Failed to load $repo ($status)"
      details = $details
      status = $status
      hint = $hint
    } -StatusCode $status
  }
}

function Handle-GitHubViewerRequest {
  param(
    [Parameter(Mandatory = $true)]$Context
  )

  $auth = Get-GitHubCliToken
  $token = $auth.token

  if (-not $token) {
    Write-JsonResponse -Context $Context -Payload @{
      message = "GitHub CLI auth unavailable"
      status = 401
    } -StatusCode 401
    return
  }

  $headers = @{
    Accept = "application/vnd.github+json"
    "User-Agent" = "pr-dashboard-local"
    Authorization = "Bearer $token"
  }

  try {
    $response = Invoke-WebRequest -Uri "https://api.github.com/user" -Headers $headers -Method Get -UseBasicParsing
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($response.Content)

    $Context.Response.StatusCode = 200
    $Context.Response.ContentType = "application/json; charset=utf-8"
    $Context.Response.ContentLength64 = $bytes.Length
    $Context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
  } catch {
    Write-JsonResponse -Context $Context -Payload @{
      message = "Unable to resolve GitHub user"
      status = 500
    } -StatusCode 500
  }
}

while ($listener.IsListening) {
  try {
    $context = $listener.GetContext()
    if ($context.Request.Url.AbsolutePath -eq "/api/pulls") {
      Handle-GitHubPullsRequest -Context $context -BasePath $basePath
      continue
    }

    if ($context.Request.Url.AbsolutePath -eq "/api/me") {
      Handle-GitHubViewerRequest -Context $context
      continue
    }

    $requestPath = $context.Request.Url.AbsolutePath.TrimStart('/')
    if ([string]::IsNullOrWhiteSpace($requestPath)) {
      $requestPath = "index.html"
    }

    $requestPath = $requestPath -replace '/', '\\'
    $fullPath = Join-Path $basePath $requestPath

    if ((Test-Path $fullPath) -and -not (Get-Item $fullPath).PSIsContainer) {
      $ext = [System.IO.Path]::GetExtension($fullPath).ToLowerInvariant()
      $contentType = if ($mimeTypes.ContainsKey($ext)) { $mimeTypes[$ext] } else { "application/octet-stream" }
      $bytes = [System.IO.File]::ReadAllBytes($fullPath)

      $context.Response.StatusCode = 200
      $context.Response.ContentType = $contentType
      $context.Response.ContentLength64 = $bytes.Length
      $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $message = "Not Found"
      $bytes = [System.Text.Encoding]::UTF8.GetBytes($message)
      $context.Response.StatusCode = 404
      $context.Response.ContentType = "text/plain; charset=utf-8"
      $context.Response.ContentLength64 = $bytes.Length
      $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    }
  } catch {
    Write-Warning "Request handling error: $_"
  } finally {
    if ($context -and $context.Response) {
      $context.Response.OutputStream.Close()
    }
  }
}

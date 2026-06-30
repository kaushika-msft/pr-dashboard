param(
  [int]$Port = 5500
)

$basePath = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$prefix = "http://localhost:$Port/"
$baseUrl = "http://localhost:$Port"

$oauthClientId = $env:GITHUB_OAUTH_CLIENT_ID
$oauthClientSecret = $env:GITHUB_OAUTH_CLIENT_SECRET
$oauthRedirectUri = if ([string]::IsNullOrWhiteSpace($env:GITHUB_OAUTH_REDIRECT_URI)) {
  "$baseUrl/auth/github/callback"
} else {
  $env:GITHUB_OAUTH_REDIRECT_URI
}

$sessions = @{}
$oauthStates = @{}

$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add($prefix)

try {
  $listener.Start()
  Write-Host "Serving $basePath at $prefix"
  if ((-not [string]::IsNullOrWhiteSpace($oauthClientId)) -and (-not [string]::IsNullOrWhiteSpace($oauthClientSecret))) {
    Write-Host "GitHub OAuth enabled. Redirect URI: $oauthRedirectUri"
  } else {
    Write-Host "GitHub OAuth disabled. Set GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET to enable web login."
  }
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

function Write-RedirectResponse {
  param(
    [Parameter(Mandatory = $true)]$Context,
    [Parameter(Mandatory = $true)][string]$Location,
    [int]$StatusCode = 302
  )

  $Context.Response.StatusCode = $StatusCode
  $Context.Response.RedirectLocation = $Location
}

function Test-OAuthConfigured {
  return (-not [string]::IsNullOrWhiteSpace($oauthClientId)) -and (-not [string]::IsNullOrWhiteSpace($oauthClientSecret))
}

function Get-CookieValue {
  param(
    [Parameter(Mandatory = $true)]$Request,
    [Parameter(Mandatory = $true)][string]$Name
  )

  $cookieHeader = $Request.Headers["Cookie"]
  if ([string]::IsNullOrWhiteSpace($cookieHeader)) {
    return $null
  }

  $parts = $cookieHeader.Split(';')
  foreach ($part in $parts) {
    $kv = $part.Trim().Split('=', 2)
    if ($kv.Length -eq 2 -and $kv[0].Trim() -eq $Name) {
      return $kv[1].Trim()
    }
  }

  return $null
}

function Get-SessionRecord {
  param(
    [Parameter(Mandatory = $true)]$Context
  )

  $sessionId = Get-CookieValue -Request $Context.Request -Name "prdash_session"
  if ([string]::IsNullOrWhiteSpace($sessionId)) {
    return $null
  }

  if ($sessions.ContainsKey($sessionId)) {
    return $sessions[$sessionId]
  }

  return $null
}

function Set-SessionCookie {
  param(
    [Parameter(Mandatory = $true)]$Context,
    [Parameter(Mandatory = $true)][string]$SessionId
  )

  $Context.Response.Headers.Add("Set-Cookie", "prdash_session=$SessionId; Path=/; HttpOnly; SameSite=Lax")
}

function Clear-SessionCookie {
  param(
    [Parameter(Mandatory = $true)]$Context
  )

  $Context.Response.Headers.Add("Set-Cookie", "prdash_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0")
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
      source = "none"
    }
  }

  try {
    $token = (& $ghPath auth token 2>$null)
    if ($LASTEXITCODE -ne 0) {
      return @{
        token = $null
        authState = "gh-not-authenticated"
        source = "none"
      }
    }

    $trimmed = "$token".Trim()
    if ([string]::IsNullOrWhiteSpace($trimmed)) {
      return @{
        token = $null
        authState = "gh-not-authenticated"
        source = "none"
      }
    }

    return @{
      token = $trimmed
      authState = "authenticated"
      source = "gh-cli"
    }
  } catch {
    return @{
      token = $null
      authState = "gh-token-error"
      source = "none"
    }
  }
}

function Get-RequestAuth {
  param(
    [Parameter(Mandatory = $true)]$Context
  )

  $session = Get-SessionRecord -Context $Context
  if ($session -and $session.token) {
    return @{
      token = $session.token
      authState = "authenticated"
      source = "oauth"
      login = $session.login
    }
  }

  return Get-GitHubCliToken
}

function Invoke-OAuthLoginRequest {
  param(
    [Parameter(Mandatory = $true)]$Context
  )

  if (-not (Test-OAuthConfigured)) {
    Write-JsonResponse -Context $Context -Payload @{
      message = "OAuth is not configured on this server."
      status = 500
      hint = "Set GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET, then restart the server."
    } -StatusCode 500
    return
  }

  $state = [guid]::NewGuid().ToString("N")
  $oauthStates[$state] = (Get-Date)

  $query = @(
    "client_id=$([uri]::EscapeDataString($oauthClientId))"
    "redirect_uri=$([uri]::EscapeDataString($oauthRedirectUri))"
    "scope=$([uri]::EscapeDataString('read:user repo'))"
    "state=$([uri]::EscapeDataString($state))"
  ) -join "&"

  $authUrl = "https://github.com/login/oauth/authorize?$query"
  Write-RedirectResponse -Context $Context -Location $authUrl
}

function Invoke-OAuthCallbackRequest {
  param(
    [Parameter(Mandatory = $true)]$Context
  )

  if (-not (Test-OAuthConfigured)) {
    Write-JsonResponse -Context $Context -Payload @{
      message = "OAuth is not configured on this server."
      status = 500
    } -StatusCode 500
    return
  }

  $code = $Context.Request.QueryString["code"]
  $state = $Context.Request.QueryString["state"]
  $oauthError = $Context.Request.QueryString.Get("error")

  if (-not [string]::IsNullOrWhiteSpace($oauthError)) {
    Write-RedirectResponse -Context $Context -Location "/index.html?auth=denied"
    return
  }

  if ([string]::IsNullOrWhiteSpace($code) -or [string]::IsNullOrWhiteSpace($state) -or -not $oauthStates.ContainsKey($state)) {
    Write-RedirectResponse -Context $Context -Location "/index.html?auth=failed"
    return
  }

  $null = $oauthStates.Remove($state)

  try {
    $tokenResponse = Invoke-RestMethod -Uri "https://github.com/login/oauth/access_token" -Method Post -Headers @{
      Accept = "application/json"
      "User-Agent" = "pr-dashboard-local"
    } -Body @{
      client_id = $oauthClientId
      client_secret = $oauthClientSecret
      code = $code
      redirect_uri = $oauthRedirectUri
      state = $state
    }

    if (-not $tokenResponse.access_token) {
      Write-RedirectResponse -Context $Context -Location "/index.html?auth=failed"
      return
    }

    $accessToken = "$($tokenResponse.access_token)".Trim()
    $userResponse = Invoke-RestMethod -Uri "https://api.github.com/user" -Method Get -Headers @{
      Accept = "application/vnd.github+json"
      "User-Agent" = "pr-dashboard-local"
      Authorization = "Bearer $accessToken"
    }

    $sessionId = [guid]::NewGuid().ToString("N")
    $sessions[$sessionId] = @{
      token = $accessToken
      login = "$($userResponse.login)".Trim().ToLowerInvariant()
      createdAt = (Get-Date).ToString("o")
    }

    Set-SessionCookie -Context $Context -SessionId $sessionId
    Write-RedirectResponse -Context $Context -Location "/index.html?auth=success"
  } catch {
    Write-RedirectResponse -Context $Context -Location "/index.html?auth=failed"
  }
}

function Invoke-OAuthLogoutRequest {
  param(
    [Parameter(Mandatory = $true)]$Context
  )

  $sessionId = Get-CookieValue -Request $Context.Request -Name "prdash_session"
  if ($sessionId -and $sessions.ContainsKey($sessionId)) {
    $null = $sessions.Remove($sessionId)
  }

  Clear-SessionCookie -Context $Context
  Write-RedirectResponse -Context $Context -Location "/index.html?auth=logged-out"
}

function Get-AuthStatusResponse {
  param(
    [Parameter(Mandatory = $true)]$Context
  )

  $session = Get-SessionRecord -Context $Context
  if ($session -and $session.login) {
    Write-JsonResponse -Context $Context -Payload @{
      authenticated = $true
      source = "oauth"
      login = $session.login
    }
    return
  }

  Write-JsonResponse -Context $Context -Payload @{
    authenticated = $false
    oauthConfigured = (Test-OAuthConfigured)
    loginUrl = "/auth/github/login"
  }
}

function Invoke-GitHubPullsRequest {
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

  $auth = Get-RequestAuth -Context $Context
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
      if (Test-OAuthConfigured) {
        "Sign in with GitHub: /auth/github/login"
      } elseif ($auth.authState -eq "gh-not-found") {
        "GitHub CLI not found by server process. Restart VS Code/task after installing GitHub CLI."
      } elseif ($auth.authState -eq "gh-not-authenticated") {
        "Sign in with GitHub CLI: gh auth login -w -s repo,read:org"
      } else {
        "No auth session found. Configure OAuth or GitHub CLI auth."
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

function Invoke-GitHubViewerRequest {
  param(
    [Parameter(Mandatory = $true)]$Context
  )

  $auth = Get-RequestAuth -Context $Context
  $token = $auth.token

  if (-not $token) {
    Write-JsonResponse -Context $Context -Payload @{
      message = "GitHub auth unavailable"
      status = 401
      loginUrl = if (Test-OAuthConfigured) { "/auth/github/login" } else { $null }
      hint = if (Test-OAuthConfigured) {
        "Sign in with GitHub to start a local session."
      } else {
        "Set GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET, or sign in with GitHub CLI."
      }
    } -StatusCode 401
    return
  }

  if ($auth.source -eq "oauth" -and -not [string]::IsNullOrWhiteSpace($auth.login)) {
    Write-JsonResponse -Context $Context -Payload @{
      login = $auth.login
      source = "oauth"
    }
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

    switch ($context.Request.Url.AbsolutePath) {
      "/api/pulls" {
        Invoke-GitHubPullsRequest -Context $context -BasePath $basePath
        continue
      }
      "/api/me" {
        Invoke-GitHubViewerRequest -Context $context
        continue
      }
      "/api/auth/status" {
        Get-AuthStatusResponse -Context $context
        continue
      }
      "/auth/github/login" {
        Invoke-OAuthLoginRequest -Context $context
        continue
      }
      "/auth/github/callback" {
        Invoke-OAuthCallbackRequest -Context $context
        continue
      }
      "/auth/logout" {
        Invoke-OAuthLogoutRequest -Context $context
        continue
      }
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

$ErrorActionPreference = "Stop"

$root = [System.IO.Path]::GetFullPath($PSScriptRoot)
$rootPrefix = $root.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://127.0.0.1:8080/")

try {
  $listener.Start()
  Write-Host "CRM preview: http://127.0.0.1:8080/"
  Write-Host "Press Ctrl+C to stop the server."

  while ($listener.IsListening) {
    $context = $listener.GetContext()
    $response = $context.Response
    $response.Headers["Cache-Control"] = "no-store"

    if ($context.Request.HttpMethod -ne "GET" -and $context.Request.HttpMethod -ne "HEAD") {
      $response.StatusCode = 405
      $response.Close()
      continue
    }

    $relativePath = [System.Uri]::UnescapeDataString($context.Request.Url.AbsolutePath.TrimStart("/"))
    if ([string]::IsNullOrWhiteSpace($relativePath)) {
      $relativePath = "index.html"
    }
    $relativePath = $relativePath.Replace("/", [System.IO.Path]::DirectorySeparatorChar)
    $filePath = [System.IO.Path]::GetFullPath((Join-Path $root $relativePath))

    if (-not $filePath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      $response.StatusCode = 403
      $response.Close()
      continue
    }
    if (-not (Test-Path -LiteralPath $filePath -PathType Leaf)) {
      $response.StatusCode = 404
      $response.Close()
      continue
    }

    $mimeTypes = @{
      ".html" = "text/html; charset=utf-8"
      ".css"  = "text/css; charset=utf-8"
      ".js"   = "text/javascript; charset=utf-8"
      ".json" = "application/json; charset=utf-8"
      ".md"   = "text/markdown; charset=utf-8"
      ".svg"  = "image/svg+xml"
    }
    $extension = [System.IO.Path]::GetExtension($filePath).ToLowerInvariant()
    if ($mimeTypes.ContainsKey($extension)) {
      $response.ContentType = $mimeTypes[$extension]
    } else {
      $response.ContentType = "application/octet-stream"
    }

    $bytes = [System.IO.File]::ReadAllBytes($filePath)
    $response.ContentLength64 = $bytes.Length
    if ($context.Request.HttpMethod -eq "GET") {
      $response.OutputStream.Write($bytes, 0, $bytes.Length)
    }
    $response.Close()
  }
} finally {
  if ($listener.IsListening) {
    $listener.Stop()
  }
  $listener.Close()
}

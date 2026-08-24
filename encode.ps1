<#
  encode.ps1 — builds the web-ready scrub sources from assets/jet-v7.mp4

  Why these flags:
    -g 1 -keyint_min 1 -sc_threshold 0   every frame is an IDR keyframe, so
                                         video.currentTime = t decodes exactly
                                         one frame. No GOP walk-back, no stall
                                         mid-scrub. This is the whole reason the
                                         file is bigger than a normal delivery
                                         encode — it buys seek latency.
    -movflags +faststart                 moov atom in front, so the browser can
                                         seek before the file finishes loading.
    -bf 0                                no B-frames: decode order == display
                                         order, which keeps backwards scrub
                                         (scroll up) as cheap as forwards.
    -an                                  source has no audio track; strip anyway.

  Run:  powershell -ExecutionPolicy Bypass -File encode.ps1
#>

[CmdletBinding()]
param(
  [string]$Source,
  [string]$OutDir,
  [int]   $DesktopWidth = 1440,
  [int]   $DesktopCrf   = 32,
  [int]   $MobileWidth  = 960,
  [int]   $MobileCrf    = 34
)

$ErrorActionPreference = 'Stop'

# $PSScriptRoot is not reliably bound inside param() defaults under PS 5.1,
# so resolve the script directory here instead.
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $Source) { $Source = Join-Path $root 'assets\jet-v7.mp4' }
if (-not $OutDir) { $OutDir = Join-Path $root 'assets' }

# winget drops ffmpeg in a Links shim dir that an already-open shell won't have.
$shim = "$env:LOCALAPPDATA\Microsoft\WinGet\Links"
if ((Test-Path $shim) -and ($env:Path -notlike "*$shim*")) { $env:Path = "$shim;$env:Path" }

$ffmpeg = (Get-Command ffmpeg -ErrorAction SilentlyContinue).Source
if (-not $ffmpeg) {
  $probe = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Filter ffmpeg.exe -Recurse -ErrorAction SilentlyContinue |
           Select-Object -First 1
  if ($probe) { $ffmpeg = $probe.FullName }
}
if (-not $ffmpeg) { throw "ffmpeg not found. Install it with:  winget install Gyan.FFmpeg" }

if (-not (Test-Path $Source)) { throw "Source not found: $Source" }
New-Item -ItemType Directory -Force $OutDir | Out-Null

function Invoke-Encode {
  param([string]$Label, [int]$Width, [int]$Crf, [string]$OutFile)

  Write-Host "  $Label -> $(Split-Path $OutFile -Leaf) (width $Width, crf $Crf)"
  & $ffmpeg -y -loglevel error -stats `
    -i $Source `
    -an `
    -vf "scale=$($Width):-2:flags=lanczos" `
    -c:v libx264 -preset veryslow -crf $Crf `
    -g 1 -keyint_min 1 -sc_threshold 0 -bf 0 `
    -pix_fmt yuv420p -profile:v high -level 4.1 `
    -movflags +faststart `
    $OutFile
  if ($LASTEXITCODE -ne 0) { throw "ffmpeg failed on $Label" }
}

Write-Host "`nEncoding all-intra scrub sources..." -ForegroundColor Cyan
Invoke-Encode -Label 'desktop' -Width $DesktopWidth -Crf $DesktopCrf -OutFile "$OutDir\jet-v7-web.mp4"
Invoke-Encode -Label 'mobile'  -Width $MobileWidth  -Crf $MobileCrf  -OutFile "$OutDir\jet-v7-web-540.mp4"

# Poster is regenerated from frame 0 of the delivery encode so there is no
# visible pop when the video takes over from the poster on load.
# The original is preserved once, on first run.
$poster = "$OutDir\poster.jpg"
$backup = "$OutDir\poster.original.jpg"
if ((Test-Path $poster) -and -not (Test-Path $backup)) {
  Copy-Item $poster $backup
  Write-Host "  poster  -> backed up original to poster.original.jpg"
}
Write-Host "  poster  -> poster.jpg"
& $ffmpeg -y -loglevel error -i "$OutDir\jet-v7-web.mp4" -frames:v 1 -vf "scale=1920:-2:flags=lanczos" -q:v 4 $poster
if ($LASTEXITCODE -ne 0) { throw "ffmpeg failed on poster" }

Write-Host "`nDone.`n" -ForegroundColor Green
Get-ChildItem $OutDir -Include *.mp4, *.jpg -Recurse |
  Sort-Object Length |
  Format-Table @{n='file';e={$_.Name}}, @{n='size';e={'{0:N2} MB' -f ($_.Length / 1MB)}} -AutoSize

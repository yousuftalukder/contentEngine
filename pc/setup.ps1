# Prepares this PC to be a video worker: ffmpeg, yt-dlp and whisper.cpp in the project's own .tools folder, nothing
# installed system-wide. Safe to run again — anything already present is left alone. Every download is printed with
# where it comes from before it starts.
$ErrorActionPreference = "Stop"
$root  = Split-Path $PSScriptRoot -Parent
$tools = Join-Path $root ".tools"
$bin   = Join-Path $tools "bin"
$wdir  = Join-Path $tools "whisper"
$wbin  = Join-Path $wdir "bin"
New-Item -ItemType Directory -Force $bin, $wbin | Out-Null

function Fetch($url, $dest) {
  Write-Host "  downloading $url"
  Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
  Write-Host ("  -> {0} ({1:N1} MB)" -f $dest, ((Get-Item $dest).Length / 1MB))
}

# ffmpeg + ffprobe: the gyan.dev "essentials" build, the standard Windows distribution linked from ffmpeg.org.
if (-not (Test-Path (Join-Path $bin "ffmpeg.exe"))) {
  Write-Host "ffmpeg"
  $zip = Join-Path $env:TEMP "ffmpeg-essentials.zip"
  Fetch "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip" $zip
  $x = Join-Path $env:TEMP "ffmpeg-x"; Remove-Item -Recurse -Force $x -ErrorAction SilentlyContinue
  Expand-Archive -Force $zip $x
  Get-ChildItem $x -Recurse -Include ffmpeg.exe, ffprobe.exe | Copy-Item -Destination $bin
  Remove-Item -Recurse -Force $x, $zip
} else { Write-Host "ffmpeg: already present" }

# yt-dlp: the standalone Windows build from the project's own GitHub releases — no Python needed.
if (-not (Test-Path (Join-Path $bin "yt-dlp.exe"))) {
  Write-Host "yt-dlp"
  Fetch "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe" (Join-Path $bin "yt-dlp.exe")
} else { Write-Host "yt-dlp: already present" }

# whisper.cpp: the official x64 build (it picks the fastest CPU code path at run time), and the multilingual base
# model. Base is the right size here: a PC has the memory a 512 MB server does not, and it is ~8x faster than real time.
if (-not (Test-Path (Join-Path $wbin "whisper-cli.exe"))) {
  Write-Host "whisper.cpp"
  $zip = Join-Path $env:TEMP "whisper-bin-x64.zip"
  Fetch "https://github.com/ggml-org/whisper.cpp/releases/download/b5130/whisper-bin-x64.zip" $zip
  $x = Join-Path $env:TEMP "whisper-x"; Remove-Item -Recurse -Force $x -ErrorAction SilentlyContinue
  Expand-Archive -Force $zip $x
  $rel = Get-ChildItem $x -Recurse -Filter whisper-cli.exe | Select-Object -First 1
  Copy-Item (Join-Path $rel.DirectoryName "*") -Destination $wbin -Recurse
  Remove-Item -Recurse -Force $x, $zip
} else { Write-Host "whisper.cpp: already present" }
if (-not (Test-Path (Join-Path $wdir "ggml-base.bin"))) {
  Write-Host "whisper model"
  Fetch "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin" (Join-Path $wdir "ggml-base.bin")
} else { Write-Host "whisper model: already present" }

# edge-tts: free neural voices, Bangla included. A venv of its own in .tools\edge, so nothing goes into your system
# Python. Needs Python installed (python.org); everything else here does not.
$edge = Join-Path $tools "edge"
if (-not (Test-Path (Join-Path $edge "Scripts\edge-tts.exe"))) {
  Write-Host "edge-tts"
  python -m venv $edge
  & (Join-Path $edge "Scripts\python.exe") -m pip install --quiet --disable-pip-version-check edge-tts
} else { Write-Host "edge-tts: already present" }

Write-Host ""
Write-Host "Checking the tools run:"
# Judged by exit code. These programs print banners on stderr, and Windows PowerShell turns any stderr line into an
# error under "Stop" — which would report a working tool as broken.
$ErrorActionPreference = "Continue"
$bad = @()
foreach ($t in @(@((Join-Path $bin "ffmpeg.exe"), "-version"), @((Join-Path $bin "yt-dlp.exe"), "--version"), @((Join-Path $wbin "whisper-cli.exe"), "--help"), @((Join-Path $edge "Scripts\edge-tts.exe"), "--version"))) {
  $null = & $t[0] $t[1] 2>$null
  if ($LASTEXITCODE -eq 0) { Write-Host "  ok   $(Split-Path $t[0] -Leaf)" } else { Write-Host "  FAIL $(Split-Path $t[0] -Leaf) (exit $LASTEXITCODE)"; $bad += $t[0] }
}
if ($bad.Count) { Write-Error "Some tools did not run - see above."; exit 1 }
Write-Host ""
if (Test-Path (Join-Path $root ".env.pc")) { Write-Host "Ready. Start the worker with:  pc\start.ps1" }
else { Write-Host "Tools ready. Next: copy .env.pc.example to .env.pc and fill it in from Render's Environment tab, then run pc\start.ps1" }

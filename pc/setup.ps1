# Prepares this PC to be a video worker: ffmpeg, yt-dlp, deno, cloudflared, whisper.cpp and edge-tts in the project's
# own .tools folder, nothing installed system-wide. Safe to run again — anything already present is left alone. Every download is printed with
# where it comes from before it starts.
# -Blender also installs Blender (about 350 MB), for 3D explainers (blueprint 6d). Optional: nothing else needs it.
param([switch]$Blender)
$ErrorActionPreference = "Stop"
$root  = Split-Path $PSScriptRoot -Parent
$tools = Join-Path $root ".tools"
$bin   = Join-Path $tools "bin"
$wdir  = Join-Path $tools "whisper"
$wbin  = Join-Path $wdir "bin"
New-Item -ItemType Directory -Force $bin, $wbin | Out-Null

# Two things this script cannot install for you, checked first so a new PC fails here with a clear message instead of
# later with a cryptic one: Node.js runs the engine itself (20 or newer), Python runs the free voices (edge-tts).
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Error "Node.js is not installed. Install the LTS version from https://nodejs.org, then run this again."; exit 1 }
$nodeMajor = [int]((& node -v).TrimStart("v").Split(".")[0])
if ($nodeMajor -lt 20) { Write-Error "Node.js $(& node -v) is too old. Install version 20 or newer from https://nodejs.org, then run this again."; exit 1 }
$pyOk = $false; try { $null = & python --version 2>$null; $pyOk = ($LASTEXITCODE -eq 0) } catch {}
if (-not $pyOk) { Write-Error "Python is not installed (the free voices need it). Install it from https://python.org with 'Add python.exe to PATH' ticked, then run this again."; exit 1 }

# The engine's own packages, and the video studio's (animated explainers and reels) with the browser it renders in.
# A fresh copy of the project has none of these; this PC had them only because they were installed by hand.
if (-not (Test-Path (Join-Path $root "node_modules\pg"))) {
  Write-Host "engine packages (npm ci)"
  Push-Location $root; npm ci --omit=dev --no-audit --no-fund; $rc = $LASTEXITCODE; Pop-Location
  if ($rc) { Write-Error "Installing the engine's packages failed (npm ci)."; exit 1 }
} else { Write-Host "engine packages: already present" }
$studio = Join-Path $root "studio"
if (-not (Test-Path (Join-Path $studio "node_modules\@remotion\renderer"))) {
  Write-Host "video studio packages (npm ci)"
  Push-Location $studio; npm ci --no-audit --no-fund; $rc = $LASTEXITCODE; Pop-Location
  if ($rc) { Write-Error "Installing the video studio's packages failed (npm ci)."; exit 1 }
} else { Write-Host "video studio packages: already present" }
Write-Host "video studio browser"
Push-Location $studio; npx --no-install remotion browser ensure; if ($LASTEXITCODE) { Write-Host "  (the studio fetches its browser on the first render instead)" }; Pop-Location

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

# deno: the JavaScript runtime yt-dlp now uses to read YouTube's pages. Without one, yt-dlp warns that YouTube
# extraction "has been deprecated, and some formats may be missing" -- and YouTube is the one site this PC is the
# worker for. yt-dlp looks for deno on PATH by itself; start.ps1 puts the tools folder's bin there. Official GitHub release.
if (-not (Test-Path (Join-Path $bin "deno.exe"))) {
  Write-Host "deno"
  $zip = Join-Path $env:TEMP "deno-windows.zip"
  Fetch "https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip" $zip
  Expand-Archive -Force $zip $bin
  Remove-Item -Force $zip
} else { Write-Host "deno: already present" }

# cloudflared: when files are kept on this PC (Settings -> storage), the worker opens a free Cloudflare quick tunnel so the
# dashboard on your phone and the publishers can fetch them. No account needed. Cloudflare's own signed GitHub release.
if (-not (Test-Path (Join-Path $bin "cloudflared.exe"))) {
  Write-Host "cloudflared"
  Fetch "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" (Join-Path $bin "cloudflared.exe")
} else { Write-Host "cloudflared: already present" }

# Blender (only with -Blender): the portable Windows build of the 4.2 LTS release from blender.org, into
# .tools\blender, where the worker finds it. Renders 3D explainers on the CPU; nothing else uses it.
if ($Blender) {
  $bdir = Join-Path $tools "blender"
  if (-not (Test-Path (Join-Path $bdir "blender.exe"))) {
    Write-Host "blender"
    $zip = Join-Path $env:TEMP "blender-windows.zip"
    Fetch "https://download.blender.org/release/Blender4.2/blender-4.2.3-windows-x64.zip" $zip
    $x = Join-Path $env:TEMP "blender-x"; Remove-Item -Recurse -Force $x -ErrorAction SilentlyContinue
    Expand-Archive -Force $zip $x
    $exe = Get-ChildItem $x -Recurse -Filter blender.exe | Select-Object -First 1
    New-Item -ItemType Directory -Force $bdir | Out-Null
    Copy-Item (Join-Path $exe.DirectoryName "*") -Destination $bdir -Recurse
    Remove-Item -Recurse -Force $x, $zip
  } else { Write-Host "blender: already present" }
}

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
foreach ($t in @(@((Join-Path $bin "ffmpeg.exe"), "-version"), @((Join-Path $bin "yt-dlp.exe"), "--version"), @((Join-Path $bin "deno.exe"), "--version"), @((Join-Path $bin "cloudflared.exe"), "--version"), @((Join-Path $wbin "whisper-cli.exe"), "--help"), @((Join-Path $edge "Scripts\edge-tts.exe"), "--version"))) {
  $null = & $t[0] $t[1] 2>$null
  if ($LASTEXITCODE -eq 0) { Write-Host "  ok   $(Split-Path $t[0] -Leaf)" } else { Write-Host "  FAIL $(Split-Path $t[0] -Leaf) (exit $LASTEXITCODE)"; $bad += $t[0] }
}
if ($bad.Count) { Write-Error "Some tools did not run - see above."; exit 1 }
Write-Host ""
if (Test-Path (Join-Path $root ".env.pc")) { Write-Host "Ready. Start the worker with:  pc\start.ps1" }
else { Write-Host "Tools ready. Next: copy .env.pc.example to .env.pc and fill it in from Render's Environment tab, then run pc\start.ps1" }

# Starts this PC as a worker. It claims only work the server routes to the PC lane: programmes set to "My PC", and,
# while files are kept on this PC (Settings -> storage.on_pc), every job that makes or sends a file -- news cards,
# reels, clips, explainers, publishing. It reads no feeds and runs none of the server's sweeps; the server keeps doing
# those. While files are kept here it writes them to data\media (MEDIA_DIR), cleans up its own, and opens a Cloudflare
# quick tunnel (cloudflared from .tools\bin, installed by setup.ps1) so they can be fetched. Stop it with Ctrl+C:
# running jobs are handed back to the queue rather than left locked.
$ErrorActionPreference = "Stop"
$root  = Split-Path $PSScriptRoot -Parent
$tools = Join-Path $root ".tools"
$envFile = Join-Path $root ".env.pc"
if (-not (Test-Path (Join-Path $tools "bin\ffmpeg.exe"))) { Write-Error "Tools are missing. Run pc\setup.ps1 first."; exit 1 }
if (-not (Test-Path $envFile)) { Write-Error "Missing .env.pc. Copy .env.pc.example to .env.pc and fill it in from Render's Environment tab."; exit 1 }

$env:PATH = "$tools\bin;$tools\whisper\bin;$tools\edge\Scripts;$env:PATH"
$env:WHISPER_DIR = Join-Path $tools "whisper"
# Set here rather than read from the file, so a stray line in .env.pc can never turn this into a second server.
$env:LANES = "video_local"
$env:RUN_SWEEPS = "false"
if (-not $env:PORT) { $env:PORT = "4100" }

Set-Location $root
Write-Host "PC worker starting - claims only work routed to this PC. Ctrl+C to stop."
node --env-file="$envFile" server.js

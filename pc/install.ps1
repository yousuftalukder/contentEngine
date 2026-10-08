# Sets this PC up as the Content Engine's video worker, from the one command made on the dashboard (Set up a PC).
# The server sends this file with the values at the top filled in: its own address, a one-time setup token and the
# options ticked on the dashboard. Run straight from the repository it only says that, and does nothing.
#
# What it does, in order:
#   1. Checks that Node.js 20+ and Python are installed, and stops with a link if one is missing. This comes before the
#      token is used, so a missing install does not spend the command: paste it again once it is installed.
#   2. Gets the engine: a git pull if the folder is a git checkout, otherwise GitHub's zip of main copied over the
#      folder. Nothing already there is deleted: data\media (the files this PC keeps), .env.pc, .tools and node_modules stay.
#   3. Asks the server for this PC's settings with the token. That request uses the token up, so the command works
#      once. The settings go into .env.pc and are never printed.
#   4. Runs pc\setup.ps1 (the tools), pc\autostart.ps1 if chosen, and starts pc\start.ps1 in a minimised window.
# Nothing here needs administrator rights, and this file itself holds no secrets: only the address and the token.

$CeServer    = '__CE_SERVER__'
$CeToken     = '__CE_TOKEN__'
$CeBlender   = '__CE_BLENDER__' -eq '1'
$CeAutostart = '__CE_AUTOSTART__' -eq '1'
$CeTakeover  = '__CE_TAKEOVER__' -eq '1'
$CeRepo      = 'yousuftalukder/contentEngine'

function Install-ContentEngine {
  $ErrorActionPreference = 'Stop'
  # Windows PowerShell's progress bar makes a download many times slower than the connection.
  $ProgressPreference = 'SilentlyContinue'
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  function Stop-With($m) { Write-Host ''; Write-Host $m -ForegroundColor Red; Write-Host '' }

  if ($CeServer -notmatch '^https?://') { Stop-With 'This script is run by the command made on the dashboard (Set up a PC), which fills in the server address and a one-time token. Make one there.'; return }

  Write-Host 'Content Engine: setting this PC up as the video worker'
  Write-Host "  server: $CeServer"

  # A Node.js or Python installed a minute ago is not on this window's PATH yet. Read it fresh, so pasting the command
  # again right after installing works without opening a new window.
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') + ';' + $env:Path

  # The two things this cannot install for you, checked first.
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Stop-With 'Node.js is not installed. Install the LTS version from https://nodejs.org (the default options are fine), then paste the same command again. It works for 30 minutes.'; return }
  $nodeMajor = 0; try { $nodeMajor = [int]((& node -v).TrimStart('v').Split('.')[0]) } catch {}
  if ($nodeMajor -lt 20) { Stop-With 'Node.js is too old: version 20 or newer is needed. Install the LTS version from https://nodejs.org, then paste the same command again.'; return }
  $pyOk = $false; try { $null = & python --version 2>$null; $pyOk = ($LASTEXITCODE -eq 0) } catch {}
  if (-not $pyOk) { Stop-With "Python is not installed (the free voices need it). Install it from https://www.python.org/downloads/ and tick 'Add python.exe to PATH' on its first screen, then paste the same command again."; return }
  Write-Host "  Node.js $(& node -v) and Python: found"

  # Where the engine lives: this folder if it already is one, otherwise ContentEngine in your user folder.
  $here = (Get-Location).Path
  if ((Test-Path (Join-Path $here 'server.js')) -and (Test-Path (Join-Path $here 'pc\start.ps1'))) { $dir = $here } else { $dir = Join-Path $env:USERPROFILE 'ContentEngine' }
  New-Item -ItemType Directory -Force $dir | Out-Null
  Write-Host "  folder: $dir"
  $envFile = Join-Path $dir '.env.pc'
  # A worker already running from this folder is updated, not started a second time.
  $needle = $envFile.ToLower()
  $running = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($needle) })

  Write-Host ''
  Write-Host '1/4  Getting the engine'
  if ((Test-Path (Join-Path $dir '.git')) -and (Get-Command git -ErrorAction SilentlyContinue)) {
    Push-Location $dir; & git pull --ff-only; $rc = $LASTEXITCODE; Pop-Location
    if ($rc) { Stop-With 'git pull failed in this folder (see above). Sort it out, or delete the .git folder to use the zip instead, then paste the command again.'; return }
    # The engine reads its version from git now; a .commit left by an earlier zip install would be out of date.
    Remove-Item (Join-Path $dir '.commit') -Force -ErrorAction SilentlyContinue
  } else {
    # The exact commit main is at, and that commit's zip: the engine reports it (.commit) so the dashboard can say when
    # this PC runs another version than the server. Without the answer, main's zip, and no version to report.
    $sha = $null
    try { $sha = [string](Invoke-RestMethod -Uri "https://api.github.com/repos/$CeRepo/commits/main" -Headers @{ Accept = 'application/vnd.github.sha' } -UseBasicParsing) } catch {}
    if ($sha -notmatch '^[0-9a-f]{40}$') { $sha = $null }
    $CeZip = if ($sha) { "https://codeload.github.com/$CeRepo/zip/$sha" } else { "https://codeload.github.com/$CeRepo/zip/refs/heads/main" }
    $zip = Join-Path $env:TEMP 'contentengine-main.zip'
    $x = Join-Path $env:TEMP 'contentengine-main-x'
    Write-Host "  downloading $CeZip"
    Invoke-WebRequest -Uri $CeZip -OutFile $zip -UseBasicParsing
    Remove-Item -Recurse -Force $x -ErrorAction SilentlyContinue
    Expand-Archive -Force $zip $x
    $src = Get-ChildItem $x -Directory | Select-Object -First 1
    if (-not $src -or -not (Test-Path (Join-Path $src.FullName 'server.js'))) { Stop-With 'The download from GitHub did not contain the engine. Try again in a minute.'; return }
    # Copied over the folder, never mirrored: what is here and not in the zip stays (data\media, .env.pc, .tools, node_modules).
    $null = & robocopy $src.FullName $dir /E /NFL /NDL /NJH /NJS /NP
    $rc = $LASTEXITCODE
    Remove-Item -Recurse -Force $x, $zip -ErrorAction SilentlyContinue
    if ($rc -ge 8) { Stop-With "Copying the engine into $dir failed (robocopy exit $rc)."; return }
    if ($sha) { [IO.File]::WriteAllText((Join-Path $dir '.commit'), $sha) } else { Remove-Item (Join-Path $dir '.commit') -Force -ErrorAction SilentlyContinue }
  }
  Get-ChildItem (Join-Path $dir 'pc') -Filter *.ps1 | Unblock-File

  Write-Host ''
  Write-Host '2/4  Connecting this PC to the server'
  $conf = $null
  try { $conf = Invoke-RestMethod -Method Post -Uri ($CeServer + '/api/public/pc/config') -Headers @{ 'X-Setup-Token' = $CeToken } -UseBasicParsing }
  catch {
    $why = $_.Exception.Message
    if ((Test-Path $envFile) -and (Select-String -Path $envFile -Pattern '^\s*DATABASE_URL\s*=\s*\S' -Quiet)) { Write-Host "  The server did not send new settings ($why); keeping this PC's .env.pc as it is." }
    else { Stop-With "The server did not send this PC its settings: $why. A setup command works once and for 30 minutes: make a new one on the dashboard (Set up a PC)."; return }
  }
  if ($conf) {
    # Merged into .env.pc line by line: the server's values replace the same names, anything else already in the file
    # (an optional key, MEDIA_DIR) stays. Written without a byte-order mark, which Node would read as part of the first name.
    $new = @{}; $order = @()
    foreach ($line in ([string]$conf -split '\r?\n')) { if ($line -match '^([A-Z0-9_]+)=') { $new[$Matches[1]] = $line; $order += $Matches[1] } }
    if (-not $new.ContainsKey('DATABASE_URL')) { Stop-With 'The server answered without a database address. Make a new command on the dashboard and try again.'; return }
    $keep = @()
    if (Test-Path $envFile) { foreach ($line in (Get-Content $envFile)) { if (($line -match '^\s*([A-Za-z0-9_]+)\s*=') -and $new.ContainsKey($Matches[1])) { continue }; $keep += $line } }
    else { $keep = @('# Written by the setup command from the dashboard (Set up a PC). It holds the database password and the vault key:', '# keep it private and never paste it into a chat. Optional extras are described in .env.pc.example.') }
    $text = (($keep + @($order | ForEach-Object { $new[$_] })) -join [Environment]::NewLine) + [Environment]::NewLine
    [IO.File]::WriteAllText($envFile, $text, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "  settings written to $envFile ($($order.Count) values, not shown)"
  }

  Write-Host ''
  Write-Host '3/4  Installing the tools (pc\setup.ps1). The first time this takes several minutes.'
  $setupArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $dir 'pc\setup.ps1'))
  if ($CeBlender) { $setupArgs += '-Blender' }
  & powershell.exe @setupArgs
  if ($LASTEXITCODE) { Stop-With "Installing the tools failed (see above). This PC is already connected: fix what it says, then in $dir run pc\setup.ps1 again and start the worker with pc\start.ps1."; return }
  if ($CeAutostart) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $dir 'pc\autostart.ps1')
    if ($LASTEXITCODE) { Write-Host '  (the sign-in task could not be added; the worker still starts now)' }
  }

  Write-Host ''
  Write-Host '4/4  Starting the worker'
  if ($running.Count) { Write-Host '  A worker is already running from this folder. Close its window (or press Ctrl+C in it) and start it again with pc\start.ps1 to run the update.' }
  else {
    # PC_TAKEOVER=1 only for this first start, and only when this PC replaces another: the guard in the engine refuses a
    # second PC while another one keeps the files, unless told the move is deliberate.
    if ($CeTakeover) { $env:PC_TAKEOVER = '1' }
    Start-Process powershell.exe -WorkingDirectory $dir -WindowStyle Minimized -ArgumentList @('-NoExit', '-ExecutionPolicy', 'Bypass', '-File', ('"' + (Join-Path $dir 'pc\start.ps1') + '"'))
    Remove-Item Env:PC_TAKEOVER -ErrorAction SilentlyContinue
    Write-Host '  started in a minimised PowerShell window (it is the worker: leave it open)'
  }
  Write-Host ''
  Write-Host 'Done - watch the dashboard (Set up a PC): it shows this PC online within a minute.' -ForegroundColor Green
}

try { Install-ContentEngine } catch { Write-Host ''; Write-Host ('Setup stopped: ' + $_.Exception.Message) -ForegroundColor Red; Write-Host 'Nothing is lost: paste the command again, or make a new one on the dashboard if it was already used.' }

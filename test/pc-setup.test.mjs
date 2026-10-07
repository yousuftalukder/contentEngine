import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { parseEnv } from "node:util";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startEngine } from "./harness.mjs";

// "Set up a PC" from the dashboard: one command, made by an authenticated request, that a new PC pastes into PowerShell.
// The installer it fetches holds no secrets and does not use the token up; the one call that hands over the database
// connection and the vault key deletes the token as it answers. Only the token's hash is ever stored.
// The installer itself is not run here: it installs software and starts a worker.
const SECRET = "test secrets#key";                                    // a space and a # — must come back quoted in .env.pc
const sha = (s) => createHash("sha256").update(s).digest("hex");
const tokenOf = (command) => /install\.ps1\?t=([A-Za-z0-9_-]{32})'/.exec(command)?.[1];
// A raw request, so the Host and X-Forwarded-Proto headers can be set (fetch will not set Host).
const raw = (base, method, path, headers = {}) => new Promise((resolve, reject) => {
  const u = new URL(base + path);
  const req = http.request({ host: u.hostname, port: u.port, method, path: u.pathname + u.search, headers }, (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode, text: d })); });
  req.on("error", reject); req.end();
});

test("a setup command is made once, the installer is served for it, and the PC's settings are handed over exactly once", async () => {
  const s = await startEngine({ env: { SECRETS_KEY: SECRET } });
  try {
    const made = await s.api("POST", "/api/pc/setup-token", { blender: true, autostart: false, takeover: true });
    assert.match(made.command, /^powershell -NoProfile -ExecutionPolicy Bypass -Command "\[Net\.ServicePointManager\]::SecurityProtocol = 'Tls12'; irm 'http:\/\/localhost:\d+\/api\/public\/pc\/install\.ps1\?t=[A-Za-z0-9_-]{32}' \| iex"$/);
    assert.deepEqual(made.options, { blender: true, autostart: false, takeover: true });
    const token = tokenOf(made.command);
    assert.ok(new Date(made.expires_at) - Date.now() > 25 * 60000, "valid for about 30 minutes");

    // Only the hash is stored: no row anywhere in settings holds the token itself, and the record is not a setting.
    const rows = await s.query(`SELECT key, value::text AS v FROM settings WHERE key LIKE 'pc.setup%'`);
    assert.deepEqual(rows.filter((r) => r.key.startsWith("pc.setup.")).map((r) => r.key), [`pc.setup.${sha(token)}`]);
    assert.equal((await s.query(`SELECT count(*)::int AS n FROM settings WHERE key LIKE $1 OR value::text LIKE $1`, [`%${token}%`]))[0].n, 0, "the token's plaintext is stored nowhere");
    assert.ok(!Object.keys(await s.api("GET", "/api/settings")).some((k) => k.startsWith("pc.setup")), "setup records are not shown as settings");

    // The installer: filled in, no secrets, and fetching it twice is fine (a PC missing Node.js pastes the command again).
    const res = await fetch(`${s.base}/api/public/pc/install.ps1?t=${token}`);
    assert.equal(res.status, 200);
    const script = await res.text();
    assert.match(script, new RegExp(`\\$CeToken\\s+= '${token}'`));
    assert.match(script, /\$CeServer\s+= 'http:\/\/localhost:\d+'/);
    assert.match(script, /\$CeBlender\s+= '1' -eq '1'/);
    assert.match(script, /\$CeAutostart = '0' -eq '1'/);
    assert.match(script, /\$CeTakeover\s+= '1' -eq '1'/);
    assert.doesNotMatch(script, /__CE_[A-Z]+__/, "every placeholder is filled");
    assert.ok(!script.includes(s.databaseUrl) && !script.includes(SECRET), "the installer holds no secrets");
    assert.equal((await fetch(`${s.base}/api/public/pc/install.ps1?t=${token}`)).status, 200, "fetching the installer does not use the token up");
    // On Windows, check the served script is valid PowerShell (CI runs on Linux, where there is no powershell.exe).
    if (process.platform === "win32") {
      const dir = mkdtempSync(join(tmpdir(), "ce-ps-")), file = join(dir, "install.ps1"); writeFileSync(file, script);
      const r = spawnSync("powershell.exe", ["-NoProfile", "-Command", `$e = $null; $null = [System.Management.Automation.PSParser]::Tokenize((Get-Content -Raw -LiteralPath '${file}'), [ref]$e); if ($e.Count) { $e | ForEach-Object { $_.Message }; exit 1 }`], { encoding: "utf8", timeout: 60000 });
      rmSync(dir, { recursive: true, force: true });
      assert.equal(r.status, 0, `the served installer parses as PowerShell: ${r.stdout}${r.stderr}`);
    }

    // Unknown or missing tokens: the same plain 410.
    for (const path of ["/api/public/pc/install.ps1?t=" + "A".repeat(32), "/api/public/pc/install.ps1", "/api/public/pc/install.ps1?t=short"]) {
      const r = await fetch(s.base + path);
      assert.equal(r.status, 410, path);
      assert.match(await r.text(), /already used or has expired/);
    }

    // The settings: DATABASE_URL and SECRETS_KEY, nothing else (no AI keys, no Supabase when it is not set), readable by Node.
    const conf = await fetch(`${s.base}/api/public/pc/config`, { method: "POST", headers: { "X-Setup-Token": token } });
    assert.equal(conf.status, 200);
    const text = await conf.text();
    assert.deepEqual(parseEnv(text), { DATABASE_URL: s.databaseUrl, SECRETS_KEY: SECRET });
    assert.match(text, /^SECRETS_KEY='test secrets#key'$/m, "a value with a space or # is quoted");

    // Used up: the second call, and the installer, both get 410; the token's record is gone.
    const again = await fetch(`${s.base}/api/public/pc/config`, { method: "POST", headers: { "X-Setup-Token": token } });
    assert.equal(again.status, 410);
    assert.doesNotMatch(await again.text(), /DATABASE_URL|postgres/);
    assert.equal((await fetch(`${s.base}/api/public/pc/install.ps1?t=${token}`)).status, 410);
    assert.equal((await s.query(`SELECT count(*)::int AS n FROM settings WHERE key = $1`, [`pc.setup.${sha(token)}`]))[0].n, 0);

    // The dashboard sees it was used, and a notice says so; the token never reaches the log.
    const st = await s.api("GET", "/api/pc/setup-status");
    assert.ok(st.setup.used_at, "the status records the use");
    assert.equal(st.pc.online, false);
    assert.equal((await s.query(`SELECT count(*)::int AS n FROM notifications WHERE kind = 'pc'`))[0].n, 1);
    assert.ok(!s.logs().includes(token), "the token is not logged");
    assert.match(s.logs(), /pc setup: a PC at .* was sent its settings \(DATABASE_URL, SECRETS_KEY\)/);
  } finally { await s.stop(); }
});

test("an expired setup command is refused, and nothing is handed over in plain http to another host", async () => {
  const s = await startEngine({ env: { SECRETS_KEY: SECRET } });
  try {
    const token = tokenOf((await s.api("POST", "/api/pc/setup-token", {})).command);
    // Defaults: Blender off, start at sign-in on, not a takeover.
    assert.match(await (await fetch(`${s.base}/api/public/pc/install.ps1?t=${token}`)).text(), /\$CeAutostart = '1' -eq '1'/);

    // Plain http from a non-local host is refused before the token is even looked at; behind TLS (as on Render) it is not.
    const http1 = await raw(s.base, "POST", `/api/public/pc/config?t=${token}`, { Host: "engine.example.com" });
    assert.equal(http1.status, 403);
    assert.match(http1.text, /only over https/);
    assert.equal((await s.query(`SELECT count(*)::int AS n FROM settings WHERE key = $1`, [`pc.setup.${sha(token)}`]))[0].n, 1, "a refused call does not use the token up");
    assert.equal((await raw(s.base, "GET", `/api/public/pc/install.ps1?t=${token}`, { Host: "engine.example.com", "X-Forwarded-Proto": "https" })).status, 200);

    // Thirty minutes later.
    await s.query(`UPDATE settings SET value = jsonb_set(value, '{expires_at}', to_jsonb(now() - interval '1 minute')) WHERE key = $1`, [`pc.setup.${sha(token)}`]);
    const r = await fetch(`${s.base}/api/public/pc/install.ps1?t=${token}`);
    assert.equal(r.status, 410);
    assert.match(await r.text(), /already used or has expired/);
    const c = await fetch(`${s.base}/api/public/pc/config?t=${token}`, { method: "POST" });
    assert.equal(c.status, 410);
    assert.doesNotMatch(await c.text(), /postgres/);

    // Making the next command clears expired ones nobody used.
    const unused = tokenOf((await s.api("POST", "/api/pc/setup-token", {})).command);
    await s.query(`UPDATE settings SET value = jsonb_set(value, '{expires_at}', to_jsonb(now() - interval '1 minute')) WHERE key = $1`, [`pc.setup.${sha(unused)}`]);
    const fresh = tokenOf((await s.api("POST", "/api/pc/setup-token", {})).command);
    assert.deepEqual((await s.query(`SELECT key FROM settings WHERE key LIKE 'pc.setup.%'`)).map((r) => r.key), [`pc.setup.${sha(fresh)}`]);
  } finally { await s.stop(); }
});

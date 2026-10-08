import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startEngine, waitFor, sleep } from "./harness.mjs";

// A quick tunnel can lose its address while cloudflared keeps running (2026-10-08: the address stopped existing in DNS,
// cloudflared never exited, every file link failed while the PC showed as on). The PC asks itself through its public
// address; a tunnel that no longer reaches it is replaced, one that does is left alone.
const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-cloudflared.mjs");
const starts = (log) => { try { return readFileSync(log, "utf8").split("\n").filter(Boolean).length; } catch { return 0; } };

test("a tunnel whose address no longer reaches the PC is replaced, and a healthy one is left alone", async () => {
  const server = await startEngine();
  let pc;
  try {
    await server.api("PUT", "/api/settings/ingest.enabled", { value: false });
    await server.api("PUT", "/api/settings/storage.on_pc", { value: true });
    const pcEnv = (log, extra = {}) => ({ DATABASE_URL: server.databaseUrl, LANES: "video_local", RUN_SWEEPS: "false", CLOUDFLARED_BIN: FAKE, FAKE_CF_LOG: log, PC_TUNNEL_POLL_MS: "400", ...extra });

    // The fake's address (fake-tunnel-1.trycloudflare.com) exists nowhere: the checks miss, and the tunnel is replaced.
    const dead = join(mkdtempSync(join(tmpdir(), "ce-cf-")), "starts.log");
    pc = await startEngine({ env: pcEnv(dead) });
    await waitFor(async () => starts(dead) >= 2, { timeout: 60000, interval: 300, what: "the dead tunnel replaced" });
    const [row] = await waitFor(async () => { const r = await server.query(`SELECT value FROM settings WHERE key = 'pc.tunnel'`); return r.length && /fake-tunnel-[2-9]/.test(JSON.stringify(r[0].value)) && r; }, { timeout: 20000, what: "the new address recorded" });
    assert.match(JSON.stringify(row.value), /fake-tunnel-[2-9]\.trycloudflare\.com/, "the new tunnel's address is the one links follow");
    assert.match(String(pc.logs()), /no longer reaches this PC/, "and the replacement is logged");
    await pc.stop(); pc = null;

    // Checked through an address that does reach the PC (itself): many checks later, still the first tunnel.
    const live = join(mkdtempSync(join(tmpdir(), "ce-cf-")), "starts.log");
    pc = await startEngine({ env: pcEnv(live, { PC_TUNNEL_CHECK_URL: "self" }) });
    await waitFor(async () => starts(live) >= 1, { what: "the tunnel started" });
    await sleep(6000);
    assert.equal(starts(live), 1, "a tunnel that answers is never replaced");
    const check = await fetch(`${pc.base}/media/.tunnel-check`);
    assert.equal(check.status, 200);
    assert.match(await check.text(), /^[0-9a-f]{24}$/, "the check answers with this run's own token, nothing else");
  } finally { await pc?.stop(); await server.stop(); }
});

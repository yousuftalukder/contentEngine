import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startEngine, waitFor } from "./harness.mjs";

// The PC keeps its files in the folder chosen on the dashboard (Settings → Media storage → Your PC → folder), and when
// that changes it moves the files there itself as it starts, before taking a job — nothing Review shows goes missing.
test("the PC keeps its files in the folder chosen on the dashboard, and moves them there when it changes", async () => {
  const server = await startEngine();
  const base = mkdtempSync(join(tmpdir(), "ce-pcdir-")), oldDir = join(base, "old"), newDir = join(base, "chosen", "media");
  mkdirSync(join(oldDir, "image"), { recursive: true }); writeFileSync(join(oldDir, "image", "a.png"), "picture");
  let pc;
  try {
    await server.api("PUT", "/api/settings/ingest.enabled", { value: false });
    await server.api("PUT", "/api/settings/storage.on_pc", { value: true });
    await server.api("PUT", "/api/settings/storage.pc_dir", { value: newDir });
    pc = await startEngine({ env: { DATABASE_URL: server.databaseUrl, LANES: "video_local", RUN_SWEEPS: "false", PC_TUNNEL: "off", MEDIA_DIR: oldDir, PC_DIR_POLL_MS: "500" } });
    const beat = await waitFor(async () => { const [r] = await server.query(`SELECT value FROM settings WHERE key = 'worker.pc'`); const v = typeof r?.value === "string" ? JSON.parse(r.value) : r?.value; return v?.media?.dir && v; }, { what: "the PC's heartbeat" });
    assert.equal(beat.media.dir.toLowerCase(), newDir.toLowerCase(), "the PC reports the chosen folder");
    assert.equal(readFileSync(join(newDir, "image", "a.png"), "utf8"), "picture", "the old folder's files were moved there");
    assert.ok(!existsSync(join(oldDir, "image", "a.png")), "and are no longer in the old one");
    const got = await fetch(`${pc.base}/media/image/a.png`);
    assert.equal(got.status, 200, "and the PC serves from the new folder");
    assert.equal(await got.text(), "picture");

    // Changed again while the worker runs: picked up within the poll, the files moved on, served from there.
    const thirdDir = join(base, "third");
    await server.api("PUT", "/api/settings/storage.pc_dir", { value: thirdDir });
    await waitFor(async () => { const [r] = await server.query(`SELECT value FROM settings WHERE key = 'worker.pc'`); const v = typeof r?.value === "string" ? JSON.parse(r.value) : r?.value; return v?.media?.dir?.toLowerCase() === thirdDir.toLowerCase(); }, { timeout: 30000, what: "the PC to move to the third folder" });
    assert.equal(readFileSync(join(thirdDir, "image", "a.png"), "utf8"), "picture", "the files moved on with it");
    assert.ok(!existsSync(join(newDir, "image", "a.png")));
    assert.equal((await fetch(`${pc.base}/media/image/a.png`)).status, 200, "and are served from there");
    // Cleared: back to the folder the worker started with.
    await server.api("PUT", "/api/settings/storage.pc_dir", { value: null });
    await waitFor(async () => existsSync(join(oldDir, "image", "a.png")), { timeout: 30000, what: "the files back in the default folder" });
  } finally { await pc?.stop(); await server.stop(); }
});

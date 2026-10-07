import { test } from "node:test";
import assert from "node:assert/strict";
import { startEngine, waitFor } from "./harness.mjs";

// One PC keeps the files. While it is the worker, a worker started on another machine refuses to start — two would
// split the files between them, and the tunnel would follow whichever started last. Moving to a new PC is deliberate:
// PC_TAKEOVER=1. A restart on the same machine is always allowed.
test("while one PC keeps the files, a second PC does not become the worker unless told to take over", async () => {
  const server = await startEngine();
  const pc = (host, extra = {}) => startEngine({ env: { DATABASE_URL: server.databaseUrl, LANES: "video_local", RUN_SWEEPS: "false", PC_TUNNEL: "off", PC_HOSTNAME: host, ...extra } });
  let first, again, taken;
  try {
    await server.api("PUT", "/api/settings/storage.on_pc", { value: true });
    first = await pc("pc-at-home");
    await waitFor(async () => (await server.query(`SELECT value->>'host' AS host FROM settings WHERE key = 'worker.pc'`))[0]?.host === "pc-at-home", { what: "the first PC's heartbeat" });

    await assert.rejects(pc("pc-at-office"), /exited with 1[\s\S]*Another PC \("pc-at-home"\) is the worker/, "a second machine is refused, and told why");

    await first.stop(); first = null;
    again = await pc("pc-at-home");                                    // the same machine restarting: always fine
    await again.stop(); again = null;

    taken = await pc("pc-at-office", { PC_TAKEOVER: "1" });            // a deliberate move
    await waitFor(async () => (await server.query(`SELECT value->>'host' AS host FROM settings WHERE key = 'worker.pc'`))[0]?.host === "pc-at-office", { what: "the new PC's heartbeat" });
  } finally { await first?.stop(); await again?.stop(); await taken?.stop(); await server.stop(); }
});

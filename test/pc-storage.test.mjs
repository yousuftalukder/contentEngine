import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { startEngine, waitFor } from "./harness.mjs";

// Files kept on your PC (storage.on_pc): the server holds none. A draft is made on the PC, its picture written to the
// PC's disk, and the address stored is the server's /pc/ link — which says the PC is off while there is no tunnel, and
// sends the asker on to the PC's tunnel once there is one. Through the tunnel the PC serves its media and nothing else.
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
test("files kept on the PC: made there, linked through the server, served through the tunnel and nothing else", { skip: !hasFfmpeg && "ffmpeg not installed" }, async () => {
  const server = await startEngine();
  let pc;
  try {
    await server.api("PUT", "/api/settings/ingest.enabled", { value: false });
    await server.api("PUT", "/api/settings/storage.on_pc", { value: true });
    const b = await server.api("POST", "/api/brands", { name: "PC files" });
    const p = await server.api("POST", "/api/programs", { brandId: b.id, key: "pc_files", displayName: "PC files", contentType: "NEWS_STATIC", useMocks: true, autoStyle: false, autoSources: false, methodConfig: { qa: { enabled: false } } });
    pc = await startEngine({ env: { DATABASE_URL: server.databaseUrl, LANES: "video_local", RUN_SWEEPS: "false", PC_TUNNEL: "off" } });
    const { id } = await server.api("POST", "/api/generate", { nicheId: p.id, topic: "Ferries resume at Paturia" });
    const it = await waitFor(async () => { const x = await server.api("GET", `/api/content-items/${id}`); if (x.status === "FAILED") throw new Error(x.rejection_note); return x.status === "PENDING_REVIEW" && x; }, { timeout: 90000, what: "the draft" });
    const [job] = await server.query(`SELECT queue FROM jobs WHERE content_item_id = $1 AND type = 'GENERATE_CONTENT'`, [id]);
    assert.equal(job.queue, "video_local", "the draft was made on the PC");
    const url = it.hero_media?.url;
    assert.ok(url?.startsWith(`${server.base.replace("127.0.0.1", "localhost")}/pc/`) || url?.startsWith(`${server.base}/pc/`), `its picture is linked through the server: ${url}`);
    const path = new URL(url).pathname;

    const off = await fetch(`${server.base}${path}`, { redirect: "manual" });
    assert.equal(off.status, 503, "with no tunnel the link says the PC is off");
    await server.query(`INSERT INTO settings (key, value) VALUES ('pc.tunnel', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify({ url: pc.base })]);
    const on = await fetch(`${server.base}${path}`, { redirect: "manual" });
    assert.equal(on.status, 302, "with a tunnel it sends the asker on");
    assert.equal(on.headers.get("location"), `${pc.base}/media/${path.slice(4)}`);
    const file = await fetch(`${server.base}${path}`);
    assert.equal(file.status, 200, "and the file comes from the PC");
    assert.ok((await file.arrayBuffer()).byteLength > 100);

    // An upload reaches the server, which keeps no files: the PC writes it out, and its link serves it.
    const bytes = Buffer.from("a logo, as far as this test is concerned ".repeat(40));
    const up = await (await fetch(`${server.base}/api/uploads?purpose=logo&name=logo.png`, { method: "POST", headers: { "content-type": "image/png" }, body: bytes })).json();
    assert.ok(up.url?.includes("/pc/uploads/logo/"), `the upload is linked to the PC: ${up.url}`);
    const got = await waitFor(async () => { const r = await fetch(`${server.base}${new URL(up.url).pathname}`); return r.status === 200 && Buffer.from(await r.arrayBuffer()); }, { timeout: 30000, what: "the PC to write the upload out" });
    assert.ok(got.equals(bytes), "byte for byte");
    assert.equal((await server.query(`SELECT count(*)::int AS n FROM pending_files`))[0].n, 0, "and the server let its copy go");

    // What the internet can reach through the tunnel: media, nothing else.
    const relayed = { "cf-connecting-ip": "203.0.113.9" };
    assert.equal((await fetch(`${pc.base}/media/${path.slice(4)}`, { headers: relayed })).status, 200);
    assert.equal((await fetch(`${pc.base}/api/programs`, { headers: relayed })).status, 403, "not the PC's API");
    assert.equal((await fetch(`${pc.base}/`, { headers: relayed })).status, 403, "not its dashboard");
    assert.equal((await fetch(`${pc.base}/api/programs`)).status, 200, "while on the PC itself everything still works");
  } finally { await pc?.stop(); await server.stop(); }
});

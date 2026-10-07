import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startEngine, waitFor } from "./harness.mjs";

// Files kept on your PC (storage.on_pc), the paths the first version missed. The server keeps no files, so: a voice or
// picture test answers with the file itself; work queued on a server lane before the switch goes to the PC instead of
// failing there; an upload shows while the PC has not saved it yet, and deleting one deletes it on the PC; a file the
// server needs from the PC makes the job wait while the PC is off (not fail), and is read through the tunnel once it is
// on; a PC whose heartbeat has stopped is "off" even with its tunnel's address still on record; the PC reports how full
// its media folder is; and a post whose picture is on the PC waits for the tunnel instead of failing.
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const setTunnel = (eng, url) => eng.query(`INSERT INTO settings (key, value) VALUES ('pc.tunnel', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [JSON.stringify({ url })]);
const job = async (eng, id) => (await eng.query(`SELECT * FROM jobs WHERE id = $1`, [id]))[0];

test("files kept on the PC: previews, handed-over jobs, uploads, reads from the PC, its disk, and posts all work", { skip: !hasFfmpeg && "ffmpeg not installed", timeout: 400000 }, async () => {
  const server = await startEngine();
  let pc;
  try {
    await server.api("PUT", "/api/settings/ingest.enabled", { value: false });
    await server.api("PUT", "/api/settings/storage.on_pc", { value: true });

    // --- The server alone: the PC has never started.
    // A voice test and a picture adapter's test: answered with the file inline, and nothing recorded for it.
    const voice = await server.api("POST", "/api/voices/test", { adapter: "tts_mock", text: "One two three four five six." });
    assert.match(voice.url, /^data:audio\/mpeg;base64,/, `the voice comes back in the answer: ${String(voice.url).slice(0, 60)}`);
    assert.ok(Buffer.from(voice.url.split(",")[1], "base64").length > 200, "and it is a real file");
    await server.api("POST", "/api/adapter-configs", { key: "img_preview", stage: "IMAGE", impl: "image_mock" });
    const pic = await server.api("POST", "/api/adapter-configs/img_preview/test", {});
    assert.match(pic.url, /^data:image\//, `the picture comes back in the answer: ${String(pic.url).slice(0, 60)}`);
    assert.equal((await server.query(`SELECT count(*)::int AS n FROM media_assets WHERE url LIKE 'data:%'`))[0].n, 0, "no media row carries an inline file");

    // An upload while the PC is off: linked to the PC, and shown from the server meanwhile.
    const mp3 = join(tmpdir(), `pc-gaps-${process.pid}.mp3`);
    spawnSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-q:a", "9", mp3]);
    const bytes = readFileSync(mp3); rmSync(mp3, { force: true });
    const up = await (await fetch(`${server.base}/api/uploads?purpose=other&name=tone.mp3`, { method: "POST", headers: { "content-type": "audio/mpeg" }, body: bytes })).json();
    assert.ok(up.url?.includes("/pc/uploads/other/"), `the upload is linked to the PC: ${up.url}`);
    const upPath = new URL(up.url).pathname;
    const early = await fetch(`${server.base}${upPath}`, { redirect: "manual" });
    assert.equal(early.status, 200, "the upload the PC has not saved yet is served from where it waits");
    assert.ok(Buffer.from(await early.arrayBuffer()).equals(bytes));

    // Work that makes files, queued on a server lane before the switch (here: put there directly): handed to the PC's
    // lane when a server worker picks it up, with no attempt spent — it used to run here and fail the draft for good.
    const stray = "stray-regen-" + Date.now();
    await server.query(`INSERT INTO jobs (id, type, status, payload, queue, priority, max_attempts) VALUES ($1, 'REGENERATE', 'PENDING', $2, 'image', 0, 3)`, [stray, JSON.stringify({ itemId: "no-such-item", part: "image" })]);
    const moved = await waitFor(async () => { const j = await job(server, stray); return j.queue === "video_local" && j.status === "PENDING" && j; }, { timeout: 20000, what: "the stray job to be handed to the PC" });
    assert.equal(moved.attempts, 0, "no attempt spent");
    await server.query(`DELETE FROM jobs WHERE id = $1`, [stray]);

    // Cleanup asked for on the server: the PC's job, since only the PC can reach its files.
    const clean = await server.api("POST", "/api/storage/cleanup");
    assert.equal(clean.onPc, true);
    const [cj] = await server.query(`SELECT id, queue FROM jobs WHERE type = 'CLEAN_STORAGE' AND status = 'PENDING'`);
    assert.equal(cj?.queue, "video_local", "the cleanup is queued for the PC");

    const st = await server.api("GET", "/api/storage");
    assert.equal(st.onPc, true, "the Storage page knows files are on the PC");
    assert.equal(st.pc.tunnel, null, "and that the PC can't be reached");
    assert.equal(st.pc.waiting, 1, "with one upload waiting for it");

    // --- The PC starts.
    pc = await startEngine({ env: { DATABASE_URL: server.databaseUrl, LANES: "video_local", RUN_SWEEPS: "false", PC_TUNNEL: "off" } });
    await waitFor(async () => (await server.query(`SELECT count(*)::int AS n FROM pending_files`))[0].n === 0, { timeout: 30000, what: "the PC to save the upload" });
    await waitFor(async () => (await job(server, cj.id)).status === "SUCCEEDED", { timeout: 30000, what: "the PC to run the cleanup" });
    // It reports how full its media folder is (measured at boot, then every ten minutes), and the Overview and Storage
    // page show it.
    const media = await waitFor(async () => { const s = await server.api("GET", "/api/stats"); return typeof s.pcMedia?.files === "number" && s.pcMedia; }, { timeout: 60000, what: "the PC's media folder size" });
    assert.ok(media.mb >= 0 && typeof media.at === "string" && media.dir, JSON.stringify(media));
    assert.ok(media.free_mb == null || media.free_mb > 0, "with the room left on its disk");
    assert.equal(typeof (await server.api("GET", "/api/storage")).pc.media?.files, "number");

    // A file the server needs from the PC (a soundtrack handed over for transcription) while the PC can't be reached
    // (no tunnel): the job waits without spending an attempt, and says why.
    await server.api("POST", "/api/adapter-configs", { key: "tr_given", stage: "TRANSCRIBE", impl: "transcribe_mock", config: { segments: [{ start: 0, end: 1, text: "A tone, and then the point of it all." }] } });
    const b = await server.api("POST", "/api/brands", { name: "PC gaps" });
    const prog = await server.api("POST", "/api/programs", { brandId: b.id, key: "pc_gaps_clip", displayName: "PC gaps clips", contentType: "PODCAST_CLIP", productionMethod: "PODCAST_HIGHLIGHT", useMocks: true, autoStyle: false, autoSources: false, methodConfig: { qa: { enabled: false } } });
    await server.query(`UPDATE niches SET transcript_adapter = 'tr_given', transcript_adapter_fallbacks = '[]'::jsonb WHERE id = $1`, [prog.id]);
    const cand = "cand-" + Date.now();
    await server.query(`INSERT INTO video_candidates (id, niche_id, source_url, title, status, duration_seconds, transcript) VALUES ($1, $2, 'https://example.org/v', 'A tone', 'QUEUED', 1, $3::jsonb)`, [cand, prog.id, JSON.stringify({ audio_url: up.url })]);
    const pick = "pick-" + Date.now();
    await server.query(`INSERT INTO jobs (id, type, status, payload, queue, priority, max_attempts) VALUES ($1, 'PICK_CLIPS', 'PENDING', $2, 'text', 5, 3)`, [pick, JSON.stringify({ candidateId: cand })]);
    const waiting = await waitFor(async () => { const j = await job(server, pick); return j.status === "PENDING" && j.error_message && j; }, { timeout: 30000, what: "the pick to wait for the PC" });
    assert.match(waiting.error_message, /kept on your PC, which is off/, waiting.error_message);
    assert.equal(waiting.attempts, 0, "no attempt spent while the PC is away");
    assert.ok(new Date(waiting.run_after) > new Date(), "and it comes back later");
    assert.notEqual((await server.query(`SELECT status FROM video_candidates WHERE id = $1`, [cand]))[0].status, "FAILED", "the candidate did not fail");

    // The tunnel comes up: links are sent on to it, and the waiting job reads the file through it.
    await setTunnel(server, pc.base);
    const on = await fetch(`${server.base}${upPath}`, { redirect: "manual" });
    assert.equal(on.status, 302);
    await server.query(`UPDATE jobs SET run_after = now() WHERE id = $1`, [pick]);
    await waitFor(async () => { const [c] = await server.query(`SELECT transcript FROM video_candidates WHERE id = $1`, [cand]); return c.transcript?.segments?.length > 0; }, { timeout: 30000, what: "the server to read the soundtrack from the PC" });

    // A PC switched off at the wall leaves its tunnel's address behind; without its heartbeat it is off all the same.
    // (The table's trigger stamps every update with now(), so it is held off while the heartbeat is aged.)
    await server.query(`ALTER TABLE settings DISABLE TRIGGER trg_settings_updated_at`);
    try {
      await server.query(`UPDATE settings SET updated_at = now() - interval '10 minutes' WHERE key = 'worker.pc'`);
      assert.equal((await fetch(`${server.base}${upPath}`, { redirect: "manual" })).status, 503, "a silent PC is reported off, not sent on to a dead tunnel");
      await server.query(`UPDATE settings SET updated_at = now() WHERE key = 'worker.pc'`);
    } finally { await server.query(`ALTER TABLE settings ENABLE TRIGGER trg_settings_updated_at`); }

    // Deleting an upload deletes the PC's copy.
    await server.api("DELETE", `/api/uploads/${up.id}`);
    const [drop] = await server.query(`SELECT id, queue FROM jobs WHERE type = 'DROP_FILE'`);
    assert.equal(drop?.queue, "video_local", "the PC is asked to delete it");
    await waitFor(async () => (await job(server, drop.id)).status === "SUCCEEDED", { timeout: 30000, what: "the PC to delete the upload" });
    assert.equal((await fetch(`${pc.base}/media/${upPath.slice(4)}`)).status, 404, "and it is gone from the PC");

    // --- A post whose picture is on the PC, while the tunnel is down: it waits, unposted, and goes out once it is up.
    await server.query(`DELETE FROM settings WHERE key = 'pc.tunnel'`);
    const news = await server.api("POST", "/api/programs", { brandId: b.id, key: "pc_gaps_news", displayName: "PC gaps news", contentType: "NEWS_STATIC", useMocks: true, autoStyle: false, autoSources: false, approvalMode: "MANUAL", methodConfig: { qa: { enabled: false } } });
    const fb = await server.api("POST", "/api/channels", { brandId: b.id, key: "fb_gaps", displayName: "FB", platform: "FACEBOOK", format: "STATIC_IMAGE_CAPTION", publisherAdapter: "publish_mock" });
    await server.api("POST", `/api/channels/${fb.id}/niches/${news.id}`);
    const { id } = await server.api("POST", "/api/generate", { nicheId: news.id, topic: "Ferries resume at Paturia" });
    const draft = await waitFor(async () => { const x = await server.api("GET", `/api/content-items/${id}`); if (x.status === "FAILED") throw new Error(x.rejection_note); return x.status === "PENDING_REVIEW" && x; }, { timeout: 120000, what: "the draft" });
    assert.ok(draft.hero_media?.url?.includes("/pc/"), "its picture is on the PC");
    await server.api("POST", `/api/content-items/${id}/approve`, {});
    const held = await waitFor(async () => { const [j] = await server.query(`SELECT * FROM jobs WHERE type = 'PUBLISH_ASSET' AND status = 'PENDING' AND error_message IS NOT NULL`); return j; }, { timeout: 60000, what: "the post to wait for the tunnel" });
    assert.equal(held.queue, "video_local");
    assert.match(held.error_message, /tunnel/, held.error_message);
    const [asset] = await server.query(`SELECT status FROM content_assets WHERE content_item_id = $1`, [id]);
    assert.notEqual(asset.status, "FAILED", "the post is not marked failed while it waits");
    await setTunnel(server, pc.base);
    await server.query(`UPDATE jobs SET run_after = now() WHERE id = $1`, [held.id]);
    await waitFor(async () => (await server.api("GET", `/api/content-items/${id}`)).status === "PUBLISHED", { timeout: 60000, what: "the post to go out" });
  } finally { await pc?.stop(); await server.stop(); }
});

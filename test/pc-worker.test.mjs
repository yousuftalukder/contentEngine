import { test } from "node:test";
import assert from "node:assert/strict";
import { startEngine, waitFor, sleep } from "./harness.mjs";

// Your own computer as a worker: fast, free, and served by YouTube where a datacenter is refused — but on only a few
// hours a day. A programme set to run on the PC must queue its video work for the PC; the server must leave that work
// alone however long it waits; and a PC worker on the same database must pick it up and finish it. Two real engines,
// one database, exactly as it runs: the server on Render, the PC at home.
test("work routed to your PC waits for your PC, and your PC does it", async () => {
  const server = await startEngine();
  let pc;
  try {
    await server.api("PUT", "/api/settings/ingest.enabled", { value: false });
    const brand = await server.api("POST", "/api/brands", { name: "PC brand" });
    await server.api("POST", "/api/adapter-configs", { key: "talk_words", stage: "TRANSCRIBE", impl: "transcribe_mock", label: "Talk",
      config: { segments: [0, 8, 16, 24, 32, 40].map((t) => ({ start: t, end: t + 8, text: `We spent ${t + 3} years learning the one thing nobody tells you about this.` })) } });
    const p = await server.api("POST", "/api/programs", { brandId: brand.id, key: "on_my_pc", displayName: "On my PC",
      contentType: "PODCAST_CLIP", productionMethod: "PODCAST_HIGHLIGHT", useMocks: true, autoStyle: false, autoSources: false,
      computeWhere: "pc", downloadAdapter: "download_mock", transcriptAdapter: "talk_words", clipAdapter: "clip_signal", renderAdapter: "render_mock",
      methodConfig: { clips_per_video: 1, clip_min_seconds: 10, clip_max_seconds: 30, min_score: 0 } });
    assert.equal(p.compute_where, "pc", "the programme remembers where it runs");

    await server.api("POST", "/api/video-candidates", { nicheId: p.id, url: "https://example.invalid/long-talk.mp4", title: "A long talk" });
    const [job] = await server.query(`SELECT queue, status FROM jobs WHERE type = 'PROCESS_CANDIDATE'`);
    assert.equal(job.queue, "video_local", "the work is queued for the PC, not the server");

    // The server is running every lane it normally does. Give it time to make the mistake if it is going to.
    await sleep(3000);
    const [still] = await server.query(`SELECT status FROM jobs WHERE type = 'PROCESS_CANDIDATE'`);
    assert.equal(still.status, "PENDING", "the server leaves PC work alone");
    const before = await server.api("GET", "/api/workers");
    assert.equal(before.pc.online, false, "and the dashboard can say the PC is off");
    assert.equal(before.pc.waiting, 1, "with one job waiting for it");

    // Now the PC comes on: same database, only the PC lane, no sweeps of its own.
    pc = await startEngine({ env: { DATABASE_URL: server.databaseUrl, LANES: "video_local", RUN_SWEEPS: "false" } });
    const item = await waitFor(async () => {
      const [x] = await server.query(`SELECT status, rejection_note FROM content_items WHERE niche_id = $1`, [p.id]);
      if (x?.status === "FAILED") throw new Error(x.rejection_note);
      return x?.status === "PENDING_REVIEW" && x;
    }, { timeout: 120000, interval: 500, what: "the PC to clip it and land it in review" });
    assert.ok(item, "the clip reached review");

    const renders = await server.query(`SELECT queue, status FROM jobs WHERE type = 'RENDER_CLIP'`);
    assert.ok(renders.length && renders.every((r) => r.queue === "video_local"), "the render step was routed to the PC too");
    const after = await server.api("GET", "/api/workers");
    assert.equal(after.pc.online, true, "the dashboard sees the PC is on");
    const serverBoot = await server.query(`SELECT value FROM settings WHERE key = 'boot.last'`);
    assert.ok(serverBoot.length, "the server's own boot record is still there");

    // A PC whose clock runs an hour fast, switched off five minutes ago. Its own timestamp says it beat in the future;
    // only the database's clock knows it has been quiet.
    await pc.stop(); pc = null;
    // Re-inserted rather than updated: a trigger stamps updated_at on every update, which is what keeps it honest.
    await server.query(`DELETE FROM settings WHERE key = 'worker.pc'`);
    await server.query(`INSERT INTO settings (key, value, updated_at) VALUES ('worker.pc', $1::jsonb, now() - interval '5 minutes')`, [JSON.stringify({ at: new Date(Date.now() + 3600e3).toISOString(), worker: "fast-clock" })]);
    const off = await server.api("GET", "/api/workers");
    assert.equal(off.pc.online, false, `a PC with a fast clock is off once it stops beating (seen ${off.pc.seen_seconds_ago}s ago)`);
    assert.ok(off.pc.seen_seconds_ago >= 299, "and how long ago is measured on the database's clock");
  } finally { await pc?.stop(); await server.stop(); }
});

// Your PC transcribes (YouTube serves it) but may have no AI key, while the server has one. The moment is chosen on
// the server from the PC's transcript — the LLM picker, not the free one — and the clip goes back to the PC to cut.
test("a PC without a writer hands the choosing to the server, and the clip comes back to the PC", async () => {
  const http = await import("node:http");
  const gemini = http.createServer((req, res) => { let raw = ""; req.on("data", (d) => (raw += d)); req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    if (!/:generateContent/.test(req.url)) return res.end(JSON.stringify({ models: [] }));
    const picks = [{ start: 8, end: 30, title: "The thing nobody tells you", hook: "", score: 0.9, reason: "chosen by the LLM on the server" }];
    res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(picks) }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10 } }));
  }); });
  await new Promise((r) => gemini.listen(0, "127.0.0.1", r));
  const server = await startEngine({ env: { GEMINI_API_KEY: "server-only-key", GEMINI_API_BASE: `http://127.0.0.1:${gemini.address().port}` } });
  let pc;
  try {
    await server.api("PUT", "/api/settings/ingest.enabled", { value: false });
    const brand = await server.api("POST", "/api/brands", { name: "Handoff" });
    await server.api("POST", "/api/adapter-configs", { key: "talk_words2", stage: "TRANSCRIBE", impl: "transcribe_mock", label: "Talk",
      config: { segments: [0, 8, 16, 24, 32, 40].map((t) => ({ start: t, end: t + 8, text: `We spent ${t + 3} years learning the one thing nobody tells you about this.` })) } });
    const p = await server.api("POST", "/api/programs", { brandId: brand.id, key: "handoff", displayName: "Handoff", contentType: "PODCAST_CLIP", productionMethod: "PODCAST_HIGHLIGHT",
      useMocks: true, autoStyle: false, autoSources: false, computeWhere: "pc", downloadAdapter: "download_mock", transcriptAdapter: "talk_words2", renderAdapter: "render_mock",
      scriptAdapter: "gemini_live", scriptAdapterFallbacks: [], clipAdapter: "llm_clipper", clipAdapterFallbacks: ["clip_meaning", "clip_signal"],
      methodConfig: { clips_per_video: 1, clip_min_seconds: 10, clip_max_seconds: 30, min_clip_score: 0, qa: { enabled: false } } });
    pc = await startEngine({ env: { DATABASE_URL: server.databaseUrl, LANES: "video_local", RUN_SWEEPS: "false" } });
    await server.api("POST", "/api/video-candidates", { nicheId: p.id, url: "https://example.invalid/talk.mp4", title: "A talk" });
    const clip = await waitFor(async () => { const [c] = await server.query(`SELECT cl.reason, ci.status FROM clips cl JOIN content_items ci ON ci.id = cl.content_item_id WHERE cl.niche_id = $1`, [p.id]);
      if (c?.status === "FAILED") throw new Error("item failed"); return c?.status === "PENDING_REVIEW" && c; }, { timeout: 120000, interval: 500, what: "the clip in review" });
    assert.equal(clip.reason.includes("chosen by the LLM on the server"), true, `the server's LLM chose it, not the free picker: ${clip.reason}`);
    const jobs = await server.query(`SELECT type, queue FROM jobs ORDER BY created_at`);
    assert.deepEqual(jobs.filter((j) => ["PROCESS_CANDIDATE", "PICK_CLIPS", "RENDER_CLIP"].includes(j.type)).map((j) => `${j.type}@${j.queue}`),
      ["PROCESS_CANDIDATE@video_local", "PICK_CLIPS@text", "RENDER_CLIP@video_local"], "transcribed on the PC, picked on the server, cut on the PC");
  } finally { await pc?.stop(); await server.stop(); await new Promise((r) => gemini.close(r)); }
});

// Bangla speech on a PC with no key: local whisper cannot hear Bangla (it writes Urdu script), so it is never used for
// it. The PC sends the soundtrack up; the server transcribes it with its hosted transcriber, picks, and the PC cuts.
test("Bangla speech is never given to local whisper: a PC without a key sends the audio to the server to transcribe", { skip: (await import("node:child_process")).spawnSync("ffmpeg", ["-version"]).status !== 0 && "ffmpeg not installed" }, async () => {
  const http = await import("node:http"), { spawnSync } = await import("node:child_process"), { mkdtempSync } = await import("node:fs"), { tmpdir } = await import("node:os"), { join } = await import("node:path");
  const src = join(mkdtempSync(join(tmpdir(), "ce-bn-")), "report.mp4");
  spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=15:duration=40", "-f", "lavfi", "-i", "sine=frequency=220:duration=40", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", src]);
  let uploads = 0;
  const gemini = http.createServer((req, res) => { const chunks = []; req.on("data", (d) => chunks.push(d)); req.on("end", () => {
    const base = `http://127.0.0.1:${gemini.address().port}`, send = (b, h = {}) => { res.writeHead(200, { "content-type": "application/json", ...h }); res.end(JSON.stringify(b)); };
    if (req.url.startsWith("/upload/v1beta/files")) { uploads++; return send({}, { "x-goog-upload-url": `${base}/up` }); }
    if (req.url === "/up") return send({ file: { name: "files/a", uri: `${base}/files/a`, state: "ACTIVE" } });
    if (req.method === "DELETE") return send({});
    if (!/:generateContent/.test(req.url)) return send({ models: [] });
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const text = /file_data/.test(JSON.stringify(body.contents))
      ? [0, 8, 16, 24, 32].map((t) => ({ start: t, end: t + 8, text: `পাটুরিয়ায় ফেরি চলাচল আবার শুরু হয়েছে, যাত্রীরা স্বস্তি পেয়েছেন ${t}` }))
      : [{ start: 8, end: 30, title: "ফেরি চলাচল শুরু", hook: "", score: 0.9, reason: "the server read the Bangla transcript" }];
    send({ candidates: [{ content: { parts: [{ text: JSON.stringify(text) }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10 } });
  }); });
  await new Promise((r) => gemini.listen(0, "127.0.0.1", r));
  const server = await startEngine({ env: { GEMINI_API_KEY: "server-only-key", GEMINI_API_BASE: `http://127.0.0.1:${gemini.address().port}` } });
  let pc;
  try {
    await server.api("PUT", "/api/settings/ingest.enabled", { value: false });
    const brand = await server.api("POST", "/api/brands", { name: "বাংলা" });
    const p = await server.api("POST", "/api/programs", { brandId: brand.id, key: "bn_tv", displayName: "TV clips", contentType: "PODCAST_CLIP", productionMethod: "PODCAST_HIGHLIGHT",
      language: "bn", country: "Bangladesh", useMocks: true, autoStyle: false, autoSources: false, computeWhere: "pc", downloadAdapter: "direct", renderAdapter: "render_mock",
      transcriptAdapter: "whisper_cpp", transcriptAdapterFallbacks: ["gemini_transcribe"], scriptAdapter: "gemini_live", scriptAdapterFallbacks: [],
      clipAdapter: "llm_clipper", clipAdapterFallbacks: ["clip_meaning"], methodConfig: { clips_per_video: 1, clip_min_seconds: 10, clip_max_seconds: 30, min_clip_score: 0, qa: { enabled: false } } });
    pc = await startEngine({ env: { DATABASE_URL: server.databaseUrl, LANES: "video_local", RUN_SWEEPS: "false" } });
    const cand = await server.api("POST", "/api/video-candidates", { nicheId: p.id, url: src, title: "পাটুরিয়া" });
    const clip = await waitFor(async () => { const [c] = await server.query(`SELECT cl.reason, cl.transcript_text, ci.status FROM clips cl JOIN content_items ci ON ci.id = cl.content_item_id WHERE cl.niche_id = $1`, [p.id]);
      const [v] = await server.query(`SELECT status, error_message FROM video_candidates WHERE id = $1`, [cand.id]); if (v?.status === "FAILED") throw new Error(v.error_message);
      return c?.status === "PENDING_REVIEW" && c; }, { timeout: 120000, interval: 500, what: "the Bangla clip in review" });
    assert.match(clip.transcript_text, /ফেরি চলাচল/, "the words are the hosted transcriber's Bangla, not whisper's");
    assert.match(clip.reason, /server read the Bangla transcript/);
    assert.equal(uploads, 1, "the soundtrack went to the hosted transcriber once");
    const jobs = (await server.query(`SELECT type, queue FROM jobs ORDER BY created_at`)).filter((j) => ["PROCESS_CANDIDATE", "PICK_CLIPS", "RENDER_CLIP"].includes(j.type)).map((j) => `${j.type}@${j.queue}`);
    assert.deepEqual(jobs, ["PROCESS_CANDIDATE@video_local", "PICK_CLIPS@text", "RENDER_CLIP@video_local"]);
  } finally { await pc?.stop(); await server.stop(); await new Promise((r) => gemini.close(r)); }
});

// An explainer written on the server and rendered on the PC. The server has the writer and the voice but too little
// memory for the studio; it writes, narrates, stores the plan and hands only the render to the PC. (The studio itself
// is switched off on both here; the PC's attempt to render shows the work arrived there with its plan.)
test("an explainer is written on the server and only its render is handed to the PC", async () => {
  const tone = "-hide_banner -loglevel error -y -f lavfi -i sine=frequency=220:duration=2".split(" ");
  const server = await startEngine({ env: { STUDIO_MIN_MEMORY_MB: "999999" } });
  let pc;
  try {
    await server.api("PUT", "/api/settings/ingest.enabled", { value: false });
    await server.api("POST", "/api/adapter-configs", { key: "tts_tone", stage: "VOICE", impl: "tts_command", config: { command: "ffmpeg", args: [...tone, "{out}"], voice: "", format: "wav" } });
    await server.api("POST", "/api/adapter-configs", { key: "llm_plan", stage: "SCRIPT", impl: "llm_mock", config: { respond: [{ match: "script animated explainer", json: {
      title: "Metro in a minute", description: "A plan written on the server", hashtags: ["metro"], scenes: [
        { layout: "TitleCard", chapter: "Start", data: { title: "Metro in a minute" }, parts: ["Here is the metro."] },
        { layout: "BulletReveal", chapter: "Facts", data: { heading: "Facts", bullets: ["Fast", "Cheap"] }, parts: ["It is fast.", "It is cheap."] },
        { layout: "FullQuote", chapter: "End", data: { quote: "On time", attribution: "Riders" }, parts: ["That is it."] }] } }] } });
    const brand = await server.api("POST", "/api/brands", { name: "Explainers" });
    const p = await server.api("POST", "/api/programs", { brandId: brand.id, key: "pc_explainer2", displayName: "PC explainer", contentType: "ANIMATED_EXPLAINER", computeWhere: "pc",
      useMocks: true, autoStyle: false, autoSources: false, scriptAdapter: "llm_plan", scriptAdapterFallbacks: [], voiceAdapter: "tts_tone", methodConfig: { explainer_minutes: 1, qa: { enabled: false } } });
    const { id } = await server.api("POST", "/api/generate", { nicheId: p.id, topic: "Dhaka metro" });
    const handed = await waitFor(async () => { const [j] = await server.query(`SELECT queue, status FROM jobs WHERE type = 'STUDIO_RENDER' AND content_item_id = $1`, [id]); return j; }, { timeout: 60000, what: "the render handed to the PC" });
    assert.equal(handed.queue, "video_local", "the render is the PC's job");
    const [gen] = await server.query(`SELECT queue, status FROM jobs WHERE type = 'GENERATE_CONTENT' AND content_item_id = $1`, [id]);
    assert.deepEqual([gen.queue, gen.status], ["video", "SUCCEEDED"], "the writing was done on the server");
    const it = await server.api("GET", `/api/content-items/${id}`);
    assert.equal(it.status, "RENDERING", "the item waits for the PC, not failed");
    const plan = it.script_meta.studio;
    assert.ok(plan.audio && plan.scenes.length === 3 && plan.scenes[0].durationInFrames > 0, "with the whole plan stored: narration, scenes, timing");

    pc = await startEngine({ env: { DATABASE_URL: server.databaseUrl, LANES: "video_local", RUN_SWEEPS: "false", STUDIO_MIN_MEMORY_MB: "999999" } });
    const tried = await waitFor(async () => { const [j] = await server.query(`SELECT status, attempts, error_message FROM jobs WHERE type = 'STUDIO_RENDER' AND content_item_id = $1`, [id]); return j?.attempts > 0 && j; }, { timeout: 60000, what: "the PC to take the render" });
    assert.match(tried.error_message || "", /studio/i, "the PC took the render (and, with its studio off here, said so)");
  } finally { await pc?.stop(); await server.stop(); }
});

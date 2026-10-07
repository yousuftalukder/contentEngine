import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startEngine, waitFor, sleep } from "./harness.mjs";

// Your PC runs several jobs at once, but never two heavy ones. Since every job that writes a file runs on the PC, one
// loop meant a 20-minute Blender render held up a news card and a one-second upload hand-off behind it. Here the heavy
// job is a render whose first picture is held by a stand-in picture service for as long as the test likes: while it is
// held, the light work behind it (an upload hand-off, a news card) must go through, and the other heavy work (a second
// render, a slideshow to draft and render) must wait for it — never two heavy jobs running at the same moment.
test("with two loops, light work flows past a long render, and two heavy jobs never run together", async () => {
  let release, inFlight = 0, maxInFlight = 0; const asked = [];
  const gate = new Promise((r) => (release = r));
  // Answers "not found" once released: the picture is missing, so the render puts itself off for a minute (a transient
  // failure) and the next heavy job gets its turn.
  const pics = http.createServer(async (req, res) => {
    asked.push(decodeURIComponent(req.url)); inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await gate; inFlight--; res.writeHead(404); res.end();
  });
  await new Promise((r) => pics.listen(0, "127.0.0.1", r));
  const eng = await startEngine({ env: { LANES: "video_local", RUN_SWEEPS: "false", PC_TUNNEL: "off", PC_CONCURRENCY: "2", STUDIO_MIN_MEMORY_MB: "999999", RELAY_TIMEOUT_MS: "3000",
    POLLINATIONS_API_BASE: `http://127.0.0.1:${pics.address().port}`, POLLINATIONS_RETRY_MS: "10" } });
  let sampling = true, maxHeavy = 0;
  try {
    const brand = await eng.api("POST", "/api/brands", { name: "Busy PC" });
    const p = await eng.api("POST", "/api/programs", { brandId: brand.id, key: "busy_pc", displayName: "Busy PC", contentType: "ANIMATED_EXPLAINER", computeWhere: "pc",
      useMocks: true, autoStyle: false, autoSources: false, methodConfig: { explainer_minutes: 1, explainer_style: "illustrated", qa: { enabled: false } } });
    const plan = (place) => JSON.stringify({ studio: { width: 1080, height: 1920, fps: 30, lang: "en", title: place, subtitles: false, outroFrames: 0, orientation: "vertical", engine: "studio",
      scenes: [{ layout: "Illustrated", chapter: "Street", data: { setting: place, character: null, caption: place }, parts: ["A street."], durationInFrames: 60 }] } });
    const item = async (id, type, meta = null) => eng.query(`INSERT INTO content_items (id, niche_id, topic, status, content_type, script_meta) VALUES ($1, $2, $1, 'QUEUED', $3, $4)`, [id, p.id, type, meta]);
    await item("render_one", "ANIMATED_EXPLAINER", plan("first heavy street"));
    await item("render_two", "ANIMATED_EXPLAINER", plan("second heavy street"));
    await item("slideshow", "IMAGE_SLIDESHOW");
    await item("news_card", "NEWS_STATIC");
    // All queued in one statement, so the PC sees them together. The slideshow's job names its item only in its payload,
    // as some do; it is heavy all the same.
    await eng.query(`INSERT INTO jobs (id, type, status, payload, queue, priority, content_item_id, created_at) VALUES
      ('h1', 'STUDIO_RENDER', 'PENDING', '{"itemId":"render_one"}', 'video_local', 5, 'render_one', now() - interval '3 seconds'),
      ('h2', 'STUDIO_RENDER', 'PENDING', '{"itemId":"render_two"}', 'video_local', 5, 'render_two', now() - interval '2 seconds'),
      ('h3', 'GENERATE_CONTENT', 'PENDING', '{"itemId":"slideshow"}', 'video_local', 1, NULL, now() - interval '1 seconds'),
      ('l1', 'STORE_FILE', 'PENDING', '{"id":"nothing-to-store"}', 'video_local', 9, NULL, now()),
      ('l2', 'GENERATE_CONTENT', 'PENDING', '{"itemId":"news_card"}', 'video_local', 0, 'news_card', now())`);
    (async () => { while (sampling) {
      const [r] = await eng.query(`SELECT count(*)::int AS n FROM jobs WHERE id IN ('h1','h2','h3') AND status = 'RUNNING'`).catch(() => [{ n: 0 }]);
      maxHeavy = Math.max(maxHeavy, r.n); await sleep(40);
    } })();

    await waitFor(() => asked.some((u) => u.includes("first heavy street")), { timeout: 30000, what: "the first render to start drawing" });
    const job = async (id) => (await eng.query(`SELECT status, attempts, error_message FROM jobs WHERE id = $1`, [id]))[0];
    const stored = await waitFor(async () => { const j = await job("l1"); return j.status === "SUCCEEDED" && j; }, { timeout: 15000, what: "the upload hand-off to finish while the render is held" });
    assert.ok(stored, "the hand-off went through");
    await waitFor(async () => (await job("l2")).attempts > 0, { timeout: 15000, what: "the news card to be taken while the render is held" });
    await sleep(1500);   // time for a wrong claim, if one is coming: the light loop polls every 100 ms
    assert.equal((await job("h1")).status, "RUNNING", "the render is still running, held on its picture");
    assert.equal(inFlight, 1, "and it was the only thing asking for a picture");
    assert.deepEqual([(await job("h2")).attempts, (await job("h3")).attempts], [0, 0], "neither the second render nor the slideshow started beside it");

    release();
    await waitFor(async () => (await job("h2")).attempts > 0 && (await job("h3")).attempts > 0, { timeout: 60000, what: "the other heavy jobs to take their turns" });
    const h1 = await job("h1");
    assert.equal(h1.status, "PENDING", `the first render put itself off when its picture was missing (${h1.error_message})`);
    sampling = false; await sleep(100);
    assert.equal(maxHeavy, 1, "never two heavy jobs running at once");
    assert.equal(maxInFlight, 1, "and never two renders drawing at once");
    const [slots] = await eng.query(`SELECT value FROM settings WHERE key = 'worker.pc_slots'`);
    assert.equal((typeof slots.value === "string" ? JSON.parse(slots.value) : slots.value).concurrency, 2, "the PC says how many it runs at once");
  } finally { sampling = false; release(); await eng.stop(); await new Promise((r) => pics.close(r)); }
});

// The number is a dashboard setting too, read by the PC while it runs: lowered to one, the PC goes back to a single
// loop that takes anything in order, as before; the extra loop stops once it is idle, never cutting a job short.
test("the PC reads worker.pc_concurrency while it runs", async () => {
  const eng = await startEngine({ env: { LANES: "video_local", RUN_SWEEPS: "false", PC_TUNNEL: "off", PC_CONCURRENCY: "3", PC_SLOTS_POLL_MS: "1000" } });
  try {
    const reported = async () => { const [r] = await eng.query(`SELECT value FROM settings WHERE key = 'worker.pc_slots'`); const v = r && (typeof r.value === "string" ? JSON.parse(r.value) : r.value); return v?.concurrency; };
    assert.equal(await waitFor(reported, { what: "the PC to report its loops" }), 3, "PC_CONCURRENCY is used while the setting is unset");
    await eng.api("PUT", "/api/settings/worker.pc_concurrency", { value: 1 });
    await waitFor(async () => (await reported()) === 1, { timeout: 30000, interval: 300, what: "the PC to pick up the setting" });
    await waitFor(() => /loop 3 stopped/.test(eng.logs()) && /loop 2 stopped/.test(eng.logs()), { timeout: 15000, what: "the extra loops to stop" });
    await eng.query(`INSERT INTO jobs (id, type, status, payload, queue) VALUES ('s1', 'STORE_FILE', 'PENDING', '{"id":"none"}', 'video_local')`);
    await waitFor(async () => (await eng.query(`SELECT status FROM jobs WHERE id = 's1'`))[0].status === "SUCCEEDED", { what: "the one loop left to keep working" });
  } finally { await eng.stop(); }
});

// Two jobs in flight at the same moment — a render held on its picture, and a news card waiting for the server to write
// it (a PC without a key relays its writing, and no server answers here) — each keeping its own lock. Told to stop, the
// PC hands both back to the queue, neither charged an attempt. (Windows has no SIGTERM to deliver, so that half runs in
// CI, where the engine actually lives.)
test("two jobs in flight on the PC are each kept and each handed back on shutdown", async () => {
  let release; const gate = new Promise((r) => (release = r)), asked = [];
  const pics = http.createServer(async (req, res) => { asked.push(decodeURIComponent(req.url)); await gate; res.writeHead(404); res.end(); });
  await new Promise((r) => pics.listen(0, "127.0.0.1", r));
  const eng = await startEngine({ env: { LANES: "video_local", RUN_SWEEPS: "false", PC_TUNNEL: "off", PC_CONCURRENCY: "2", STUDIO_MIN_MEMORY_MB: "999999",
    POLLINATIONS_API_BASE: `http://127.0.0.1:${pics.address().port}`, POLLINATIONS_RETRY_MS: "10" } });
  try {
    const brand = await eng.api("POST", "/api/brands", { name: "Two at once" });
    const draw = await eng.api("POST", "/api/programs", { brandId: brand.id, key: "two_draw", displayName: "Draw", contentType: "ANIMATED_EXPLAINER", computeWhere: "pc",
      useMocks: true, autoStyle: false, autoSources: false, methodConfig: { explainer_minutes: 1, explainer_style: "illustrated", qa: { enabled: false } } });
    const news = await eng.api("POST", "/api/programs", { brandId: brand.id, key: "two_news", displayName: "News", contentType: "NEWS_STATIC",
      useMocks: true, autoStyle: false, autoSources: false, scriptAdapter: "gemini_live", scriptAdapterFallbacks: [], methodConfig: { qa: { enabled: false } } });
    const plan = JSON.stringify({ studio: { width: 1080, height: 1920, fps: 30, lang: "en", title: "t", subtitles: false, outroFrames: 0, orientation: "vertical", engine: "studio",
      scenes: [{ layout: "Illustrated", chapter: "Street", data: { setting: "a held street", character: null, caption: "c" }, parts: ["A street."], durationInFrames: 60 }] } });
    await eng.query(`INSERT INTO content_items (id, niche_id, topic, status, content_type, script_meta) VALUES ('held_render', $1, 'render', 'RENDERING', 'ANIMATED_EXPLAINER', $2), ('held_card', $3, 'A bridge opens', 'QUEUED', 'NEWS_STATIC', NULL)`, [draw.id, plan, news.id]);
    await eng.query(`INSERT INTO jobs (id, type, status, payload, queue, priority, content_item_id) VALUES
      ('r1', 'STUDIO_RENDER', 'PENDING', '{"itemId":"held_render"}', 'video_local', 5, 'held_render'),
      ('c1', 'GENERATE_CONTENT', 'PENDING', '{"itemId":"held_card"}', 'video_local', 1, 'held_card')`);
    const running = await waitFor(async () => { const r = await eng.query(`SELECT id, locked_by FROM jobs WHERE id IN ('r1','c1') AND status = 'RUNNING'`);
      return r.length === 2 && asked.length && (await eng.query(`SELECT 1 FROM jobs WHERE type = 'LLM_RELAY'`)).length && r; }, { timeout: 30000, what: "the render and the news card to be running together" });
    assert.equal(new Set(running.map((j) => j.locked_by)).size, 1, "both held by this PC");
    if (process.platform === "win32") return;
    process.kill(eng.pid, "SIGTERM");
    const back = await waitFor(async () => { const r = await eng.query(`SELECT id, status, locked_by, attempts FROM jobs WHERE id IN ('r1','c1') ORDER BY id`); return r.every((j) => j.status === "PENDING") && r; }, { timeout: 15000, what: "both jobs handed back" });
    assert.deepEqual(back.map((j) => [j.id, j.locked_by, j.attempts]), [["c1", null, 0], ["r1", null, 0]], "both handed back, neither attempt charged");
  } finally { release(); await eng.stop(); await new Promise((r) => pics.close(r)); }
});

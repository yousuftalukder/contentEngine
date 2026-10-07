import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startEngine, waitFor } from "./harness.mjs";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const listen = async (handler) => { const s = http.createServer(handler); await new Promise((r) => s.listen(0, "127.0.0.1", r)); return s; };
const send = (res, status, body, type = "application/json") => { res.writeHead(status, { "content-type": type }); res.end(type === "application/json" ? JSON.stringify(body) : body); };
const clipFile = (seconds) => { const f = join(mkdtempSync(join(tmpdir(), "ce-rent-")), "c.mp4");
  spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=360x640:rate=15:duration=${seconds}`, "-f", "lavfi", "-i", `sine=frequency=300:duration=${seconds}`, "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", f]); return f; };

// 1b, optional: Vizard fetches the link and cuts it itself. The engine starts the project once, comes back while Vizard
// is still working without spending an attempt, and sends each finished clip to review with the brand pass on it.
test("rented clips: Vizard cuts the video; the job waits for it and each clip lands in review", { skip: !hasFfmpeg && "ffmpeg not installed" }, async () => {
  const clip = readFileSync(clipFile(6)); let created = 0, queried = 0, key = null;
  const vizard = await listen((req, res) => {
    let raw = ""; req.on("data", (d) => (raw += d)); req.on("end", () => {
      if (req.url !== "/clip.mp4") key = req.headers.vizardai_api_key; const base = `http://127.0.0.1:${vizard.address().port}`;
      if (req.url === "/project/create") { created++; const b = JSON.parse(raw); assert.equal(b.videoType, 2, "a YouTube link is handed over as one"); return send(res, 200, { code: 2000, projectId: 77 }); }
      if (req.url === "/project/query/77") { queried++; return send(res, 200, queried === 1 ? { code: 1000 } : { code: 2000, videos: [{ videoUrl: `${base}/clip.mp4`, videoMsDuration: 6000, title: "The line everyone quotes", transcript: "We will not stop.", viralScore: "8.5", viralReason: "a quotable line" }] }); }
      if (req.url === "/clip.mp4") return send(res, 200, clip, "video/mp4");
      send(res, 404, {});
    });
  });
  const eng = await startEngine({ env: { VIZARDAI_API_KEY: "not-a-real-key", VIZARD_API_BASE: `http://127.0.0.1:${vizard.address().port}` } });
  try {
    await eng.api("PUT", "/api/settings/ingest.enabled", { value: false });
    const b = await eng.api("POST", "/api/brands", { name: "Rented" });
    const p = await eng.api("POST", "/api/programs", { brandId: b.id, key: "rented", displayName: "Rented", contentType: "PODCAST_CLIP", productionMethod: "PODCAST_HIGHLIGHT", clipAdapter: "vizard",
      useMocks: true, autoStyle: false, autoSources: false, methodConfig: { qa: { enabled: false }, clips_per_video: 2 } });
    const cand = await eng.api("POST", "/api/video-candidates", { nicheId: p.id, url: "https://www.youtube.com/watch?v=abc", title: "A long speech" });
    // The first look finds Vizard still cutting: the job is put off, not failed, and no attempt is spent.
    const [job] = await waitFor(async () => { const j = await eng.query(`SELECT id, status, attempts, run_after FROM jobs WHERE type = 'PROCESS_CANDIDATE' AND payload::jsonb->>'candidateId' = $1`, [cand.id]); return queried === 1 && j[0]?.status === "PENDING" && j[0].run_after && j; }, { timeout: 30000, what: "the job put off" });
    assert.equal(job.attempts, 0, "waiting is not an attempt");
    await eng.query(`UPDATE jobs SET run_after = now() WHERE id = $1`, [job.id]);
    const it = await waitFor(async () => { const [x] = await eng.query(`SELECT id, status, headline, rejection_note FROM content_items WHERE niche_id = $1`, [p.id]); if (x?.status === "FAILED") throw new Error(x.rejection_note); return x?.status === "PENDING_REVIEW" && x; }, { timeout: 60000, what: "the clip in review" });
    assert.equal(created, 1, "the project was started once, not on every look");
    assert.equal(key, "not-a-real-key");
    const [v] = await eng.query(`SELECT meta FROM media_assets WHERE content_item_id = $1 AND kind = 'VIDEO'`, [it.id]);
    const meta = typeof v.meta === "string" ? JSON.parse(v.meta) : v.meta;
    assert.equal(meta.provider, "vizard"); assert.equal(meta.brand_finish, "done", "with the logo and loudness pass");
    const [c] = await eng.query(`SELECT status FROM video_candidates WHERE id = $1`, [cand.id]);
    assert.equal(c.status, "PROCESSED");
  } finally { await eng.stop(); await new Promise((r) => vizard.close(r)); }
});

// 5c, optional: Twelve Labs indexes the video and its chapters are the scenes the recap is cut from (5a's assembly).
test("Twelve Labs recap: the video is indexed and its chapters become the scenes", { skip: !hasFfmpeg && "ffmpeg not installed" }, async () => {
  const src = clipFile(30); const seen = []; let polls = 0;
  const tl = await listen((req, res) => {
    const chunks = []; req.on("data", (d) => chunks.push(d)); req.on("end", () => {
      seen.push(`${req.method} ${req.url}`);
      if (req.url === "/indexes") return send(res, 200, { _id: "idx1" });
      if (req.url === "/tasks" && req.method === "POST") { assert.match(Buffer.concat(chunks).toString("latin1"), /name="index_id"[\s\S]*idx1/); return send(res, 200, { _id: "t1", status: "pending" }); }
      if (req.url === "/tasks/t1") { polls++; return send(res, 200, polls < 2 ? { _id: "t1", status: "indexing" } : { _id: "t1", status: "ready", video_id: "v1" }); }
      if (req.url === "/summarize") return send(res, 200, { chapters: [{ chapter_number: 0, start_sec: 0, end_sec: 12, chapter_title: "The arrival", chapter_summary: "A train pulls into a crowded station" }, { chapter_number: 1, start_sec: 12, end_sec: 30, chapter_title: "The chase", chapter_summary: "A boy runs along the platform" }] });
      send(res, 404, {});
    });
  });
  const eng = await startEngine({ env: { TWELVE_LABS_API_KEY: "not-a-real-key", TWELVE_LABS_API_BASE: `http://127.0.0.1:${tl.address().port}`, TWELVE_LABS_POLL_MS: "100" } });
  try {
    await eng.api("PUT", "/api/settings/ingest.enabled", { value: false });
    await eng.api("POST", "/api/adapter-configs", { key: "llm_recap", stage: "SCRIPT", impl: "llm_mock", config: { respond: [{ match: "Its scenes", json: { title: "The station", beats: [{ narration: "The train arrives.", start: 0, end: 12 }, { narration: "And the boy runs.", start: 12, end: 30 }], hashtags: ["recap"] } }] } });
    const b = await eng.api("POST", "/api/brands", { name: "TL" });
    const p = await eng.api("POST", "/api/programs", { brandId: b.id, key: "tl_recap", displayName: "TL recap", contentType: "MOVIE_RECAP", productionMethod: "SCENE_RECAP", transcriptAdapter: "twelve_labs",
      useMocks: true, autoStyle: false, autoSources: false, downloadAdapter: "direct", scriptAdapter: "llm_recap", scriptAdapterFallbacks: [], renderAdapter: "render_mock", methodConfig: { qa: { enabled: false } } });
    const cand = await eng.api("POST", "/api/video-candidates", { nicheId: p.id, url: src, title: "The Station" });
    await waitFor(async () => { const [it] = await eng.query(`SELECT status, rejection_note FROM content_items WHERE niche_id = $1`, [p.id]); if (it?.status === "FAILED") throw new Error(it.rejection_note); return it?.status === "PENDING_REVIEW"; }, { timeout: 60000, what: "the recap" });
    const [{ transcript }] = await eng.query(`SELECT transcript FROM video_candidates WHERE id = $1`, [cand.id]);
    const t = typeof transcript === "string" ? JSON.parse(transcript) : transcript;
    assert.deepEqual(t.segments.map((x) => x.visual), ["The arrival: A train pulls into a crowded station", "The chase: A boy runs along the platform"]);
    assert.ok(seen.includes("POST /indexes") && seen.includes("POST /summarize"), seen.join(", "));
    const catalog = await eng.api("GET", "/api/catalog"), programs = await eng.api("GET", "/api/programs");
    assert.equal(catalog.find((v) => v.id === "5c").needs.find((n) => n.key === "twelve_labs").ok, true, "the key is seen");
    assert.deepEqual(programs.find((x) => x.id === p.id).variants, ["5c"], "and the programme is a Twelve Labs recap");
  } finally { await eng.stop(); await new Promise((r) => tl.close(r)); }
});

// A retry must not buy the job again: when the second clip fails to download, the retry finds the same Vizard project,
// skips the clip already made, and finishes the second — one project, two clips, no duplicates.
test("rented clips: a retry after a failed download neither buys a second project nor makes a clip twice", { skip: !hasFfmpeg && "ffmpeg not installed" }, async () => {
  const clip = readFileSync(clipFile(4)); let created = 0, second = 0;
  const vizard = await listen((req, res) => {
    req.on("data", () => {}); req.on("end", () => {
      const base = `http://127.0.0.1:${vizard.address().port}`;
      if (req.url === "/project/create") { created++; return send(res, 200, { code: 2000, projectId: 88 }); }
      if (req.url === "/project/query/88") return send(res, 200, { code: 2000, videos: [{ videoUrl: `${base}/one.mp4`, videoMsDuration: 4000, title: "First moment" }, { videoUrl: `${base}/two.mp4`, videoMsDuration: 4000, title: "Second moment" }] });
      if (req.url === "/one.mp4") return send(res, 200, clip, "video/mp4");
      if (req.url === "/two.mp4") { second++; return second === 1 ? send(res, 503, "busy for now", "text/plain") : send(res, 200, clip, "video/mp4"); }
      send(res, 404, {});
    });
  });
  const eng = await startEngine({ env: { VIZARDAI_API_KEY: "not-a-real-key", VIZARD_API_BASE: `http://127.0.0.1:${vizard.address().port}` } });
  try {
    await eng.api("PUT", "/api/settings/ingest.enabled", { value: false });
    const b = await eng.api("POST", "/api/brands", { name: "Rented twice" });
    const p = await eng.api("POST", "/api/programs", { brandId: b.id, key: "rented_twice", displayName: "Rented twice", contentType: "PODCAST_CLIP", productionMethod: "PODCAST_HIGHLIGHT", clipAdapter: "vizard",
      useMocks: true, autoStyle: false, autoSources: false, methodConfig: { qa: { enabled: false }, clips_per_video: 2 } });
    const cand = await eng.api("POST", "/api/video-candidates", { nicheId: p.id, url: "https://www.youtube.com/watch?v=def", title: "Another speech" });
    const [job] = await waitFor(async () => { const j = await eng.query(`SELECT id, status FROM jobs WHERE type = 'PROCESS_CANDIDATE' AND payload::jsonb->>'candidateId' = $1`, [cand.id]); return second === 1 && j[0]?.status === "PENDING" && j; }, { timeout: 60000, what: "the failed download to be retried" });
    await eng.query(`UPDATE jobs SET run_after = now() WHERE id = $1`, [job.id]);
    await waitFor(async () => { const [c] = await eng.query(`SELECT status FROM video_candidates WHERE id = $1`, [cand.id]); return c.status === "PROCESSED"; }, { timeout: 60000, what: "the video processed" });
    const items = await eng.query(`SELECT headline, status FROM content_items WHERE niche_id = $1 ORDER BY created_at`, [p.id]);
    assert.equal(created, 1, "the project was bought once");
    assert.equal(items.length, 2, `two clips, no duplicate: ${items.map((x) => x.headline).join(", ")}`);
    assert.ok(items.every((x) => x.status === "PENDING_REVIEW"), items.map((x) => x.status).join(", "));
    const [mark] = await eng.query(`SELECT 1 FROM settings WHERE key = $1`, [`vizard.project.${cand.id}`]);
    assert.equal(mark, undefined, "and the project mark is cleared once every clip is made");
  } finally { await eng.stop(); await new Promise((r) => vizard.close(r)); }
});

// Twelve Labs still indexing after the wait: the retry asks about the same task, it does not upload the video again.
test("Twelve Labs: a retry while still indexing polls the same task instead of indexing again", { skip: !hasFfmpeg && "ffmpeg not installed" }, async () => {
  const src = clipFile(20); let uploads = 0, polls = 0;
  const tl = await listen((req, res) => {
    req.on("data", () => {}); req.on("end", () => {
      if (req.url === "/indexes") return send(res, 200, { _id: "idx2" });
      if (req.url === "/tasks" && req.method === "POST") { uploads++; return send(res, 200, { _id: "t2", status: "indexing" }); }
      if (req.url === "/tasks/t2") { polls++; return send(res, 200, polls < 3 ? { _id: "t2", status: "indexing" } : { _id: "t2", status: "ready", video_id: "v2" }); }
      if (req.url === "/summarize") return send(res, 200, { chapters: [{ start_sec: 0, end_sec: 10, chapter_title: "Start", chapter_summary: "It begins" }, { start_sec: 10, end_sec: 20, chapter_title: "End", chapter_summary: "It ends" }] });
      send(res, 404, {});
    });
  });
  const eng = await startEngine({ env: { TWELVE_LABS_API_KEY: "not-a-real-key", TWELVE_LABS_API_BASE: `http://127.0.0.1:${tl.address().port}`, TWELVE_LABS_POLL_MS: "50" } });
  try {
    await eng.api("PUT", "/api/settings/ingest.enabled", { value: false });
    await eng.api("POST", "/api/adapter-configs", { key: "tl_impatient", stage: "TRANSCRIBE", impl: "twelve_labs", config: { max_wait_minutes: 0.001 } });
    await eng.api("POST", "/api/adapter-configs", { key: "llm_recap2", stage: "SCRIPT", impl: "llm_mock", config: { respond: [{ match: "Its scenes", json: { title: "Two parts", beats: [{ narration: "It begins.", start: 0, end: 10 }, { narration: "It ends.", start: 10, end: 20 }], hashtags: [] } }] } });
    const b = await eng.api("POST", "/api/brands", { name: "TL twice" });
    const p = await eng.api("POST", "/api/programs", { brandId: b.id, key: "tl_twice", displayName: "TL twice", contentType: "MOVIE_RECAP", productionMethod: "SCENE_RECAP", transcriptAdapter: "tl_impatient",
      useMocks: true, autoStyle: false, autoSources: false, downloadAdapter: "direct", scriptAdapter: "llm_recap2", scriptAdapterFallbacks: [], renderAdapter: "render_mock", methodConfig: { qa: { enabled: false } } });
    const cand = await eng.api("POST", "/api/video-candidates", { nicheId: p.id, url: src, title: "Two parts" });
    const [job] = await waitFor(async () => { const j = await eng.query(`SELECT id, status FROM jobs WHERE type = 'PROCESS_CANDIDATE' AND payload::jsonb->>'candidateId' = $1`, [cand.id]); return uploads === 1 && j[0]?.status === "PENDING" && j; }, { timeout: 60000, what: "the still-indexing retry" });
    await eng.query(`UPDATE jobs SET run_after = now() WHERE id = $1`, [job.id]);
    await waitFor(async () => { const [it] = await eng.query(`SELECT status, rejection_note FROM content_items WHERE niche_id = $1`, [p.id]); if (it?.status === "FAILED") throw new Error(it.rejection_note); return it?.status === "PENDING_REVIEW"; }, { timeout: 60000, what: "the recap" });
    assert.equal(uploads, 1, "the video was indexed once");
  } finally { await eng.stop(); await new Promise((r) => tl.close(r)); }
});

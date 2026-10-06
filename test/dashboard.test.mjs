import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startEngine, waitFor } from "./harness.mjs";

// What the dashboard asks of the engine, checked through the same API it uses: each of these was a control that looked
// like it worked and did not.
const prog = (b, extra) => ({ brandId: b.id, useMocks: true, autoStyle: false, autoSources: false, ...extra });

test("a key's Test button works for every provider, and says so plainly when there is no check", async () => {
  const seen = [];
  const stub = http.createServer((req, res) => {
    seen.push(`${req.url} ${req.headers.authorization || ""}`);
    if (req.url === "/models" && req.headers.authorization === "Bearer good-key") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ data: [{ id: "llama" }, { id: "gpt-oss" }] })); }
    res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "Invalid API Key" } }));
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  const eng = await startEngine({ env: { GROQ_API_BASE: `http://127.0.0.1:${stub.address().port}`, DASH_GOOD_KEY: "good-key", DASH_BAD_KEY: "bad-key" } });
  try {
    const good = await eng.api("POST", "/api/credentials", { provider: "groq", label: "good", envVar: "DASH_GOOD_KEY" });
    const ok = await eng.api("POST", `/api/credentials/${good.id}/test`);
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(ok.result.models, 2, "it listed the provider's models with the key");
    const bad = await eng.api("POST", "/api/credentials", { provider: "groq", label: "bad", envVar: "DASH_BAD_KEY" });
    const refused = await eng.api("POST", `/api/credentials/${bad.id}/test`);
    assert.equal(refused.ok, false);
    assert.doesNotMatch(refused.error, /is not a function/);
    // A provider with no check written for it (one added to the list later) is told so, not crashed into.
    await eng.query(`INSERT INTO api_credentials (id, provider, label, env_var) VALUES ('mystery-key', 'mystery', 'mystery', 'DASH_GOOD_KEY')`);
    const none = await eng.api("POST", "/api/credentials/mystery-key/test");
    assert.equal(none.ok, false);
    assert.match(none.error, /no connection test for mystery/);
  } finally { await eng.stop(); await new Promise((r) => stub.close(r)); }
});

test("emptying a field on an edited programme puts the engine's default back", async () => {
  const eng = await startEngine();
  try {
    const b = await eng.api("POST", "/api/brands", { name: "Edits" });
    const style = await eng.api("POST", "/api/style-profiles", { name: "House", language: "en" });
    const p = await eng.api("POST", "/api/programs", prog(b, { key: "edits", displayName: "Edits", contentType: "PODCAST_CLIP", productionMethod: "PODCAST_HIGHLIGHT", country: "Bangladesh",
      clipAdapter: "clip_signal", reviewWindowMinutes: 15, voiceId: "bn-BD-PradeepNeural", styleProfileId: style.id }));
    const after = await eng.api("PATCH", `/api/programs/${p.id}`, { country: null, clipAdapter: null, reviewWindowMinutes: null, voiceId: null, styleProfileId: null, productionMethod: null, maxItemsPerDay: null });
    assert.equal(after.country, null);
    assert.equal(after.clip_adapter, "clip_meaning", "a cleared picker is the one a new programme would get (no writer here: the free one)");
    assert.equal(Number(after.review_window_minutes), 60);
    assert.equal(after.voice_id, null);
    assert.equal(after.style_profile_id, null);
    assert.equal(after.production_method, null);
    assert.equal(Number(after.max_items_per_day), 0);
    // A creation-time null is still "not given": the engine's defaults, not an error.
    const q = await eng.api("POST", "/api/programs", prog(b, { key: "nulls", displayName: "Nulls", country: null, voiceId: null }));
    assert.ok(q.id);
  } finally { await eng.stop(); }
});

test("Creative Commons only on a programme keeps other videos out, whatever the source allows", async () => {
  const eng = await startEngine();
  try {
    await eng.api("PUT", "/api/settings/ingest.enabled", { value: false });
    await eng.api("PUT", "/api/settings/queues.enabled", { value: { ingest: false, text: false, image: false, video: false, publish: false, metrics: false } });
    const b = await eng.api("POST", "/api/brands", { name: "Licences" });
    const any = await eng.api("POST", "/api/programs", prog(b, { key: "any", displayName: "Any", contentType: "PODCAST_CLIP" }));
    const cc = await eng.api("POST", "/api/programs", prog(b, { key: "cc", displayName: "CC only", contentType: "PODCAST_CLIP", licensePolicy: "CC_ONLY" }));
    assert.equal(cc.license_policy, "CC_ONLY");
    await assert.rejects(eng.api("PATCH", `/api/programs/${cc.id}`, { licensePolicy: "SOMETIMES" }), /licensePolicy/);
    const src = await eng.api("POST", "/api/sources", { name: "A channel", adapterKey: "ingest_mock", nicheIds: [any.id, cc.id] });
    const item = (id, license) => eng.query(`INSERT INTO source_items (id, source_id, url, url_hash, title, kind, raw) VALUES ($1, $2, $3, $3, $4, 'VIDEO', $5::jsonb)`, [id, src.id, `https://example.com/${id}`, `Video ${id}`, JSON.stringify({ license })]);
    await item("standard", "STANDARD"); await item("open", "CC_BY");
    assert.equal((await eng.api("POST", "/api/source-items/standard/route")).routed, 1, "an ordinary licence reaches only the programme that takes any");
    assert.equal((await eng.api("POST", "/api/source-items/open/route")).routed, 2, "a Creative Commons video reaches both");
    const took = await eng.query(`SELECT niche_id, source_item_id FROM video_candidates ORDER BY source_item_id`);
    assert.deepEqual(took.filter((r) => r.niche_id === cc.id).map((r) => r.source_item_id), ["open"]);
  } finally { await eng.stop(); }
});

test("setups that cannot work fail before anything is spent: a reaction short with no reactor clip, 7a with no folder", async () => {
  const eng = await startEngine();
  try {
    await eng.api("PUT", "/api/settings/ingest.enabled", { value: false });
    const b = await eng.api("POST", "/api/brands", { name: "Fail fast" });
    const react = await eng.api("POST", "/api/programs", prog(b, { key: "react", displayName: "Reactions", contentType: "REACTION_CLIP", productionMethod: "REACTION_OVERLAY", downloadAdapter: "download_mock" }));
    const cand = await eng.api("POST", "/api/video-candidates", { nicheId: react.id, url: "https://example.com/talk.mp4", title: "A talk" });
    const failed = await waitFor(async () => { const [c] = await eng.query(`SELECT status, error_message, local_path, transcript FROM video_candidates WHERE id = $1`, [cand.id]); return c?.status === "FAILED" && c; }, { timeout: 30000, what: "the candidate refused" });
    assert.match(failed.error_message, /reactor clip/);
    assert.equal(failed.local_path, null, "nothing was downloaded");
    assert.equal(failed.transcript, null, "nothing was transcribed");
    const [job] = await eng.query(`SELECT attempts FROM jobs WHERE type = 'PROCESS_CANDIDATE'`);
    assert.equal(Number(job.attempts), 1, "and it is not retried: a missing clip does not appear by itself");

    const own = await eng.api("POST", "/api/programs", prog(b, { key: "own", displayName: "Own footage", contentType: "IMAGE_SLIDESHOW", methodConfig: { own_footage_only: true } }));
    const gen = await eng.api("POST", "/api/generate", { nicheId: own.id, topic: "Rivers of Bangladesh" });
    const it = await waitFor(async () => { const [r] = await eng.query(`SELECT status, rejection_note, script FROM content_items WHERE id = $1`, [gen.id]); return r?.status === "FAILED" && r; }, { timeout: 30000, what: "the 7a item refused" });
    assert.match(it.rejection_note, /footage folder/);
    assert.equal(it.script, null, "no script was written");
  } finally { await eng.stop(); }
});

test("Review gets an item's research, and Re-render draws a stored explainer plan again without rewriting it", async () => {
  const eng = await startEngine();
  try {
    await eng.api("PUT", "/api/settings/ingest.enabled", { value: false });
    const b = await eng.api("POST", "/api/brands", { name: "Review" });
    const ex = await eng.api("POST", "/api/programs", prog(b, { key: "ex", displayName: "Explained", contentType: "ANIMATED_EXPLAINER", computeWhere: "pc" }));
    const plan = { width: 1920, height: 1080, fps: 30, audio: "https://example.com/a.mp3", scenes: [], orientation: "16:9", engine: "studio" };
    await eng.query(`INSERT INTO content_items (id, niche_id, content_type, topic, status, script_meta, script) VALUES ('ex1', $1, 'ANIMATED_EXPLAINER', 'Rivers', 'PENDING_REVIEW', $2::jsonb, 'the script'), ('ex2', $1, 'NEWS_STATIC', 'Other', 'PENDING_REVIEW', '{}'::jsonb, NULL)`, [ex.id, JSON.stringify({ studio: plan })]);
    await eng.query(`INSERT INTO research_notes (id, niche_id, content_item_id, topic, notes) VALUES ('n1', $1, 'ex1', 'Rivers', $2::jsonb), ('n2', $1, 'ex2', 'Other', '[]'::jsonb)`, [ex.id, JSON.stringify([{ fact: "Bangladesh has about 700 rivers", source_url: "https://example.com/rivers", source_name: "Example" }])]);
    const notes = await eng.api("GET", "/api/research-notes?contentItemId=ex1");
    assert.deepEqual(notes.map((n) => n.id), ["n1"]);
    assert.equal(notes[0].notes[0].fact, "Bangladesh has about 700 rivers");
    assert.equal((await eng.api("GET", "/api/research-notes")).length, 2, "without the filter, all of them as before");

    await eng.api("POST", "/api/content-items/ex1/regenerate", { part: "render" });
    const [item] = await eng.query(`SELECT status, script FROM content_items WHERE id = 'ex1'`);
    assert.equal(item.status, "RENDERING");
    assert.equal(item.script, "the script", "the script is kept");
    const jobs = await eng.query(`SELECT type, queue FROM jobs WHERE content_item_id = 'ex1'`);
    assert.deepEqual(jobs, [{ type: "STUDIO_RENDER", queue: "video_local" }], "only the render is queued, on the PC");
    await assert.rejects(eng.api("POST", "/api/content-items/ex2/regenerate", { part: "render" }), /no stored|keeps a plan/i);
  } finally { await eng.stop(); }
});

test("Instagram channels from Connect Facebook are the short vertical format, and the engine says when the chat id comes from env", async () => {
  const eng = await startEngine({ env: { TELEGRAM_CHAT_ID: "123" } });
  try {
    const b = await eng.api("POST", "/api/brands", { name: "Meta" });
    await eng.api("POST", "/api/meta/channels", { brandId: b.id, pageId: "17841400000000000", credentialId: "any", displayName: "@page", platform: "INSTAGRAM" });
    const [ch] = await eng.query(`SELECT format FROM channels WHERE platform = 'INSTAGRAM'`);
    assert.equal(ch.format, "SHORT_FORM_VOICEOVER");
    assert.equal((await eng.api("GET", "/api/stats")).telegramChatEnv, true);
  } finally { await eng.stop(); }
});

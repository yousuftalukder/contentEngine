// What the engine does when a provider says no. A daily quota (a free Gemini key allows about 20 requests a day per
// model) parks the work until the reset instead of burning attempts and failing stories; and when no picture can be
// made at all, the post still goes out as a branded text card that a headline edit redraws.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startEngine, waitFor } from "./harness.mjs";

const ffmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const dir = mkdtempSync(join(tmpdir(), "ce-quota-"));
const probe = (file) => JSON.parse(spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "json", file]).stdout);
// Gemini's own wording for a used-up free daily allowance, down to the RetryInfo that must NOT be taken for the wait.
const DAILY_429 = 'POST https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent -> 429: '
  + '{"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details. * Quota exceeded for metric: '
  + 'generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-3-flash","status":"RESOURCE_EXHAUSTED",'
  + '"details":[{"@type":"type.googleapis.com/google.rpc.QuotaFailure","violations":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]},'
  + '{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"31s"}]}}';

// Gemini's wording when the model itself is swamped: transient, not a quota, and it can last for hours.
const BUSY_503 = 'POST https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent -> 503: '
  + '{"error":{"code":503,"message":"This model is currently experiencing high demand. Spikes in demand may cause errors '
  + 'that typically resolve themselves.","status":"UNAVAILABLE"}}';

let eng, brand, channel;
before(async () => {
  eng = await startEngine({ env: { PEXELS_API_KEY: "stub-key" } });   // the stock-photo test answers for Pexels itself
  await eng.api("PUT", "/api/settings/ingest.enabled", { value: false });
  await eng.api("PUT", "/api/settings/planner.enabled", { value: false });
  if (ffmpeg) spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=0xffc400:s=320x120", "-frames:v", "1", join(dir, "logo.png")]);
  brand = await eng.api("POST", "/api/brands", { name: "Quota brand", brandKit: { primary_color: "#0b3d91", accent_color: "#ffc400", handle: "@quotanews", logo_url: join(dir, "logo.png") } });
  channel = await eng.api("POST", "/api/channels", { brandId: brand.id, key: "fb", displayName: "FB", platform: "FACEBOOK", format: "STATIC_IMAGE_CAPTION", publisherAdapter: "publish_mock" });
  await eng.api("POST", "/api/adapter-configs", { key: "llm_out_of_quota", stage: "SCRIPT", impl: "llm_mock", config: { fail_first: 99, fail_status: 429, fail_message: DAILY_429 } });
  await eng.api("POST", "/api/adapter-configs", { key: "image_no_key", stage: "IMAGE", impl: "gemini_image", config: {} });
  await eng.api("POST", "/api/adapter-configs", { key: "llm_overloaded", stage: "SCRIPT", impl: "llm_mock", config: { fail_first: 99, fail_status: 503, fail_message: BUSY_503 } });
});
after(async () => { await eng?.stop(); rmSync(dir, { recursive: true, force: true }); });

const program = (key, extra) => eng.api("POST", "/api/programs", { brandId: brand.id, key, displayName: key, contentType: "NEWS_STATIC", useMocks: true, autoStyle: false, ...extra });

// A busy provider is not a bad story. Gemini answering "high demand" for an hour once failed 74 drafts in a night —
// each one burning its retries against a wall and then throwing the story away. An outage has to wait like a quota does.
test("a provider that is overloaded past its retries parks the work instead of failing the story", async () => {
  const p = await program("overloaded", { scriptAdapter: "llm_overloaded" });
  const { id } = await eng.api("POST", "/api/generate", { nicheId: p.id, topic: "A story the model is too busy to write" });
  // Wait for the first failure to have backed off, not merely to have started: an update landing while the job is still
  // running is overwritten by the job's own.
  await waitFor(async () => {
    const [j] = await eng.query(`SELECT status, attempts, run_after FROM jobs WHERE content_item_id=$1 AND type='GENERATE_CONTENT'`, [id]);
    return j?.status === "PENDING" && j.attempts > 0 && new Date(j.run_after) > Date.now();
  }, { what: "the first attempt to fail and back off" });
  // Spend the retry budget, so the next failure is the one where the engine decides between giving up on the story and
  // deciding that the provider, not the story, is the problem.
  await eng.query(`UPDATE jobs SET attempts = 9, run_after = now() WHERE content_item_id = $1 AND type = 'GENERATE_CONTENT'`, [id]);
  const job = await waitFor(async () => {
    const [j] = await eng.query(`SELECT * FROM jobs WHERE content_item_id=$1 AND type='GENERATE_CONTENT'`, [id]);
    return j && new Date(j.run_after) - Date.now() > 300000 && j;
  }, { timeout: 30000, what: "the job parked for the outage" });
  assert.equal(job.status, "PENDING", "still queued, not failed");
  assert.ok((new Date(job.run_after) - Date.now()) / 1000 < 1800, "and comes back in minutes, not tomorrow");
  assert.notEqual((await eng.api("GET", `/api/content-items/${id}`)).status, "FAILED", "the story is kept");

  const alert = await waitFor(async () => (await eng.api("GET", "/api/notifications")).find((n) => n.kind === "outage"), { what: "one alert for the outage" });
  assert.match(alert.body, /waiting rather than failing/i);
});

test("a daily quota parks the job until the reset, keeps its attempts and says what to do", async () => {
  const p = await program("out_of_quota", { scriptAdapter: "llm_out_of_quota" });
  const { id } = await eng.api("POST", "/api/generate", { nicheId: p.id, topic: "A story nobody can write today" });
  const job = await waitFor(async () => {
    const [j] = await eng.query(`SELECT * FROM jobs WHERE content_item_id = $1 AND type = 'GENERATE_CONTENT'`, [id]);
    return j?.status === "PENDING" && j.run_after && j;
  }, { what: "the job parked for the quota" });

  // The wait is until midnight in California, so how long it is depends on the hour this test runs; what must hold at
  // every hour is that it ignored the 31-second RetryInfo that Google sends with a daily limit.
  const waitSeconds = (new Date(job.run_after) - Date.now()) / 1000;
  assert.ok(waitSeconds >= 300, `waits for the daily reset, not the 31 s RetryInfo (waited ${Math.round(waitSeconds)} s)`);
  assert.ok(waitSeconds < 25 * 3600, "and not longer than a day");
  assert.equal(job.attempts, 0, "a quota is not the job's fault: it keeps its retry budget");

  const alert = await waitFor(async () => (await eng.api("GET", "/api/notifications")).find((n) => n.kind === "quota"), { what: "the alert that explains the quota" });
  assert.match(alert.title, /free tier/i);
  assert.match(alert.body, /billing/i);

  // The desk is only paused when the wait is long enough to be worth pausing for: run this a minute before midnight
  // in California and the reset is a minute away, and stopping the program for that would be pointless.
  if (waitSeconds > 600) {
    const settings = await eng.api("GET", "/api/settings");
    assert.ok(settings[`quota.pause.${p.id}`]?.until, "the program stops taking new stories until the reset");
    const stats = await eng.api("GET", "/api/stats");
    assert.ok(stats.quotaPauses.some((x) => x.program === "out_of_quota"), "the dashboard can say why it is quiet");
  }
});

test("a news story that would be stale by the time the quota returns is dropped, not left half-written", async () => {
  const p = await program("stale_quota", { scriptAdapter: "llm_out_of_quota", methodConfig: { desk: { max_age_hours: 6 } } });
  // A desk story: it belongs to a cluster, so it ages out while the writer waits for tomorrow's allowance.
  const [cluster] = await eng.query(`INSERT INTO story_clusters (id, title, outlets, weight_sum, item_count, source_count) VALUES (gen_random_uuid()::text, 'Ferry delayed at Paturia', '[{"name":"Test outlet","weight":1}]'::jsonb, 1, 1, 1) RETURNING id`);
  // The lane is held while the story is prepared: the job must not run before it belongs to a cluster, and the story
  // is given a real age, so the test does not depend on how far away midnight in California happens to be right now.
  await eng.api("PUT", "/api/settings/queues.enabled", { value: { text: false } });
  const { id } = await eng.api("POST", "/api/generate", { nicheId: p.id, topic: "Ferry delayed at Paturia" });
  await eng.query(`UPDATE content_items SET cluster_id = $2, created_at = now() - interval '10 hours' WHERE id = $1`, [id, cluster.id]);
  await eng.api("PUT", "/api/settings/queues.enabled", { value: {} });

  const item = await waitFor(async () => { const it = await eng.api("GET", `/api/content-items/${id}`); return it.status === "REJECTED" && it; }, { what: "the stale story set aside" });
  assert.match(item.rejection_note, /quota/i);
  const [job] = await eng.query(`SELECT status FROM jobs WHERE content_item_id = $1 AND type = 'GENERATE_CONTENT'`, [id]);
  assert.equal(job.status, "CANCELLED", "cancelled, so it does not count as a failure");
});

test("no picture, still a reel: sections fall back to branded backdrops and the video renders", { skip: !ffmpeg && "ffmpeg not installed" }, async () => {
  const p = await program("reel_cards", { contentType: "NEWS_REEL", imageAdapter: "image_no_key", voiceAdapter: "tts_mock", renderAdapter: "ffmpeg", language: "bn", methodConfig: { slides: 2 } });
  const { id } = await eng.api("POST", "/api/generate", { nicheId: p.id, topic: "পদ্মা সেতুতে টোল আদায়ের রেকর্ড" });
  const item = await waitFor(async () => { const it = await eng.api("GET", `/api/content-items/${id}`); if (it.status === "FAILED") throw new Error(it.rejection_note); return it.status === "PENDING_REVIEW" && it; }, { timeout: 120000, interval: 500, what: "a reel built on backdrops" });
  assert.equal(item.hero_media.kind, "VIDEO");
  const cards = await eng.query(`SELECT meta FROM media_assets WHERE content_item_id = $1 AND kind = 'IMAGE'`, [id]);
  assert.ok(cards.length >= 2, "one backdrop per section");
  assert.ok(cards.every((c) => c.meta.overlay === "textcard"), "every section picture is a brand backdrop");
});

test("no picture, still a post: the hero is a branded text card, and a headline edit redraws it", { skip: !ffmpeg && "ffmpeg not installed" }, async () => {
  const p = await program("text_cards", { imageAdapter: "image_no_key", language: "bn" });
  await eng.api("POST", `/api/channels/${channel.id}/niches/${p.id}`);
  const { id } = await eng.api("POST", "/api/generate", { nicheId: p.id, topic: "সিলেটে বন্যা পরিস্থিতির অবনতি" });
  const item = await waitFor(async () => { const it = await eng.api("GET", `/api/content-items/${id}`); if (it.status === "FAILED") throw new Error(it.rejection_note); return it.status === "PENDING_REVIEW" && it; }, { what: "a draft with a text card" });

  assert.equal(item.hero_media.meta.overlay, "textcard");
  assert.match(item.hero_media.meta.fallback, /No API key/i, "the card says why there is no picture");
  const file = join(dir, "card.jpg");
  writeFileSync(file, Buffer.from(await (await fetch(item.hero_media.url.replace(/^https?:\/\/[^/]+/, eng.base))).arrayBuffer()));
  const [v] = probe(file).streams;
  assert.deepEqual([v.width, v.height], [1080, 1080]);

  const alert = (await eng.api("GET", "/api/notifications")).find((n) => /text cards/i.test(n.title));
  assert.ok(alert, "the dashboard says posts are going out without pictures");

  const edited = await eng.api("PATCH", `/api/content-items/${id}`, { headline: "সিলেটে বন্যার পানি নামছে ধীরে" });
  assert.notEqual(edited.hero_media_id, item.hero_media_id, "the card is redrawn with the new headline");
  assert.equal(edited.hero_media.meta.overlay, "textcard");
});

// A library photo is fine for "monsoon rain in Dhaka" and dishonest for a named person's arrest. The writer makes that
// call by giving a search phrase or withholding one, and a withheld phrase must not be worked around.
test("stock photos: a story the writer won't illustrate gets a card, not a stand-in photo", { skip: !ffmpeg && "ffmpeg not installed" }, async () => {
  await eng.api("POST", "/api/adapter-configs", { key: "llm_no_photo", stage: "SCRIPT", impl: "llm_mock",
    config: { respond: [{ match: "Produce JSON", json: { headline: "Businessman arrested over a land dispute", summary: "Police detained a named businessman.", photo_query: null, image_prompt: "courtroom", captions: { facebook: "x" }, hashtags: ["bd"] } }] } });
  const p = await program("no_photo", { scriptAdapter: "llm_no_photo", imageAdapter: "pexels_stock" });
  await eng.query(`DELETE FROM notifications`);                      // earlier tests here already raised the no-pictures alert
  const { id } = await eng.api("POST", "/api/generate", { nicheId: p.id, topic: "Businessman arrested over a land dispute" });
  const item = await waitFor(async () => { const it = await eng.api("GET", `/api/content-items/${id}`); if (it.status === "FAILED") throw new Error(it.rejection_note); return it.status === "PENDING_REVIEW" && it; }, { what: "a draft with no photo" });
  assert.equal(item.hero_media.meta.overlay, "textcard");
  assert.match(item.hero_media.meta.fallback, /mislead/i, "and it records why there is no photo");
  const alerts = await eng.api("GET", "/api/notifications");
  assert.ok(!alerts.some((n) => /text cards|pictures/i.test(n.title)), "an editorial choice is not something for a person to fix, so it raises no alert");
});

// The whole stock-photo path against a local stand-in for Pexels: the phrase the writer chose becomes a search, the
// photo is fetched and composed into the brand's card, and the card carries the illustrative note and the credit.
test("stock photos: the photo is fetched, composed into the card, and credited", { skip: !ffmpeg && "ffmpeg not installed" }, async () => {
  const photo = join(dir, "stock.jpg");
  spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1600x1000", "-frames:v", "1", photo]);
  const { readFileSync } = await import("node:fs");
  const bytes = readFileSync(photo);
  let asked = null;
  const http = await import("node:http");
  const stub = http.createServer((req, res) => {
    if (req.url.startsWith("/search")) {
      asked = { query: new URL(req.url, "http://x").searchParams.get("query"), auth: req.headers.authorization };
      const src = `http://127.0.0.1:${stub.address().port}/photo.jpg`;
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ photos: [{ id: 42, width: 1600, height: 1000, url: "https://pexels.com/p/42", photographer: "A Photographer", alt: "rain over a city", src: { large2x: src, original: src } }] }));
    }
    res.writeHead(200, { "content-type": "image/jpeg" }); res.end(bytes);
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  try {
    await eng.api("POST", "/api/credentials", { provider: "pexels", label: "stub", envVar: "PEXELS_API_KEY" });
    await eng.api("POST", "/api/adapter-configs", { key: "stock_stub", stage: "IMAGE", impl: "pexels_stock", config: { api_base: `http://127.0.0.1:${stub.address().port}` } });
    await eng.api("POST", "/api/adapter-configs", { key: "llm_wants_photo", stage: "SCRIPT", impl: "llm_mock",
      config: { respond: [{ match: "Produce JSON", json: { headline: "Monsoon rain floods Dhaka streets", summary: "Heavy rain left roads under water.", photo_query: "monsoon rain dhaka street", image_prompt: "rain", captions: { facebook: "x" }, hashtags: ["bd"] } }] } });
    const p = await program("with_photo", { scriptAdapter: "llm_wants_photo", imageAdapter: "stock_stub" });
    const { id } = await eng.api("POST", "/api/generate", { nicheId: p.id, topic: "Monsoon rain floods Dhaka streets" });
    const item = await waitFor(async () => { const it = await eng.api("GET", `/api/content-items/${id}`); if (it.status === "FAILED") throw new Error(it.rejection_note); return it.status === "PENDING_REVIEW" && it; }, { what: "a draft with a stock photo" });

    assert.equal(asked?.query, "monsoon rain dhaka street", "the writer's phrase is what gets searched");
    assert.ok(asked.auth, "the key goes in the Authorization header");
    assert.equal(item.hero_media.meta.overlay, "photocard", "a real picture means a normal photocard, not a text card");
    assert.equal(item.hero_media.meta.photographer, "A Photographer");
    assert.match(item.hero_media.meta.compose_specs.photo_credit, /Illustrative photo · Pexels\/A Photographer/);
    const out = join(dir, "stockcard.jpg");
    writeFileSync(out, Buffer.from(await (await fetch(item.hero_media.url.replace(/^https?:\/\/[^/]+/, eng.base))).arrayBuffer()));
    assert.deepEqual([probe(out).streams[0].width, probe(out).streams[0].height], [1080, 1080]);
  } finally { await new Promise((r) => stub.close(r)); await eng.api("PUT", "/api/settings/footage.api_base", { value: null }); }
});

// What every Bangladeshi news page on Facebook is actually built from: the photo the outlet ran with the story. It is
// the real people and the real place, it costs nothing, and no generated illustration competes with it. The feed
// carries it, or the article page declares it as og:image; either way it goes in front of whatever the program would
// have drawn.
test("the story's own photo is what the post uses, credited to the outlet that ran it", { skip: !ffmpeg && "ffmpeg not installed" }, async () => {
  const photo = join(dir, "press.jpg");
  spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1600x900", "-frames:v", "1", photo]);
  const tiny = join(dir, "badge.png");
  spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=120x120", "-frames:v", "1", tiny]);
  const { readFileSync } = await import("node:fs");
  const http = await import("node:http");
  let port = 0;
  const stub = http.createServer((req, res) => {
    if (req.url === "/press.jpg") { res.writeHead(200, { "content-type": "image/jpeg" }); return res.end(readFileSync(photo)); }
    if (req.url === "/badge.png") { res.writeHead(200, { "content-type": "image/png" }); return res.end(readFileSync(tiny)); }
    if (req.url === "/feed.xml") {
      res.writeHead(200, { "content-type": "application/rss+xml" });
      return res.end(`<?xml version="1.0"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel>
        <item><title>Rickshaw drivers block Mirpur road over fare rules</title><link>http://127.0.0.1:${port}/story</link>
          <media:content url="http://127.0.0.1:${port}/press.jpg" /><description>Traffic stopped for three hours.</description>
          <pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`);
    }
    // The article page, for the text and for the og:image a feed without one would fall back to.
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<html><head><meta property="og:image" content="http://127.0.0.1:${port}/press.jpg"></head><body><article><p>${"Drivers stopped traffic for three hours on Wednesday. ".repeat(12)}</p></article></body></html>`);
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  port = stub.address().port;
  try {
    const src = await eng.api("POST", "/api/sources", { name: "Mirpur Times", adapterKey: "rss", config: { url: `http://127.0.0.1:${port}/feed.xml` } });
    const p = await program("own_photo", { sourceIds: [src.id], methodConfig: { desk: { settle_minutes: 0, min_sources: 1, min_gap_minutes: 0, per_sweep: 3 } } });
    await eng.api("POST", `/api/sources/${src.id}/poll`);
    await eng.api("POST", "/api/desk/run", {});
    const item = await waitFor(async () => {
      const [x] = await eng.api("GET", `/api/content-items?nicheId=${p.id}`);
      if (x?.status === "FAILED") throw new Error(x.rejection_note);
      return x?.status === "PENDING_REVIEW" && (await eng.api("GET", `/api/content-items/${x.id}`));
    }, { timeout: 60000, interval: 1000, what: "a draft built on the outlet's photo" });

    assert.equal(item.hero_media.meta.provider, "source", "the picture is the one the story came with");
    assert.equal(item.hero_media.meta.overlay, "photocard", "composed into the brand's card, not posted raw");
    assert.match(item.hero_media.meta.compose_specs.photo_credit, /Photo: Mirpur Times/, "and the outlet is credited");

    // A 120x120 badge is a section icon or a tracking pixel, not a news picture. A story that came with only that one
    // must fall back to the brand's card rather than post it.
    await eng.query(`UPDATE source_items SET thumbnail_url = $1, raw = raw - 'lead_image'`, [`http://127.0.0.1:${port}/badge.png`]);
    const { id: badgeId } = await eng.api("POST", "/api/generate", { nicheId: p.id, topic: "Rickshaw drivers block Mirpur road over fare rules" });
    await eng.query(`UPDATE content_items SET source_item_id = (SELECT id FROM source_items LIMIT 1), cluster_id = NULL WHERE id = $1`, [badgeId]);
    await eng.api("POST", `/api/content-items/${badgeId}/regenerate`, { part: "image" }).catch(() => {});
    const redrawn = await waitFor(async () => { const it = await eng.api("GET", `/api/content-items/${badgeId}`); return it.hero_media && it; }, { timeout: 40000, interval: 800, what: "the badge story redrawn" });
    assert.notEqual(redrawn.hero_media.meta.provider, "source", "a badge-sized image is refused");
  } finally { await new Promise((r) => stub.close(r)); }
});

// Stock footage is the difference between a video and a slideshow, and it is free. Sections take a clip where the
// library has one; a section the writer marks as needing the real event keeps a picture, and the reel still renders.
test("reels: sections run on stock footage, and a section that must not use it keeps a picture", { skip: !ffmpeg && "ffmpeg not installed" }, async () => {
  const clipFile = join(dir, "broll.mp4");
  spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=720x1280:rate=30", "-t", "6", "-c:v", "libx264", "-pix_fmt", "yuv420p", clipFile]);
  const { readFileSync } = await import("node:fs");
  const bytes = readFileSync(clipFile);
  const asked = [];
  const http = await import("node:http");
  const stub = http.createServer((req, res) => {
    if (req.url.startsWith("/videos/search")) {
      asked.push(new URL(req.url, "http://x").searchParams.get("query"));
      const link = `http://127.0.0.1:${stub.address().port}/clip.mp4`;
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ videos: [{ id: 7, duration: 6, url: "https://pexels.com/v/7", user: { name: "A Filmmaker" }, video_files: [{ file_type: "video/mp4", width: 720, height: 1280, link }] }] }));
    }
    res.writeHead(200, { "content-type": "video/mp4" }); res.end(bytes);
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  try {
    await eng.api("POST", "/api/adapter-configs", { key: "llm_reel_footage", stage: "SCRIPT", impl: "llm_mock", config: { respond: [{ match: "Write the video in exactly", json: {
      title: "Rain floods the capital", kicker: "Weather", description: "d", hashtags: ["bd"],
      sections: [{ narration: "Heavy rain has flooded several roads in the capital.", image_prompt: "rain", footage_query: "monsoon rain city" },
                 { narration: "The mayor visited the worst affected area this morning.", image_prompt: "mayor", footage_query: null }] } }] } });
    await eng.api("PUT", "/api/settings/footage.api_base", { value: `http://127.0.0.1:${stub.address().port}/videos` });
    const p = await program("reel_broll", { contentType: "NEWS_REEL", scriptAdapter: "llm_reel_footage", imageAdapter: "image_no_key", voiceAdapter: "tts_mock", renderAdapter: "ffmpeg", methodConfig: { slides: 2 } });
    const { id } = await eng.api("POST", "/api/generate", { nicheId: p.id, topic: "Rain floods the capital" });
    const item = await waitFor(async () => { const it = await eng.api("GET", `/api/content-items/${id}`); if (it.status === "FAILED") throw new Error(it.rejection_note); return it.status === "PENDING_REVIEW" && it; }, { timeout: 120000, interval: 500, what: "a reel built on footage" });

    assert.deepEqual(asked, ["monsoon rain city"], "only the section that may use footage asks for a clip");
    const media = await eng.query(`SELECT kind, meta FROM media_assets WHERE content_item_id = $1 AND kind IN ('VIDEO','IMAGE') ORDER BY created_at`, [id]);
    assert.equal(media.filter((m) => m.meta.provider === "pexels").length, 1, "one section on footage");
    assert.ok(media.some((m) => m.meta.overlay === "textcard"), "the other keeps a picture");
    assert.equal(item.hero_media.kind, "VIDEO");
  } finally { await new Promise((r) => stub.close(r)); await eng.api("PUT", "/api/settings/footage.api_base", { value: null }); }
});

// A speech model reads "BNP" as a word and drifts in loudness between calls. Both are audible, and both are handled
// before the audio is joined: the spoken text is kept on the track, so what the voice was asked to say is on record.
test("narration: acronyms are spelled out for the voice, and a brand's own spellings win", { skip: !ffmpeg && "ffmpeg not installed" }, async () => {
  const b = await eng.api("POST", "/api/brands", { name: "Voice brand", brandKit: { pronounce: { WASA: "ওয়াসা" } } });
  await eng.api("POST", "/api/adapter-configs", { key: "llm_acronyms", stage: "SCRIPT", impl: "llm_mock", config: { respond: [{ match: "Write the video in exactly", json: {
    title: "BNP ও WASA নিয়ে খবর", kicker: "খবর", description: "d", hashtags: ["bd"],
    sections: [{ narration: "BNP আজ বৈঠক করেছে।", image_prompt: "x", footage_query: null }, { narration: "WASA পানি সরবরাহ বাড়িয়েছে।", image_prompt: "y", footage_query: null }] } }] } });
  const p = await eng.api("POST", "/api/programs", { brandId: b.id, key: "voiced", displayName: "Voiced", contentType: "NEWS_REEL", language: "bn", useMocks: true,
    autoStyle: false, autoSources: false, scriptAdapter: "llm_acronyms", voiceAdapter: "tts_mock", renderAdapter: "ffmpeg", imageAdapter: "image_no_key", methodConfig: { slides: 2 } });
  const { id } = await eng.api("POST", "/api/generate", { nicheId: p.id, topic: "BNP ও WASA" });
  const item = await waitFor(async () => { const it = await eng.api("GET", `/api/content-items/${id}`); if (it.status === "FAILED") throw new Error(it.rejection_note); return it.status === "PENDING_REVIEW" && it; }, { timeout: 120000, interval: 500, what: "a narrated reel" });

  assert.match(item.script, /BNP/, "the written script keeps the acronym as written");
  const [audio] = await eng.query(`SELECT meta, duration_seconds FROM media_assets WHERE content_item_id = $1 AND kind = 'AUDIO' ORDER BY created_at DESC LIMIT 1`, [id]);
  const spoken = (audio.meta.spoken || []).join(" ");
  assert.match(spoken, /বি এন পি/, "but the voice is given the acronym letter by letter, in Bangla");
  assert.match(spoken, /ওয়াসা/, "and the brand's own spelling is used where it has one");
  assert.ok(!/WASA/.test(spoken), "the written form does not reach the voice once a spelling exists");
  assert.equal(audio.meta.levelled, true, "the joined narration went through the loudness pass");
  assert.ok(audio.duration_seconds > 0);
});

// Stock footage is what keeps a reel moving, but it is generic by definition. The opening second is where a viewer
// decides, and the photograph the outlet ran of this story beats a library clip of something like it.
test("the opening section is the story's own photo; the rest take footage", { skip: !ffmpeg && "ffmpeg not installed" }, async () => {
  const photo = join(dir, "own.jpg"), clipFile = join(dir, "broll2.mp4");
  spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1600x900", "-frames:v", "1", photo]);
  spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "mandelbrot=size=720x1280:rate=30", "-t", "6", "-c:v", "libx264", "-pix_fmt", "yuv420p", clipFile]);
  const { readFileSync } = await import("node:fs");
  const http = await import("node:http");
  const stub = http.createServer((req, res) => {
    if (req.url.startsWith("/videos/search")) {
      const src = `http://127.0.0.1:${stub.address().port}/clip.mp4`;
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ videos: [{ id: 4242, duration: 12, user: { name: "A Filmer" }, url: "https://pexels.com/v/4242",
        video_files: [{ link: src, width: 720, height: 1280, quality: "hd", file_type: "video/mp4" }] }] }));
    }
    if (req.url === "/own.jpg") { res.writeHead(200, { "content-type": "image/jpeg" }); return res.end(readFileSync(photo)); }
    res.writeHead(200, { "content-type": "video/mp4" }); res.end(readFileSync(clipFile));
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  const port = stub.address().port;
  try {
    await eng.api("PUT", "/api/settings/footage.api_base", { value: `http://127.0.0.1:${port}/videos` });
    const src = await eng.api("POST", "/api/sources", { name: "Photo wire", adapterKey: "ingest_mock",
      config: { items: [{ title: "Rickshaw drivers block the Mirpur road over fare rules", url: `http://127.0.0.1:${port}/story`, summary: "Traffic stopped for three hours on Wednesday morning." }] } });
    await eng.query(`UPDATE sources SET language='en' WHERE id=$1`, [src.id]);
    const p = await program("open_on_photo", { contentType: "NEWS_REEL", sourceIds: [src.id], renderAdapter: "ffmpeg", voiceAdapter: "tts_mock",
      methodConfig: { slides: 3, orientation: "9:16", desk: { settle_minutes: 0, min_sources: 1, min_gap_minutes: 0, per_sweep: 2 } } });
    await eng.query(`UPDATE source_items SET thumbnail_url=$2 WHERE source_id=$1`, [src.id, `http://127.0.0.1:${port}/own.jpg`]).catch(() => {});
    await eng.api("POST", `/api/sources/${src.id}/poll`);
    await waitFor(async () => (await eng.query(`SELECT 1 FROM source_items WHERE source_id=$1`, [src.id])).length, { what: "ingested" });
    await eng.query(`UPDATE source_items SET thumbnail_url=$2 WHERE source_id=$1`, [src.id, `http://127.0.0.1:${port}/own.jpg`]);
    await eng.api("POST", "/api/desk/run");

    const id = await waitFor(async () => { const [x] = await eng.api("GET", `/api/content-items?nicheId=${p.id}`); return x && !["QUEUED", "DRAFTING", "FETCHING_DATA"].includes(x.status) && x.id; }, { timeout: 180000, interval: 1500, what: "the reel written" });
    const used = await eng.query(`SELECT kind, meta->>'provider' AS provider, meta->>'section' AS section FROM media_assets
      WHERE content_item_id=$1 AND kind IN ('IMAGE','VIDEO') AND meta->>'purpose' IS DISTINCT FROM 'youtube thumbnail' ORDER BY created_at`, [id]);
    assert.equal(used[0]?.provider, "source", `the reel opens on the outlet's own photo — got ${JSON.stringify(used)}`);
    assert.ok(used.slice(1).some((r) => r.provider === "pexels"), "and the later sections take footage");
  } finally { await new Promise((r) => stub.close(r)); await eng.api("PUT", "/api/settings/footage.api_base", { value: "https://api.pexels.com/videos" }); }
});

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

let eng, brand, channel;
before(async () => {
  eng = await startEngine();
  await eng.api("PUT", "/api/settings/ingest.enabled", { value: false });
  await eng.api("PUT", "/api/settings/planner.enabled", { value: false });
  if (ffmpeg) spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=0xffc400:s=320x120", "-frames:v", "1", join(dir, "logo.png")]);
  brand = await eng.api("POST", "/api/brands", { name: "Quota brand", brandKit: { primary_color: "#0b3d91", accent_color: "#ffc400", handle: "@quotanews", logo_url: join(dir, "logo.png") } });
  channel = await eng.api("POST", "/api/channels", { brandId: brand.id, key: "fb", displayName: "FB", platform: "FACEBOOK", format: "STATIC_IMAGE_CAPTION", publisherAdapter: "publish_mock" });
  await eng.api("POST", "/api/adapter-configs", { key: "llm_out_of_quota", stage: "SCRIPT", impl: "llm_mock", config: { fail_first: 99, fail_status: 429, fail_message: DAILY_429 } });
  await eng.api("POST", "/api/adapter-configs", { key: "image_no_key", stage: "IMAGE", impl: "gemini_image", config: {} });
});
after(async () => { await eng?.stop(); rmSync(dir, { recursive: true, force: true }); });

const program = (key, extra) => eng.api("POST", "/api/programs", { brandId: brand.id, key, displayName: key, contentType: "NEWS_STATIC", useMocks: true, autoStyle: false, ...extra });

test("a daily quota parks the job until the reset, keeps its attempts and says what to do", async () => {
  const p = await program("out_of_quota", { scriptAdapter: "llm_out_of_quota" });
  const { id } = await eng.api("POST", "/api/generate", { nicheId: p.id, topic: "A story nobody can write today" });
  const job = await waitFor(async () => {
    const [j] = await eng.query(`SELECT * FROM jobs WHERE content_item_id = $1 AND type = 'GENERATE_CONTENT'`, [id]);
    return j?.status === "PENDING" && j.run_after && j;
  }, { what: "the job parked for the quota" });

  const waitHours = (new Date(job.run_after) - Date.now()) / 3600e3;
  assert.ok(waitHours > 1, `waits for the daily reset, not the 31 s RetryInfo (waited ${waitHours.toFixed(1)} h)`);
  assert.ok(waitHours < 25, "and not longer than a day");
  assert.equal(job.attempts, 0, "a quota is not the job's fault: it keeps its retry budget");

  const alert = await waitFor(async () => (await eng.api("GET", "/api/notifications")).find((n) => n.kind === "quota"), { what: "the alert that explains the quota" });
  assert.match(alert.title, /free tier/i);
  assert.match(alert.body, /billing/i);

  const settings = await eng.api("GET", "/api/settings");
  assert.ok(settings[`quota.pause.${p.id}`]?.until, "the program stops taking new stories until the reset");
  const stats = await eng.api("GET", "/api/stats");
  assert.ok(stats.quotaPauses.some((x) => x.program === "out_of_quota"), "the dashboard can say why it is quiet");
});

test("a news story that would be stale by the time the quota returns is dropped, not left half-written", async () => {
  const p = await program("stale_quota", { scriptAdapter: "llm_out_of_quota", methodConfig: { desk: { max_age_hours: 6 } } });
  // A desk story: it belongs to a cluster, so it ages out while the writer waits for tomorrow's allowance.
  const [cluster] = await eng.query(`INSERT INTO story_clusters (id, title, outlets, weight_sum, item_count, source_count) VALUES (gen_random_uuid()::text, 'Ferry delayed at Paturia', '[{"name":"Test outlet","weight":1}]'::jsonb, 1, 1, 1) RETURNING id`);
  const { id } = await eng.api("POST", "/api/generate", { nicheId: p.id, topic: "Ferry delayed at Paturia" });
  await eng.query(`UPDATE content_items SET cluster_id = $2 WHERE id = $1`, [id, cluster.id]);

  const item = await waitFor(async () => { const it = await eng.api("GET", `/api/content-items/${id}`); return it.status === "REJECTED" && it; }, { what: "the stale story set aside" });
  assert.match(item.rejection_note, /quota/i);
  const [job] = await eng.query(`SELECT status FROM jobs WHERE content_item_id = $1 AND type = 'GENERATE_CONTENT'`, [id]);
  assert.equal(job.status, "CANCELLED", "cancelled, so it does not count as a failure");
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

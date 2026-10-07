import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startEngine, waitFor } from "./harness.mjs";

// What happens to work whose worker went away, and to work that must never be done twice. Recovery runs when any
// worker boots: a second engine started on the first one's database is the restart.
let eng, brand;
before(async () => {
  eng = await startEngine();
  brand = await eng.api("POST", "/api/brands", { name: "Recovery brand" });
});
after(async () => { await eng?.stop(); });

const program = (key, extra) => eng.api("POST", "/api/programs", { brandId: brand.id, key, displayName: key, contentType: "NEWS_STATIC", useMocks: true, autoStyle: false, autoSources: false, methodConfig: { qa: { enabled: false } }, ...extra });
const restart = async () => { const other = await startEngine({ env: { DATABASE_URL: eng.databaseUrl, LANES: "metrics" } }); await other.stop(); };
const backdate = (table, id, col, interval) => eng.query(`ALTER TABLE ${table} DISABLE TRIGGER trg_${table}_updated_at; UPDATE ${table} SET ${col} = now() - interval '${interval}' WHERE id = '${id}'; ALTER TABLE ${table} ENABLE TRIGGER trg_${table}_updated_at;`);

test("a job whose worker died is handed back, and one that keeps killing its worker fails instead of looping", async () => {
  const fresh = randomUUID(), doomed = randomUUID();
  for (const [id, reclaims] of [[fresh, 0], [doomed, 2]])
    await eng.query(`INSERT INTO jobs (id, type, status, payload, queue, attempts, locked_by, locked_at, reclaims) VALUES ($1, 'SERIES_NEXT', 'RUNNING', '{}', 'nowhere', 1, 'gone-worker', now() - interval '3 hours', $2)`, [id, reclaims]);
  await restart();
  const [a] = await eng.query(`SELECT status, attempts, reclaims, locked_by FROM jobs WHERE id = $1`, [fresh]);
  assert.deepEqual([a.status, a.reclaims, a.locked_by], ["PENDING", 1, null], "handed back, and the hand-back is counted");
  assert.equal(a.attempts, 1, "the attempt it died in is not given back");
  const [b] = await eng.query(`SELECT status, error_message FROM jobs WHERE id = $1`, [doomed]);
  assert.equal(b.status, "FAILED", "the third time, it fails");
  assert.match(b.error_message, /stopped 3 times/);
});

test("a live job keeps its lock fresh, so a long render is not taken for abandoned", async () => {
  // The heartbeat runs every minute; here it is enough that a running job's lock is renewed by its own worker and that
  // a lock owned by another worker is not touched by this one's final write.
  const id = randomUUID();
  await eng.query(`INSERT INTO jobs (id, type, status, payload, queue, attempts, locked_by, locked_at) VALUES ($1, 'SERIES_NEXT', 'RUNNING', '{}', 'nowhere', 1, 'someone-else', now())`, [id]);
  await restart();
  const [j] = await eng.query(`SELECT status, locked_by FROM jobs WHERE id = $1`, [id]);
  assert.deepEqual([j.status, j.locked_by], ["RUNNING", "someone-else"], "a fresh lock is left alone by recovery");
});

test("a story left queued with no job, and a video left processing, are recovered rather than stuck for ever", async () => {
  const p = await program("orphans");
  await eng.api("PUT", "/api/settings/queues.enabled", { value: { text: false } });
  let id;
  try {
    ({ id } = await eng.api("POST", "/api/generate", { nicheId: p.id, topic: "A story whose job was lost" }));
    await eng.query(`DELETE FROM jobs WHERE content_item_id = $1`, [id]);
    await backdate("content_items", id, "updated_at", "3 hours");
  } finally { await eng.api("PUT", "/api/settings/queues.enabled", { value: { text: true } }); }
  const cand = randomUUID();
  await eng.query(`INSERT INTO video_candidates (id, niche_id, source_url, title, status, created_at) VALUES ($1, $2, 'https://example.com/v', 'A lost video', 'PROCESSING', now() - interval '5 hours')`, [cand, p.id]);
  const kept = randomUUID();
  await eng.query(`INSERT INTO video_candidates (id, niche_id, source_url, title, status, created_at) VALUES ($1, $2, 'https://example.com/w', 'A video still waiting', 'PROCESSING', now() - interval '5 hours')`, [kept, p.id]);
  await eng.query(`INSERT INTO jobs (id, type, status, payload, queue, run_after) VALUES ($1, 'PROCESS_CANDIDATE', 'PENDING', $2, 'nowhere', now() + interval '1 day')`, [randomUUID(), JSON.stringify({ candidateId: kept })]);
  await restart();
  const it = await eng.api("GET", `/api/content-items/${id}`);
  assert.equal(it.status, "FAILED", "the story is no longer counted as queued");
  assert.match(it.rejection_note, /job was lost/);
  const [v] = await eng.query(`SELECT status FROM video_candidates WHERE id = $1`, [cand]);
  assert.equal(v.status, "FAILED", "the video with no job is recovered");
  const [w] = await eng.query(`SELECT status FROM video_candidates WHERE id = $1`, [kept]);
  assert.equal(w.status, "PROCESSING", "one whose job is only waiting is left alone");
});

test("a post found half-sent is not posted again, and a published post cannot be retried", async () => {
  const p = await program("publish_once");
  const { id } = await eng.api("POST", "/api/generate", { nicheId: p.id, topic: "A story that was being posted" });
  await waitFor(async () => (await eng.api("GET", `/api/content-items/${id}`)).status === "PENDING_REVIEW", { what: "the draft" });
  const [c1, c2] = [randomUUID(), randomUUID()];
  for (const [cid, key] of [[c1, "once_a"], [c2, "once_b"]])
    await eng.query(`INSERT INTO channels (id, brand_id, key, display_name, platform, format, publisher_adapter) VALUES ($1, $2, $3, $3, 'FACEBOOK', 'STATIC_IMAGE_CAPTION', 'publish_mock')`, [cid, brand.id, key]);
  const half = randomUUID(), done = randomUUID();
  await eng.query(`INSERT INTO content_assets (id, content_item_id, channel_id, status) VALUES ($1, $3, $4, 'PUBLISHING'), ($2, $3, $5, 'PUBLISHED')`, [half, done, id, c1, c2]);
  await eng.query(`INSERT INTO jobs (id, type, status, payload, queue, max_attempts) VALUES ($1, 'PUBLISH_ASSET', 'PENDING', $2, 'publish', 2)`, [randomUUID(), JSON.stringify({ assetId: half })]);
  const a = await waitFor(async () => { const [x] = await eng.query(`SELECT status, error_message, external_id FROM content_assets WHERE id = $1`, [half]); return x.status !== "PUBLISHING" && x; }, { what: "the half-sent post to be looked at" });
  assert.equal(a.status, "FAILED", "it is held for a person to check");
  assert.match(a.error_message, /may already be on the channel/);
  assert.equal(a.external_id, null, "and was not sent again");
  await assert.rejects(eng.api("POST", `/api/assets/${done}/retry`), /409/, "a published post is never retried");
  const [d] = await eng.query(`SELECT status FROM content_assets WHERE id = $1`, [done]);
  assert.equal(d.status, "PUBLISHED");
});

test("an only key resting after a quota refusal is a wait, not a missing key", async () => {
  const vault = await startEngine({ env: { SECRETS_KEY: "3".repeat(64) } });
  try {
    const b = await vault.api("POST", "/api/brands", { name: "Resting key" });
    const cred = await vault.api("POST", "/api/credentials", { provider: "gemini", secret: "not-a-real-key", label: "Only Gemini key" });
    await vault.query(`UPDATE api_credentials SET cooldown_until = now() + interval '20 minutes' WHERE id = $1`, [cred.id]);
    const p = await vault.api("POST", "/api/programs", { brandId: b.id, key: "resting", displayName: "Resting", contentType: "NEWS_STATIC", useMocks: true, autoStyle: false, autoSources: false,
      scriptAdapter: "gemini_live", scriptAdapterFallbacks: [], methodConfig: { qa: { enabled: false } } });
    const { id } = await vault.api("POST", "/api/generate", { nicheId: p.id, topic: "A story while the key rests" });
    const job = await waitFor(async () => { const [j] = await vault.query(`SELECT status, attempts, error_message, run_after FROM jobs WHERE content_item_id = $1 AND type = 'GENERATE_CONTENT'`, [id]); return j && j.status !== "RUNNING" && j.error_message && j; }, { timeout: 30000, what: "the job to settle" });
    assert.equal(job.status, "PENDING", `it waits (${job.error_message})`);
    assert.doesNotMatch(job.error_message, /No API key/);
    assert.equal(job.attempts, 0, "without spending an attempt");
    const it = await vault.api("GET", `/api/content-items/${id}`);
    assert.notEqual(it.status, "FAILED");
  } finally { await vault.stop(); }
});

test("a limit of another kind starts its own wait: a minute limit after a daily one is not a day", async () => {
  await eng.api("POST", "/api/adapter-configs", { key: "llm_minute_again", stage: "SCRIPT", impl: "llm_mock", config: { fail_first: 99, fail_status: 429,
    fail_message: 'POST https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent -> 429: {"error":{"code":429,"message":"Quota exceeded for metric: generate_content_free_tier_requests, limit: 10","details":[{"violations":[{"quotaId":"GenerateRequestsPerMinutePerProjectPerModel-FreeTier"}]},{"retryDelay":"20s"}]}}' } });
  const p = await program("minute_after_day", { scriptAdapter: "llm_minute_again" });
  await eng.api("PUT", "/api/settings/queues.enabled", { value: { text: false } });
  const { id } = await eng.api("POST", "/api/generate", { nicheId: p.id, topic: "A story that waited a day, then a minute" });
  await eng.query(`UPDATE jobs SET quota_since = now() - interval '26 hours', quota_kind = 'day' WHERE content_item_id = $1`, [id]);
  await eng.api("PUT", "/api/settings/queues.enabled", { value: { text: true } });
  const job = await waitFor(async () => { const [j] = await eng.query(`SELECT status, quota_kind, run_after, now() AS now FROM jobs WHERE content_item_id = $1 AND type = 'GENERATE_CONTENT'`, [id]); return j?.status === "PENDING" && j.quota_kind === "short" && j; }, { timeout: 30000, what: "the job to wait" });
  const mins = (new Date(job.run_after) - new Date(job.now)) / 60000;
  assert.ok(mins < 5, `it waits the minute limit's delay, not for the next reset (${mins.toFixed(1)} min)`);
});

test("Gemini spent and the next writer briefly down waits a quarter of an hour instead of failing", async () => {
  await eng.api("POST", "/api/adapter-configs", { key: "llm_spent_day", stage: "SCRIPT", impl: "llm_mock", config: { fail_first: 99, fail_status: 429,
    fail_message: 'POST https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent -> 429: {"error":{"code":429,"message":"Quota exceeded for metric: generate_content_free_tier_requests, limit: 20","details":[{"violations":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}]}}' } });
  await eng.api("POST", "/api/adapter-configs", { key: "llm_briefly_down", stage: "SCRIPT", impl: "llm_mock", config: { fail_first: 99, fail_status: 503, fail_message: "upstream timed out" } });
  const p = await program("spent_and_down", { scriptAdapter: "llm_spent_day", scriptAdapterFallbacks: ["llm_briefly_down"] });
  const { id } = await eng.api("POST", "/api/generate", { nicheId: p.id, topic: "A story with every writer out" });
  const job = await waitFor(async () => { const [j] = await eng.query(`SELECT status, attempts, quota_since, run_after, now() AS now FROM jobs WHERE content_item_id = $1 AND type = 'GENERATE_CONTENT'`, [id]); return j?.status === "PENDING" && j.quota_since && j; }, { timeout: 30000, what: "the job to wait" });
  const mins = (new Date(job.run_after) - new Date(job.now)) / 60000;
  assert.ok(mins > 10 && mins < 20, `about fifteen minutes (${mins.toFixed(1)})`);
  assert.equal(job.attempts, 0, "without spending an attempt");
});

// An explainer whose narration fails once (a network blip) is retried — and the retry uses the research and the plan it
// already paid for instead of asking the writer for them again. A new job (Regenerate everything) would start afresh.
test("a retried explainer reuses the research and plan it already paid for", async () => {
  const dir = mkdtempSync(join(tmpdir(), "voice-")), flag = join(dir, "failed-once"), script = join(dir, "voice.mjs");
  writeFileSync(script, [
    'import { existsSync, writeFileSync } from "node:fs"; import { spawnSync } from "node:child_process";',
    `const flag = ${JSON.stringify(flag)};`,
    'if (!existsSync(flag)) { writeFileSync(flag, "1"); process.stderr.write("ECONNRESET"); process.exit(1); }',
    'const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=220:duration=2", process.argv[2]]); process.exit(r.status ?? 1);'].join("\n"));
  const cheap = await startEngine({ env: { STUDIO_MIN_MEMORY_MB: "999999" } });
  try {
    await cheap.api("POST", "/api/adapter-configs", { key: "voice_blips_once", stage: "VOICE", impl: "tts_command", config: { command: process.execPath, args: [script, "{out}"], format: "wav" } });
    const b = await cheap.api("POST", "/api/brands", { name: "Reuse" });
    const p = await cheap.api("POST", "/api/programs", { brandId: b.id, key: "reuse", displayName: "Reuse", contentType: "ANIMATED_EXPLAINER", useMocks: true, autoStyle: false, autoSources: false,
      voiceAdapter: "voice_blips_once", voiceAdapterFallbacks: [], methodConfig: { explainer_minutes: 1, qa: { enabled: false } } });
    const { id } = await cheap.api("POST", "/api/generate", { nicheId: p.id, topic: "Dhaka metro ridership" });
    const first = await waitFor(async () => { const [j] = await cheap.query(`SELECT id, status, attempts FROM jobs WHERE content_item_id = $1 AND type = 'GENERATE_CONTENT'`, [id]); return j?.status === "PENDING" && j.attempts >= 1 && j; }, { timeout: 60000, what: "the narration to fail once" });
    const [{ script_meta }] = await cheap.query(`SELECT script_meta FROM content_items WHERE id = $1`, [id]);
    const draft = (typeof script_meta === "string" ? JSON.parse(script_meta) : script_meta)?.draft;
    assert.equal(draft?.job, first.id, "the research and plan were kept, marked with the job");
    assert.ok(draft.research && draft.plan);
    await cheap.query(`UPDATE jobs SET run_after = now() WHERE id = $1`, [first.id]);
    await waitFor(async () => { const [j] = await cheap.query(`SELECT status, attempts FROM jobs WHERE id = $1`, [first.id]); return j.attempts >= 2 && j.status !== "RUNNING" && j; }, { timeout: 60000, what: "the retry" });
    const notes = await cheap.query(`SELECT id FROM research_notes WHERE content_item_id = $1`, [id]);
    assert.equal(notes.length, 1, "the research was not done again");
    const it = await cheap.api("GET", `/api/content-items/${id}`);
    assert.ok(it.voice_asset_url, "and the retry went on to narrate");
  } finally { await cheap.stop(); }
});

// Free storage fills with the pictures of drafts nobody will publish (1 GB in two weeks, then every file refused). With
// a number of days set, the hourly cleanup deletes the media of drafts rejected or failed that long ago — and nothing a
// live draft still uses. Off by default: deleting is the owner's choice.
test("media of long-rejected drafts is deleted when the owner sets a retention, and a live draft's is kept", async () => {
  const p = await program("retention");
  const make = async (topic) => { const { id } = await eng.api("POST", "/api/generate", { nicheId: p.id, topic }); await waitFor(async () => (await eng.api("GET", `/api/content-items/${id}`)).status === "PENDING_REVIEW", { what: topic }); return id; };
  const gone = await make("A story rejected a week ago"), kept = await make("A story still waiting for review");
  await eng.query(`UPDATE content_items SET status = 'REJECTED' WHERE id = $1`, [gone]);
  await backdate("content_items", gone, "updated_at", "7 days");
  const media = async (id) => eng.query(`SELECT url, deleted_at FROM media_assets WHERE content_item_id = $1 AND url LIKE 'http%'`, [id]);
  assert.ok((await media(gone)).length, "the rejected draft has stored media to begin with");
  await eng.api("POST", "/api/storage/cleanup");
  assert.ok((await media(gone)).every((m) => !m.deleted_at), "nothing is deleted while the retention is off");
  await eng.api("PUT", "/api/settings/storage.cleanup_rejected_days", { value: 3 });
  await eng.api("POST", "/api/storage/cleanup");
  const after = await media(gone);
  assert.ok(after.every((m) => m.deleted_at), "the rejected draft's media is deleted");
  for (const m of after) assert.equal((await fetch(m.url.replace(/^https?:\/\/[^/]+/, eng.base))).status, 404, "and the file is gone from storage");
  assert.ok((await media(kept)).every((m) => !m.deleted_at), "a draft still in Review keeps its media");
  const it = await eng.api("GET", `/api/content-items/${gone}`);
  assert.equal(it.status, "REJECTED", "the draft itself stays");
});

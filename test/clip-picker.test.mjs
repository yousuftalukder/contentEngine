import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startEngine, waitFor } from "./harness.mjs";

// Who chooses the moment. On fourteen real speeches (eval/selection.mjs) an LLM reading the transcript picked the line
// anyone would clip first in 9, the free heuristic in 4. So the LLM goes first wherever there is a writer — with the
// free pickers behind it, because a writer's allowance runs out and a video must still be clipped that day.
const fb = (v) => (typeof v === "string" ? JSON.parse(v) : v);

test("a new clip programme picks with the LLM when there is a writer, with the free pickers behind it", async () => {
  const withKey = await startEngine({ env: { GEMINI_API_KEY: "not-a-real-key" } });
  try {
    const b = await withKey.api("POST", "/api/brands", { name: "Keyed" });
    const p = await withKey.api("POST", "/api/programs", { brandId: b.id, key: "keyed_clips", displayName: "Keyed clips", contentType: "PODCAST_CLIP", productionMethod: "PODCAST_HIGHLIGHT", autoStyle: false, autoSources: false });
    assert.equal(p.clip_adapter, "llm_clipper");
    assert.deepEqual(fb(p.clip_adapter_fallbacks), ["clip_meaning", "clip_signal"]);
  } finally { await withKey.stop(); }
  const noKey = await startEngine();
  try {
    const b = await noKey.api("POST", "/api/brands", { name: "Unkeyed" });
    const p = await noKey.api("POST", "/api/programs", { brandId: b.id, key: "free_clips", displayName: "Free clips", contentType: "PODCAST_CLIP", productionMethod: "PODCAST_HIGHLIGHT", autoStyle: false, autoSources: false });
    assert.equal(p.clip_adapter, "clip_meaning", "no writer: the free picker, not an LLM with nothing to call");
    assert.deepEqual(fb(p.clip_adapter_fallbacks), ["clip_signal"]);
  } finally { await noKey.stop(); }
});

test("on the first boot with a writer, an existing programme's picker moves behind the LLM, not out", async () => {
  const before = await startEngine();
  let after;
  try {
    const b = await before.api("POST", "/api/brands", { name: "Existing" });
    const p = await before.api("POST", "/api/programs", { brandId: b.id, key: "old_clips", displayName: "Old clips", contentType: "PODCAST_CLIP", productionMethod: "PODCAST_HIGHLIGHT",
      useMocks: true, autoStyle: false, autoSources: false, clipAdapter: "clip_meaning", clipAdapterFallbacks: [] });
    after = await startEngine({ env: { DATABASE_URL: before.databaseUrl, GEMINI_API_KEY: "not-a-real-key" } });
    const row = await waitFor(async () => { const [r] = await after.query(`SELECT clip_adapter, clip_adapter_fallbacks FROM niches WHERE id = $1`, [p.id]); return r?.clip_adapter === "llm_clipper" && r; },
      { timeout: 60000, interval: 500, what: "the LLM picker moved to the front" });
    assert.deepEqual(fb(row.clip_adapter_fallbacks), ["clip_meaning", "clip_signal"], "its own picker right behind, then the loudness one");
  } finally { await after?.stop(); await before.stop(); }
});

test("when the writer refuses, the video is still clipped — by the free picker", { skip: spawnSync("ffmpeg", ["-version"]).status !== 0 && "ffmpeg not installed" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ce-picker-")), src = join(dir, "talk.mp4");
  spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=15:duration=60", "-f", "lavfi", "-i", "sine=frequency=220:duration=60", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", src]);
  const eng = await startEngine();
  try {
    await eng.api("PUT", "/api/settings/ingest.enabled", { value: false });
    await eng.api("POST", "/api/adapter-configs", { key: "llm_out_of_credit", stage: "SCRIPT", impl: "llm_mock", config: { fail_first: 99, fail_status: 402, fail_message: "Your credit balance is too low" } });
    const segments = Array.from({ length: 8 }, (_, i) => ({ start: i * 7, end: i * 7 + 7, text: `Sentence ${i + 1} is where the speaker says something that matters to the people in the hall today.` }));
    await eng.api("POST", "/api/adapter-configs", { key: "tr_fixed", stage: "TRANSCRIBE", impl: "transcribe_mock", config: { segments } });
    const b = await eng.api("POST", "/api/brands", { name: "Refusing writer" });
    const p = await eng.api("POST", "/api/programs", { brandId: b.id, key: "refused", displayName: "Refused", contentType: "PODCAST_CLIP", productionMethod: "PODCAST_HIGHLIGHT", useMocks: true, autoStyle: false, autoSources: false,
      downloadAdapter: "direct", transcriptAdapter: "tr_fixed", renderAdapter: "render_mock", scriptAdapter: "llm_out_of_credit", scriptAdapterFallbacks: [],
      clipAdapter: "llm_clipper", clipAdapterFallbacks: ["clip_meaning", "clip_signal"], methodConfig: { clips_per_video: 1, clip_min_seconds: 20, clip_max_seconds: 40, min_clip_score: 0 } });
    const cand = await eng.api("POST", "/api/video-candidates", { nicheId: p.id, url: src, title: "A talk" });
    const clip = await waitFor(async () => { const [v] = await eng.query(`SELECT status, error_message FROM video_candidates WHERE id = $1`, [cand.id]);
      if (v?.status === "FAILED") throw new Error(v.error_message); return v?.status === "PROCESSED" && (await eng.query(`SELECT reason FROM clips WHERE video_candidate_id = $1`, [cand.id]))[0]; },
      { timeout: 60000, what: "the video clipped" });
    assert.match(clip.reason, /whole thought/, `the free picker chose it — got: ${clip.reason}`);
  } finally { await eng.stop(); }
});

// The LLM picker out of today's allowance is not a reason to cut the video with a weaker picker: the video waits for
// the reset, without spending an attempt. A programme that wants its clips now ("now") gets the free picker at once.
test("when the AI picker is only out of allowance, the video waits for it; a programme that wants clips now gets the free picker", { skip: spawnSync("ffmpeg", ["-version"]).status !== 0 && "ffmpeg not installed" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ce-wait-")), src = join(dir, "talk.mp4");
  spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=15:duration=60", "-f", "lavfi", "-i", "sine=frequency=220:duration=60", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", src]);
  const eng = await startEngine();
  try {
    await eng.api("PUT", "/api/settings/ingest.enabled", { value: false });
    await eng.api("POST", "/api/adapter-configs", { key: "llm_spent", stage: "SCRIPT", impl: "llm_mock", config: { fail_first: 99, fail_status: 429,
      fail_message: "You exceeded your current quota. Quota exceeded for metric: generate_content_free_tier_requests, limit: 20 (GenerateRequestsPerDayPerProjectPerModel-FreeTier)" } });
    const segments = Array.from({ length: 8 }, (_, i) => ({ start: i * 7, end: i * 7 + 7, text: `Sentence ${i + 1} is where the speaker says something that matters to the people in the hall today.` }));
    await eng.api("POST", "/api/adapter-configs", { key: "tr_fixed2", stage: "TRANSCRIBE", impl: "transcribe_mock", config: { segments } });
    const b = await eng.api("POST", "/api/brands", { name: "Spent writer" });
    const programme = (key, extra = {}) => eng.api("POST", "/api/programs", { brandId: b.id, key, displayName: key, contentType: "PODCAST_CLIP", productionMethod: "PODCAST_HIGHLIGHT", useMocks: true, autoStyle: false, autoSources: false,
      downloadAdapter: "direct", transcriptAdapter: "tr_fixed2", renderAdapter: "render_mock", scriptAdapter: "llm_spent", scriptAdapterFallbacks: [],
      clipAdapter: "llm_clipper", clipAdapterFallbacks: ["clip_meaning", "clip_signal"], methodConfig: { clips_per_video: 1, clip_min_seconds: 20, clip_max_seconds: 40, min_clip_score: 0, ...extra } });
    const waits = await programme("waits"), now = await programme("now", { picker_fallback: "now" });

    const c1 = await eng.api("POST", "/api/video-candidates", { nicheId: waits.id, url: src, title: "A talk" });
    const job = await waitFor(async () => { const [j] = await eng.query(`SELECT status, attempts, run_after > now() AS later FROM jobs WHERE type = 'PROCESS_CANDIDATE' AND payload::jsonb->>'candidateId' = $1`, [c1.id]);
      return j?.status === "PENDING" && j.later && j; }, { timeout: 60000, what: "the video put off until the reset" });
    assert.equal(job.attempts, 0, "waiting for the allowance is not an attempt");
    assert.equal((await eng.query(`SELECT 1 FROM clips WHERE video_candidate_id = $1`, [c1.id])).length, 0, "and no clip was cut by the free picker meanwhile");

    const c2 = await eng.api("POST", "/api/video-candidates", { nicheId: now.id, url: src, title: "A talk" });
    const clip = await waitFor(async () => { const [v] = await eng.query(`SELECT status, error_message FROM video_candidates WHERE id = $1`, [c2.id]);
      if (v?.status === "FAILED") throw new Error(v.error_message); return v?.status === "PROCESSED" && (await eng.query(`SELECT reason FROM clips WHERE video_candidate_id = $1`, [c2.id]))[0]; }, { timeout: 60000, what: "the clip cut now" });
    assert.match(clip.reason, /whole thought/, "by the free picker, at once");
  } finally { await eng.stop(); }
});

// A long video is read in pieces, not cut off: the line worth clipping is near the end, far past what one piece holds
// (the transcript used to be truncated at 120,000 characters — about two hours of speech). The picker still finds it.
test("the LLM picker reads a long transcript in pieces, so a moment near the end can be chosen", { skip: spawnSync("ffmpeg", ["-version"]).status !== 0 && "ffmpeg not installed" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ce-long-")), src = join(dir, "talk.mp4");
  spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=5:duration=1210", "-f", "lavfi", "-i", "sine=frequency=220:duration=1210", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", src]);
  const eng = await startEngine();
  try {
    await eng.api("PUT", "/api/settings/ingest.enabled", { value: false });
    // Two hundred sentences; only the last stretch contains the line, and the picker is told where it is only there.
    const segments = Array.from({ length: 200 }, (_, i) => ({ start: i * 6, end: i * 6 + 6, text: i >= 190 ? `ONLY-NEAR-THE-END sentence ${i} is the one everyone will quote tomorrow morning.` : `Sentence ${i} is ordinary talk about the weather and the traffic on the way in.` }));
    await eng.api("POST", "/api/adapter-configs", { key: "tr_long", stage: "TRANSCRIBE", impl: "transcribe_mock", config: { segments } });
    await eng.api("POST", "/api/adapter-configs", { key: "llm_reads", stage: "SCRIPT", impl: "llm_mock", config: { respond: [
      // A request that holds the opening answers with filler, so the line can only come from a piece without it —
      // read whole (as before), the picker would return the filler and nothing else.
      { match: "Sentence 0 is ordinary", json: [{ start: 60, end: 90, title: "Weather", hook: "", score: 0.2, reason: "filler" }] },
      { match: "ONLY-NEAR-THE-END", json: [{ start: 1150, end: 1180, title: "The line", hook: "", score: 0.95, reason: "the quoted line" }] }] } });
    const b = await eng.api("POST", "/api/brands", { name: "Long" });
    const p = await eng.api("POST", "/api/programs", { brandId: b.id, key: "long_talk", displayName: "Long talk", contentType: "PODCAST_CLIP", productionMethod: "PODCAST_HIGHLIGHT", useMocks: true, autoStyle: false, autoSources: false,
      downloadAdapter: "direct", transcriptAdapter: "tr_long", renderAdapter: "render_mock", scriptAdapter: "llm_reads", scriptAdapterFallbacks: [],
      clipAdapter: "llm_clipper", clipAdapterFallbacks: ["clip_meaning"], methodConfig: { clips_per_video: 1, clip_min_seconds: 20, clip_max_seconds: 40, min_clip_score: 0, transcript_chars: 4000 } });
    const cand = await eng.api("POST", "/api/video-candidates", { nicheId: p.id, url: src, title: "A long talk" });
    const clip = await waitFor(async () => { const [v] = await eng.query(`SELECT status, error_message FROM video_candidates WHERE id = $1`, [cand.id]);
      if (v?.status === "FAILED") throw new Error(v.error_message); return v?.status === "PROCESSED" && (await eng.query(`SELECT start_seconds, reason FROM clips WHERE video_candidate_id = $1`, [cand.id]))[0]; }, { timeout: 90000, what: "the clip" });
    assert.match(clip.reason, /quoted line/, `the line near the end was chosen: ${clip.reason}`);
    assert.ok(Number(clip.start_seconds) > 1100, `at ${clip.start_seconds}s, not at the start`);
  } finally { await eng.stop(); }
});

// A clip opens where its sentence opens: a pick that lands a few seconds into a sentence starts at that sentence.
test("an LLM pick that starts a few seconds into a sentence is moved back to where the sentence starts", { skip: spawnSync("ffmpeg", ["-version"]).status !== 0 && "ffmpeg not installed" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ce-sent-")), src = join(dir, "talk.mp4");
  spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=5:duration=80", "-f", "lavfi", "-i", "sine=frequency=220:duration=80", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", src]);
  const eng = await startEngine();
  try {
    await eng.api("PUT", "/api/settings/ingest.enabled", { value: false });
    const segments = Array.from({ length: 10 }, (_, i) => ({ start: i * 8, end: i * 8 + 8, text: `Sentence ${i} carries a whole thought that a viewer could follow without anything before it.` }));
    await eng.api("POST", "/api/adapter-configs", { key: "tr_sent", stage: "TRANSCRIBE", impl: "transcribe_mock", config: { segments } });
    await eng.api("POST", "/api/adapter-configs", { key: "llm_mid", stage: "SCRIPT", impl: "llm_mock", config: { respond: [{ match: "Timestamped transcript", json: [{ start: 19, end: 48, title: "Mid", hook: "", score: 0.9, reason: "lands mid-sentence" }] }] } });
    const b = await eng.api("POST", "/api/brands", { name: "Sentences" });
    const p = await eng.api("POST", "/api/programs", { brandId: b.id, key: "sentences", displayName: "Sentences", contentType: "PODCAST_CLIP", productionMethod: "PODCAST_HIGHLIGHT", useMocks: true, autoStyle: false, autoSources: false,
      downloadAdapter: "direct", transcriptAdapter: "tr_sent", renderAdapter: "render_mock", scriptAdapter: "llm_mid", scriptAdapterFallbacks: [],
      clipAdapter: "llm_clipper", clipAdapterFallbacks: ["clip_meaning"], methodConfig: { clips_per_video: 1, clip_min_seconds: 20, clip_max_seconds: 40, min_clip_score: 0 } });
    const cand = await eng.api("POST", "/api/video-candidates", { nicheId: p.id, url: src, title: "A talk" });
    const clip = await waitFor(async () => { const [v] = await eng.query(`SELECT status, error_message FROM video_candidates WHERE id = $1`, [cand.id]);
      if (v?.status === "FAILED") throw new Error(v.error_message); return v?.status === "PROCESSED" && (await eng.query(`SELECT start_seconds FROM clips WHERE video_candidate_id = $1`, [cand.id]))[0]; }, { timeout: 60000, what: "the clip" });
    assert.equal(Number(clip.start_seconds), 16, "the pick at 19 s starts where its sentence starts, 16 s");
  } finally { await eng.stop(); }
});

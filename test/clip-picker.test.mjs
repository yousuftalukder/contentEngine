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

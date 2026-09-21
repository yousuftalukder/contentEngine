import { test } from "node:test";
import assert from "node:assert/strict";
import { startEngine, waitFor } from "./harness.mjs";

// A tenth of a CPU hears three minutes of speech in nineteen, so the free daily allowance of a hosted transcriber is
// worth spending before falling back to the local engine that never runs out. That only works if a transcriber that
// refuses hands the video on instead of failing it — the same chain the writers and the voices already have.
test("a transcriber that refuses hands the video to the next one", async () => {
  const eng = await startEngine();
  try {
    await eng.api("PUT", "/api/settings/ingest.enabled", { value: false });
    const brand = await eng.api("POST", "/api/brands", { name: "Transcribe brand" });
    // gemini_transcribe with no key configured: it throws the moment it is asked, exactly as a spent quota would.
    await eng.api("POST", "/api/adapter-configs", { key: "hosted_no_key", stage: "TRANSCRIBE", impl: "gemini_transcribe", label: "Hosted, unkeyed", config: {} });
    await eng.api("POST", "/api/adapter-configs", { key: "local_engine", stage: "TRANSCRIBE", impl: "transcribe_mock", label: "Local stand-in",
      config: { segments: [{ start: 0, end: 30, text: "The local engine heard this one because the hosted one would not." }] } });

    const p = await eng.api("POST", "/api/programs", { brandId: brand.id, key: "fallback_tr", displayName: "Transcriber fallback",
      contentType: "PODCAST_CLIP", productionMethod: "PODCAST_HIGHLIGHT", useMocks: true, autoStyle: false, autoSources: false,
      downloadAdapter: "download_mock", transcriptAdapter: "hosted_no_key", transcriptAdapterFallbacks: ["local_engine"],
      clipAdapter: "clip_signal", renderAdapter: "render_mock",
      methodConfig: { clips_per_video: 1, clip_min_seconds: 10, clip_max_seconds: 30, min_score: 0 } });

    await eng.api("POST", "/api/video-candidates", { nicheId: p.id, url: "https://example.invalid/talk.mp4", title: "A talk" });
    const stored = await waitFor(async () => {
      const [c] = await eng.query(`SELECT transcript FROM video_candidates WHERE niche_id=$1`, [p.id]);
      return c?.transcript ? c.transcript : null;
    }, { timeout: 120000, interval: 500, what: "the second transcriber to be reached" });

    const text = JSON.stringify(stored);
    assert.match(text, /the local engine heard this one/i, `the fallback produced the transcript (got ${text.slice(0, 160)})`);
  } finally { await eng.stop(); }
});

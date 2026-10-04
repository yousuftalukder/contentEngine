import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { startEngine, waitFor } from "./harness.mjs";

// Every transcript in production came back as 0-30, 30-60, 60-90: the engine ran whisper with -nt, which decodes each
// 30-second window as one block. The picker could not place a moment inside half a minute and captions drifted off
// the speech. whisper.cpp stands in here as a script with the same arguments, so the flags are what is tested.
const ffmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-whisper.mjs");

test("whisper is asked for timestamps, and the transcript keeps its sentence timing", { skip: !ffmpeg && "ffmpeg not installed" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ce-whisper-")), log = join(dir, "calls.jsonl"), src = join(dir, "talk.mp4");
  for (const m of ["ggml-base.bin", "ggml-tiny.bin"]) writeFileSync(join(dir, m), "stand-in");
  spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=45", "-f", "lavfi", "-i", "sine=frequency=220:duration=45", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", src]);
  const eng = await startEngine({ env: { WHISPER_CLI: FAKE, WHISPER_DIR: dir, FAKE_WHISPER_LOG: log } });
  try {
    await eng.api("PUT", "/api/settings/ingest.enabled", { value: false });
    const b = await eng.api("POST", "/api/brands", { name: "Whisper brand" });
    const p = await eng.api("POST", "/api/programs", { brandId: b.id, key: "timed", displayName: "Timed", contentType: "PODCAST_CLIP", productionMethod: "PODCAST_HIGHLIGHT",
      useMocks: true, autoStyle: false, autoSources: false, downloadAdapter: "direct", transcriptAdapter: "whisper_cpp", renderAdapter: "render_mock", language: "en",
      methodConfig: { clips_per_video: 1, clip_min_seconds: 10, clip_max_seconds: 25 } });
    const cand = await eng.api("POST", "/api/video-candidates", { nicheId: p.id, url: src, title: "Ferry report" });
    const row = await waitFor(async () => { const [v] = await eng.query(`SELECT status, transcript, error_message FROM video_candidates WHERE id = $1`, [cand.id]);
      if (v?.status === "FAILED") throw new Error(v.error_message); return v?.transcript && v; }, { timeout: 60000, what: "the transcript" });

    const [args] = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(!args.includes("-nt"), `timestamps are asked for (args: ${args.join(" ")})`);
    const segs = (typeof row.transcript === "string" ? JSON.parse(row.transcript) : row.transcript).segments;
    assert.equal(segs.length, 6, "one segment per sentence, not one per 30 seconds");
    assert.ok(segs.every((s) => s.end - s.start < 10), "and none of them is a 30-second block");
    assert.equal(segs[1].start, 6.2, "with whisper's own timing");
  } finally { await eng.stop(); }
});

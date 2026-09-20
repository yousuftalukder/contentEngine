// Footage pipelines end to end with real ffmpeg (CI installs it; skipped where it is missing): a long-form reaction
// with a reactor picture-in-picture, and a vertical voice-over reel in the blur-pad layout, both brand-finished.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startEngine, waitFor } from "./harness.mjs";

const ffmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const dir = mkdtempSync(join(tmpdir(), "ce-footage-"));
const ff = (...args) => { const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]); if (r.status !== 0) throw new Error(String(r.stderr)); };
const probe = (file) => JSON.parse(spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", file]).stdout);

let eng, brand;
before(async () => {
  if (!ffmpeg) return;
  ff("-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=40", "-f", "lavfi", "-i", "sine=frequency=330:duration=40", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", join(dir, "source.mp4"));
  ff("-f", "lavfi", "-i", "mandelbrot=size=480x480:rate=30", "-t", "5", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(dir, "reactor.mp4"));
  ff("-f", "lavfi", "-i", "color=c=0xffb300:s=320x120", "-frames:v", "1", join(dir, "logo.png"));
  eng = await startEngine();
  await eng.api("PUT", "/api/settings/ingest.enabled", { value: false });
  brand = await eng.api("POST", "/api/brands", { name: "Footage brand", brandKit: { primary_color: "#0b3d91", accent_color: "#ffb300", logo_url: join(dir, "logo.png") } });
});
after(async () => { await eng?.stop(); rmSync(dir, { recursive: true, force: true }); });

const base = () => ({ brandId: brand.id, useMocks: true, autoStyle: false, downloadAdapter: "direct", transcriptAdapter: "transcribe_mock", voiceAdapter: "tts_mock", renderAdapter: "ffmpeg" });
async function renderFrom(program) {
  await eng.api("POST", "/api/video-candidates", { nicheId: program.id, url: join(dir, "source.mp4"), title: "Test broadcast" });
  const it = await waitFor(async () => { const x = (await eng.api("GET", `/api/content-items?nicheId=${program.id}`))[0]; if (x?.status === "FAILED") throw new Error(x.rejection_note); return x?.status === "PENDING_REVIEW" && x; }, { timeout: 240000, interval: 1000, what: `${program.display_name} rendered` });
  const full = await eng.api("GET", `/api/content-items/${it.id}`);
  const file = join(dir, `${program.key}.mp4`);
  (await import("node:fs")).writeFileSync(file, Buffer.from(await (await fetch(full.hero_media.url.replace(/^https?:\/\/[^/]+/, eng.base))).arrayBuffer()));
  return { item: full, info: probe(file) };
}

test("long-form reaction: source segments and commentary, 16:9, chapters in the description", { skip: !ffmpeg && "ffmpeg not installed" }, async () => {
  const p = await eng.api("POST", "/api/programs", { ...base(), key: "react", displayName: "Reactions", contentType: "REACTION_CLIP", productionMethod: "REACTION_LONG", methodConfig: { reactor_url: join(dir, "reactor.mp4") } });
  const { item, info } = await renderFrom(p);
  const v = info.streams.find((s) => s.codec_type === "video");
  assert.deepEqual([v.width, v.height], [1920, 1080]);
  assert.ok(info.streams.some((s) => s.codec_type === "audio"));
  assert.ok(Number(info.format.duration) > 20, "20 s of source plus the commentary");
  assert.match(item.captions.youtube, /0:00 Intro[\s\S]*Verdict/);
});

test("voice-over reel: vertical blur-pad layout covering the whole narration", { skip: !ffmpeg && "ffmpeg not installed" }, async () => {
  const p = await eng.api("POST", "/api/programs", { ...base(), key: "vo", displayName: "Voiceovers", contentType: "VOICEOVER_CLIP", productionMethod: "VOICEOVER", methodConfig: { vertical_layout: "blurpad", clips_per_video: 1 } });
  const { item, info } = await renderFrom(p);
  const v = info.streams.find((s) => s.codec_type === "video");
  assert.deepEqual([v.width, v.height], [1080, 1920]);
  assert.ok(Number(info.format.duration) >= Number(item.hero_media.duration_seconds) - 0.5);
  assert.ok(item.script?.length > 0, "the narration is stored as the script");
});

// The studio renderer is picked for any program that makes its own videos, on whatever machine the video lane runs on.
// An instance too small for Chromium must still produce the reel through ffmpeg rather than fail the item.
test("a studio program on an instance too small for the studio still renders, through ffmpeg", { skip: !ffmpeg && "ffmpeg not installed" }, async () => {
  const small = await startEngine({ env: { STUDIO_MIN_MEMORY_MB: "999999" } });
  try {
    await small.api("PUT", "/api/settings/ingest.enabled", { value: false });
    const b = await small.api("POST", "/api/brands", { name: "Small instance", brandKit: { primary_color: "#0b3d91" } });
    // Pictures come from the text-card fallback, so the sections are real JPEGs: the mock adapter's SVG needs an
    // ffmpeg built with librsvg, which this test should not depend on.
    await small.api("POST", "/api/adapter-configs", { key: "image_no_key", stage: "IMAGE", impl: "gemini_image", config: {} });
    const p = await small.api("POST", "/api/programs", { brandId: b.id, key: "reels", displayName: "Reels", contentType: "NEWS_REEL", useMocks: true, autoStyle: false, autoSources: false, renderAdapter: "remotion", voiceAdapter: "tts_mock", imageAdapter: "image_no_key", methodConfig: { slides: 2 } });
    const { id } = await small.api("POST", "/api/generate", { nicheId: p.id, topic: "Metro rail extends its hours" });
    const done = await waitFor(async () => { const it = await small.api("GET", `/api/content-items/${id}`); if (it.status === "FAILED") throw new Error(it.rejection_note); return it.status === "PENDING_REVIEW" && it; }, { timeout: 120000, interval: 500, what: "a reel rendered without the studio" });
    assert.equal(done.hero_media.kind, "VIDEO");
  } finally { await small.stop(); }
});

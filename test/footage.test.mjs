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
  const p = await eng.api("POST", "/api/programs", { ...base(), key: "react", displayName: "Reactions", contentType: "REACTION_CLIP", productionMethod: "REACTION_LONG", methodConfig: { reactor_url: join(dir, "reactor.mp4"), min_commentary_share: 0, max_play_seconds: 600 } });
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

// A semi-long video is watched on a television-shaped screen, picked out of a list of covers, and judged in its first
// second. So the ffmpeg path — the one every instance can run — has to produce both a cover and a sound bed, not just
// pictures over a voice. The mock voice is a silent track, which makes the bed easy to hear: anything above silence in
// the finished audio came from the brand's music.
test("landscape reel: a 1280x720 cover and the brand's music under the narration", { skip: !ffmpeg && "ffmpeg not installed" }, async () => {
  ff("-f", "lavfi", "-i", "sine=frequency=880:duration=20", "-q:a", "4", join(dir, "bed.mp3"));
  const b = await eng.api("POST", "/api/brands", { name: "Music brand", brandKit: { primary_color: "#0b3d91", accent_color: "#ffb300", music_urls: [join(dir, "bed.mp3")] } });
  // No key for the image adapter, so the sections fall back to text cards: real JPEGs, no network.
  await eng.api("POST", "/api/adapter-configs", { key: "image_unkeyed", stage: "IMAGE", impl: "gemini_image", config: {} });
  const p = await eng.api("POST", "/api/programs", { brandId: b.id, key: "semilong", displayName: "Semi long", contentType: "NEWS_REEL", useMocks: true, autoStyle: false, autoSources: false,
    renderAdapter: "ffmpeg", voiceAdapter: "tts_mock", imageAdapter: "image_unkeyed", methodConfig: { slides: 2, orientation: "16:9" } });
  const { id } = await eng.api("POST", "/api/generate", { nicheId: p.id, topic: "The city opens its new line" });
  const done = await waitFor(async () => { const it = await eng.api("GET", `/api/content-items/${id}`); if (it.status === "FAILED") throw new Error(it.rejection_note); return it.status === "PENDING_REVIEW" && it; }, { timeout: 180000, interval: 1000, what: "a landscape reel" });

  const file = join(dir, "semilong.mp4");
  (await import("node:fs")).writeFileSync(file, Buffer.from(await (await fetch(done.hero_media.url.replace(/^https?:\/\/[^/]+/, eng.base))).arrayBuffer()));
  const v = probe(file).streams.find((s) => s.codec_type === "video");
  assert.deepEqual([v.width, v.height], [1920, 1080]);
  const loud = spawnSync("ffmpeg", ["-hide_banner", "-i", file, "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" });
  const mean = Number(/mean_volume:\s*(-?[\d.]+) dB/.exec(loud.stderr)?.[1] ?? -99);
  assert.ok(mean > -50, `the music bed is in the mix (mean volume ${mean} dB, silence is about -91)`);

  const thumb = (await eng.query(`SELECT width, height, meta FROM media_assets WHERE content_item_id=$1 AND kind='THUMBNAIL' AND deleted_at IS NULL`, [id]))[0];
  assert.ok(thumb, "a landscape video gets a thumbnail");
  assert.deepEqual([thumb.width, thumb.height], [1280, 720]);
});

// A planner left to itself drifts towards long unbroken playback — duller to watch, and the shape that gets a channel
// claimed. Whatever it returns, the plan is shaped before it renders.
test("reaction: the plan is shaped so the host carries it, not the source", { skip: !ffmpeg && "ffmpeg not installed" }, async () => {
  // A deliberately bad plan: opens on the source, one enormous clip, a token remark, way past the budget.
  await eng.api("POST", "/api/adapter-configs", { key: "llm_lazy_reaction", stage: "SCRIPT", impl: "llm_mock", config: { respond: [{ match: "Plan a reaction video", json: {
    title: "Reacting to the broadcast", description: "d", hashtags: ["reaction"],
    beats: [{ type: "play", start: 0, end: 600, chapter: "The clip" },
            { type: "comment", text: "Wow.", chapter: "Reaction" },
            { type: "play", start: 600, end: 1200 },
            { type: "comment", text: "Anyway, that is the story.", chapter: "Verdict" },
            { type: "play", start: 1200, end: 1800 }] } }] } });
  const p = await eng.api("POST", "/api/programs", { ...base(), key: "shaped", displayName: "Shaped reactions", contentType: "REACTION_CLIP", productionMethod: "REACTION_LONG",
    scriptAdapter: "llm_lazy_reaction", methodConfig: { reactor_url: join(dir, "reactor.mp4"), max_play_seconds: 20, max_play_minutes: 1, min_commentary_share: 0.35 } });
  await eng.api("POST", "/api/video-candidates", { nicheId: p.id, url: join(dir, "source.mp4"), title: "Test broadcast" });
  const it = await waitFor(async () => { const x = (await eng.api("GET", `/api/content-items?nicheId=${p.id}`))[0]; if (x?.status === "FAILED") throw new Error(x.rejection_note); return x?.status === "PENDING_REVIEW" && x; }, { timeout: 240000, interval: 1000, what: "a shaped reaction" });
  const full = await eng.api("GET", `/api/content-items/${it.id}`);
  const raw = (await eng.query(`SELECT script_meta FROM content_items WHERE id = $1`, [full.id]))[0]?.script_meta;
  const plan = typeof raw === "string" ? JSON.parse(raw) : raw;
  const beats = plan?.beats;
  assert.ok(beats?.length, "the shaped plan is kept with the item");
  assert.equal(beats[0].type, "comment", "it opens on the host");
  assert.equal(beats[beats.length - 1].type, "comment", "and closes on the host");
  for (const b of beats.filter((x) => x.type === "play")) assert.ok(b.end - b.start <= 20.01, `no clip longer than the cap (${b.end - b.start}s)`);
  const play = beats.filter((x) => x.type === "play").reduce((a, b) => a + (b.end - b.start), 0);
  assert.ok(play <= 60.01, `the source stays inside its budget (${play}s)`);
  assert.ok(plan.reaction.commentShare >= 0.34, `commentary carries the video (${Math.round(plan.reaction.commentShare * 100)}%)`);
});

// Picking the moment is the product. The transcript says what was said; the soundtrack says where something was
// happening and where nobody was speaking — and a cut that lands mid-word reads as an accident however good the
// moment is. This runs with no LLM and no key at all, which is also the day every quota is spent.
test("the clipper finds the loud moment and cuts it at the pauses", { skip: !ffmpeg && "ffmpeg not installed" }, async () => {
  // Three minutes of quiet with one loud stretch at 100-135s, and a clear pause either side of it.
  const src = join(dir, "loudspot.mp4");
  ff("-f", "lavfi", "-i", "testsrc2=size=640x360:rate=15:duration=180",
     "-f", "lavfi", "-i", "sine=frequency=200:duration=180",
     "-filter_complex", "[1:a]volume='if(between(t,100,135),1.0,if(between(t,97,100)+between(t,135,138),0.0,0.06))':eval=frame[a]",
     "-map", "0:v", "-map", "[a]", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", src);

  const p = await eng.api("POST", "/api/programs", { ...base(), key: "signalclip", displayName: "Signal clip",
    contentType: "PODCAST_CLIP", productionMethod: "PODCAST_HIGHLIGHT", clipAdapter: "clip_signal",
    methodConfig: { clips_per_video: 1, clip_min_seconds: 25, clip_max_seconds: 45, orientation: "9:16", min_score: 0 } });
  await eng.api("POST", "/api/video-candidates", { nicheId: p.id, url: src, title: "Quiet with one loud stretch" });
  const it = await waitFor(async () => { const x = (await eng.api("GET", `/api/content-items?nicheId=${p.id}`))[0]; if (x?.status === "FAILED") throw new Error(String(x.rejection_note).slice(-300)); return x?.status === "PENDING_REVIEW" && x; },
    { timeout: 300000, interval: 1000, what: "a clip chosen by sound" });

  const clip = (await eng.query(`SELECT start_seconds, end_seconds, reason FROM clips WHERE content_item_id=$1`, [it.id]))[0];
  const start = Number(clip.start_seconds), end = Number(clip.end_seconds);
  assert.ok(start >= 90 && start <= 115, `it starts on the loud stretch, not at the top of the video (started ${start}s)`);
  assert.ok(end > start + 15, `and it is long enough to be a clip (${(end - start).toFixed(0)}s)`);
  assert.match(clip.reason, /loudest stretch/, "and says why it chose there");
});

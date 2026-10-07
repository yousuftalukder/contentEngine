import { test } from "node:test";
import assert from "node:assert/strict";
import { startEngine, waitFor } from "./harness.mjs";

// A data explainer (6b) is the explainer pointed at numbers: the planner is told to build most scenes from charts,
// counted-up figures and timelines, with only the research's own numbers — and a plan made of those scenes is accepted.
// The studio is not needed to check either: the plan is accepted, and the description written from it, before the
// render, and the mock voice then stops the job at the render with its own message.
test("a data explainer asks the planner for data scenes, and a plan of figures and timelines is accepted", async () => {
  const eng = await startEngine({ env: { STUDIO_MIN_MEMORY_MB: "999999" } });   // no studio: each job stops after planning
  try {
    await eng.api("POST", "/api/adapter-configs", { key: "llm_data_planner", stage: "SCRIPT", impl: "llm_mock", config: { respond: [{ match: "This is a DATA explainer", json: {
      title: "Dhaka metro in numbers", description: "DATA PLAN", hashtags: ["data"], scenes: [
        { layout: "BigNumber", chapter: "Riders", data: { heading: "Riders every day", value: 410000, label: "people ride Line 6 on a weekday" }, parts: ["Four hundred and ten thousand people ride it every weekday."] },
        { layout: "Timeline", chapter: "Building it", data: { heading: "How it was built", events: [{ date: "2016", label: "Work begins" }, { date: "2022", label: "First section" }, { date: "2025", label: "Kamalapur" }] }, parts: ["Work began in 2016.", "The first section opened in 2022.", "It reached Kamalapur in 2025."] },
        { layout: "DataChart", chapter: "Growth", data: { heading: "Daily riders", kind: "line", unit: "k", data: [{ label: "2023", value: 180 }, { label: "2025", value: 410 }] }, parts: ["Ridership more than doubled."] }] } }] } });
    const b = await eng.api("POST", "/api/brands", { name: "Data brand" });
    const made = async (key, style) => {
      const p = await eng.api("POST", "/api/programs", { brandId: b.id, key, displayName: key, contentType: "ANIMATED_EXPLAINER", useMocks: true, autoStyle: false, autoSources: false,
        scriptAdapter: "llm_data_planner", scriptAdapterFallbacks: [], methodConfig: { explainer_minutes: 1, ...(style ? { explainer_style: style } : {}), qa: { enabled: false } } });
      const { id } = await eng.api("POST", "/api/generate", { nicheId: p.id, topic: "Dhaka metro ridership" });
      // The description is written from the accepted plan just before the render, so it is the check: whether the studio
      // is installed (it renders) or not (the job stops there) does not matter to what is being tested.
      return waitFor(async () => { const it = await eng.api("GET", `/api/content-items/${id}`); if (it.status === "FAILED" && !it.captions?.youtube) throw new Error(it.rejection_note); return it.captions?.youtube && it; }, { timeout: 60000, what: `${key} plan accepted` });
    };
    const data = await made("data_explainer", "data");
    assert.match(data.captions.youtube, /^DATA PLAN/, "the planner was asked for a data explainer, and its plan was used");
    assert.match(data.captions.youtube, /Riders[\s\S]*Building it[\s\S]*Growth/, "every BigNumber, Timeline and DataChart scene was accepted and timed");
    const general = await made("general_explainer", null);
    assert.doesNotMatch(general.captions.youtube, /^DATA PLAN/, "a general explainer is not asked for one");
  } finally { await eng.stop(); }
});

// 6d, a 3D explainer: the planner is told to use the 3D layouts, and each scene goes to Blender (a stand-in here) with
// its data, its cue frames and the brand's colours; the scenes are joined and narrated into one video.
test("a 3D explainer plans in 3D layouts and renders every scene through Blender", { skip: (await import("node:child_process")).spawnSync("ffmpeg", ["-version"]).status !== 0 && "ffmpeg not installed" }, async () => {
  const { mkdtempSync, readFileSync } = await import("node:fs"), { tmpdir } = await import("node:os"), { join, dirname } = await import("node:path"), { fileURLToPath } = await import("node:url");
  const log = join(mkdtempSync(join(tmpdir(), "ce-3d-")), "blender.log");
  const fake = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-blender.mjs");
  const tone = "-hide_banner -loglevel error -y -f lavfi -i sine=frequency=220:duration=2".split(" ");
  const eng = await startEngine({ env: { STUDIO_MIN_MEMORY_MB: "999999", BLENDER_BIN: fake, FAKE_BLENDER_LOG: log } });
  try {
    await eng.api("POST", "/api/adapter-configs", { key: "tts_tone3d", stage: "VOICE", impl: "tts_command", config: { command: "ffmpeg", args: [...tone, "{out}"], voice: "", format: "wav" } });
    await eng.api("POST", "/api/adapter-configs", { key: "llm_3d", stage: "SCRIPT", impl: "llm_mock", config: { respond: [{ match: "3D explainer rendered in Blender", json: {
      title: "Metro in 3D", description: "3D PLAN", hashtags: ["metro"], scenes: [
        { layout: "Title3D", chapter: "Start", data: { title: "Dhaka Metro", subtitle: "in numbers" }, parts: ["This is the Dhaka metro, in numbers."] },
        { layout: "Bars3D", chapter: "Riders", data: { heading: "Daily riders", unit: "k", data: [{ label: "2023", value: 180 }, { label: "2025", value: 410 }] }, parts: ["In 2023, a hundred and eighty thousand a day.", "By 2025, four hundred and ten thousand."] },
        { layout: "Words3D", chapter: "Why", data: { heading: "Why it works", words: ["Fast", "Cheap", "On time"] }, parts: ["It is fast.", "It is cheap.", "It runs on time."] },
        { layout: "TitleCard", data: { title: "not a 3D layout" }, parts: ["Dropped."] }] } }] } });
    const b = await eng.api("POST", "/api/brands", { name: "3D brand", brandKit: { primary_color: "#0b3d91", accent_color: "#ffc400" } });
    const p = await eng.api("POST", "/api/programs", { brandId: b.id, key: "three_d", displayName: "3D", contentType: "ANIMATED_EXPLAINER", useMocks: true, autoStyle: false, autoSources: false,
      scriptAdapter: "llm_3d", scriptAdapterFallbacks: [], voiceAdapter: "tts_tone3d", methodConfig: { explainer_minutes: 1, explainer_style: "3d", orientation: "16:9", qa: { enabled: false } } });
    const { id } = await eng.api("POST", "/api/generate", { nicheId: p.id, topic: "Dhaka metro ridership" });
    const it = await waitFor(async () => { const x = await eng.api("GET", `/api/content-items/${id}`); if (x.status === "FAILED") throw new Error(x.rejection_note); return x.status === "PENDING_REVIEW" && x; }, { timeout: 120000, what: "the 3D explainer" });
    const calls = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(calls.map((c) => c.spec.layout), ["Title3D", "Bars3D", "Words3D"], "each 3D scene went to Blender, and the non-3D one was dropped");
    assert.ok(calls.every((c) => /explainer3d\.py$/.test(c.script)), "through the scene template");
    const bars = calls[1].spec;
    assert.deepEqual(bars.data.data.map((d) => d.value), [180, 410], "with the research's own numbers");
    assert.equal(bars.cues.length, 2, "and a cue frame for each bar, from the narration");
    assert.deepEqual([bars.width, bars.height, bars.primary, bars.accent], [1280, 720, "#0b3d91", "#ffc400"], "at 720p in the brand's colours");
    const [video] = await eng.query(`SELECT meta, duration_seconds FROM media_assets WHERE content_item_id = $1 AND kind = 'VIDEO'`, [id]);
    const meta = typeof video.meta === "string" ? JSON.parse(video.meta) : video.meta;
    assert.equal(meta.method, "EXPLAINER_3D");
    const expected = calls.reduce((n, c) => n + c.spec.frames / c.spec.fps, 0);
    assert.ok(Math.abs(Number(video.duration_seconds) - expected) < 1.5, `the scenes joined into one video (${video.duration_seconds}s of ${expected.toFixed(1)}s)`);
    assert.match(it.captions.youtube, /^3D PLAN/);
    // The narration is burned in: the stand-in's frames are a flat dark blue, so white caption text is the only bright
    // thing in the lower part of the picture.
    const { spawnSync } = await import("node:child_process"), { writeFileSync } = await import("node:fs");
    const [hero] = await eng.query(`SELECT url FROM media_assets WHERE content_item_id = $1 AND kind = 'VIDEO' ORDER BY created_at DESC LIMIT 1`, [id]);
    const mp4 = join(dirname(log), "3d.mp4"); writeFileSync(mp4, Buffer.from(await (await fetch(hero.url.replace(/^https?:\/\/[^/]+/, eng.base))).arrayBuffer()));
    const stats = spawnSync("ffmpeg", ["-hide_banner", "-ss", "1.5", "-i", mp4, "-frames:v", "1", "-vf", "crop=iw:ih*0.35:0:ih*0.65,signalstats,metadata=print:key=lavfi.signalstats.YMAX", "-f", "null", "-"], { encoding: "utf8" });
    const ymax = Number((/YMAX=(\d+)/.exec(stats.stderr + stats.stdout) || [])[1]);
    assert.ok(ymax > 180, `captions are burned into the 3D video (brightest pixel in the lower third: ${ymax})`);
  } finally { await eng.stop(); }
});

// A plan short of what was asked is not used as it came: the writer is told what was missing and asked once more, and
// the better plan is the one rendered. (2026-10-07: two scenes for a one-minute data explainer, rendered as they were.)
test("a plan short of the scenes asked for is sent back once, and the fuller plan is used", async () => {
  const eng = await startEngine({ env: { STUDIO_MIN_MEMORY_MB: "999999" } });
  try {
    const scene = (layout, data, line) => ({ layout, chapter: layout, data, parts: [line] });
    await eng.api("POST", "/api/adapter-configs", { key: "llm_short_then_full", stage: "SCRIPT", impl: "llm_mock", config: { respond: [
      { match: "YOUR LAST PLAN WAS REJECTED", json: { title: "Full", description: "FULL PLAN", hashtags: [], scenes: [
        scene("TitleCard", { title: "Dhaka metro", subtitle: "in numbers" }, "This is the Dhaka metro."),
        scene("BigNumber", { heading: "Riders", value: 410000, label: "a day" }, "Four hundred and ten thousand ride it a day."),
        scene("BulletReveal", { heading: "Why", bullets: ["Fast", "Cheap"] }, "It is fast and cheap."),
        scene("FullQuote", { quote: "It changed my day", attribution: "A rider" }, "One rider says it changed her day.")] } },
      { match: "3D explainer", json: {} },
      { match: "You script animated explainer videos", json: { title: "Short", description: "SHORT PLAN", hashtags: [], scenes: [
        scene("TitleCard", { title: "Dhaka metro", subtitle: "" }, "The metro."), scene("BulletReveal", { heading: "Why", bullets: ["Fast"] }, "The metro is fast.")] } }] } });
    const b = await eng.api("POST", "/api/brands", { name: "Plans" });
    const p = await eng.api("POST", "/api/programs", { brandId: b.id, key: "plan_check", displayName: "Plan check", contentType: "ANIMATED_EXPLAINER", useMocks: true, autoStyle: false, autoSources: false,
      scriptAdapter: "llm_short_then_full", scriptAdapterFallbacks: [], methodConfig: { explainer_minutes: 1, qa: { enabled: false } } });
    const { id } = await eng.api("POST", "/api/generate", { nicheId: p.id, topic: "Dhaka metro ridership" });
    const it = await waitFor(async () => { const x = await eng.api("GET", `/api/content-items/${id}`); if (x.status === "FAILED" && !x.captions?.youtube) throw new Error(x.rejection_note); return x.captions?.youtube && x; }, { timeout: 60000, what: "the plan accepted" });
    assert.match(it.captions.youtube, /^FULL PLAN/, "the plan sent back for being short was replaced by the full one");
  } finally { await eng.stop(); }
});

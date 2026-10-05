import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startEngine, waitFor } from "./harness.mjs";

// 7a, a script over your own footage: a folder of clips, found by their names, the folder they are filed in, and a note
// beside one of them. Each section's footage phrase finds its clip; a section nothing in the folder fits is left to its
// picture (no stock key here, and the programme says own footage only).
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
test("own footage: each section takes the clip from your folder that fits its phrase", { skip: !hasFfmpeg && "ffmpeg not installed" }, async () => {
  const lib = mkdtempSync(join(tmpdir(), "ce-footage-"));
  mkdirSync(join(lib, "market"));
  const clip = (path) => spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=15:duration=12", "-c:v", "libx264", "-pix_fmt", "yuv420p", path]);
  clip(join(lib, "dhaka-rickshaw-rain.mp4")); clip(join(lib, "market", "fish-stall.mp4")); clip(join(lib, "clip0007.mp4"));
  writeFileSync(join(lib, "clip0007.txt"), "a wooden boat crossing the river at sunset");
  const eng = await startEngine();
  try {
    await eng.api("PUT", "/api/settings/ingest.enabled", { value: false });
    await eng.api("POST", "/api/adapter-configs", { key: "llm_script", stage: "SCRIPT", impl: "llm_mock", config: { respond: [{ match: "exactly 4 sections", json: {
      hook: "Dhaka in the rain", title: "A rainy day in Dhaka", kicker: "Life", place: "Bangladesh", description: "A day in the rain", hashtags: ["dhaka"], sections: [
        { narration: "The rickshaws keep going through the rain.", image_prompt: "rickshaws in rain", footage_query: "rickshaw rain" },
        { narration: "At the market the fish stalls stay open.", image_prompt: "fish market", footage_query: "fish market stall" },
        { narration: "By evening the boats cross the river.", image_prompt: "river boats", footage_query: "boat river" },
        { narration: "And the city sleeps.", image_prompt: "city at night", footage_query: "skyline night" }] } }] } });
    const b = await eng.api("POST", "/api/brands", { name: "Own footage" });
    const p = await eng.api("POST", "/api/programs", { brandId: b.id, key: "own_footage", displayName: "Own footage", contentType: "IMAGE_SLIDESHOW", useMocks: true, autoStyle: false, autoSources: false,
      scriptAdapter: "llm_script", scriptAdapterFallbacks: [], renderAdapter: "render_mock", methodConfig: { slides: 4, qa: { enabled: false }, footage_dir: lib, own_footage_only: true, describe_per_day: 0 } });
    const { id } = await eng.api("POST", "/api/generate", { nicheId: p.id, topic: "A rainy day in Dhaka" });
    await waitFor(async () => { const x = await eng.api("GET", `/api/content-items/${id}`); if (x.status === "FAILED") throw new Error(x.rejection_note); return x.status === "PENDING_REVIEW"; }, { timeout: 90000, what: "the video" });
    const used = (await eng.query(`SELECT meta FROM media_assets WHERE content_item_id = $1 AND kind = 'VIDEO' AND meta->>'provider' = 'own_footage'`, [id]))
      .map((r) => (typeof r.meta === "string" ? JSON.parse(r.meta) : r.meta)).sort((a, b) => a.section - b.section);
    assert.deepEqual(used.map((m) => [m.section, m.file.replace(/\\/g, "/")]), [[0, "dhaka-rickshaw-rain.mp4"], [1, "market/fish-stall.mp4"], [2, "clip0007.mp4"]],
      "by name, by the folder it is filed in, and by the note beside it; the night skyline has no clip");
  } finally { await eng.stop(); }
});

// A made video for a programme whose video work runs on the PC is made on the PC: an explainer needs the studio and a
// script over your footage needs the folder, and the server has neither. Text drafts stay on the server.
test("made videos go where the programme's video work runs; text stays on the server", async () => {
  const eng = await startEngine();
  try {
    await eng.api("PUT", "/api/settings/ingest.enabled", { value: false });
    const b = await eng.api("POST", "/api/brands", { name: "Routing" });
    const queueOf = async (body) => {
      const p = await eng.api("POST", "/api/programs", { brandId: b.id, useMocks: true, autoStyle: false, autoSources: false, ...body });
      const { id } = await eng.api("POST", "/api/generate", { nicheId: p.id, topic: "Anything" });
      const [j] = await eng.query(`SELECT queue FROM jobs WHERE content_item_id = $1 AND type = 'GENERATE_CONTENT'`, [id]); return j.queue;
    };
    assert.equal(await queueOf({ key: "pc_video", displayName: "PC video", contentType: "IMAGE_SLIDESHOW", computeWhere: "pc" }), "video_local");
    // An explainer is written on the server, where the AI key is; only its render goes to the PC (pc-worker test).
    assert.equal(await queueOf({ key: "pc_explainer", displayName: "PC explainer", contentType: "ANIMATED_EXPLAINER", computeWhere: "pc" }), "video");
    assert.equal(await queueOf({ key: "srv_video", displayName: "Server video", contentType: "IMAGE_SLIDESHOW" }), "video");
    assert.equal(await queueOf({ key: "pc_news", displayName: "PC news", contentType: "NEWS_STATIC", computeWhere: "pc" }), "text");
  } finally { await eng.stop(); }
});

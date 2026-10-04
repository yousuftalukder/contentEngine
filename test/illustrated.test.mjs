import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startEngine, waitFor } from "./harness.mjs";

// 6c, an illustrated series: the planner is given the programme's cast, and every Illustrated scene is drawn by the free
// image service — the place with nobody in it, and the character on white, with a seed taken from the character so a
// series' character is drawn alike every time. The studio is switched off here; drawing happens before the render.
// The stand-in refuses every other request the way the real service does without a token, so the retry is exercised.
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
test("illustrated series: the cast reaches the planner and each scene is drawn, a character always with the same seed", { skip: !hasFfmpeg && "ffmpeg not installed" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ce-draw-")), jpg = join(dir, "p.jpg");
  spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=512x512", "-frames:v", "1", jpg]);
  // A figure the way the service draws one: on white. A dark ring stands for the outline, with white inside it (a white
  // vest) that must survive the cut-out while the white outside goes.
  const fig = join(dir, "f.jpg");
  spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=white:s=512x512", "-vf", "drawbox=x=156:y=156:w=200:h=200:color=0x202020:t=30", "-frames:v", "1", fig]);
  const picture = readFileSync(jpg), figure = readFileSync(fig), drawn = []; let calls = 0;
  const stub = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    // The real service turns away every other request without a token, with an empty 402.
    if (++calls % 2 === 1) { res.writeHead(402, { "content-type": "application/json" }); return res.end("{}"); }
    drawn.push({ prompt: decodeURIComponent(url.pathname.replace(/^\/prompt\//, "")), seed: url.searchParams.get("seed"), w: url.searchParams.get("width") });
    res.writeHead(200, { "content-type": "image/jpeg" }); res.end(/Full body character/.test(drawn.at(-1).prompt) ? figure : picture);
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  const eng = await startEngine({ env: { STUDIO_MIN_MEMORY_MB: "999999", POLLINATIONS_API_BASE: `http://127.0.0.1:${stub.address().port}`, POLLINATIONS_RETRY_MS: "10" } });
  try {
    await eng.api("POST", "/api/adapter-configs", { key: "llm_story", stage: "SCRIPT", impl: "llm_mock", config: { respond: [{ match: "This is an ILLUSTRATED story", json: {
      title: "Rafi and the rain", description: "ILLUSTRATED PLAN", hashtags: ["story"], scenes: [
        { layout: "TitleCard", chapter: "Start", data: { title: "Rafi and the rain" }, parts: ["This is Rafi."] },
        { layout: "Illustrated", chapter: "Morning", data: { setting: "a Dhaka street at dawn", character: "Rafi", action: "pedalling his rickshaw", enter: "left", caption: "Every morning" }, parts: ["Every morning Rafi rides out."] },
        { layout: "Illustrated", chapter: "Rain", data: { setting: "the same street in heavy monsoon rain", character: "Rafi", action: "holding an umbrella", enter: "right", caption: "Then the rain came" }, parts: ["Then the rain came."] },
        { layout: "Illustrated", data: { setting: "a flooded lane with floating sandals", character: null, caption: "The lane" }, parts: ["The lane was a river."] }] } }] } });
    const b = await eng.api("POST", "/api/brands", { name: "Stories" });
    const p = await eng.api("POST", "/api/programs", { brandId: b.id, key: "rafi", displayName: "Rafi", contentType: "ANIMATED_EXPLAINER", useMocks: true, autoStyle: false, autoSources: false,
      scriptAdapter: "llm_story", scriptAdapterFallbacks: [], methodConfig: { explainer_minutes: 1, explainer_style: "illustrated", qa: { enabled: false },
        characters: [{ name: "Rafi", look: "a cheerful rickshaw driver in a green lungi and white vest" }] } });
    const { id } = await eng.api("POST", "/api/generate", { nicheId: p.id, topic: "A rainy day" });
    const it = await waitFor(async () => { const x = await eng.api("GET", `/api/content-items/${id}`); if (x.status === "FAILED" && !x.captions?.youtube) throw new Error(x.rejection_note); return x.captions?.youtube && x; }, { timeout: 60000, what: "the plan drawn" });
    assert.match(it.captions.youtube, /^ILLUSTRATED PLAN/, "the planner was told it is an illustrated story, with the cast");

    const places = drawn.filter((d) => /no people/.test(d.prompt)), figures = drawn.filter((d) => /Full body character/.test(d.prompt));
    assert.equal(places.length, 3, `each Illustrated scene's place is drawn (${drawn.length} pictures)`);
    assert.equal(figures.length, 2, "Rafi drawn for each of his two different actions");
    assert.ok(figures.every((f) => /green lungi/.test(f.prompt) && /white background/.test(f.prompt)), "from the cast's description, on white");
    assert.equal(new Set(figures.map((f) => f.seed)).size, 1, "with the same seed both times, so he looks the same");

    // Each figure is cut out of its background: transparent outside the outline, the white inside it kept.
    const [cut] = await eng.query(`SELECT url FROM media_assets WHERE content_item_id = $1 AND meta->>'purpose' = 'illustration figure' LIMIT 1`, [id]);
    assert.ok(cut, "a cut-out figure was stored");
    const png = join(dir, "cut.png"); writeFileSync(png, Buffer.from(await (await fetch(cut.url)).arrayBuffer()));
    const alpha = (x, y) => spawnSync("ffmpeg", ["-v", "error", "-i", png, "-vf", `crop=1:1:${x}:${y}`, "-f", "rawvideo", "-pix_fmt", "rgba", "-"]).stdout[3];
    assert.equal(alpha(10, 10), 0, "the background is gone");
    assert.equal(alpha(256, 256), 255, "the white inside the outline stays");
    assert.equal(alpha(170, 256), 255, "and so does the outline");
  } finally { await eng.stop(); await new Promise((r) => stub.close(r)); }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startEngine, waitFor } from "./harness.mjs";

// Your PC makes the files, but the keys live on the server: Pexels, Gemini. The PC asks the server to make the keyed
// call for it (KEY_RELAY) and never sees a key. One local stand-in answers for Pexels' API and CDN and for Gemini, and
// writes down which key each call carried, so the test can say whose key it was.
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const SERVER_PEXELS = "server-pexels-key", SERVER_GEMINI = "server-gemini-key";

async function stubApis(dir) {
  const photo = join(dir, "stock.jpg"), clip = join(dir, "broll.mp4");
  spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1600x1000", "-frames:v", "1", photo]);
  spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=720x1280:rate=30", "-t", "6", "-c:v", "libx264", "-pix_fmt", "yuv420p", clip]);
  const seen = { photos: [], videos: [], embed: [], describe: [], cdn: [] };
  const http = await import("node:http");
  const server = http.createServer((req, res) => { let raw = ""; req.on("data", (d) => (raw += d)); req.on("end", () => {
    const base = `http://127.0.0.1:${server.address().port}`, url = new URL(req.url, base), json = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (url.pathname === "/v1/search") {
      seen.photos.push({ query: url.searchParams.get("query"), auth: req.headers.authorization });
      return json({ photos: [{ id: 42, width: 1600, height: 1000, url: "https://pexels.com/p/42", photographer: "A Photographer", alt: "rain over a city", src: { large2x: `${base}/photo.jpg`, original: `${base}/photo.jpg` } }] });
    }
    if (url.pathname === "/videos/search") {
      seen.videos.push({ query: url.searchParams.get("query"), auth: req.headers.authorization });
      return json({ videos: [{ id: 7, duration: 6, url: "https://pexels.com/v/7", user: { name: "A Filmmaker" }, video_files: [{ file_type: "video/mp4", width: 720, height: 1280, link: `${base}/clip.mp4` }] }] });
    }
    if (url.pathname === "/photo.jpg" || url.pathname === "/clip.mp4") {
      seen.cdn.push({ path: url.pathname, auth: req.headers.authorization || null });
      res.writeHead(200, { "content-type": url.pathname.endsWith(".jpg") ? "image/jpeg" : "video/mp4" }); return res.end(readFileSync(url.pathname.endsWith(".jpg") ? photo : clip));
    }
    if (/:embedContent$/.test(url.pathname)) { seen.embed.push({ key: req.headers["x-goog-api-key"] }); return json({ embedding: { values: [0.11, 0.22, 0.33] } }); }
    if (/:generateContent$/.test(url.pathname)) {
      const body = JSON.parse(raw || "{}"), frames = (body.contents?.[0]?.parts || []).filter((p) => p.inline_data);
      if (frames.length) seen.describe.push({ key: req.headers["x-goog-api-key"], frames: frames.length });
      return json({ candidates: [{ content: { parts: [{ text: "A goat grazing on a green hill under a pale sky." }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10 } });
    }
    json({ models: [] });
  }); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { seen, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}
// The PC: the server's database, only the PC lane, and no key of its own (blanked, in case the developer's shell has one).
const pcEnv = (server, extra = {}) => ({ DATABASE_URL: server.databaseUrl, LANES: "video_local", RUN_SWEEPS: "false", PC_TUNNEL: "off", RELAY_POLL_MS: "200", PEXELS_API_KEY: "", GEMINI_API_KEY: "", ...extra });
const draft = (server, id, timeout = 90000) => waitFor(async () => { const x = await server.api("GET", `/api/content-items/${id}`); if (x.status === "FAILED") throw new Error(x.rejection_note); return x.status === "PENDING_REVIEW" && x; }, { timeout, interval: 300, what: "the draft" });

test("a news card made on the PC gets the server's Pexels photo and Gemini embedding; a PC with its own key asks nobody", { skip: !hasFfmpeg && "ffmpeg not installed" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ce-relay-"));
  const apis = await stubApis(dir);
  const server = await startEngine({ env: { PEXELS_API_KEY: SERVER_PEXELS, GEMINI_API_KEY: SERVER_GEMINI, GEMINI_API_BASE: apis.base } });
  let pc;
  try {
    await server.api("PUT", "/api/settings/ingest.enabled", { value: false });
    await server.api("PUT", "/api/settings/planner.enabled", { value: false });
    await server.api("PUT", "/api/settings/storage.on_pc", { value: true });
    await server.api("POST", "/api/adapter-configs", { key: "stock_relay", stage: "IMAGE", impl: "pexels_stock", config: { api_base: `${apis.base}/v1` } });
    await server.api("POST", "/api/adapter-configs", { key: "llm_relay_photo", stage: "SCRIPT", impl: "llm_mock",
      config: { respond: [{ match: "Produce JSON", json: { headline: "Monsoon rain floods Dhaka streets", summary: "Heavy rain left roads under water.", photo_query: "monsoon rain dhaka street", image_prompt: "rain", captions: { facebook: "x" }, hashtags: ["bd"] } }] } });
    const b = await server.api("POST", "/api/brands", { name: "Relay cards" });
    const p = await server.api("POST", "/api/programs", { brandId: b.id, key: "relay_card", displayName: "Relay card", contentType: "NEWS_STATIC", useMocks: true, autoStyle: false, autoSources: false,
      scriptAdapter: "llm_relay_photo", imageAdapter: "stock_relay", embedAdapter: "gemini_embed", methodConfig: { qa: { enabled: false } } });
    pc = await startEngine({ env: pcEnv(server) });
    const { id } = await server.api("POST", "/api/generate", { nicheId: p.id, topic: "Monsoon rain floods Dhaka streets" });
    const it = await draft(server, id);

    const [gen] = await server.query(`SELECT queue FROM jobs WHERE content_item_id = $1 AND type = 'GENERATE_CONTENT'`, [id]);
    assert.equal(gen.queue, "video_local", "the card was made on the PC");
    assert.equal(it.hero_media.meta.provider, "pexels", `it carries a Pexels photo, not a text card (${it.hero_media.meta.fallback || ""})`);
    assert.equal(it.hero_media.meta.overlay, "photocard");
    assert.ok(apis.seen.photos.length && apis.seen.photos.every((s) => s.auth === SERVER_PEXELS), `the search carried the server's key: ${JSON.stringify(apis.seen.photos)}`);
    assert.ok(apis.seen.cdn.some((c) => c.path === "/photo.jpg" && !c.auth), "and the photo itself came straight from the CDN, with no key");
    assert.ok(apis.seen.embed.length && apis.seen.embed.every((s) => s.key === SERVER_GEMINI), "the duplicate check's embedding was the server's Gemini call");
    const [row] = await server.query(`SELECT topic_embedding FROM content_items WHERE id = $1`, [id]);
    assert.deepEqual(JSON.parse(row.topic_embedding), [0.11, 0.22, 0.33], "and the vector came back to the PC, not a word count");

    const relays = await server.query(`SELECT queue, status, payload, result FROM jobs WHERE type = 'KEY_RELAY'`);
    const ops = relays.map((r) => JSON.parse(r.payload).op);
    assert.ok(ops.includes("pexels_photos") && ops.includes("gemini_embed"), `both crossed as named operations: ${ops}`);
    assert.ok(relays.every((r) => r.queue === "text" && r.status === "SUCCEEDED"), `on the server's text lane: ${JSON.stringify(relays.map((r) => [r.status, r.result]))}`);
    assert.equal((await server.query(`SELECT 1 FROM settings WHERE key LIKE 'relay.%'`)).length, 0, "the answers were collected and cleared");
    assert.ok(!pc.logs().includes(SERVER_PEXELS) && !pc.logs().includes(SERVER_GEMINI), "the PC never printed, and so never had, a key");
    assert.ok(!JSON.stringify(relays).includes(SERVER_PEXELS), "and no key passed through the job table");
    const [use] = await server.query(`SELECT COALESCE(SUM(units),0)::int AS n FROM api_usage_daily WHERE provider = 'pexels'`);
    assert.ok(use.n >= 1, "the server counted the use against its key");

    // A PC with a Pexels key of its own searches with it, directly, as before.
    await pc.stop(); pc = null;
    pc = await startEngine({ env: pcEnv(server, { PEXELS_API_KEY: "pc-own-key" }) });
    const before = (await server.query(`SELECT count(*)::int AS n FROM jobs WHERE type = 'KEY_RELAY' AND payload LIKE '%pexels%'`))[0].n;
    const p2 = await server.api("POST", "/api/programs", { brandId: b.id, key: "own_key_card", displayName: "Own key card", contentType: "NEWS_STATIC", useMocks: true, autoStyle: false, autoSources: false,
      scriptAdapter: "llm_relay_photo", imageAdapter: "stock_relay", methodConfig: { qa: { enabled: false } } });
    const asked = apis.seen.photos.length;
    const own = await server.api("POST", "/api/generate", { nicheId: p2.id, topic: "Monsoon rain floods Dhaka streets" });
    const it2 = await draft(server, own.id);
    assert.equal(it2.hero_media.meta.provider, "pexels");
    assert.ok(apis.seen.photos.length > asked && apis.seen.photos.slice(asked).every((s) => s.auth === "pc-own-key"), "the PC's own key did the search");
    assert.equal((await server.query(`SELECT count(*)::int AS n FROM jobs WHERE type = 'KEY_RELAY' AND payload LIKE '%pexels%'`))[0].n, before, "and nothing was relayed");
  } finally { await pc?.stop(); await server.stop(); await apis.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a reel made on the PC runs on the server's Pexels footage, and the PC's own clips are looked at by the server's Gemini", { skip: !hasFfmpeg && "ffmpeg not installed" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ce-relay-reel-")), library = join(dir, "library");
  mkdirSync(library, { recursive: true });
  spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25", "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(library, "unrelated-clip.mp4")]);
  const apis = await stubApis(dir);
  const server = await startEngine({ env: { PEXELS_API_KEY: SERVER_PEXELS, GEMINI_API_KEY: SERVER_GEMINI, GEMINI_API_BASE: apis.base } });
  let pc;
  try {
    await server.api("PUT", "/api/settings/ingest.enabled", { value: false });
    await server.api("PUT", "/api/settings/planner.enabled", { value: false });
    await server.api("PUT", "/api/settings/storage.on_pc", { value: true });
    await server.api("PUT", "/api/settings/footage.api_base", { value: `${apis.base}/videos` });
    await server.api("POST", "/api/adapter-configs", { key: "llm_relay_reel", stage: "SCRIPT", impl: "llm_mock", config: { respond: [{ match: "Write the video in exactly", json: {
      title: "Rain floods the capital", kicker: "Weather", description: "d", hashtags: ["bd"],
      sections: [{ narration: "Heavy rain has flooded several roads in the capital.", image_prompt: "rain", footage_query: "monsoon rain city" },
                 { narration: "The mayor visited the worst affected area this morning.", image_prompt: "mayor", footage_query: null }] } }] } });
    const b = await server.api("POST", "/api/brands", { name: "Relay reels" });
    const p = await server.api("POST", "/api/programs", { brandId: b.id, key: "relay_reel", displayName: "Relay reel", contentType: "NEWS_REEL", useMocks: true, autoStyle: false, autoSources: false,
      scriptAdapter: "llm_relay_reel", imageAdapter: "image_mock", voiceAdapter: "tts_mock", renderAdapter: "ffmpeg", methodConfig: { slides: 2, footage_dir: library, describe_per_day: 1, qa: { enabled: false } } });
    pc = await startEngine({ env: pcEnv(server) });
    const { id } = await server.api("POST", "/api/generate", { nicheId: p.id, topic: "Rain floods the capital" });
    const it = await draft(server, id, 150000);

    const media = await server.query(`SELECT kind, meta FROM media_assets WHERE content_item_id = $1 AND kind IN ('VIDEO','IMAGE')`, [id]);
    assert.equal(media.filter((m) => m.meta.provider === "pexels").length, 1, `the section that may use footage has a Pexels clip: ${JSON.stringify(media.map((m) => m.meta.provider))}`);
    assert.equal(it.hero_media.kind, "VIDEO");
    assert.deepEqual(apis.seen.videos.map((s) => s.auth), [SERVER_PEXELS], "searched once, with the server's key");
    assert.ok(apis.seen.cdn.some((c) => c.path === "/clip.mp4"), "the clip itself was downloaded from the CDN");

    assert.equal(apis.seen.describe.length, 1, "the library clip was looked at once");
    assert.equal(apis.seen.describe[0].key, SERVER_GEMINI, "by the server's Gemini");
    assert.ok(apis.seen.describe[0].frames >= 1 && apis.seen.describe[0].frames <= 4, "from a few stills, not the clip");
    const [remembered] = await server.query(`SELECT value FROM settings WHERE key LIKE 'footage.seen.%'`);
    const value = typeof remembered?.value === "string" ? JSON.parse(remembered.value) : remembered?.value;
    assert.match(value?.seen || "", /goat grazing/, "and what it saw is remembered for the library match");
    const relays = await server.query(`SELECT payload FROM jobs WHERE type = 'KEY_RELAY'`);
    assert.ok(relays.every((r) => !r.payload.includes("frames")), "the stills did not stay in the job history");
  } finally { await pc?.stop(); await server.stop(); await apis.close(); rmSync(dir, { recursive: true, force: true }); }
});

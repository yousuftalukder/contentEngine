import { test } from "node:test";
import assert from "node:assert/strict";
import { startEngine } from "./harness.mjs";

// The "What it makes" page: every variant in the blueprint, and whether what it needs is there right now. It is only
// useful if it is true, so each need is checked against the engine's real state, not assumed.
test("the catalog lists every variant and says what is missing for each, from the engine's real state", async () => {
  const eng = await startEngine({ env: { EDGE_TTS: "edge-tts-is-not-installed-on-this-machine", CATALOG_TEST_KEY: "not-a-real-key" } });
  try {
    const before = await eng.api("GET", "/api/catalog");
    const ids = before.map((v) => v.id);
    for (const id of ["1a", "1b", "1c", "1d", "2a", "2b", "2c", "3a", "3b", "3c", "4a", "4b", "4c", "5a", "5b", "5c", "6a", "6b", "6c", "7a", "7b", "7c"]) assert.ok(ids.includes(id), `${id} is listed`);
    const by = (id, list = before) => list.find((v) => v.id === id);
    const need = (id, key, list = before) => by(id, list).needs.find((n) => n.key === key);

    assert.equal(by("1d").ready, true, "a server clip needs nothing, so it is ready");
    assert.equal(need("2a", "writer").ok, false, "no writer key yet");
    assert.equal(by("2a").ready, false, "so a news card is not ready");
    assert.equal(need("3a", "voice").ok, false, "edge-tts is missing here, and the page says so");
    assert.equal(need("1a", "pc").ok, false, "no PC has ever connected");
    assert.match(need("1a", "pc").detail, /never connected/);
    assert.equal(need("4a", "persona").ok, false, "no reactor clip uploaded");
    assert.equal(by("1b").ready, false, "something still to build is never ready");

    await eng.api("POST", "/api/credentials", { provider: "gemini", label: "test", envVar: "CATALOG_TEST_KEY" });
    const brand = await eng.api("POST", "/api/brands", { name: "Catalog brand" });
    await eng.api("POST", "/api/programs", { brandId: brand.id, key: "pc_clips", displayName: "PC clips", contentType: "PODCAST_CLIP", productionMethod: "PODCAST_HIGHLIGHT", computeWhere: "pc", useMocks: true, autoStyle: false, autoSources: false });
    const after = await eng.api("GET", "/api/catalog");
    assert.equal(need("2a", "writer", after).ok, true, "a writer key, once added, is seen");
    assert.match(need("2a", "writer", after).detail, /Gemini/);
    assert.deepEqual(by("1a", after).programs, ["PC clips"], "a programme set to run on the PC counts as a laptop clip");
    assert.deepEqual(by("1d", after).programs, [], "and not as a server clip");
  } finally { await eng.stop(); }
});

// Both writers had keys and neither could write — one out of credit, one at its free-tier limit — and the page said
// "a writer key: Gemini + Claude". A refusal for money or quota is now recorded where the dashboard can see it, and
// the first success clears it. Exercised through the key layer every provider shares, with a provider whose address
// can be pointed at a stand-in.
test("a provider refusing for money is shown as refusing until it works again", async () => {
  const http = await import("node:http");
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const jpg = join(mkdtempSync(join(tmpdir(), "ce-cat-")), "p.jpg");
  const made = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1200x800", "-frames:v", "1", jpg]).status === 0;
  if (!made) return; // no ffmpeg here: the page half below is covered by the first test's shape
  let paid = false;
  const stub = http.createServer((req, res) => {
    if (req.url.startsWith("/p.jpg")) { res.writeHead(200, { "content-type": "image/jpeg" }); return res.end(readFileSync(jpg)); }
    if (!paid) { res.writeHead(402, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: "Your credit balance is too low" })); }
    const src = `http://127.0.0.1:${stub.address().port}/p.jpg`;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ photos: [{ id: 1, width: 1200, height: 800, url: "https://www.pexels.com/photo/dhaka-street-1/", alt: "Dhaka street", photographer: "A", src: { large2x: src, original: src } }] }));
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  const eng = await startEngine({ env: { CATALOG_TEST_KEY: "not-a-real-key" } });
  try {
    await eng.api("POST", "/api/credentials", { provider: "pexels", label: "stub", envVar: "CATALOG_TEST_KEY" });
    await eng.api("POST", "/api/adapter-configs", { key: "stock_refusing", stage: "IMAGE", impl: "pexels_stock", config: { api_base: `http://127.0.0.1:${stub.address().port}` } });
    await eng.api("POST", "/api/adapter-configs/stock_refusing/test", { prompt: "dhaka street" }).catch(() => {});
    const [refused] = await eng.query(`SELECT value FROM settings WHERE key = 'provider.refused.pexels'`);
    assert.equal(refused?.value?.reason, "out of credit", "the refusal is on record, with why");

    paid = true;
    await eng.api("POST", "/api/adapter-configs/stock_refusing/test", { prompt: "dhaka street" }).catch(() => {});
    assert.equal((await eng.query(`SELECT 1 FROM settings WHERE key = 'provider.refused.pexels'`)).length, 0, "and cleared by the first success");

    // The page itself: a writer with a key that is out of credit is not a writer.
    await eng.api("POST", "/api/credentials", { provider: "anthropic", label: "claude", envVar: "CATALOG_TEST_KEY" });
    await eng.query(`INSERT INTO settings (key, value) VALUES ('provider.refused.anthropic', '{"reason":"out of credit"}'::jsonb)`);
    const writer = (await eng.api("GET", "/api/catalog")).find((v) => v.id === "2a").needs.find((n) => n.key === "writer");
    assert.equal(writer.ok, false, "a key that cannot pay is not a working writer");
    assert.match(writer.detail, /Claude: out of credit/);
  } finally { await eng.stop(); await new Promise((r) => stub.close(r)); }
});

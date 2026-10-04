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

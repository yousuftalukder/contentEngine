import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { startEngine, waitFor } from "./harness.mjs";

// A free voice that actually speaks. edge-tts stands in here as a script with the same arguments that writes real
// audio, so the adapter is exercised end to end without asking Microsoft for anything. Whether Microsoft answers the
// address production runs from is a separate question, answered from production.
const ffmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-edge-tts.mjs");
const calls = (log) => readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("edge-tts reads each language in its own voice, refuses another provider's voice id, and stores the speech", { skip: !ffmpeg && "ffmpeg not installed" }, async () => {
  const log = join(mkdtempSync(join(tmpdir(), "ce-edge-")), "calls.jsonl");
  const eng = await startEngine({ env: { EDGE_TTS: FAKE, FAKE_EDGE_LOG: log } });
  try {
    const bn = await eng.api("POST", "/api/voices/test", { adapter: "tts_edge", lang: "bn" });
    assert.ok(bn.url, "the speech was stored");
    assert.ok(bn.duration_seconds > 1, `and it has length (${bn.duration_seconds}s)`);
    await eng.api("POST", "/api/voices/test", { adapter: "tts_edge", lang: "en", text: "Hello there." });
    // An ElevenLabs voice id on a programme must not be handed to Edge, which would refuse it.
    await eng.api("POST", "/api/voices/test", { adapter: "tts_edge", lang: "bn", voice: "21m00Tcm4TlvDq8ikWAM" });
    await eng.api("POST", "/api/voices/test", { adapter: "tts_edge", lang: "bn", voice: "bn-BD-PradeepNeural" });

    const [first, english, foreign, chosen] = calls(log);
    assert.equal(first.voice, "bn-BD-NabanitaNeural", "Bangla is read in a Bangladeshi voice");
    assert.match(first.text, /[ঀ-৿]/, "and the Bangla text reached it intact");
    assert.equal(english.voice, "en-US-AriaNeural", "English in an American one");
    assert.equal(foreign.voice, "bn-BD-NabanitaNeural", "another provider's voice id falls back to the language's voice");
    assert.equal(chosen.voice, "bn-BD-PradeepNeural", "an Edge voice that is asked for by name is the one used");

    const brand = await eng.api("POST", "/api/brands", { name: "Voice brand" });
    const p = await eng.api("POST", "/api/programs", { brandId: brand.id, key: "voiced", displayName: "Voiced",
      contentType: "NEWS_REEL", language: "bn", country: "Bangladesh", autoStyle: false, autoSources: false });
    assert.equal(p.voice_adapter, "tts_edge", "a new programme speaks with edge-tts first");
  } finally { await eng.stop(); }
});

// The deploy that adds edge-tts: programmes that already exist must move it to the front of their chain. The general
// upgrade rules only append fallbacks and only replace a primary with no key, so without this one edge-tts would land
// behind Piper, whose Bangla is silent. Two engines on one database, exactly like a redeploy.
test("on the first boot that has edge-tts, an existing programme moves it to the front and keeps its own choices behind", { skip: !ffmpeg && "ffmpeg not installed" }, async () => {
  const before = await startEngine({ env: { EDGE_TTS: "edge-tts-is-not-installed-on-this-machine" } });
  let after;
  try {
    const brand = await before.api("POST", "/api/brands", { name: "Existing brand" });
    const p = await before.api("POST", "/api/programs", { brandId: brand.id, key: "already_here", displayName: "Already here",
      contentType: "NEWS_REEL", language: "bn", country: "Bangladesh", useMocks: true, autoStyle: false, autoSources: false,
      voiceAdapter: "gemini_tts", voiceAdapterFallbacks: ["tts_piper"] });
    assert.equal(p.voice_adapter, "gemini_tts", "it starts on the voice it was given");

    after = await startEngine({ env: { DATABASE_URL: before.databaseUrl, EDGE_TTS: FAKE } });
    const row = await waitFor(async () => {
      const [r] = await after.query(`SELECT voice_adapter, voice_adapter_fallbacks FROM niches WHERE id = $1`, [p.id]);
      return r?.voice_adapter === "tts_edge" && r;
    }, { timeout: 60000, interval: 500, what: "the upgrade to move edge-tts to the front" });
    const fb = typeof row.voice_adapter_fallbacks === "string" ? JSON.parse(row.voice_adapter_fallbacks) : row.voice_adapter_fallbacks;
    assert.deepEqual(fb, ["gemini_tts", "tts_piper"], "the programme's own voices stay behind it, in order, each once");
  } finally { await after?.stop(); await before.stop(); }
});

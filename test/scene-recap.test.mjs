import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startEngine, waitFor } from "./harness.mjs";

// 5a: Gemini watches the video. Against a stand-in for the API: the video goes up through the Files API as a small
// proxy, the scenes come back with what is seen and said (one of them silent, given in clock time), and the recap
// writer is handed the scenes by picture. The cut is made from those scenes, with the film's own sound under the voice.
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
test("scene recap: Gemini reads the scenes from the picture and the recap is cut from them", { skip: !hasFfmpeg && "ffmpeg not installed" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ce-scenes-")), src = join(dir, "film.mp4");
  spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=15:duration=40", "-f", "lavfi", "-i", "sine=frequency=220:duration=40", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", src]);
  const uploads = [], prompts = []; let deleted = 0, proxyBytes = 0;
  const stub = http.createServer((req, res) => {
    const chunks = []; req.on("data", (d) => chunks.push(d)); req.on("end", () => {
      const url = new URL(req.url, "http://x"), base = `http://127.0.0.1:${stub.address().port}`;
      const send = (status, body, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
      if (url.pathname === "/upload/v1beta/files" && req.headers["x-goog-upload-command"] === "start") { uploads.push(req.headers["x-goog-upload-header-content-type"]); return send(200, {}, { "x-goog-upload-url": `${base}/upload-here` }); }
      if (url.pathname === "/upload-here") { proxyBytes = Buffer.concat(chunks).length; return send(200, { file: { name: "files/abc", uri: `${base}/files/abc`, state: "ACTIVE" } }); }
      if (req.method === "DELETE") { deleted++; return send(200, {}); }
      if (/:generateContent$/.test(url.pathname)) {
        const body = JSON.parse(Buffer.concat(chunks).toString()), text = JSON.stringify(body.contents);
        if (/file_data/.test(text)) {
          assert.equal(body.generationConfig.mediaResolution, "MEDIA_RESOLUTION_LOW");
          return send(200, { candidates: [{ content: { parts: [{ text: JSON.stringify([
            { start: 0, end: 8, seen: "a man in a red jacket stands on a rooftop at night", said: "I told you I would come back." },
            { start: "0:08", end: "0:20", seen: "he runs across the rooftop and jumps to the next building", said: "" },
            { start: 20, end: 40, seen: "a crowd below looks up and points", said: "Look, up there!" }]) }] } }], usageMetadata: { promptTokenCount: 4000, candidatesTokenCount: 300 } });
        }
        prompts.push(text);
        return send(200, { candidates: [{ content: { parts: [{ text: JSON.stringify({ title: "The rooftop", beats: [{ narration: "He came back, as he promised.", start: 0, end: 8 }, { narration: "And then he jumped.", start: 8, end: 20 }], hashtags: ["recap"] }) }] } }], usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 80 } });
      }
      send(404, { error: { message: "not here" } });
    });
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  const eng = await startEngine({ env: { GEMINI_API_KEY: "not-a-real-key", GEMINI_API_BASE: `http://127.0.0.1:${stub.address().port}` } });
  try {
    await eng.api("PUT", "/api/settings/ingest.enabled", { value: false });
    const b = await eng.api("POST", "/api/brands", { name: "Recaps" });
    const p = await eng.api("POST", "/api/programs", { brandId: b.id, key: "scene_recap", displayName: "Scene recap", contentType: "MOVIE_RECAP", productionMethod: "SCENE_RECAP",
      useMocks: true, autoStyle: false, autoSources: false, downloadAdapter: "direct", transcriptAdapter: "transcribe_mock", scriptAdapter: "gemini_live", scriptAdapterFallbacks: [],
      voiceAdapter: "tts_mock", renderAdapter: "ffmpeg", methodConfig: { qa: { enabled: false }, recap_seconds: 20, brand_finish: false } });
    const cand = await eng.api("POST", "/api/video-candidates", { nicheId: p.id, url: src, title: "The Rooftop" });
    const item = await waitFor(async () => {
      const [v] = await eng.query(`SELECT status, error_message FROM video_candidates WHERE id = $1`, [cand.id]); if (v?.status === "FAILED") throw new Error(v.error_message);
      const [it] = await eng.query(`SELECT id, status, script, rejection_note FROM content_items WHERE niche_id = $1`, [p.id]); if (it?.status === "FAILED") throw new Error(it.rejection_note);
      return it?.status === "PENDING_REVIEW" && it; }, { timeout: 120000, interval: 500, what: "the recap" });

    assert.deepEqual(uploads, ["video/mp4"], "the video itself went to Gemini, once");
    assert.ok(proxyBytes > 0 && proxyBytes < statSync(src).size / 2, `as a proxy far smaller than the film (${proxyBytes} of ${statSync(src).size} bytes)`);
    assert.ok(deleted >= 1, "and was deleted from Gemini afterwards");
    const [{ transcript }] = await eng.query(`SELECT transcript FROM video_candidates WHERE id = $1`, [cand.id]);
    const t = typeof transcript === "string" ? JSON.parse(transcript) : transcript;
    assert.equal(t.segments.length, 3, "every scene kept, the silent one too");
    assert.deepEqual([t.segments[1].start, t.segments[1].end], [8, 20], "clock times read as seconds");
    assert.ok(prompts.some((x) => /SEEN: he runs across the rooftop/.test(x) && /SAID: Look, up there!/.test(x)), "the recap writer was given the scenes by picture and word");
    assert.equal(item.script, "He came back, as he promised. And then he jumped.");
    const [{ script_meta }] = await eng.query(`SELECT script_meta FROM content_items WHERE id = $1`, [item.id]);
    const recap = (typeof script_meta === "string" ? JSON.parse(script_meta) : script_meta)?.recap;
    assert.deepEqual(recap?.beats?.map((b) => [b.start, b.end, b.narration]), [[0, 8, "He came back, as he promised."], [8, 20, "And then he jumped."]], "the scenes the recap was cut from are kept with the item, for Review");
    assert.equal(recap.seen, true, "and it says they were read from the picture");
    const [media] = await eng.query(`SELECT meta FROM media_assets WHERE content_item_id = $1 AND kind = 'VIDEO'`, [item.id]);
    assert.ok(media, "and the recap was rendered");
  } finally { await eng.stop(); await new Promise((r) => stub.close(r)); }
});

// 5a on your PC, which has no Gemini key: the recap used to be told from the dialogue alone (whisper), a 5b under a
// 5a's name. Now the PC sends the server the small copy Gemini watches; the server, whose key lives only in its own
// environment, reads the scenes; and the recap comes back to the PC to be cut.
test("scene recap on a PC without a key: the server watches the scenes, the PC cuts the recap", { skip: !hasFfmpeg && "ffmpeg not installed" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ce-scenes-pc-")), src = join(dir, "film.mp4");
  spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=15:duration=40", "-f", "lavfi", "-i", "sine=frequency=220:duration=40", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", src]);
  let watched = 0;
  const stub = http.createServer((req, res) => {
    const chunks = []; req.on("data", (d) => chunks.push(d)); req.on("end", () => {
      const url = new URL(req.url, "http://x"), base = `http://127.0.0.1:${stub.address().port}`;
      const send = (status, body, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
      if (url.pathname === "/upload/v1beta/files") return send(200, {}, { "x-goog-upload-url": `${base}/upload-here` });
      if (url.pathname === "/upload-here") return send(200, { file: { name: "files/abc", uri: `${base}/files/abc`, state: "ACTIVE" } });
      if (req.method === "DELETE") return send(200, {});
      if (/:generateContent$/.test(url.pathname)) {
        const text = JSON.stringify(JSON.parse(Buffer.concat(chunks).toString()).contents);
        if (/file_data/.test(text)) { watched++; return send(200, { candidates: [{ content: { parts: [{ text: JSON.stringify([
          { start: 0, end: 20, seen: "a woman opens a letter by a window", said: "" }, { start: 20, end: 40, seen: "she runs out into the rain", said: "Wait!" }]) }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 } }); }
        return send(200, { candidates: [{ content: { parts: [{ text: JSON.stringify({ title: "The letter", beats: [{ narration: "She opens the letter.", start: 0, end: 20 }, { narration: "And she runs.", start: 20, end: 40 }], hashtags: [] }) }] } }], usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 20 } });
      }
      send(200, { models: [] });
    });
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  const server = await startEngine({ env: { GEMINI_API_KEY: "server-only-key", GEMINI_API_BASE: `http://127.0.0.1:${stub.address().port}` } });
  let pc;
  try {
    await server.api("PUT", "/api/settings/ingest.enabled", { value: false });
    const b = await server.api("POST", "/api/brands", { name: "PC recaps" });
    const p = await server.api("POST", "/api/programs", { brandId: b.id, key: "pc_scene_recap", displayName: "PC scene recap", contentType: "MOVIE_RECAP", productionMethod: "SCENE_RECAP", computeWhere: "pc",
      useMocks: true, autoStyle: false, autoSources: false, downloadAdapter: "direct", transcriptAdapter: "whisper_cpp", scriptAdapter: "gemini_live", scriptAdapterFallbacks: [],
      voiceAdapter: "tts_mock", renderAdapter: "render_mock", methodConfig: { qa: { enabled: false }, recap_seconds: 20 } });
    pc = await startEngine({ env: { DATABASE_URL: server.databaseUrl, LANES: "video_local", RUN_SWEEPS: "false" } });
    const cand = await server.api("POST", "/api/video-candidates", { nicheId: p.id, url: src, title: "The Letter" });
    await waitFor(async () => {
      const [v] = await server.query(`SELECT status, error_message FROM video_candidates WHERE id = $1`, [cand.id]); if (v?.status === "FAILED") throw new Error(v.error_message);
      const [it] = await server.query(`SELECT status, rejection_note FROM content_items WHERE niche_id = $1`, [p.id]); if (it?.status === "FAILED") throw new Error(it.rejection_note);
      return it?.status === "PENDING_REVIEW"; }, { timeout: 180000, interval: 500, what: "the recap" });
    assert.equal(watched, 1, "Gemini watched the copy once, on the server");
    const [{ transcript }] = await server.query(`SELECT transcript FROM video_candidates WHERE id = $1`, [cand.id]);
    const t = typeof transcript === "string" ? JSON.parse(transcript) : transcript;
    assert.equal(t.scenes, true, "the recap was told from the scenes, not the dialogue");
    assert.equal(t.segments[1].visual, "she runs out into the rain");
    assert.equal(t.scene_video_url, undefined, "and the copy made for it is gone");
    const jobs = (await server.query(`SELECT type, queue FROM jobs ORDER BY created_at`)).filter((j) => ["PROCESS_CANDIDATE", "PICK_CLIPS", "RENDER_CLIP"].includes(j.type)).map((j) => `${j.type}@${j.queue}`);
    assert.deepEqual(jobs, ["PROCESS_CANDIDATE@video_local", "PICK_CLIPS@text", "RENDER_CLIP@video_local"]);
  } finally { await pc?.stop(); await server.stop(); await new Promise((r) => stub.close(r)); }
});

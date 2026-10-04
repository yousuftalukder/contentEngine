// Does the picker choose what a person would? Selection is the product, so it is measured, not assumed.
//
// Each case in eval/cases.json is a real video and the line any editor would clip from it. This downloads the audio,
// transcribes it with whisper.cpp exactly as production does (timestamps on), and runs each picker through the real
// engine — a local engine on an in-memory database, the transcript handed in, nothing rendered — asking for eight
// moments. It reports where the famous line ranks. A miss, or a hit at rank 6, is the finding; tune against the whole
// table, never one video.
//
//   node eval/selection.mjs                 every case, pickers clip_meaning and clip_signal
//   node eval/selection.mjs jfk-rice        one case
//   PICKERS=clip_meaning,llm_clipper node eval/selection.mjs   (llm_clipper needs a working writer key)
//   CASES=eval/holdout.json node eval/selection.mjs            the speeches no picker was tuned on
//
// Needs yt-dlp, ffmpeg and whisper.cpp on PATH (the PC's .tools: run pc/setup.ps1) and WHISPER_DIR pointing at the
// models. Audio and transcripts are cached in .tools/eval-cache, so a re-run only re-picks.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { startEngine, waitFor } from "../test/harness.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = join(ROOT, ".tools", "eval-cache");
const WHISPER_DIR = process.env.WHISPER_DIR || join(ROOT, ".tools", "whisper");
const MODEL = join(WHISPER_DIR, process.env.WHISPER_MODEL || "ggml-base.bin");
const PICKERS = (process.env.PICKERS || "clip_meaning,clip_signal").split(",").map((s) => s.trim()).filter(Boolean);
const TOP = Number(process.env.TOP) || 8;
const only = process.argv[2];
mkdirSync(CACHE, { recursive: true });

const run = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }); if (r.status !== 0) throw new Error(`${cmd} failed: ${(r.stderr || r.error?.message || "").slice(-400)}`); return r.stdout; };
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

function transcriptFor(c) {
  const audio = join(CACHE, `${c.id}.m4a`), wav = join(CACHE, `${c.id}.wav`), out = join(CACHE, `${c.id}`), json = `${out}.json`;
  if (!existsSync(json)) {
    if (!existsSync(audio)) { console.log(`  downloading ${c.id}`); run("yt-dlp", ["--no-warnings", "-q", "--retries", "5", "--fragment-retries", "5", "-f", "ba[ext=m4a]/ba", "-o", audio, c.url]); }
    if (!existsSync(wav)) run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", audio, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav]);
    console.log(`  transcribing ${c.id}`);
    run(process.env.WHISPER_CLI || "whisper-cli", ["-m", MODEL, "-f", wav, "-oj", "-of", out, "-l", "en"]);
  }
  const data = JSON.parse(readFileSync(json, "utf8"));
  return { audio, segments: data.transcription.map((x) => ({ start: x.offsets.from / 1000, end: x.offsets.to / 1000, text: String(x.text || "").trim() })).filter((s) => s.text && s.end > s.start) };
}

// Where each famous line is said: a segment, or two adjacent ones, whose words contain the phrase. Every occurrence
// counts — "I have a dream" is said eight times, and a clip of any of them is the clip.
function momentsIn(segments, phrases) {
  // When the phrase is said: the segment's start plus the words before it at a speaking pace (2.5 words a second),
  // capped by its share of the segment's text. Not the segment's middle: whisper folds the applause after a line into
  // the line's segment, and "Mr. Gorbachev, tear down this wall" then sat ten seconds into the cheering.
  const when = (s, text, want) => { const i = text.indexOf(want), before = text.slice(0, i).split(" ").filter(Boolean).length;
    return s.start + Math.min(before / 2.5, (s.end - s.start) * (i / Math.max(1, text.length))); };
  const found = [];
  for (const p of phrases) {
    const want = norm(p);
    segments.forEach((s, i) => {
      const one = norm(s.text), two = i + 1 < segments.length ? `${one} ${norm(segments[i + 1].text)}` : one;
      if (one.includes(want)) found.push({ phrase: p, at: when(s, one, want) });
      else if (two.includes(want) && !norm(segments[i + 1].text).includes(want)) found.push({ phrase: p, at: when(s, two, want) });
    });
  }
  return found;
}

// eval/cases.json is what the pickers are tuned on; eval/holdout.json is never looked at while tuning, and is the
// check that a change helps speeches it was not shaped around (CASES=eval/holdout.json).
const cases = JSON.parse(readFileSync(join(ROOT, process.env.CASES || join("eval", "cases.json")), "utf8")).filter((c) => !only || c.id === only);
// The LLM picker needs a writer. Keys are never read from the developer's environment by the test harness, so they are
// handed in by name: EVAL_ANTHROPIC_API_KEY or EVAL_GEMINI_API_KEY, and the picker uses whichever is there.
const writerEnv = { ...(process.env.EVAL_ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: process.env.EVAL_ANTHROPIC_API_KEY } : {}), ...(process.env.EVAL_GEMINI_API_KEY ? { GEMINI_API_KEY: process.env.EVAL_GEMINI_API_KEY } : {}) };
const writer = writerEnv.ANTHROPIC_API_KEY ? "anthropic_live" : writerEnv.GEMINI_API_KEY ? "gemini_live" : null;
if (PICKERS.includes("llm_clipper") && !writer) { console.log("llm_clipper needs EVAL_ANTHROPIC_API_KEY or EVAL_GEMINI_API_KEY"); process.exit(1); }
const eng = await startEngine({ env: { STUDIO_MIN_MEMORY_MB: "999999", ...writerEnv } });
const table = [];
try {
  await eng.api("PUT", "/api/settings/ingest.enabled", { value: false });
  const brand = await eng.api("POST", "/api/brands", { name: "Selection eval" });
  for (const c of cases) {
    console.log(c.id);
    let audio, segments;
    try { ({ audio, segments } = transcriptFor(c)); }
    catch (e) { console.log(`  skipped: ${e.message.slice(0, 200)}`); table.push({ case: c.id, picker: "-", rank: "could not fetch" }); continue; }
    const moments = momentsIn(segments, c.moments);
    if (!moments.length) { console.log(`  the transcript never says ${c.moments.map((m) => `"${m}"`).join(" or ")} — check the case`); table.push({ case: c.id, picker: "-", rank: "phrase not heard" }); continue; }
    const tkey = `eval_tr_${c.id.replace(/\W/g, "_")}`;
    await eng.api("POST", "/api/adapter-configs", { key: tkey, stage: "TRANSCRIBE", impl: "transcribe_mock", config: { segments } }).catch(() => {});
    for (const picker of PICKERS) {
      const p = await eng.api("POST", "/api/programs", { brandId: brand.id, key: `eval_${c.id}_${picker}`.replace(/\W/g, "_"), displayName: `${c.id} / ${picker}`,
        contentType: "PODCAST_CLIP", productionMethod: "PODCAST_HIGHLIGHT", useMocks: true, autoStyle: false, autoSources: false, language: "en",
        downloadAdapter: "direct", transcriptAdapter: tkey, clipAdapter: picker, renderAdapter: "render_mock", ...(writer ? { scriptAdapter: writer, scriptAdapterFallbacks: [] } : {}),
        methodConfig: { clips_per_video: TOP, min_clip_score: 0, captions: false, brand_finish: false } });
      const cand = await eng.api("POST", "/api/video-candidates", { nicheId: p.id, url: audio, title: c.title });
      const clips = await waitFor(async () => {
        const [v] = await eng.query(`SELECT status, error_message FROM video_candidates WHERE id = $1`, [cand.id]);
        if (v?.status === "FAILED") throw new Error(v.error_message);
        const rows = await eng.query(`SELECT start_seconds AS s, end_seconds AS e, score, reason FROM clips WHERE video_candidate_id = $1 ORDER BY score DESC`, [cand.id]);
        return v?.status === "PROCESSED" && rows.length && rows;
      }, { timeout: 15 * 60000, interval: 1000, what: `${picker} on ${c.id}` }).catch((e) => { console.log(`  ${picker}: ${e.message.slice(0, 200)}`); return []; });
      const hitAt = clips.findIndex((k) => moments.some((m) => m.at >= Number(k.s) && m.at <= Number(k.e)));
      // DETAIL=1: every pick, what it says and why it scored — what to read when the famous line loses.
      if (process.env.DETAIL) clips.forEach((k, i) => {
        const words = segments.filter((x) => x.end > Number(k.s) && x.start < Number(k.e)).map((x) => x.text).join(" ");
        console.log(`    ${i + 1}. ${Number(k.s).toFixed(0)}-${Number(k.e).toFixed(0)}s ${Number(k.score).toFixed(3)} ${i === hitAt ? "<= FAMOUS " : ""}| ${k.reason}
       "${words.slice(0, 220)}"`);
      });
      const rank = hitAt < 0 ? `miss (of ${clips.length})` : hitAt + 1;
      // Each famous line on its own as well: several listed for one speech must not hide that one of them is missed.
      const each = c.moments.map((ph) => { const i = clips.findIndex((k) => moments.some((m) => m.phrase === ph && m.at >= Number(k.s) && m.at <= Number(k.e))); return `"${ph}" ${i < 0 ? "-" : i + 1}`; });
      if (c.moments.length > 1) console.log(`  ${picker} per line: ${each.join(", ")}`);
      table.push({ case: c.id, picker, rank, top: clips[0] ? `${Number(clips[0].s).toFixed(0)}-${Number(clips[0].e).toFixed(0)}s ${Number(clips[0].score).toFixed(2)}` : "-" });
      console.log(`  ${picker}: famous line at rank ${rank}${hitAt >= 0 ? ` (${Number(clips[hitAt].s).toFixed(0)}-${Number(clips[hitAt].e).toFixed(0)}s, score ${Number(clips[hitAt].score).toFixed(3)}: ${clips[hitAt].reason})` : ""}`);
    }
  }
} finally { await eng.stop(); }

console.log("\ncase                picker         rank of the famous line   top pick");
for (const r of table) console.log(`${r.case.padEnd(20)}${r.picker.padEnd(15)}${String(r.rank).padEnd(26)}${r.top || ""}`);
const scored = table.filter((r) => r.picker !== "-");
for (const picker of PICKERS) {
  const mine = scored.filter((r) => r.picker === picker), first = mine.filter((r) => r.rank === 1).length, top3 = mine.filter((r) => typeof r.rank === "number" && r.rank <= 3).length;
  console.log(`${picker}: first ${first}/${mine.length}, top three ${top3}/${mine.length}`);
}
writeFileSync(join(CACHE, `results-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.json`), JSON.stringify(table, null, 2));

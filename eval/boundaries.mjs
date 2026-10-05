// Offline: are the LLM picker's misses near-misses at the cut boundaries? Re-scores every stored production eval run
// (clips of the hidden eval_llm_picker programme, cached whisper transcripts in .tools/eval-cache) under boundary
// rules, and prints how often the famous line is first / in the top three. Spends no API calls.
//   node --env-file=.env.pc eval/boundaries.mjs
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const pg = createRequire("E:/dev/contentengine/package.json")("pg");
const ROOT = "E:/dev/contentengine", CACHE = `${ROOT}/.tools/eval-cache`;
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
function momentsIn(segments, phrases) {
  const when = (s, text, want) => { const i = text.indexOf(want), before = text.slice(0, i).split(" ").filter(Boolean).length;
    return s.start + Math.min(before / 2.5, (s.end - s.start) * (i / Math.max(1, text.length))); };
  const found = [];
  for (const p of phrases) { const want = norm(p);
    segments.forEach((s, i) => { const one = norm(s.text), two = i + 1 < segments.length ? `${one} ${norm(segments[i + 1].text)}` : one;
      if (one.includes(want)) found.push(when(s, one, want)); else if (two.includes(want) && !norm(segments[i + 1].text).includes(want)) found.push(when(s, two, want)); }); }
  return found;
}
const cases = Object.fromEntries(["cases", "holdout", "fresh"].flatMap((set) => JSON.parse(readFileSync(`${ROOT}/eval/${set}.json`, "utf8")).map((c) => [c.id, { ...c, set }])));
const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }); await db.connect();
const { rows: cands } = await db.query(`SELECT v.id, v.title, v.created_at FROM video_candidates v JOIN niches n ON n.id = v.niche_id WHERE n.key = 'eval_llm_picker' AND v.status = 'PROCESSED' ORDER BY v.created_at`);
// Boundary rules to try, each a function (clip, segments) -> {s, e}
const segAt = (segs, t) => segs.find((x) => x.start <= t && t < x.end);
const rules = {
  as_is: (k) => ({ s: k.s, e: k.e }),
  start_to_sentence: (k, segs) => { const a = segAt(segs, k.s + 0.01); return { s: a && k.s - a.start <= 8 ? a.start : k.s, e: k.e }; },
  end_to_sentence: (k, segs) => { const b = segAt(segs, k.e - 0.01); return { s: k.s, e: b && b.end - k.e <= 8 ? b.end : k.e }; },
  both: (k, segs) => { const a = segAt(segs, k.s + 0.01), b = segAt(segs, k.e - 0.01); return { s: a && k.s - a.start <= 8 ? a.start : k.s, e: b && b.end - k.e <= 8 ? b.end : k.e }; },
};
const results = Object.fromEntries(Object.keys(rules).map((r) => [r, { first: 0, top3: 0, n: 0 }]));
const near = []; let runs = 0; const worse = [];
for (const v of cands) {
  const id = /\[eval:\w+:([\w-]+)\]/.exec(v.title)?.[1], c = cases[id]; if (!c) continue;
  const segs = JSON.parse(readFileSync(`${CACHE}/${id}.json`, "utf8")).transcription.map((x) => ({ start: x.offsets.from / 1000, end: x.offsets.to / 1000, text: String(x.text || "").trim() }));
  const moments = momentsIn(segs, c.moments); if (!moments.length) continue;
  const { rows: clips } = await db.query(`SELECT start_seconds::float s, end_seconds::float e, score FROM clips WHERE video_candidate_id = $1 ORDER BY score DESC`, [v.id]);
  if (!clips.length) continue; runs++;
  const rankOf = (rule) => clips.findIndex((k) => { const w = rule(k, segs); return moments.some((m) => m >= w.s && m <= w.e); }); const a0 = rankOf(rules.as_is), a1 = rankOf(rules.start_to_sentence); const sc = (h) => (h < 0 ? 99 : h); if (sc(a1) > sc(a0)) worse.push(id + " " + a0 + "->" + a1);
  for (const [name, rule] of Object.entries(rules)) {
    const hit = clips.findIndex((k) => { const w = rule(k, segs); return moments.some((m) => m >= w.s && m <= w.e); });
    const r = results[name]; r.n++; if (hit === 0) r.first++; if (hit >= 0 && hit < 3) r.top3++;
  }
  const top = clips[0], d = Math.min(...moments.map((m) => (m >= top.s && m <= top.e ? 0 : Math.min(Math.abs(m - top.s), Math.abs(m - top.e)))));
  near.push({ id, d: Number(d.toFixed(1)), top: `${top.s.toFixed(0)}-${top.e.toFixed(0)}`, at: moments.map((m) => m.toFixed(0)).join("/") });
}
await db.end(); console.log("worse:", JSON.stringify(worse));
console.log(`${runs} picker runs over ${new Set(near.map((x) => x.id)).size} speeches`);
for (const [name, r] of Object.entries(results)) console.log(`${name.padEnd(18)} first ${r.first}/${r.n}  top-3 ${r.top3}/${r.n}`);
console.log("top pick's distance from the famous line (s):");
for (const x of near.sort((a, b) => a.d - b.d)) if (x.d > 0) console.log(`  ${x.id.padEnd(24)} ${String(x.d).padStart(6)}  top ${x.top}  line at ${x.at}`);

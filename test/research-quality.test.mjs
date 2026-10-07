import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startEngine, waitFor } from "./harness.mjs";

// The quality floor of researched content, against a stand-in for Gemini that counts every request: on the free tier
// each one is one of the day's twenty for the model, so the floor may cost at most one more request per item, and only
// when the first answer is clearly below it. (2026-10-07: four notes with no numbers, and a plan that said "The metro
// rail impacts daily commuting in Dhaka regarding …" four times, went out as they came.)
const note = (i, topic) => ({ fact: `${topic}: fact number ${i + 1}, about ${["riders", "fares", "stations", "trains", "loans", "delays", "hours", "jobs", "power", "parking"][i % 10]}.`, source_url: `https://example.com/${i}`, source_name: "Example" });
const notes = (n, topic) => Array.from({ length: n }, (_, i) => note(i, topic));
const scene = (layout, data, line) => ({ layout, chapter: layout, data, parts: [line] });
const goodPlan = (description) => ({ title: "Dhaka metro", description, hashtags: [], scenes: [
  scene("TitleCard", { title: "Dhaka metro", subtitle: "explained" }, "Here is how the Dhaka metro changed the city."),
  scene("BigNumber", { heading: "Riders", value: 410000, label: "a day" }, "Four hundred and ten thousand people ride it every weekday."),
  scene("BulletReveal", { heading: "Why", bullets: ["Fast", "Cheap"] }, "A trip that took two hours by bus now takes forty minutes."),
  scene("FullQuote", { quote: "It changed my day", attribution: "A rider" }, "One rider says the train gave her back an evening with her children.")] });
const repetitivePlan = { title: "Dhaka metro", description: "REPETITIVE PLAN", hashtags: [], scenes: [
  scene("TitleCard", { title: "Dhaka metro", subtitle: "" }, "The metro rail impacts daily commuting in Dhaka regarding travel time."),
  scene("BulletReveal", { heading: "Cost", bullets: ["Cost"] }, "The metro rail impacts daily commuting in Dhaka regarding cost."),
  scene("BulletReveal", { heading: "Safety", bullets: ["Safety"] }, "The metro rail impacts daily commuting in Dhaka regarding safety."),
  scene("FullQuote", { quote: "Comfort", attribution: "A rider" }, "The metro rail impacts daily commuting in Dhaka regarding comfort.")] };

async function gemini(answer) {
  const calls = [];
  const stub = http.createServer((req, res) => {
    let raw = ""; req.on("data", (d) => (raw += d)); req.on("end", () => {
      const url = new URL(req.url, "http://x");
      if (!/:generateContent$/.test(url.pathname)) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ models: [] })); }
      const body = JSON.parse(raw), system = JSON.stringify(body.system_instruction || ""), prompt = (body.contents?.[0]?.parts || []).map((p) => p.text).join("");
      const kind = /meticulous researcher/.test(system) ? "research" : /script animated explainer videos/.test(system) ? "plan" : /long-form Facebook posts/.test(system) ? "post" : "other";
      const topic = (prompt.match(/Topic: ([^\n]+)/) || [])[1] || "";
      calls.push({ kind, topic, prompt });
      const data = answer({ kind, topic, prompt }) || {};
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(data) }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 } }));
    });
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  return { stub, calls, base: `http://127.0.0.1:${stub.address().port}`, count: (topic, kind) => calls.filter((c) => c.topic === topic && c.kind === kind).length };
}

test("researched content: thin research and a repetitive plan are each asked for once more, a good one is not, and research thin twice is flagged", async () => {
  const THIN_THEN_FULL = "Metro fares rise", REPEATS = "Metro hours extended", GOOD = "Metro reaches Kamalapur", THIN = "Metro parking plan";
  const g = await gemini(({ kind, topic, prompt }) => {
    if (kind === "research") {
      if (topic === THIN_THEN_FULL) return { notes: notes(/YOUR LAST NOTES WERE TOO THIN/.test(prompt) ? 9 : 3, topic), angle: "what it costs" };
      if (topic === THIN) return { notes: notes(2, topic), angle: "little to go on" };
      return { notes: notes(9, topic), angle: "what changed" };
    }
    if (kind === "plan") {
      if (topic === REPEATS) return /YOUR LAST PLAN WAS REJECTED/.test(prompt) ? goodPlan("DISTINCT PLAN") : repetitivePlan;
      return goodPlan(`PLAN FOR ${topic}`);
    }
    if (kind === "post") return { headline: topic, post: `${topic}.\n\nWhat little is known.`, hashtags: ["metro"], image_prompt: "a train" };
    return null;
  });
  const eng = await startEngine({ env: { STUDIO_MIN_MEMORY_MB: "999999", GEMINI_API_KEY: "not-a-real-key", GEMINI_API_BASE: g.base } });
  try {
    const b = await eng.api("POST", "/api/brands", { name: "Research floor" });
    const program = (key, contentType, methodConfig) => eng.api("POST", "/api/programs", { brandId: b.id, key, displayName: key, contentType, useMocks: true, autoStyle: false, autoSources: false,
      scriptAdapter: "gemini_live", scriptAdapterFallbacks: [], methodConfig: { qa: { enabled: false }, ...methodConfig } });
    const explainers = await program("floor_explainer", "ANIMATED_EXPLAINER", { explainer_minutes: 1 });
    const posts = await program("floor_posts", "LONG_POST", { cover_image: false });
    const src = (x) => (typeof x.source_data_ref === "string" ? JSON.parse(x.source_data_ref) : x.source_data_ref) || {};
    // The description is written from the accepted plan just before the render; without a studio the job stops there.
    const planned = async (topic) => {
      const { id } = await eng.api("POST", "/api/generate", { nicheId: explainers.id, topic });
      return waitFor(async () => { const x = await eng.api("GET", `/api/content-items/${id}`); if (x.status === "FAILED" && !x.captions?.youtube) throw new Error(x.rejection_note); return x.captions?.youtube && x; }, { timeout: 60000, what: `${topic} planned` });
    };

    // (a) Three notes: asked once more, told what was missing and given the material again; the nine notes are used.
    const a = await planned(THIN_THEN_FULL);
    assert.equal(g.count(THIN_THEN_FULL, "research"), 2, "thin research was asked for once more, and only once");
    assert.equal(g.count(THIN_THEN_FULL, "plan"), 1);
    const reask = g.calls.filter((c) => c.topic === THIN_THEN_FULL && c.kind === "research")[1].prompt;
    assert.match(reask, /only 3 note\(s\), and at least 6 are needed/, "the second ask names what was missing");
    assert.match(reask, /SOURCE MATERIAL[\s\S]*Metro fares rise/, "and carries the material again");
    assert.match(reask, /Never invent/);
    const [kept] = await eng.query(`SELECT notes FROM research_notes WHERE content_item_id = $1`, [a.id]);
    assert.equal((typeof kept.notes === "string" ? JSON.parse(kept.notes) : kept.notes).length, 9, "the fuller research is the one kept");
    assert.ok(g.calls.find((c) => c.topic === THIN_THEN_FULL && c.kind === "plan").prompt.includes("fact number 9"), "and the plan is written from it");
    assert.notEqual(src(a).research_thin, true, "research that met the floor the second time is not flagged");

    // (b) The same sentence four times: the plan is sent back once, saying the lines repeat, and the distinct one is used.
    const r = await planned(REPEATS);
    assert.equal(g.count(REPEATS, "research"), 1, "good research is not asked for again");
    assert.equal(g.count(REPEATS, "plan"), 2, "the repetitive plan was sent back once");
    assert.match(g.calls.filter((c) => c.topic === REPEATS && c.kind === "plan")[1].prompt, /YOUR LAST PLAN WAS REJECTED: it had lines repeat: "the metro rail impacts daily" is said 4 times/);
    assert.match(r.captions.youtube, /^DISTINCT PLAN/, "and the plan whose lines do not repeat is the one used");

    // (c) Good research and a good plan: one request each, nothing more.
    const c = await planned(GOOD);
    assert.equal(g.count(GOOD, "research"), 1, "no extra research request");
    assert.equal(g.count(GOOD, "plan"), 1, "no extra plan request");
    assert.match(c.captions.youtube, /^PLAN FOR Metro reaches Kamalapur/);
    assert.notEqual(src(c).research_thin, true);

    // (d) A long post whose research is thin both times: asked once more (no more than that), written, and flagged.
    const { id } = await eng.api("POST", "/api/generate", { nicheId: posts.id, topic: THIN });
    const d = await waitFor(async () => { const x = await eng.api("GET", `/api/content-items/${id}`); if (x.status === "FAILED") throw new Error(x.rejection_note); return x.status === "PENDING_REVIEW" && x; }, { timeout: 60000, what: "the thin long post" });
    assert.equal(g.count(THIN, "research"), 2, "thin research is asked for once more, and not a third time");
    assert.equal(g.count(THIN, "post"), 1);
    assert.equal(src(d).research_thin, true, "the draft carries that its research stayed thin");
  } finally { await eng.stop(); await new Promise((r) => g.stub.close(r)); }
});

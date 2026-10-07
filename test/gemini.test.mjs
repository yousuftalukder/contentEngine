import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startEngine, waitFor } from "./harness.mjs";

// The writer production actually runs: Gemini's model fallback, against a stand-in for the API. Every Flash model has
// spent today's free allowance; the account also lists a Pro model that a free key gets none of ("limit: 0"). The job
// must wait for the reset — and say so — rather than report the Pro model, and the Pro model must not be asked again by
// every job for the rest of the day.
const daily = (model) => JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: `You exceeded your current quota. Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: ${model}`,
  details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] }] } });
const none = (model) => JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: `You exceeded your current quota. Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 0, model: ${model}` } });

test("Gemini: when the free allowance is spent, the job waits for the reset and a Pro model the plan excludes is not asked again", async () => {
  const asked = [];
  const stub = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (req.method === "GET" && url.pathname === "/v1beta/models") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ models: ["gemini-flash-latest", "gemini-flash-lite-latest", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-pro-latest"].map((n) => ({ name: `models/${n}`, supportedGenerationMethods: ["generateContent"] })) }));
    }
    const m = /\/v1beta\/models\/([^:]+):generateContent/.exec(url.pathname);
    if (m) { asked.push(m[1]); res.writeHead(429, { "content-type": "application/json" }); return res.end(/pro/.test(m[1]) ? none(m[1]) : daily(m[1])); }
    res.writeHead(404); res.end("{}");
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  const eng = await startEngine({ env: { GEMINI_API_KEY: "not-a-real-key", GEMINI_API_BASE: `http://127.0.0.1:${stub.address().port}` } });
  try {
    const brand = await eng.api("POST", "/api/brands", { name: "Gemini brand" });
    const p = await eng.api("POST", "/api/programs", { brandId: brand.id, key: "free_key", displayName: "Free key", contentType: "NEWS_STATIC",
      useMocks: true, autoStyle: false, autoSources: false, scriptAdapter: "gemini_live", scriptAdapterFallbacks: [] });
    const parked = async (id) => waitFor(async () => {
      const [j] = await eng.query(`SELECT status, run_after, error_message FROM jobs WHERE content_item_id = $1 AND type = 'GENERATE_CONTENT'`, [id]);
      return j?.status === "PENDING" && j.error_message && j;
    }, { timeout: 60000, what: "the job to be parked" });

    const { id: first } = await eng.api("POST", "/api/generate", { nicheId: p.id, topic: "Ferry service resumes at Paturia" });
    const job = await parked(first);
    assert.ok(job.run_after, "it waits for a time, not forever");
    assert.match(job.error_message, /PerDay|limit: 20/, `the reason given is the spent daily allowance — got: ${job.error_message.slice(0, 300)}`);
    assert.doesNotMatch(job.error_message, /limit: 0/, "not the Pro model nobody chose");
    assert.match(job.error_message, /\[metric [^\]]*quota GenerateRequestsPerDayPerProjectPerModel-FreeTier/, "and the stored error names the limit up front");
    assert.equal(asked.filter((m) => /pro/.test(m)).length, 1, "the Pro model was tried once, as a stand-in");

    const { id: second } = await eng.api("POST", "/api/generate", { nicheId: p.id, topic: "Metro rail extends its hours" });
    await parked(second);
    assert.equal(asked.filter((m) => /pro/.test(m)).length, 1, "and not asked again by the next job");
  } finally { await eng.stop(); await new Promise((r) => stub.close(r)); }
});

// One Bangla news draft in fifty was lost to an answer cut off at the length limit: unreadable JSON. Gemini says when
// that happened (finishReason MAX_TOKENS); the writer asks once more with twice the room and the draft is written.
test("Gemini: an answer cut off at the length limit is asked for again with more room", async () => {
  const budgets = [];
  const full = JSON.stringify({ headline: "নৌ চলাচল আবার শুরু", summary: "তিন দিন পর পাটুরিয়ায় ফেরি চলাচল শুরু হয়েছে।", captions: { facebook: "ফেরি চলাচল আবার শুরু" }, hashtags: ["খবর"] });
  const stub = http.createServer((req, res) => {
    let raw = ""; req.on("data", (d) => (raw += d)); req.on("end", () => {
      const url = new URL(req.url, "http://x");
      if (!/:generateContent$/.test(url.pathname)) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ models: [] })); }
      // Only the news writer's request is followed; any other call in the pipeline gets a plain complete answer.
      const body = JSON.parse(raw), writer = /Produce JSON/.test(JSON.stringify(body.contents));
      if (writer) budgets.push(body.generationConfig?.maxOutputTokens);
      const cut = writer && budgets.length === 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ candidates: [{ finishReason: cut ? "MAX_TOKENS" : "STOP", content: { parts: [{ text: cut ? full.slice(0, 40) : full }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 } }));
    });
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  const eng = await startEngine({ env: { GEMINI_API_KEY: "not-a-real-key", GEMINI_API_BASE: `http://127.0.0.1:${stub.address().port}` } });
  try {
    const brand = await eng.api("POST", "/api/brands", { name: "Cut off" });
    const p = await eng.api("POST", "/api/programs", { brandId: brand.id, key: "cut_off", displayName: "Cut off", contentType: "NEWS_STATIC", language: "bn",
      useMocks: true, autoStyle: false, autoSources: false, scriptAdapter: "gemini_live", scriptAdapterFallbacks: [], methodConfig: { qa: { enabled: false } } });
    const { id } = await eng.api("POST", "/api/generate", { nicheId: p.id, topic: "পাটুরিয়ায় ফেরি চলাচল" });
    const it = await waitFor(async () => { const x = await eng.api("GET", `/api/content-items/${id}`); if (x.status === "FAILED") throw new Error(x.rejection_note); return x.status === "PENDING_REVIEW" && x; }, { timeout: 60000, what: "the draft" });
    assert.equal(it.headline, "নৌ চলাচল আবার শুরু", "the draft is the second, complete answer");
    assert.equal(budgets.length, 2, `the writer was asked twice, not once and then retried as a failure (${budgets.join(" → ")})`);
    assert.ok(budgets[1] > budgets[0], `the second time with more room (${budgets.join(" → ")})`);
  } finally { await eng.stop(); await new Promise((r) => stub.close(r)); }
});

// Research asks Gemini to search the web, and search is its own allowance: a plan or model can refuse it while the model
// itself still answers. Then the research is asked once more without search and the draft says so — instead of every
// researched format (long posts, explainers) failing at its first step. A spent daily allowance for the model is a
// different thing and is not retried without search: the job waits for the reset as before.
test("Gemini: research the web search is refused for is done without it, and the draft says so", async () => {
  let mode = "refuse"; const seen = [];
  const stub = http.createServer((req, res) => {
    let raw = ""; req.on("data", (d) => (raw += d)); req.on("end", () => {
      const url = new URL(req.url, "http://x");
      if (!/:generateContent$/.test(url.pathname)) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ models: [] })); }
      const body = JSON.parse(raw), text = JSON.stringify(body.contents), research = /meticulous researcher/.test(JSON.stringify(body.system_instruction));
      seen.push({ research, search: !!body.tools, what: JSON.stringify(body.system_instruction || body.contents).slice(0, 160) });
      if (body.tools && mode === "refuse") { res.writeHead(400, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: { code: 400, status: "INVALID_ARGUMENT", message: "Search Grounding is not supported for this model." } })); }
      if (mode === "daily") { res.writeHead(429, { "content-type": "application/json" }); return res.end(daily("gemini-flash-latest")); }
      const answer = research ? { notes: [{ fact: "The ferry carried 4,000 people a day before the closure.", source_url: "https://example.com/ferry", source_name: "Example" }], angle: "what the closure cost" }
        : { headline: "Paturia ferries are back", post: `Ferries are running again at Paturia.\n\n${/4,000/.test(text) ? "They carried 4,000 people a day." : ""}`, hashtags: ["ferry"], image_prompt: "a ferry" };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(answer) }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 } }));
    });
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  const eng = await startEngine({ env: { GEMINI_API_KEY: "not-a-real-key", GEMINI_API_BASE: `http://127.0.0.1:${stub.address().port}` } });
  try {
    const brand = await eng.api("POST", "/api/brands", { name: "No search" });
    const p = await eng.api("POST", "/api/programs", { brandId: brand.id, key: "no_search", displayName: "No search", contentType: "LONG_POST",
      useMocks: true, autoStyle: false, autoSources: false, scriptAdapter: "gemini_live", scriptAdapterFallbacks: [], methodConfig: { qa: { enabled: false }, cover_image: false } });
    const { id } = await eng.api("POST", "/api/generate", { nicheId: p.id, topic: "Paturia ferry service resumes" });
    const it = await waitFor(async () => { const x = await eng.api("GET", `/api/content-items/${id}`); if (x.status === "FAILED") throw new Error(x.rejection_note); return x.status === "PENDING_REVIEW" && x; }, { timeout: 60000, what: "the draft" });
    assert.match(it.body, /4,000/, "the post was written from the research done without search");
    const r = seen.filter((s) => s.research);
    assert.ok(r[0].search, "research asked for web search first");
    assert.equal(r.at(-1).search, false, "and was asked once more without it");
    const src = typeof it.source_data_ref === "string" ? JSON.parse(it.source_data_ref) : it.source_data_ref;
    assert.equal(src.research_searched, false, "the draft carries that its research had no web search");
    const [n] = await eng.query(`SELECT created_by FROM research_notes WHERE content_item_id = $1`, [id]);
    assert.match(n.created_by, /no web search/, "and so do its research notes, which the fact check reads");

    mode = "daily"; seen.length = 0;
    const { id: second } = await eng.api("POST", "/api/generate", { nicheId: p.id, topic: "Metro rail extends its hours" });
    await waitFor(async () => { const [j] = await eng.query(`SELECT status, error_message FROM jobs WHERE content_item_id = $1 AND type = 'GENERATE_CONTENT'`, [second]); return j?.status === "PENDING" && j.error_message && j; }, { timeout: 60000, what: "the job to wait for the reset" });
    // Only the research is judged: a one-off boot upgrade may also ask for a house style for the new programme meanwhile.
    const research = seen.filter((x) => x.research);
    assert.ok(research.length && research.every((x) => x.search), `a spent daily allowance is not retried without search: ${JSON.stringify(research.filter((x) => !x.search))}`);
  } finally { await eng.stop(); await new Promise((r) => stub.close(r)); }
});

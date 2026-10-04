import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startEngine, waitFor } from "./harness.mjs";

const listen = async (handler) => { const s = http.createServer(handler); await new Promise((r) => s.listen(0, "127.0.0.1", r)); return s; };
const send = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

// No billing: Gemini's free allowance is about twenty requests a day per model, and a news day spends it by mid-morning.
// A free Groq key then stands behind it. Here every Gemini model is spent for the day; a programme created with no
// writer named gets Gemini first and Groq behind it, and the draft is written by Groq — whose first model is at its
// per-minute limit, so the next model answers.
test("free writers: when Gemini's daily allowance is spent, Groq writes the draft", async () => {
  const gemini = await listen((req, res) => {
    const url = new URL(req.url, "http://x");
    if (req.method === "GET") return send(res, 200, { models: [] });
    const model = (/models\/([^:]+):/.exec(url.pathname) || [])[1];
    send(res, 429, { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: `You exceeded your current quota. Quota exceeded for metric: generate_content_free_tier_requests, limit: 20, model: ${model}`,
      details: [{ violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] }] } });
  });
  const asked = [], auth = new Set();
  const groq = await listen((req, res) => {
    let raw = ""; req.on("data", (d) => (raw += d)); req.on("end", () => {
      auth.add(req.headers.authorization);
      if (req.url !== "/chat/completions") return send(res, 404, { error: { message: "not here" } });
      const b = JSON.parse(raw); asked.push(b.model);
      if (b.model === "llama-3.3-70b-versatile") return send(res, 429, { error: { message: "Rate limit reached for model `llama-3.3-70b-versatile` on tokens per minute (TPM): Limit 12000, Used 11950, Requested 900. Please try again in 4.2s.", type: "tokens", code: "rate_limit_exceeded" } });
      const answer = { headline: "Ferry service resumes at Paturia", summary: "Ferries crossed again after three days of fog.", captions: { facebook: "Ferries are running again at Paturia." }, hashtags: ["Paturia"] };
      send(res, 200, { model: b.model, choices: [{ message: { content: JSON.stringify(answer) } }], usage: { prompt_tokens: 300, completion_tokens: 80 } });
    });
  });
  const eng = await startEngine({ env: { GEMINI_API_KEY: "not-a-real-key", GEMINI_API_BASE: `http://127.0.0.1:${gemini.address().port}`,
    GROQ_API_KEY: "not-a-real-groq-key", GROQ_API_BASE: `http://127.0.0.1:${groq.address().port}` } });
  try {
    const brand = await eng.api("POST", "/api/brands", { name: "Free writers" });
    const p = await eng.api("POST", "/api/programs", { brandId: brand.id, key: "free_writers", displayName: "Free writers", contentType: "NEWS_STATIC",
      autoStyle: false, autoSources: false, imageAdapter: "image_mock", imageAdapterFallbacks: [], embedAdapter: "embed_mock", methodConfig: { qa: { enabled: false } } });
    const [n] = await eng.query(`SELECT script_adapter, script_adapter_fallbacks FROM niches WHERE id = $1`, [p.id]);
    assert.equal(n.script_adapter, "gemini_live", "Gemini writes first");
    assert.match(JSON.stringify(n.script_adapter_fallbacks), /groq_live/, `with Groq behind it: ${JSON.stringify(n.script_adapter_fallbacks)}`);

    const { id } = await eng.api("POST", "/api/generate", { nicheId: p.id, topic: "Ferry service resumes at Paturia" });
    const it = await waitFor(async () => { const x = await eng.api("GET", `/api/content-items/${id}`); if (x.status === "FAILED") throw new Error(x.rejection_note); return x.status === "PENDING_REVIEW" && x; }, { timeout: 60000, what: "the draft" });
    assert.equal(it.headline, "Ferry service resumes at Paturia");
    assert.deepEqual(asked.slice(0, 2), ["llama-3.3-70b-versatile", "openai/gpt-oss-120b"], `the next Groq model answered when the first was at its limit: ${asked.join(", ")}`);
    assert.deepEqual([...auth], ["Bearer not-a-real-groq-key"], "with the Groq key");

    const catalog = await eng.api("GET", "/api/catalog");
    const writer = catalog.find((v) => v.id === "2a").needs.find((n) => n.key === "writer");
    assert.ok(writer.ok && /Groq/.test(writer.detail), `the catalog counts Groq as a writer: ${writer.detail}`);
  } finally { await eng.stop(); await new Promise((r) => gemini.close(r)); await new Promise((r) => groq.close(r)); }
});

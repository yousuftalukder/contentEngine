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
    assert.equal(asked.filter((m) => /pro/.test(m)).length, 1, "the Pro model was tried once, as a stand-in");

    const { id: second } = await eng.api("POST", "/api/generate", { nicheId: p.id, topic: "Metro rail extends its hours" });
    await parked(second);
    assert.equal(asked.filter((m) => /pro/.test(m)).length, 1, "and not asked again by the next job");
  } finally { await eng.stop(); await new Promise((r) => stub.close(r)); }
});

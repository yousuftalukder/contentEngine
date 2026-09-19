import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startEngine, waitFor } from "./harness.mjs";

let eng, brand;
before(async () => {
  eng = await startEngine();
  brand = await eng.api("POST", "/api/brands", { name: "Reliability brand" });
  await eng.api("POST", "/api/adapter-configs", { key: "llm_down", stage: "SCRIPT", impl: "llm_mock", config: { fail_first: 1000, fail_status: 503 } });
  await eng.api("POST", "/api/adapter-configs", { key: "llm_bad_request", stage: "SCRIPT", impl: "llm_mock", config: { fail_first: 1000, fail_status: 400 } });
});
after(async () => { await eng?.stop(); });

const program = (key, extra) => eng.api("POST", "/api/programs", { brandId: brand.id, key, displayName: key, contentType: "NEWS_STATIC", ...extra });
const generate = (p, topic) => eng.api("POST", "/api/generate", { nicheId: p.id, topic });
const jobFor = async (itemId) => (await eng.query(`SELECT * FROM jobs WHERE content_item_id = $1 ORDER BY created_at LIMIT 1`, [itemId]))[0];

test("an overloaded primary LLM falls back to the next adapter", async () => {
  const p = await program("fallback_ok", { scriptAdapter: "llm_down", scriptAdapterFallbacks: ["llm_mock"] });
  const item = await generate(p, "Fallback story");
  await waitFor(async () => (await eng.api("GET", `/api/content-items/${item.id}`)).status === "PENDING_REVIEW", { what: "draft written by the fallback" });
});

test("a transient failure with no fallback is retried later instead of failing", async () => {
  const p = await program("transient", { scriptAdapter: "llm_down" });
  const item = await generate(p, "Transient story");
  const job = await waitFor(async () => { const j = await jobFor(item.id); return j && j.attempts >= 1 && j.status === "PENDING" && j; }, { what: "job rescheduled" });
  assert.match(job.error_message, /503/);
  const wait = (new Date(job.run_after) - Date.now()) / 1000;
  assert.ok(wait > 30 && wait <= 61, `backs off about a minute (got ${wait}s)`);
  assert.notEqual((await eng.api("GET", `/api/content-items/${item.id}`)).status, "FAILED");
});

test("a permanent failure fails the job at once", async () => {
  const p = await program("permanent", { scriptAdapter: "llm_bad_request" });
  const item = await generate(p, "Bad request story");
  const job = await waitFor(async () => { const j = await jobFor(item.id); return j?.status === "FAILED" && j; }, { what: "job failed" });
  assert.equal(job.attempts, 1);
  assert.equal((await eng.api("GET", `/api/content-items/${item.id}`)).status, "FAILED");
});

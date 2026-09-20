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

test("an unpaid provider account raises one clear alert, not one per failed job", async () => {
  await eng.api("POST", "/api/adapter-configs", { key: "llm_no_credit", stage: "SCRIPT", impl: "llm_mock", config: { fail_first: 1000, fail_status: 400, fail_message: 'POST https://api.anthropic.com/v1/messages -> 400: {"type":"error","error":{"message":"Your credit balance is too low to access the Anthropic API."}}' } });
  const p = await program("no_credit", { scriptAdapter: "llm_no_credit" });
  const a = await generate(p, "Story one"), b = await generate(p, "Story two");
  for (const it of [a, b]) await waitFor(async () => (await jobFor(it.id))?.status === "FAILED", { what: "job failed" });
  const alerts = (await eng.api("GET", "/api/notifications")).filter((n) => /Anthropic account is out of credit/.test(n.title));
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].level, "error");
});

test("a permanent failure fails the job at once", async () => {
  const p = await program("permanent", { scriptAdapter: "llm_bad_request" });
  const item = await generate(p, "Bad request story");
  const job = await waitFor(async () => { const j = await jobFor(item.id); return j?.status === "FAILED" && j; }, { what: "job failed" });
  assert.equal(job.attempts, 1);
  assert.equal((await eng.api("GET", `/api/content-items/${item.id}`)).status, "FAILED");
});

// A channel that cannot reach its platform should say so while someone is setting it up, not at the first real post.
test("a channel reports whether it can reach its platform, without publishing anything", async () => {
  const mock = await eng.api("POST", "/api/channels", { brandId: brand.id, key: "mock_fb", displayName: "Mock FB", platform: "FACEBOOK", format: "STATIC_IMAGE_CAPTION", publisherAdapter: "publish_mock" });
  const mockCheck = await eng.api("POST", `/api/channels/${mock.id}/check`, {});
  assert.equal(mockCheck.ok, true);
  assert.match(mockCheck.notes[0], /nowhere real/);

  const live = await eng.api("POST", "/api/channels", { brandId: brand.id, key: "live_fb", displayName: "Live FB", platform: "FACEBOOK", format: "STATIC_IMAGE_CAPTION", publisherAdapter: "meta_graph", platformAccountId: "123456" });
  const liveCheck = await eng.api("POST", `/api/channels/${live.id}/check`, {});
  assert.equal(liveCheck.ok, false, "no token, so it cannot connect");
  assert.match(liveCheck.error, /Meta access token/i);
});

// A deployment without the worker service queues every video job forever, in silence. The engine under test runs only
// the text lane, exactly as a web service without its video worker does, so nothing ever claims the render.
test("a lane with work and nothing running it raises an alert naming the lane", async () => {
  const web = await startEngine({ env: { LANES: "text" } });
  try {
    await web.query(`INSERT INTO jobs (id, type, status, payload, queue, created_at) VALUES (gen_random_uuid()::text, 'RENDER_CLIP', 'PENDING', '{}', 'video', now() - interval '3 hours')`);
    await web.api("POST", "/api/health/sweep", {});
    const alert = (await web.api("GET", "/api/notifications")).find((n) => n.kind === "lane");
    assert.ok(alert, "the silence is reported");
    assert.match(alert.title, /"video" lane/);
    assert.match(alert.body, /worker service/i, "and it says where video rendering is supposed to run");
  } finally { await web.stop(); }
});

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

// Keys almost always arrive after the programs that need them: someone signs up for a stock-photo account on the day
// the pictures stop appearing. A key that only reaches programs created after it is a key that does nothing.
test("a key added after the program exists reaches it straight away", async () => {
  const vault = await startEngine({ env: { SECRETS_KEY: "0".repeat(64) } });
  try {
    const b = await vault.api("POST", "/api/brands", { name: "Late key" });
    const p = await vault.api("POST", "/api/programs", { brandId: b.id, key: "latekey", displayName: "Late key news", contentType: "NEWS_STATIC", country: "Bangladesh", autoStyle: false, autoSources: false, imageAdapter: "gemini_image" });
    const fallbacks = async () => JSON.parse((await vault.query(`SELECT image_adapter_fallbacks::text AS f FROM niches WHERE id=$1`, [p.id]))[0].f || "[]");
    assert.ok(!(await fallbacks()).includes("pexels_stock"), "nothing to fall back to yet");

    await vault.api("POST", "/api/credentials", { provider: "pexels", secret: "test-stock-key", label: "Stock photos" });
    assert.ok((await fallbacks()).includes("pexels_stock"), "the existing program can now fall back to a library photo");
  } finally { await vault.stop(); }
});

// Nobody should have to hunt down an access token per Facebook Page. A Page token is derived from the token of a
// person with a role on the Page, and /me/accounts returns one for every Page that person manages — so the whole job
// is: log in once, pick pages. The tokens are stored encrypted and never sent back to the browser.
test("connecting Facebook lists every Page the login manages and stores each token", async () => {
  const http = await import("node:http");
  const vault = await startEngine({ env: { SECRETS_KEY: "7".repeat(64) } });
  let exchanged = null, asked = null;
  const graph = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    res.writeHead(200, { "content-type": "application/json" });
    if (u.pathname.endsWith("/oauth/access_token")) { exchanged = u.searchParams.get("fb_exchange_token"); return res.end(JSON.stringify({ access_token: "LONG-LIVED-USER", expires_in: 5184000 })); }
    asked = u.searchParams.get("access_token");
    return res.end(JSON.stringify({ data: [
      { id: "1001", name: "Khobor 24", access_token: "PAGE-TOKEN-A", tasks: ["CREATE_CONTENT", "MANAGE"], instagram_business_account: { id: "9001", username: "khobor24" } },
      { id: "1002", name: "Sideline", access_token: "PAGE-TOKEN-B", tasks: ["CREATE_CONTENT"] },
      { id: "1003", name: "A page I only moderate", access_token: "PAGE-TOKEN-C", tasks: ["MODERATE"] }] }));
  });
  await new Promise((r) => graph.listen(0, "127.0.0.1", r));
  try {
    await vault.api("PUT", "/api/settings/meta.api_base", { value: `http://127.0.0.1:${graph.address().port}` });
    const out = await vault.api("POST", "/api/meta/pages", { userToken: "SHORT-LIVED", appId: "app", appSecret: "secret" });

    assert.equal(exchanged, "SHORT-LIVED", "the short-lived login is exchanged first");
    assert.equal(asked, "LONG-LIVED-USER", "and the pages are read with the long-lived one");
    assert.equal(out.longLived, true);
    assert.deepEqual(out.pages.map((p) => p.name), ["Khobor 24", "Sideline", "A page I only moderate"]);
    assert.deepEqual(out.pages.map((p) => p.canPost), [true, true, false], "a page you only moderate is marked unpostable");
    assert.equal(out.pages[0].instagram.username, "khobor24");
    assert.ok(!JSON.stringify(out).includes("PAGE-TOKEN"), "no token is ever sent back to the browser");

    const stored = await vault.query(`SELECT label, secret_enc IS NOT NULL AS has FROM api_credentials WHERE provider='meta' ORDER BY label`);
    assert.equal(stored.length, 3);
    assert.ok(stored.every((r) => r.has), "each Page's token is stored encrypted");

    const brand = await vault.api("POST", "/api/brands", { name: "Connected" });
    const ch = await vault.api("POST", "/api/meta/channels", { brandId: brand.id, pageId: out.pages[0].pageId, credentialId: out.pages[0].credentialId, displayName: "Khobor 24" });
    assert.equal(ch.platform_account_id, "1001");
    assert.equal(ch.publisher_adapter, "meta_graph");
    assert.equal(ch.credential_id, out.pages[0].credentialId, "the channel posts with that Page's own token");
  } finally { await vault.stop(); await new Promise((r) => graph.close(r)); }
});

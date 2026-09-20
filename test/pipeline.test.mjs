import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startEngine, waitFor } from "./harness.mjs";

let eng;
before(async () => { eng = await startEngine(); });
after(async () => { await eng?.stop(); });

test("boot: schema applies cleanly, every table has RLS, functions have a pinned search_path", async () => {
  const [{ n }] = await eng.query(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND NOT rowsecurity`);
  assert.equal(n, 0, "tables without RLS");
  const fns = await eng.query(`SELECT proname, proconfig FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('claim_job', 'set_updated_at')`);
  assert.equal(fns.length, 2);
  for (const f of fns) assert.deepEqual(f.proconfig, ["search_path=public"], `${f.proname} search_path`);
  const health = await eng.api("GET", "/health");
  assert.equal(health.ok, true);
  const setup = await eng.api("GET", "/api/setup-status");
  assert.equal(setup.total, setup.items.length);
  assert.equal(setup.items.find((i) => i.key === "storage").ok, false, "local disk is not production storage");
});

test("news pipeline: poll source -> draft lands in review -> approve -> published to channel and portal", async () => {
  const seed = await eng.api("POST", "/api/seed");
  await eng.api("POST", `/api/sources/${seed.sourceId}/poll`);
  const draft = await waitFor(async () => (await eng.api("GET", "/api/review"))[0], { what: "a draft in review" });
  assert.ok(draft.headline, "draft has a headline");
  assert.ok(draft.hero_media_id, "draft has a hero image");

  await eng.api("POST", `/api/content-items/${draft.id}/approve`, {});
  const done = await waitFor(async () => { const it = await eng.api("GET", `/api/content-items/${draft.id}`); return it.status === "PUBLISHED" && it; }, { what: "item published" });
  assert.equal(done.assets.length, 1);
  assert.equal(done.assets[0].status, "PUBLISHED");
  assert.match(done.assets[0].published_url, /^mock:\/\/published\/facebook\//);
  assert.ok(done.portal_url, "portal article created");
  const sched = await eng.api("GET", "/api/schedule");
  assert.ok(sched.recent.some((r) => r.item_id === draft.id && r.status === "PUBLISHED"), "the post shows in the schedule's recent list");
  const res = await fetch(done.portal_url.replace(/^https?:\/\/[^/]+/, eng.base));
  assert.equal(res.status, 200);
});

// settings.value is JSONB: the driver parses it for us. Parsing it a second time turned every string setting into null,
// which silently disabled anything configured as text — the Telegram chat id most of all.
test("settings: values survive a round trip whatever their type", async () => {
  const cases = { "t.text": "123456789", "t.flag": false, "t.num": 42, "t.obj": { a: 1 }, "t.list": ["x"] };
  for (const [k, v] of Object.entries(cases)) await eng.api("PUT", `/api/settings/${k}`, { value: v });
  const back = await eng.api("GET", "/api/settings");
  for (const [k, v] of Object.entries(cases)) assert.deepEqual(back[k], v, `${k} reads back as it was written`);
  assert.equal(typeof back["t.text"], "string", "a chat id stays a string, not null");
});

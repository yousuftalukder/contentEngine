import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startEngine, waitFor } from "./harness.mjs";

let eng, brand, channel;
before(async () => {
  eng = await startEngine();
  await eng.api("PUT", "/api/settings/ingest.enabled", { value: false });
  await eng.api("PUT", "/api/settings/planner.enabled", { value: false }); // tests run the planner explicitly
  brand = await eng.api("POST", "/api/brands", { name: "Intel brand", description: "Bangladesh news for young readers" });
  channel = await eng.api("POST", "/api/channels", { brandId: brand.id, key: "fb", displayName: "FB", platform: "FACEBOOK", format: "STATIC_IMAGE_CAPTION", publisherAdapter: "publish_mock" });
  await eng.api("POST", "/api/adapter-configs", { key: "llm_flags_facts", stage: "SCRIPT", impl: "llm_mock", config: { respond: [{ match: "standards editor", json: { fact_issues: ["The death toll of 12 is not in the sources"], headline_ok: true, safety_flags: [], score: 0.5, verdict: "REVIEW", summary: "unsupported number" } }] } });
  await eng.api("POST", "/api/adapter-configs", { key: "llm_flags_unsafe", stage: "SCRIPT", impl: "llm_mock", config: { respond: [{ match: "standards editor", json: { fact_issues: [], headline_ok: true, safety_flags: [{ type: "defamation", severity: "high", detail: "names a person as a criminal" }], score: 0.2, verdict: "REVIEW", summary: "defamation risk" } }] } });
});
after(async () => { await eng?.stop(); });

async function program(key, extra = {}) {
  const p = await eng.api("POST", "/api/programs", { brandId: brand.id, key, displayName: key, contentType: "NEWS_STATIC", useMocks: true, autoStyle: false, ...extra });
  await eng.api("POST", `/api/channels/${channel.id}/niches/${p.id}`);
  return p;
}
const item = (id) => eng.api("GET", `/api/content-items/${id}`);
const settle = (id, statuses) => waitFor(async () => { const it = await item(id); return statuses.includes(it.status) && it; }, { what: `item in ${statuses}` });

test("quality gate: a clean draft on an AUTO program publishes without a person", async () => {
  const p = await program("auto_clean", { approvalMode: "AUTO" });
  const { id } = await eng.api("POST", "/api/generate", { nicheId: p.id, topic: "Metro rail extends hours" });
  const done = await settle(id, ["PUBLISHED"]);
  assert.equal(done.qa_status, "PASS");
  assert.equal(done.auto_approved, 1);
});

test("quality gate: an unsupported claim holds an AUTO draft for review, with the report", async () => {
  const p = await program("auto_facts", { approvalMode: "AUTO", scriptAdapter: "llm_flags_facts", methodConfig: { qa: { auto_fix: false } } });
  const { id } = await eng.api("POST", "/api/generate", { nicheId: p.id, topic: "Bus accident on the highway" });
  const held = await settle(id, ["PENDING_REVIEW"]);
  assert.equal(held.qa_status, "REVIEW");
  assert.match(held.qa_report.fact_issues[0], /death toll/);
  assert.equal(held.review_deadline_at, null, "no auto-approve countdown for a flagged draft");
});

test("quality gate: a high safety risk sets an AUTO draft aside", async () => {
  const p = await program("auto_unsafe", { approvalMode: "AUTO", scriptAdapter: "llm_flags_unsafe" });
  const { id } = await eng.api("POST", "/api/generate", { nicheId: p.id, topic: "Allegations against a local leader" });
  const out = await settle(id, ["REJECTED"]);
  assert.equal(out.qa_status, "REJECT");
  assert.match(out.rejection_note, /Quality gate/);
});

test("style: a new program gets a generated house style; edits are logged and refine it", async () => {
  const p = await eng.api("POST", "/api/programs", { brandId: brand.id, key: "styled", displayName: "Styled", contentType: "NEWS_STATIC", useMocks: true });
  const styled = await waitFor(async () => (await eng.api("GET", "/api/programs")).find((x) => x.id === p.id && x.style_profile_id), { what: "style generated" });
  const { id } = await eng.api("POST", "/api/generate", { nicheId: p.id, topic: "Rain expected in Dhaka" });
  await settle(id, ["PENDING_REVIEW"]);
  for (const [i, h] of ["Heavy rain likely in Dhaka today", "Dhaka braces for heavy rain", "Rain alert for Dhaka", "Dhaka: rain all day", "Carry an umbrella, Dhaka"].entries()) await eng.api("PATCH", `/api/content-items/${id}`, { headline: `${h} ${i}` });
  const [{ n }] = await eng.query(`SELECT count(*)::int AS n FROM style_feedback WHERE style_profile_id = $1 AND kind = 'EDIT'`, [styled.style_profile_id]);
  assert.equal(n, 5);
  const r = await eng.api("POST", `/api/style-profiles/${styled.style_profile_id}/refine`);
  assert.ok(r.changes);
  const [prof] = await eng.query(`SELECT history, refined_at FROM style_profiles WHERE id = $1`, [styled.style_profile_id]);
  assert.equal(prof.history.length, 1);
  assert.ok(prof.refined_at);
});

test("planner: ideas are proposed and an accepted idea becomes a draft", async () => {
  const p = await program("planned");
  const r = await eng.api("POST", `/api/programs/${p.id}/plan`);
  assert.ok(r.created >= 1);
  const [idea] = await eng.api("GET", `/api/suggestions?nicheId=${p.id}`);
  const acc = await eng.api("POST", `/api/suggestions/${idea.id}/accept`);
  assert.ok(acc.itemId);
  await settle(acc.itemId, ["PENDING_REVIEW"]);
  assert.equal((await eng.api("POST", `/api/programs/${p.id}/plan`)).created, 0, "the same idea is not proposed twice");
});

test("series: the next episode is planned from the earlier ones and numbered", async () => {
  const p = await program("serial");
  const s = await eng.api("POST", "/api/series", { nicheId: p.id, key: "rivers", displayName: "Rivers of Bangladesh", premise: "One river per episode", cadenceDays: 7 });
  const { itemId } = await eng.api("POST", `/api/series/${s.id}/next`);
  const ep = await settle(itemId, ["PENDING_REVIEW"]);
  assert.equal(ep.episode_number, 1);
  assert.equal(ep.series_id, s.id);
});

// Models answer the quality score on whatever scale they like. Production returned a flat 10 against a 0.75 threshold,
// so the score cleared it without meaning anything: it has to be read on the scale it was written on.
test("quality gate: a score on a 0-10 scale is read as 0-10, not as passing by default", async () => {
  await eng.api("POST", "/api/adapter-configs", { key: "llm_scores_out_of_ten", stage: "SCRIPT", impl: "llm_mock",
    config: { respond: [{ match: "standards editor", json: { fact_issues: [], headline_ok: true, safety_flags: [], language_issues: [], score: 6, verdict: "PASS", summary: "readable but thin" } }] } });
  const p = await program("scale_ten", { approvalMode: "AUTO", scriptAdapter: "llm_scores_out_of_ten" });
  const { id } = await eng.api("POST", "/api/generate", { nicheId: p.id, topic: "A thin story" });
  const held = await settle(id, ["PENDING_REVIEW", "PUBLISHED"]);
  assert.equal(held.status, "PENDING_REVIEW", "6 out of 10 is below the bar, so a person looks at it");
  assert.equal(held.qa_score, 0.6, "and the score is stored on one scale");
});

// Twenty drafts a day approved one at a time is not an automated newsroom. Bulk approval takes exactly the drafts an
// automatic program would have published by itself, and leaves the flagged ones where they are.
test("review: approving the clean drafts leaves the flagged ones for a person", async () => {
  const p = await program("bulk_mixed", { approvalMode: "MANUAL", methodConfig: { qa: { auto_fix: false } } });
  const ids = [];
  for (const t of ["Metro fares frozen", "New ferry terminal opens"]) ids.push((await eng.api("POST", "/api/generate", { nicheId: p.id, topic: t })).id);
  for (const id of ids) await settle(id, ["PENDING_REVIEW"]);          // written before the program's writer changes
  // The same program, now writing with an editor that flags an unsupported number: one draft a person must look at.
  await eng.api("PATCH", `/api/programs/${p.id}`, { scriptAdapter: "llm_flags_facts" });
  const held = (await eng.api("POST", "/api/generate", { nicheId: p.id, topic: "Toll collection disputed" })).id;
  await settle(held, ["PENDING_REVIEW"]);

  const r = await eng.api("POST", "/api/review/approve-clean", { nicheId: p.id });
  assert.equal(r.approved, 2, "both clean drafts go");
  assert.equal((await item(held)).status, "PENDING_REVIEW", "the flagged one stays");
  for (const id of ids) assert.notEqual((await item(id)).status, "PENDING_REVIEW");
});

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startEngine, waitFor } from "./harness.mjs";

let eng, brand;
before(async () => {
  eng = await startEngine();
  await eng.api("PUT", "/api/settings/ingest.enabled", { value: false }); // no background polling of real feeds in tests
  brand = await eng.api("POST", "/api/brands", { name: "Desk brand" });
});
after(async () => { await eng?.stop(); });

test("the same story from two outlets becomes one draft that credits both; a different story gets its own", async () => {
  const a = await eng.api("POST", "/api/sources", { name: "Outlet A", adapterKey: "ingest_mock", config: { items: [{ title: "Flood hits Sylhet as rivers rise", url: "https://a.example/1" }] } });
  const b = await eng.api("POST", "/api/sources", { name: "Outlet B", adapterKey: "ingest_mock", config: { items: [
    { title: "Rivers rise as flood hits Sylhet", url: "https://b.example/9" },
    { title: "Cricket team wins series against Zimbabwe", url: "https://b.example/10" }] } });
  const p = await eng.api("POST", "/api/programs", { brandId: brand.id, key: "desk_news", displayName: "Desk News", contentType: "NEWS_STATIC", country: "Bangladesh", useMocks: true,
    sourceIds: [a.id, b.id], methodConfig: { desk: { settle_minutes: 0, min_gap_minutes: 0, per_sweep: 5 } } });

  await eng.api("POST", `/api/sources/${a.id}/poll`);
  await waitFor(async () => (await eng.query(`SELECT 1 FROM source_items WHERE source_id = $1 AND cluster_id IS NOT NULL`, [a.id])).length, { what: "outlet A clustered" });
  await eng.api("POST", `/api/sources/${b.id}/poll`);
  await waitFor(async () => (await eng.query(`SELECT 1 FROM source_items WHERE source_id = $1 AND cluster_id IS NOT NULL`, [b.id])).length === 2, { what: "outlet B clustered" });

  const clusters = await eng.api("GET", "/api/desk");
  const flood = clusters.find((c) => /flood/i.test(c.title));
  assert.equal(flood.source_count, 2, "flood story carried by both outlets");
  assert.deepEqual(flood.outlets.map((o) => o.name).sort(), ["Outlet A", "Outlet B"]);
  assert.equal(clusters.length, 2, "two stories, not three");

  await eng.api("POST", "/api/desk/run");
  const items = await waitFor(async () => { const r = await eng.api("GET", `/api/content-items?nicheId=${p.id}`); return r.length === 2 && r.every((x) => x.status === "PENDING_REVIEW") && r; }, { what: "two drafts" });
  const floodItem = items.find((i) => /flood/i.test(i.topic));
  assert.deepEqual([...floodItem.source_data_ref.outlets].sort(), ["Outlet A", "Outlet B"]);

  await eng.api("POST", "/api/desk/run");
  assert.equal((await eng.api("GET", `/api/content-items?nicheId=${p.id}`)).length, 2, "a covered story is not written twice");
});

test("the source catalog is well formed: unique keys, an adapter and config for each", async () => {
  const catalog = await eng.api("GET", "/api/source-catalog");
  assert.ok(catalog.length >= 30, "a real catalog, not a stub");
  assert.equal(new Set(catalog.map((e) => e.key)).size, catalog.length, "catalog keys are unique");
  for (const e of catalog) {
    assert.ok(e.name && e.adapter && e.config, `${e.key} is complete`);
    if (e.adapter === "rss") assert.match(e.config.url, /^https:\/\//, `${e.key} has a feed url`);
    if (e.adapter === "google_news") assert.ok(e.config.site || e.config.query, `${e.key} has a site or query`);
    if (e.adapter === "youtube_rss") assert.match(e.config.channel_id, /^UC[\w-]{20,}$/, `${e.key} has a channel id`);
  }
});

test("a Bangladesh program starts with the catalog sources for its language", async () => {
  const p = await eng.api("POST", "/api/programs", { brandId: brand.id, key: "bn_news", displayName: "বাংলা খবর", contentType: "NEWS_STATIC", country: "Bangladesh", language: "bn", useMocks: true });
  const catalog = await eng.api("GET", "/api/source-catalog");
  const bn = catalog.filter((e) => e.language === "bn" && e.kind === "ARTICLE");
  assert.ok(bn.length >= 10);
  for (const e of bn) assert.ok(e.installed && e.programs.includes("বাংলা খবর"), `${e.key} linked`);
  assert.ok(catalog.filter((e) => e.kind === "VIDEO").every((e) => !e.installed), "TV channels are for video programs");
  const programs = await eng.api("GET", "/api/programs");
  assert.equal(programs.find((x) => x.id === p.id).sources.length, bn.length);
});

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

// A US program takes the US desk, and only the part of it that its program is about.
test("a US sports program starts with the US sports sources, not the rest of the catalog", async () => {
  const p = await eng.api("POST", "/api/programs", { brandId: brand.id, key: "us_sport", displayName: "US Sports", contentType: "NEWS_REEL",
    country: "United States", language: "en", useMocks: true, autoStyle: false, methodConfig: { topics: ["sports"] } });
  const linked = (await eng.api("GET", "/api/programs")).find((x) => x.id === p.id).sources;
  const catalog = await eng.api("GET", "/api/source-catalog");
  const names = new Set(linked.map((s) => s.name || s.display_name));
  const sport = catalog.filter((e) => e.country === "United States" && e.topic === "sports");
  assert.ok(sport.length >= 5, "the catalog carries a US sports desk");
  for (const e of sport) assert.ok(names.has(e.name), `${e.key} linked`);
  assert.ok(!catalog.filter((e) => e.topic === "entertainment").some((e) => names.has(e.name)), "and nothing from another desk");
  assert.ok(!catalog.filter((e) => e.country === "Bangladesh").some((e) => names.has(e.name)), "or another country");
});

// US feeds escape their punctuation every way there is, and a headline reading "Vanderbilt&#039;s win" goes onto the
// card and into the narration exactly as written. The parser is what has to undo it.
test("feeds: escaped punctuation is decoded before it reaches a headline", async () => {
  const http = await import("node:http");
  const rss = `<?xml version="1.0"?><rss version="2.0"><channel>
    <item><title>Vanderbilt&#039;s stunning win over NC State</title><link>https://x.example/1</link><description>It&#8217;s the upset of the week&hellip;</description><pubDate>${new Date().toUTCString()}</pubDate></item>
    <item><title>Ole Miss &amp;amp; Texas A&amp;M rise</title><link>https://x.example/2</link><description>Both climb</description><pubDate>${new Date().toUTCString()}</pubDate></item>
  </channel></rss>`;
  const stub = http.createServer((_, res) => { res.writeHead(200, { "content-type": "application/rss+xml" }); res.end(rss); });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  try {
    await eng.api("POST", "/api/adapter-configs", { key: "rss_entities", stage: "INGEST", impl: "rss", config: {} });
    const out = await eng.api("POST", "/api/adapter-configs/rss_entities/test", { config: { url: `http://127.0.0.1:${stub.address().port}/feed.xml` } });
    const titles = out.items.map((i) => i.title);
    assert.ok(titles.includes("Vanderbilt's stunning win over NC State"), `apostrophe decoded — got ${JSON.stringify(titles)}`);
    assert.ok(titles.includes("Ole Miss & Texas A&M rise"), "double-escaped ampersand decoded");
    assert.match(out.items[0].summary, /It’s the upset of the week…/, "and the summary too");
  } finally { await new Promise((r) => stub.close(r)); }
});

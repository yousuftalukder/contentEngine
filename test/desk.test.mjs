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

// Several Bangladeshi outlets serve their feed to a laptop and 403 to a datacenter, so a catalog checked from a desk
// can be half-dead on the server. The outlet's own feed is always tried first — it carries the summary, the real
// article url and the photo the outlet ran, none of which survive Google News — and only a feed the server cannot
// read falls back to reading that outlet through Google News.
test("a feed the server cannot reach is read through Google News instead of going quiet", async () => {
  const http = await import("node:http");
  let feedStatus = 403;
  const stub = http.createServer((req, res) => {
    if (req.url.startsWith("/rss/search")) {
      const site = /site:([^+&%\s]+)/.exec(decodeURIComponent(req.url))?.[1];
      res.writeHead(200, { "content-type": "application/rss+xml" });
      return res.end(`<?xml version="1.0"?><rss version="2.0"><channel><item><title>Ferry service resumes at Paturia - ${site}</title>
        <link>https://news.google.com/rss/articles/abc</link><pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`);
    }
    if (feedStatus !== 200) { res.writeHead(feedStatus); return res.end("blocked"); }
    res.writeHead(200, { "content-type": "application/rss+xml" });
    res.end(`<?xml version="1.0"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><item>
      <title>Ferry service resumes at Paturia</title><link>https://outlet.example/1</link>
      <media:content url="https://outlet.example/photo.jpg" /><description>Vehicles began crossing at dawn.</description>
      <pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`);
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  const port = stub.address().port;
  try {
    await eng.api("PUT", "/api/settings/google_news.base", { value: `http://127.0.0.1:${port}` });
    await eng.api("POST", "/api/adapter-configs", { key: "rss_blocked", stage: "INGEST", impl: "rss", config: {} });
    const cfg = { url: `http://127.0.0.1:${port}/feed`, via_site: "outlet.example" };

    const viaGoogle = await eng.api("POST", "/api/adapter-configs/rss_blocked/test", { config: cfg });
    assert.equal(viaGoogle.items.length, 1, "the outlet is still read when its own feed refuses the server");
    assert.equal(viaGoogle.items[0].raw?.via, "google_news", "and it says so, because the story arrives thinner");

    feedStatus = 200;
    const direct = await eng.api("POST", "/api/adapter-configs/rss_blocked/test", { config: cfg });
    assert.ok(!direct.items[0].raw?.via, "a reachable feed is read directly, not through Google News");
    assert.equal(direct.items[0].thumbnail, "https://outlet.example/photo.jpg", "which is where the photo comes from");
    assert.match(direct.items[0].summary, /Vehicles began crossing/, "and the summary");
  } finally { await new Promise((r) => stub.close(r)); await eng.api("PUT", "/api/settings/google_news.base", { value: null }); }
});

// Outlets label their headlines for their own site. "WATCH:" belongs on a CBS page, not on a card or in a narration;
// "Opinion:" is not a label, it is what the piece is, and taking it off would present a column as reporting.
test("feeds: an outlet's own labels come off the headline, except the ones that change what it is", async () => {
  const http = await import("node:http");
  const now = new Date().toUTCString();
  const item = (t, u) => `<item><title>${t}</title><link>https://x.example/${u}</link><pubDate>${now}</pubDate></item>`;
  const rss = `<?xml version="1.0"?><rss version="2.0"><channel>
    ${item("WATCH: Vanderbilt scores a last-second go-ahead touchdown", "1")}
    ${item("Opinion: Why the metro fare rise will not hold", "2")}
    ${item("Watch out for these five signs of dengue", "3")}
    ${item("Live: Election results from across the country | Politics", "4")}</channel></rss>`;
  const stub = http.createServer((_, res) => { res.writeHead(200, { "content-type": "application/rss+xml" }); res.end(rss); });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  try {
    const src = await eng.api("POST", "/api/sources", { name: "Labelled", adapterKey: "rss", config: { url: `http://127.0.0.1:${stub.address().port}/f.xml` } });
    await eng.api("POST", `/api/sources/${src.id}/poll`);
    const titles = await waitFor(async () => { const r = await eng.query(`SELECT title FROM source_items WHERE source_id=$1`, [src.id]); return r.length === 4 && r.map((x) => x.title); }, { what: "the labelled feed ingested" });
    assert.ok(titles.includes("Vanderbilt scores a last-second go-ahead touchdown"), `WATCH: removed — got ${JSON.stringify(titles)}`);
    assert.ok(titles.includes("Opinion: Why the metro fare rise will not hold"), "Opinion: kept, because it is not a label");
    assert.ok(titles.includes("Watch out for these five signs of dengue"), "a headline that merely starts with the word is untouched");
    assert.ok(titles.includes("Election results from across the country"), "the section name after the pipe goes too");
  } finally { await new Promise((r) => stub.close(r)); }
});

// A sports desk carries betting promos and streaming guides alongside the games, and a program should not have to be
// told about any of it: the user creates a brand and a program, not a blocklist. The desk supplies the floor.
test("a sports program rejects the betting and streaming noise without being told to", async () => {
  const http = await import("node:http");
  const now = new Date().toUTCString();
  const item = (t, u) => `<item><title>${t}</title><link>https://s.example/${u}</link><pubDate>${now}</pubDate></item>`;
  const rss = `<?xml version="1.0"?><rss version="2.0"><channel>
    ${item("Ole Miss vs. LSU prediction, odds, time for Week 3", "1")}
    ${item("How to watch Vanderbilt vs Alabama: live stream and start time", "2")}
    ${item("Vanderbilt beats Alabama in Tuscaloosa for the first time", "3")}
    ${item("Waiver wire pickups for fantasy managers this week", "4")}</channel></rss>`;
  const stub = http.createServer((_, res) => { res.writeHead(200, { "content-type": "application/rss+xml" }); res.end(rss); });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  try {
    const src = await eng.api("POST", "/api/sources", { name: "Sports wire", adapterKey: "rss", config: { url: `http://127.0.0.1:${stub.address().port}/s.xml` } });
    const p = await eng.api("POST", "/api/programs", { brandId: brand.id, key: "us_noise", displayName: "US Sport", contentType: "NEWS_STATIC",
      country: "United States", language: "en", useMocks: true, autoStyle: false, autoSources: false, sourceIds: [src.id],
      methodConfig: { topics: ["sports"], desk: { settle_minutes: 0, min_sources: 1, min_gap_minutes: 0, per_sweep: 5 } } });
    await eng.api("POST", `/api/sources/${src.id}/poll`);
    await waitFor(async () => (await eng.query(`SELECT 1 FROM source_items WHERE source_id=$1`, [src.id])).length === 4, { what: "the wire ingested" });
    await eng.api("POST", "/api/desk/run");

    const topics = await waitFor(async () => { const r = await eng.api("GET", `/api/content-items?nicheId=${p.id}`); return r.length ? r.map((x) => x.topic) : null; }, { what: "the desk to pick" });
    assert.ok(topics.some((t) => /Vanderbilt beats Alabama/.test(t)), `the game is written — got ${JSON.stringify(topics)}`);
    for (const junk of [/prediction, odds/i, /how to watch/i, /waiver wire/i]) assert.ok(!topics.some((t) => junk.test(t)), `${junk} stays off the channel`);
  } finally { await new Promise((r) => stub.close(r)); }
});

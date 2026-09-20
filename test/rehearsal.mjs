// `npm run rehearse` — a full production cycle against the live Bangladeshi sources, with no keys and nothing
// published anywhere real: the catalog's feeds are polled, the news desk clusters what they return, and a mock writer
// turns the picked story into a draft that passes the quality gate and "publishes" to a mock channel.
//
// It answers the questions a test suite cannot: are the outlets still serving their feeds, are stories from different
// outlets landing in one cluster, and does a story still travel the whole way through. Not part of `npm test`, because
// it depends on the network and on what Bangladesh is reporting today.
import { startEngine, waitFor, sleep } from "./harness.mjs";

const eng = await startEngine();
try {
  await eng.api("PUT", "/api/settings/planner.enabled", { value: false });
  const brand = await eng.api("POST", "/api/brands", { name: "Rehearsal" });
  const channel = await eng.api("POST", "/api/channels", { brandId: brand.id, key: "fb", displayName: "FB", platform: "FACEBOOK", format: "STATIC_IMAGE_CAPTION", publisherAdapter: "publish_mock" });
  // `npm run rehearse` takes the country and, for the United States, which desk: `npm run rehearse -- us sports`.
  const [where = "bd", topic] = process.argv.slice(2).map((a) => String(a).toLowerCase());
  const us = /^(us|usa|united states)$/.test(where);
  const p = await eng.api("POST", "/api/programs", {
    brandId: brand.id, key: us ? `us_${topic || "all"}` : "bd_en", displayName: us ? `US ${topic || "news"}` : "Bangladesh News",
    contentType: "NEWS_STATIC", country: us ? "United States" : "Bangladesh", language: "en", useMocks: true, autoStyle: false, approvalMode: "AUTO",
    methodConfig: { ...(topic ? { topics: [topic] } : {}), desk: { settle_minutes: 0, min_sources: 1, per_sweep: 3 } },
    // The same noise the US presets filter: score tickers and betting promos are not stories.
    topicFilters: us && topic === "sports" ? { exclude: ["promo code", "betting", "odds", "parlay", "draftkings", "fanduel", "how to watch", "live stream", "gameday", "injury report", "fantasy start"] }
      : us && topic === "entertainment" ? { exclude: ["deal of the day", "best deals", "where to buy", "shop now", "horoscope", "sponsored"] } : {} });
  await eng.api("POST", `/api/channels/${channel.id}/niches/${p.id}`);
  const sources = (await eng.api("GET", "/api/programs")).find((x) => x.id === p.id).sources;
  console.log(`catalog gave the program ${sources.length} sources`);

  for (const s of sources) await eng.api("POST", `/api/sources/${s.id}/poll`).catch((e) => console.log(`  poll ${s.display_name || s.id}: ${e.message.slice(0, 90)}`));
  await waitFor(async () => (await eng.query(`SELECT count(*)::int n FROM jobs WHERE type='INGEST_SOURCE' AND status IN ('PENDING','RUNNING')`))[0].n === 0, { timeout: 180000, interval: 1000, what: "every source polled" });

  const bySource = await eng.query(`SELECT s.name, count(si.id)::int AS items, left(coalesce(s.last_error,''), 70) AS err FROM sources s LEFT JOIN source_items si ON si.source_id = s.id GROUP BY s.name, s.last_error ORDER BY items DESC`);
  console.log("\nsources:"); for (const r of bySource) console.log(`  ${String(r.items).padStart(3)}  ${r.name}${r.err ? `  [${r.err}]` : ""}`);

  await eng.api("POST", "/api/desk/run", {});
  await sleep(4000);
  const clusters = await eng.query(`SELECT title, source_count, item_count, (SELECT string_agg(o->>'name', ', ') FROM jsonb_array_elements(outlets) o) AS outlets FROM story_clusters ORDER BY source_count DESC, item_count DESC LIMIT 8`);
  console.log(`\nclusters: ${(await eng.query(`SELECT count(*)::int n FROM story_clusters`))[0].n}, of which ${(await eng.query(`SELECT count(*)::int n FROM story_clusters WHERE source_count > 1`))[0].n} corroborated`);
  for (const c of clusters) console.log(`  [${c.source_count} outlet${c.source_count > 1 ? "s" : ""}] ${c.title.slice(0, 80)}  — ${c.outlets}`);

  const items = await waitFor(async () => { const r = await eng.api("GET", `/api/content-items?nicheId=${p.id}`); return r.length ? r : null; }, { timeout: 120000, interval: 2000, what: "the desk to start a story" });
  await sleep(8000);
  console.log("\ndrafts:");
  for (const it of await eng.api("GET", `/api/content-items?nicheId=${p.id}`)) {
    const full = await eng.api("GET", `/api/content-items/${it.id}`);
    console.log(`  ${full.status.padEnd(16)} ${(full.headline || full.topic || "").slice(0, 70)}`);
    console.log(`      sources: ${(full.source_data_ref?.outlets || []).join(", ") || "—"} | qa ${full.qa_status || "—"} | hero ${full.hero_media?.kind || "none"} | published ${(full.assets || []).filter((a) => a.status === "PUBLISHED").length}/${(full.assets || []).length}`);
  }
  const pauses = (await eng.api("GET", "/api/stats")).quotaPauses;
  console.log(`\nquota pauses: ${JSON.stringify(pauses)}`);
} finally { await eng.stop(); }

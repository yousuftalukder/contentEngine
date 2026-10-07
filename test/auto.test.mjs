import { test } from "node:test";
import assert from "node:assert/strict";
import { startEngine, waitFor } from "./harness.mjs";

// Nothing is made on its own until the owner turns automatic production on. Off — the default — a feed linked to a news
// programme is not read, nothing is drafted and no ideas are planned; "Generate" still works. On, the feed is read.
test("automatic production is off until it is turned on: no feed read, no draft, no plan — and Generate still works", async () => {
  const eng = await startEngine({ env: { AUTO_PRODUCTION_DEFAULT: "off" } });
  try {
    const b = await eng.api("POST", "/api/brands", { name: "Quiet" });
    const p = await eng.api("POST", "/api/programs", { brandId: b.id, key: "quiet_news", displayName: "Quiet news", contentType: "NEWS_STATIC", useMocks: true, autoStyle: false, autoSources: false, methodConfig: { qa: { enabled: false } } });
    await eng.api("POST", "/api/sources", { name: "A wire", adapterKey: "ingest_mock", nicheIds: [p.id], config: { items: [{ title: "Ferries resume at Paturia after three days", url: "https://a.example/1" }] } });
    const stats = await eng.api("GET", "/api/stats");
    assert.equal(stats.autoOn, false, "off by default");
    await new Promise((r) => setTimeout(r, 4000));
    const count = async (sql) => Number((await eng.query(sql))[0].n);
    assert.equal(await count(`SELECT count(*) AS n FROM jobs WHERE type IN ('INGEST_SOURCE','PLAN_PROGRAM','SERIES_NEXT')`), 0, "no feed read and nothing planned");
    assert.equal(await count(`SELECT count(*) AS n FROM content_items`), 0, "nothing drafted");

    const { id } = await eng.api("POST", "/api/generate", { nicheId: p.id, topic: "A story asked for by hand" });
    await waitFor(async () => (await eng.api("GET", `/api/content-items/${id}`)).status === "PENDING_REVIEW", { what: "the draft asked for" });

    await eng.api("PUT", "/api/settings/auto.enabled", { value: true });
    await waitFor(async () => (await count(`SELECT count(*) AS n FROM jobs WHERE type = 'INGEST_SOURCE'`)) > 0, { timeout: 90000, what: "the feed to be read once it is on" });
  } finally { await eng.stop(); }
});

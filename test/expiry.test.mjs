import { test } from "node:test";
import assert from "node:assert/strict";
import { startEngine, waitFor } from "./harness.mjs";

// Production had 2,602 news drafts waiting for review, 2,408 older than a day. News nobody reviewed in a day is set
// aside with a note; fresh news, and videos that keep (a clip), stay in the queue. Checked with a second engine on the
// same database, as the sweep runs a few seconds after every boot.
test("news drafts left unreviewed for a day are set aside; fresh news and evergreen work stay", async () => {
  const first = await startEngine();
  let second;
  try {
    await first.api("PUT", "/api/settings/ingest.enabled", { value: false });
    const b = await first.api("POST", "/api/brands", { name: "Expiry brand" });
    const news = await first.api("POST", "/api/programs", { brandId: b.id, key: "news", displayName: "News", contentType: "NEWS_STATIC", useMocks: true, autoStyle: false, autoSources: false });
    const made = async (topic) => { const { id } = await first.api("POST", "/api/generate", { nicheId: news.id, topic });
      return waitFor(async () => (await first.api("GET", `/api/content-items/${id}`)).status === "PENDING_REVIEW" && id, { timeout: 30000, what: topic }); };
    const old = await made("Ferry service resumes at Paturia"), fresh = await made("Metro rail extends its hours");
    // A clip from the same day as the old story: not news, so it keeps.
    await first.query(`UPDATE content_items SET created_at = now() - interval '30 hours' WHERE id = $1`, [old]);
    const [{ id: clip }] = await first.query(`INSERT INTO content_items (id, niche_id, content_type, status, topic, created_at) VALUES (gen_random_uuid()::text, $1, 'PODCAST_CLIP', 'PENDING_REVIEW', 'A clip', now() - interval '30 hours') RETURNING id`, [news.id]);

    second = await startEngine({ env: { DATABASE_URL: first.databaseUrl } });
    const row = await waitFor(async () => { const [r] = await second.query(`SELECT status, rejection_note FROM content_items WHERE id = $1`, [old]); return r?.status === "REJECTED" && r; },
      { timeout: 30000, what: "the day-old draft set aside" });
    assert.match(row.rejection_note, /Expired unreviewed/, "with a note saying why");
    const rest = await second.query(`SELECT id, status FROM content_items WHERE id = ANY($1)`, [[fresh, clip]]);
    assert.ok(rest.every((r) => r.status === "PENDING_REVIEW"), `fresh news and the clip stay in review: ${JSON.stringify(rest)}`);
  } finally { await second?.stop(); await first.stop(); }
});

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startEngine, waitFor } from "./harness.mjs";

// "বিস্তারিত কমেন্টে" — details in the comments. On Facebook a link in the post body costs reach, so the body says where
// to look and the source article's link goes into the first comment, the way the pages this competes with do it.
// A YouTube description carries no such penalty, so there the link is written in.
let eng, brand;
before(async () => { eng = await startEngine(); brand = await eng.api("POST", "/api/brands", { name: "খবর ২৪" }); });
after(async () => { await eng?.stop(); });

test("a Bangla post says the details are in the comments, and the first comment is the source link", async () => {
  const fb = await eng.api("POST", "/api/channels", { brandId: brand.id, key: "fb", displayName: "FB", platform: "FACEBOOK", format: "STATIC_IMAGE_CAPTION", publisherAdapter: "publish_mock" });
  const yt = await eng.api("POST", "/api/channels", { brandId: brand.id, key: "yt", displayName: "YT", platform: "YOUTUBE", format: "STATIC_IMAGE_CAPTION", publisherAdapter: "publish_mock" });
  const url = `https://www.prothomalo.com/bangladesh/district/${Date.now()}`;
  const src = await eng.api("POST", "/api/sources", { name: "প্রথম আলো", adapterKey: "ingest_mock",
    config: { items: [{ title: "সোনারগাঁয়ে মেঘনায় ডুবে তিন শিক্ষার্থীর মৃত্যু", summary: "গোসলে নেমে যমজ ভাইসহ তিন শিক্ষার্থীর মৃত্যু হয়েছে। উদ্ধারকাজ চলছে।",
      thumbnail: "https://example.org/meghna.jpg", url }] } });
  const p = await eng.api("POST", "/api/programs", { brandId: brand.id, key: "bn_comments", displayName: "বাংলাদেশ সংবাদ", contentType: "NEWS_STATIC",
    country: "Bangladesh", language: "bn", useMocks: true, autoStyle: false, autoSources: false, sourceIds: [src.id], approvalMode: "MANUAL",
    methodConfig: { desk: { settle_minutes: 0, min_sources: 1, min_gap_minutes: 0, per_sweep: 1 } } });
  for (const ch of [fb, yt]) await eng.api("POST", `/api/channels/${ch.id}/niches/${p.id}`);

  await eng.api("POST", `/api/sources/${src.id}/poll`);
  await eng.api("POST", "/api/desk/run");
  const draft = await waitFor(async () => (await eng.api("GET", `/api/content-items?nicheId=${p.id}`)).find((x) => x.status === "PENDING_REVIEW"), { timeout: 60000, what: "the story in review" });
  await eng.api("POST", `/api/content-items/${draft.id}/approve`, {});
  await waitFor(async () => (await eng.api("GET", `/api/content-items/${draft.id}`)).status === "PUBLISHED", { timeout: 60000, what: "both channels published" });

  const assets = await eng.query(`SELECT c.platform, a.caption, a.comment_text, a.comment_id FROM content_assets a JOIN channels c ON c.id = a.channel_id WHERE a.content_item_id = $1`, [draft.id]);
  const face = assets.find((a) => a.platform === "FACEBOOK"), tube = assets.find((a) => a.platform === "YOUTUBE");
  assert.match(face.caption, /বিস্তারিত কমেন্টে/, "the Facebook body says the details are in the comments");
  assert.ok(!face.caption.includes(url), "the Facebook body carries no link");
  assert.match(face.comment_text, /^সূত্র: /, "the first comment is labelled as the source, in Bangla");
  assert.ok(face.comment_text.includes(url), `the first comment carries the source link: ${face.comment_text}`);
  assert.match(face.comment_id, /^mock-comment-/, "the comment was posted");
  assert.ok(tube.caption.includes(url), `YouTube gets the link in the description itself: ${tube.caption}`);
  assert.equal(tube.comment_id, null, "and no comment");
});

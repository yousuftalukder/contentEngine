/* Content Engine dashboard. Vanilla JS, hash routing, talks to /api/* on the same origin. */
"use strict";

// ---------------------------------------------------------------- helpers
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in el && typeof v !== "string") el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const $ = (sel, root = document) => root.querySelector(sel);

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers: opts.body ? { "Content-Type": "application/json" } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
const get = (p) => api(p);
const post = (p, body = {}) => api(p, { method: "POST", body });
const patch = (p, body) => api(p, { method: "PATCH", body });
const put = (p, body) => api(p, { method: "PUT", body });
const del = (p) => api(p, { method: "DELETE" });

function toast(msg, err = false) {
  const t = h("div", { class: "toast" + (err ? " err" : "") }, msg);
  $("#toasts").appendChild(t);
  setTimeout(() => t.remove(), err ? 7000 : 3500);
}
async function run(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg); return r; }
  catch (e) { toast(e.message, true); throw e; }
}

function modal(title, body, { wide } = {}) {
  const m = $("#modal");
  const close = () => { m.hidden = true; m.innerHTML = ""; };
  const dlg = h("div", { class: "dialog", style: wide ? "max-width:960px" : "" }, h("h2", null, title), body);
  m.innerHTML = ""; m.appendChild(dlg); m.hidden = false;
  m.onclick = (e) => { if (e.target === m) close(); };
  document.onkeydown = (e) => { if (e.key === "Escape") close(); };
  return close;
}
function confirmModal(title, text, onYes, yesLabel = "Confirm") {
  const close = modal(title, h("div", null, h("p", null, text), h("div", { class: "foot" },
    h("button", { class: "btn", onclick: () => close() }, "Cancel"),
    h("button", { class: "btn primary", onclick: async () => { await onYes(); close(); } }, yesLabel))));
}

function fmtDate(d) { if (!d) return "—"; const x = new Date(d); return isNaN(x) ? "—" : x.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }); }
function ago(d) { if (!d) return ""; const s = (Date.now() - new Date(d)) / 1000; if (s < 60) return "just now"; if (s < 3600) return `${Math.floor(s / 60)} min ago`; if (s < 86400) return `${Math.floor(s / 3600)} h ago`; return `${Math.floor(s / 86400)} d ago`; }
function untilText(d) { if (!d) return ""; const s = (new Date(d) - Date.now()) / 60000; if (s <= 0) return "auto-approving now"; if (s < 60) return `auto-approves in ${Math.round(s)} min`; return `auto-approves in ${(s / 60).toFixed(1)} h`; }
const yes = (v) => v === true || v === 1 || v === "1";
const usd = (n) => "$" + Number(n || 0).toFixed(3);
const nice = (s) => String(s || "").replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

const STATUS_COLOR = {
  PENDING_REVIEW: "amber", APPROVED: "blue", RENDERING: "blue", READY_TO_PUBLISH: "blue", PUBLISHING: "blue", RENDERED: "blue",
  PUBLISHED: "green", SUCCEEDED: "green", PROCESSED: "green",
  REJECTED: "red", FAILED: "red", IGNORED: "",
  REPURPOSED: "violet", TRACKED: "violet",
};
const tag = (s) => h("span", { class: "tag " + (STATUS_COLOR[s] || "") }, nice(s));

const CONTENT_TYPES = ["NEWS_STATIC", "NICHE_STATIC", "LONG_POST", "IMAGE_SLIDESHOW", "LONG_FORM_VIDEO", "PODCAST_CLIP", "REACTION_CLIP", "VOICEOVER_CLIP", "MOVIE_RECAP"];
const VIDEO_TYPES = new Set(["PODCAST_CLIP", "REACTION_CLIP", "VOICEOVER_CLIP", "MOVIE_RECAP"]);
const PLATFORMS = ["FACEBOOK", "INSTAGRAM", "YOUTUBE", "PORTAL"];
const FORMATS = [["STATIC_IMAGE_CAPTION", "Image + caption"], ["TEXT_POST", "Text-only post"], ["SHORT_FORM_VOICEOVER", "Short vertical video (Reels / Shorts)"], ["LONG_FORM_VIDEO", "Long landscape video"]];
const PROVIDERS = ["anthropic", "gemini", "elevenlabs", "newsapi", "youtube", "meta"];
const PROVIDER_ENV = { anthropic: "ANTHROPIC_API_KEY", gemini: "GEMINI_API_KEY", elevenlabs: "ELEVENLABS_API_KEY", newsapi: "NEWSAPI_KEY", youtube: "YOUTUBE_API_KEY", meta: "META_ACCESS_TOKEN" };

// form field builders
function field(label, input, help) { return h("label", { class: "field" }, h("span", null, label), input, help ? h("span", { class: "help" }, help) : null); }
function text(name, value = "", extra = {}) { return h("input", { type: "text", name, value: value ?? "", ...extra }); }
function num(name, value, extra = {}) { return h("input", { type: "number", name, value: value ?? "", ...extra }); }
function area(name, value = "", extra = {}) { return h("textarea", { name, ...extra }, value ?? ""); }
function select(name, options, value, extra = {}) {
  const s = h("select", { name, ...extra });
  for (const o of options) { const [v, l] = Array.isArray(o) ? o : [o, o]; s.appendChild(h("option", { value: v, selected: String(v) === String(value ?? "") }, l)); }
  return s;
}
function check(name, label, checked) { return h("label", { class: "check" }, h("input", { type: "checkbox", name, checked: !!checked }), label); }
function readForm(root) {
  const out = {};
  root.querySelectorAll("[name]").forEach((el) => {
    if (el.type === "checkbox") out[el.name] = el.checked;
    else if (el.type === "number") out[el.name] = el.value === "" ? null : Number(el.value);
    else if (el.dataset.json) { try { out[el.name] = el.value.trim() ? JSON.parse(el.value) : (el.dataset.json === "arr" ? [] : {}); } catch { throw new Error(`"${el.name}" must be valid JSON`); } }
    else if (el.dataset.list) out[el.name] = el.value.split(",").map((x) => x.trim()).filter(Boolean);
    else out[el.name] = el.value;
  });
  return out;
}
function formDialog(title, fields, onSave, { saveLabel = "Save", wide } = {}) {
  const form = h("div", null, fields);
  const close = modal(title, h("div", null, form, h("div", { class: "foot" },
    h("button", { class: "btn", onclick: () => close() }, "Cancel"),
    h("button", { class: "btn primary", onclick: async (e) => { e.target.disabled = true; try { await onSave(readForm(form)); close(); } catch (err) { toast(err.message, true); e.target.disabled = false; } } }, saveLabel))), { wide });
}
function jsonDialog(title, obj) { modal(title, h("div", null, h("pre", null, JSON.stringify(obj, null, 2)))); }

// ---------------------------------------------------------------- shell
const PAGES = [
  ["overview", "Overview"], ["review", "Review", "review"], ["items", "Content"], ["programs", "Programs"], ["sources", "Sources"],
  ["candidates", "Video candidates"], ["channels", "Channels"], ["adapters", "Adapters"], ["keys", "API keys"], ["settings", "Settings"],
];
let health = null, stats = null;

function renderRail(active) {
  const links = $("#railLinks"); links.innerHTML = "";
  for (const [id, label, badge] of PAGES) {
    const a = h("a", { href: "#/" + id, class: active === id ? "active" : "" }, label);
    if (badge === "review") { const n = stats?.items?.PENDING_REVIEW || 0; if (n) a.appendChild(h("span", { class: "count" }, n)); }
    if (id === "items") { const n = stats?.items?.FAILED || 0; if (n) a.appendChild(h("span", { class: "count quiet" }, n + " failed")); }
    links.appendChild(a);
    if (id === "overview" || id === "items" || id === "channels") links.appendChild(h("div", { class: "rail-sep" }));
  }
  const f = $("#railFoot"); f.innerHTML = "";
  if (health) f.append(
    h("div", null, h("span", { class: "dot" + (health.ok ? "" : " off") }), h("b", null, health.ok ? "Engine running" : "Database unreachable")),
    h("div", null, "Spent today ", h("b", null, usd(health.spentTodayUsd)), stats?.budgetCapUsd ? ` of $${stats.budgetCapUsd}` : ""),
    h("div", null, "Storage ", h("b", null, health.storage), " · ffmpeg ", h("b", null, health.ffmpeg ? "yes" : "no")),
    stats?.globalPause ? h("div", { style: "color:var(--amber)" }, "Publishing paused") : null,
  );
}
async function refreshMeta() {
  [health, stats] = await Promise.all([get("/health").catch(() => ({ ok: false })), get("/api/stats").catch(() => null)]);
}
async function route() {
  const id = (location.hash.replace(/^#\/?/, "").split("/")[0]) || "overview";
  const sub = location.hash.split("/").slice(2).join("/");
  const main = $("#main"); main.innerHTML = "";
  main.appendChild(h("p", { class: "muted" }, "Loading…"));
  await refreshMeta();
  renderRail(id);
  $("#rail").classList.remove("open");
  const page = pages[id] || pages.overview;
  try { main.innerHTML = ""; main.appendChild(await page(sub)); }
  catch (e) { main.innerHTML = ""; main.appendChild(h("div", { class: "empty" }, h("b", null, "This page could not load"), e.message)); }
}
function pageHead(title, desc, ...actions) {
  return h("div", { class: "page-head" }, h("div", null, h("h1", null, title), desc ? h("p", null, desc) : null), actions.length ? h("div", { class: "actions" }, actions) : null);
}
const pages = {};

// ---------------------------------------------------------------- overview
pages.overview = async () => {
  const [programs, sources, channels] = await Promise.all([get("/api/programs"), get("/api/sources"), get("/api/channels")]);
  const it = stats?.items || {}, as = stats?.assets || {};
  const pending = it.PENDING_REVIEW || 0;
  const seeded = programs.length > 0;
  const generated = Object.values(it).reduce((a, b) => a + b, 0) > 0;
  const published = (as.PUBLISHED || 0) > 0;
  const lanes = ["ingest", "text", "image", "video", "publish", "metrics"];
  const queues = stats?.queues || {};

  const root = h("div", null,
    pageHead("Overview", "Everything that needs a decision from you shows up in Review. The rest runs on its own.",
      h("button", { class: "btn", onclick: () => route() }, "Refresh")),
    h("div", { class: "desk" },
      h("a", { class: "big", href: "#/review", style: "text-decoration:none;color:inherit" },
        h("div", { class: "n" + (pending ? "" : " zero") }, pending),
        h("div", { class: "l" }, pending === 1 ? "item waiting for your review" : "items waiting for your review")),
      h("div", { class: "stat-list" },
        stat(it.QUEUED + it.FETCHING_DATA + it.DRAFTING || 0, "Generating now"),
        stat(as.PUBLISHED || 0, "Published"),
        stat((it.FAILED || 0) + (as.FAILED || 0), "Failed", (it.FAILED || as.FAILED) ? "red" : ""),
        stat(stats?.activeSources ?? 0, "Active sources"))),

    h("h2", null, "Worker lanes"),
    h("div", { class: "panel" },
      h("p", { class: "muted", style: "margin:0 0 10px" }, "Click a lane to pause or resume it. Paused lanes keep their jobs and pick them up when resumed."),
      h("div", { class: "lanes" }, lanes.map((l) => h("button", { class: "lane" + (queues[l] === false ? " off" : ""), onclick: async () => {
        const next = { ...queues, [l]: queues[l] === false };
        await run(() => put("/api/settings/queues.enabled", { value: next }), `${l} lane ${next[l] === false ? "paused" : "resumed"}`); route();
      } }, h("span", { class: "dot" }), l))),
      stats?.globalPause ? h("p", { style: "margin:12px 0 0;color:var(--amber)" }, "Publishing is globally paused (Settings). Approved items will wait.") : null),

    h("h2", null, "Getting the first item through"),
    h("div", { class: "panel" },
      h("ol", { class: "steps" },
        step(seeded, h("span", null, "Create the starter setup: a demo brand, a mock news feed, the “Bangladesh News” program and a mock Facebook channel. ",
          !seeded ? h("button", { class: "btn primary sm", onclick: () => run(async () => { const r = await post("/api/seed"); jsonDialog("Starter setup created", r); route(); }, "Starter setup created") }, "Create starter setup") : null)),
        step(sources.some((s) => s.item_count > 0), h("span", null, "Poll the mock source so it drops a few headlines into the inbox. ",
          seeded && !generated ? h("button", { class: "btn sm", onclick: () => run(async () => { for (const s of sources) await post(`/api/sources/${s.id}/poll`); }, "Polling queued — check back in ~30 s") }, "Poll all sources now") : null)),
        step(generated, h("span", null, "The program picks up new headlines automatically, or you can generate one on demand from ", h("a", { href: "#/programs" }, "Programs"), ".")),
        step(pending > 0 || published, h("span", null, "Approve the item in ", h("a", { href: "#/review" }, "Review"), ".")),
        step(published, h("span", null, "It renders and publishes to every channel subscribed to the program (mock publisher for now), and lands in ", h("a", { href: "#/items" }, "Content"), ".")),
      )),
  );
  return root;
};
function stat(n, l, color) { return h("div", { class: "stat" }, h("div", { class: "n", style: color ? `color:var(--${color})` : "" }, n), h("div", { class: "l" }, l)); }
function step(done, content) { return h("li", { class: done ? "done" : "" }, content); }

// ---------------------------------------------------------------- review
pages.review = async (sub) => {
  const list = await get("/api/review");
  const root = h("div", null, pageHead("Review", "Nothing publishes without your approval. Edit anything before you approve it."));
  if (!list.length) {
    root.appendChild(h("div", { class: "empty" }, h("b", null, "The queue is empty"), "New drafts appear here as programs generate them. ", h("a", { href: "#/programs" }, "Generate one now"), "."));
    return root;
  }
  let activeId = sub || list[0].id;
  const queue = h("div", { class: "queue" });
  const proof = h("div", null);
  const draw = () => {
    queue.innerHTML = "";
    for (const it of list) queue.appendChild(h("a", { class: "qitem" + (it.id === activeId ? " active" : ""), href: `#/review/${it.id}`, onclick: (e) => { e.preventDefault(); activeId = it.id; history.replaceState(null, "", `#/review/${it.id}`); draw(); load(); } },
      h("div", { class: "t" }, it.headline || it.topic || "(untitled)"),
      h("div", { class: "m" }, it.program_name, " · ", nice(it.content_type || it.program_type), it.review_deadline_at ? h("div", { class: "deadline" }, untilText(it.review_deadline_at)) : null)));
  };
  const load = async () => { proof.innerHTML = ""; proof.appendChild(h("p", { class: "muted" }, "Loading…")); const full = await get(`/api/content-items/${activeId}`); proof.innerHTML = ""; proof.appendChild(proofView(full, () => route())); };
  draw(); load();
  root.appendChild(h("div", { class: "review" }, queue, proof));
  return root;
};

function proofView(it, onDone) {
  const isVideo = VIDEO_TYPES.has(it.content_type) || it.content_type === "IMAGE_SLIDESHOW" || it.content_type === "LONG_FORM_VIDEO";
  const caps = it.captions || {};
  const hero = it.hero_media;
  const heroEl = !hero ? null
    : hero.kind === "VIDEO" ? h("video", { src: hero.url, controls: true })
    : hero.kind === "AUDIO" ? h("audio", { src: hero.url, controls: true })
    : h("img", { class: "hero", src: hero.url, alt: "" });

  const headline = h("textarea", { class: "serif", name: "headline", style: "min-height:52px;font-size:22px;font-weight:600" }, it.headline || "");
  const summary = h("textarea", { name: "summary", style: "min-height:60px" }, it.summary || "");
  const body = (it.body || it.script) ? h("textarea", { class: "serif", name: it.body != null ? "body" : "script", style: "min-height:180px" }, it.body ?? it.script ?? "") : null;
  const capEls = {};
  const capBlock = Object.keys(caps).length ? h("div", null, Object.entries(caps).map(([k, v]) => h("div", { class: "cap" }, h("div", { class: "k" }, k), capEls[k] = h("textarea", { style: "min-height:56px;background:transparent;border:0;padding:0" }, v || "")))) : null;
  const hashtags = h("input", { type: "text", value: (it.hashtags || []).join(", ") });
  const imgPrompt = it.image_prompt != null ? h("textarea", { style: "min-height:48px" }, it.image_prompt) : null;
  const schedule = h("input", { type: "datetime-local" });
  const note = h("input", { type: "text", placeholder: "Why? (optional — helps the next draft)" });

  const collect = () => {
    const p = { headline: headline.value, summary: summary.value, hashtags: hashtags.value.split(",").map((x) => x.trim()).filter(Boolean) };
    if (body) p[body.name] = body.value;
    if (capBlock) p.captions = Object.fromEntries(Object.entries(capEls).map(([k, el]) => [k, el.value]));
    if (imgPrompt) p.imagePrompt = imgPrompt.value;
    return p;
  };
  const save = () => run(() => patch(`/api/content-items/${it.id}`, collect()), "Draft saved");
  const approve = () => run(async () => { await patch(`/api/content-items/${it.id}`, collect()); await post(`/api/content-items/${it.id}/approve`, { scheduledFor: schedule.value ? new Date(schedule.value).toISOString() : null }); onDone(); }, "Approved — rendering and publishing");
  const reject = () => run(async () => { await post(`/api/content-items/${it.id}/reject`, { note: note.value }); onDone(); }, "Rejected");
  const regen = (part) => run(async () => { await patch(`/api/content-items/${it.id}`, collect()); await post(`/api/content-items/${it.id}/regenerate`, { part }); onDone(); }, `Regenerating ${part}`);

  const src = it.source_data_ref || {};
  return h("div", { class: "proof" },
    h("div", { class: "row small mute" }, tag(it.status), h("span", null, it.program_name), h("span", null, nice(it.content_type)), h("span", null, "created ", ago(it.created_at)), h("span", null, "cost ", usd(it.generation_cost_usd)),
      it.review_deadline_at ? h("span", { class: "deadline" }, untilText(it.review_deadline_at)) : null,
      h("button", { class: "btn link sm right", onclick: () => jsonDialog("Raw item", it) }, "Raw JSON")),
    field("Headline", headline),
    heroEl,
    hero ? h("div", { class: "row small mute", style: "margin:-6px 0 10px" }, h("span", null, hero.kind, hero.width ? ` ${hero.width}×${hero.height}` : "", hero.duration_seconds ? ` ${Math.round(hero.duration_seconds)}s` : ""), h("a", { href: hero.url, target: "_blank" }, "Open"), !isVideo ? h("button", { class: "btn link sm", onclick: () => regen("image") }, "Regenerate image") : null) : null,
    field("Summary", summary),
    body ? field(it.body != null ? "Article / post body" : "Script", body) : null,
    imgPrompt ? field("Image prompt", imgPrompt, "Edit and regenerate the image to get a different visual.") : null,
    capBlock ? h("div", { class: "field" }, h("span", null, "Captions by platform"), capBlock) : null,
    field("Hashtags", hashtags, "Comma-separated."),
    src.url || src.provider ? h("p", { class: "small mute" }, "Source: ", src.provider || "", " ", src.url ? h("a", { href: src.url, target: "_blank", rel: "noopener" }, src.url) : null) : null,
    it.assets?.length ? h("div", { class: "small mute" }, "Will publish to: ", it.assets.map((a) => `${a.channel_name} (${a.platform})`).join(", ")) : null,
    h("div", { class: "bar" },
      h("button", { class: "btn primary", onclick: approve }, "Approve & publish"),
      h("span", { class: "small mute" }, "or schedule for"), schedule,
      h("button", { class: "btn", onclick: save }, "Save draft"),
      h("button", { class: "btn", onclick: () => regen(isVideo ? "all" : "headline") }, isVideo ? "Re-render" : "Regenerate headline"),
      !isVideo ? h("button", { class: "btn", onclick: () => regen("captions") }, "Regenerate captions") : null,
      h("button", { class: "btn", onclick: () => regen("all") }, "Regenerate everything")),
    h("div", { class: "row" }, note, h("button", { class: "btn danger", onclick: reject }, "Reject")),
  );
}

// ---------------------------------------------------------------- content ledger
pages.items = async (sub) => {
  const filters = ["", "PENDING_REVIEW", "APPROVED", "RENDERING", "PUBLISHED", "FAILED", "REJECTED", "QUEUED", "DRAFTING"];
  let status = sub || "";
  const wrap = h("div", null);
  const root = h("div", null, pageHead("Content", "Every item the engine has produced, newest first."), wrap);
  const draw = async () => {
    wrap.innerHTML = "";
    const tabs = h("div", { class: "tabs" }, filters.map((f) => h("button", { class: f === status ? "active" : "", onclick: () => { status = f; history.replaceState(null, "", "#/items/" + f); draw(); } }, f ? nice(f) : "All")));
    const rows = await get("/api/content-items" + (status ? `?status=${status}` : ""));
    wrap.append(tabs, !rows.length ? h("div", { class: "empty" }, h("b", null, "Nothing here yet")) :
      h("div", { class: "table-wrap" }, h("table", null,
        h("thead", null, h("tr", null, h("th", null, "Item"), h("th", null, "Program"), h("th", null, "Status"), h("th", null, "Created"), h("th", null, "Cost"), h("th"))),
        h("tbody", null, rows.map((r) => h("tr", null,
          h("td", null, h("a", { href: "#", onclick: (e) => { e.preventDefault(); openItem(r.id); } }, r.headline || r.topic || "(untitled)"), h("span", { class: "sub" }, nice(r.content_type))),
          h("td", null, r.program_name),
          h("td", null, tag(r.status), r.rejection_note ? h("span", { class: "sub" }, r.rejection_note) : null),
          h("td", { class: "small" }, fmtDate(r.created_at)),
          h("td", { class: "small" }, usd(r.generation_cost_usd)),
          h("td", { class: "row" },
            r.status === "PENDING_REVIEW" ? h("a", { class: "btn sm", href: `#/review/${r.id}` }, "Review") : null,
            r.status === "FAILED" ? h("button", { class: "btn sm", onclick: () => run(() => post(`/api/content-items/${r.id}/regenerate`, { part: "all" }), "Regenerating").then(draw) }, "Retry") : null,
            ["FAILED", "REJECTED"].includes(r.status) ? h("button", { class: "btn sm danger", onclick: () => confirmModal("Delete item?", "This removes the item and its media records.", () => run(() => del(`/api/content-items/${r.id}`), "Deleted").then(draw)) }, "Delete") : null)))))));
  };
  await draw();
  return root;
};
async function openItem(id) {
  const it = await get(`/api/content-items/${id}`);
  const jobs = await get(`/api/jobs?contentItemId=${id}`);
  modal(it.headline || it.topic || "Item", h("div", null,
    h("div", { class: "row small mute", style: "margin-bottom:10px" }, tag(it.status), it.program_name, nice(it.content_type), "created " + ago(it.created_at)),
    it.hero_media ? (it.hero_media.kind === "IMAGE" ? h("img", { class: "hero", src: it.hero_media.url, style: "max-height:260px;width:100%;object-fit:cover;border-radius:4px" }) : h("a", { href: it.hero_media.url, target: "_blank" }, "Open media")) : null,
    it.summary ? h("p", null, it.summary) : null,
    it.portal_url ? h("p", null, "Portal article: ", h("a", { href: it.portal_url, target: "_blank" }, it.portal_url)) : null,
    h("h3", { style: "margin-top:14px" }, "Publish targets"),
    it.assets?.length ? h("div", { class: "table-wrap" }, h("table", null, h("tbody", null, it.assets.map((a) => h("tr", null,
      h("td", null, a.channel_name, h("span", { class: "sub" }, a.platform)), h("td", null, tag(a.status), a.error_message ? h("span", { class: "sub", style: "color:var(--red)" }, a.error_message) : null),
      h("td", { class: "small" }, a.published_url ? h("a", { href: a.published_url, target: "_blank" }, "View post") : a.scheduled_for ? "scheduled " + fmtDate(a.scheduled_for) : ""),
      h("td", { class: "row" },
        a.status === "FAILED" ? h("button", { class: "btn sm", onclick: () => run(() => post(`/api/assets/${a.id}/retry`), "Retry queued") }, "Retry") : null,
        a.status === "PUBLISHED" ? h("button", { class: "btn sm", onclick: () => run(async () => jsonDialog("Metrics", await post(`/api/assets/${a.id}/poll-metrics`))) }, "Pull metrics") : null,
        a.status === "PUBLISHED" ? h("button", { class: "btn sm", onclick: () => run(async () => { const r = await post(`/api/assets/${a.id}/check-repurpose`); toast(r.repurposed ? "Queued a repurposed draft" : "Not above the view threshold yet"); }) }, "Check repurpose") : null)))))) : h("p", { class: "mute" }, "No channels yet — assets are created on approval."),
    it.status === "APPROVED" || it.assets?.some((a) => ["PENDING", "FAILED"].includes(a.status)) ? h("button", { class: "btn", style: "margin-top:8px", onclick: () => run(() => post(`/api/content-items/${id}/publish-now`), "Publishing now") }, "Publish now") : null,
    h("h3", { style: "margin-top:14px" }, "Jobs"),
    jobs.length ? h("div", { class: "table-wrap" }, h("table", null, h("tbody", null, jobs.map((j) => h("tr", null,
      h("td", { class: "mono" }, j.type), h("td", null, tag(j.status)), h("td", { class: "small" }, "attempt ", j.attempts, j.error_message ? h("span", { class: "sub", style: "color:var(--red)" }, j.error_message) : null), h("td", { class: "small" }, fmtDate(j.created_at)),
      h("td", null, j.status === "FAILED" ? h("button", { class: "btn sm", onclick: () => run(() => post(`/api/jobs/${j.id}/retry`), "Job retried") }, "Retry") : null)))))) : h("p", { class: "mute" }, "No jobs recorded."),
    h("div", { class: "foot" }, h("button", { class: "btn link", onclick: () => jsonDialog("Raw item", it) }, "Raw JSON")),
  ), { wide: true });
}

// ---------------------------------------------------------------- programs
pages.programs = async () => {
  const [programs, brands, sources, channels, adapters, styles] = await Promise.all([get("/api/programs"), get("/api/brands"), get("/api/sources"), get("/api/channels"), get("/api/adapters"), get("/api/style-profiles")]);
  const root = h("div", null,
    pageHead("Programs", "A program is a recurring show: what it's about, where topics come from, which adapters make it, and how strictly you review it.",
      h("button", { class: "btn", onclick: () => brandDialog(brands) }, "Brands"),
      h("button", { class: "btn", onclick: () => styleDialog(styles, brands) }, "Style profiles"),
      h("button", { class: "btn primary", disabled: !brands.length, onclick: () => programDialog(null, brands, sources, adapters, styles, route) }, "New program")));
  if (!brands.length) root.appendChild(h("div", { class: "empty" }, h("b", null, "Create a brand first"), "Programs and channels belong to a brand. ", h("button", { class: "btn sm", onclick: () => brandDialog(brands) }, "Add brand")));
  else if (!programs.length) root.appendChild(h("div", { class: "empty" }, h("b", null, "No programs yet"), "Create one, or use the starter setup on the Overview page."));
  for (const p of programs) root.appendChild(programCard(p, brands, sources, channels, adapters, styles));
  return root;
};
function programCard(p, brands, sources, channels, adapters, styles) {
  const isVideo = VIDEO_TYPES.has(p.content_type);
  const topic = h("input", { type: "text", placeholder: "Topic or headline", style: "max-width:320px" });
  return h("div", { class: "panel" },
    h("div", { class: "row" },
      h("div", null, h("h3", { style: "margin:0" }, p.display_name, " ", yes(p.is_active) ? null : h("span", { class: "tag red" }, "inactive")),
        h("div", { class: "small mute" }, nice(p.content_type), " · ", p.language, "/", p.country || "—", " · review: ", nice(p.approval_mode), p.approval_mode === "AUTO_AFTER_WINDOW" ? ` (${p.review_window_minutes || 60} min)` : "", " · ", p.max_items_per_day ? `${p.max_items_per_day}/day` : "no daily cap", yes(p.publish_to_portal) ? " · portal" : "")),
      h("div", { class: "right row" },
        h("button", { class: "btn sm", onclick: () => programDialog(p, brands, sources, adapters, styles, route) }, "Edit"),
        h("button", { class: "btn sm", onclick: () => run(() => patch(`/api/programs/${p.id}`, { isActive: !yes(p.is_active) }), yes(p.is_active) ? "Program paused" : "Program active").then(route) }, yes(p.is_active) ? "Pause" : "Activate"),
        h("button", { class: "btn sm danger", onclick: () => confirmModal("Delete program?", "Only works if it has no content items; otherwise pause it.", () => run(() => del(`/api/niches/${p.id}`), "Deleted").then(route)) }, "Delete"))),
    h("div", { class: "grid2", style: "margin-top:12px" },
      h("div", null, h("div", { class: "small muted" }, "Sources feeding it"),
        h("div", { class: "row", style: "margin-top:4px" }, (p.sources || []).map((s) => h("span", { class: "tag blue" }, s.name, " ", h("a", { href: "#", title: "Unlink", onclick: (e) => { e.preventDefault(); run(() => del(`/api/niches/${p.id}/sources/${s.id}`), "Source unlinked").then(route); } }, "×"))),
          linkPicker(sources.filter((s) => !(p.sources || []).some((x) => x.id === s.id)), (id) => run(() => post(`/api/niches/${p.id}/sources/${id}`), "Source linked").then(route), "Link source"))),
      h("div", null, h("div", { class: "small muted" }, "Publishes to"),
        h("div", { class: "row", style: "margin-top:4px" }, (p.channels || []).map((c) => h("span", { class: "tag green" }, c.name, " ", h("a", { href: "#", title: "Unsubscribe", onclick: (e) => { e.preventDefault(); run(() => del(`/api/channels/${c.id}/niches/${p.id}`), "Channel unsubscribed").then(route); } }, "×"))),
          linkPicker(channels.filter((c) => !(p.channels || []).some((x) => x.id === c.id)).map((c) => ({ id: c.id, name: c.display_name })), (id) => run(() => post(`/api/channels/${id}/niches/${p.id}`), "Channel subscribed").then(route), "Add channel")))),
    h("div", { class: "row", style: "margin-top:12px" },
      isVideo ? h("span", { class: "small mute" }, "Video programs generate from video candidates, not from a topic.") : [topic,
        h("button", { class: "btn sm", onclick: () => run(async () => { await post("/api/generate", { nicheId: p.id, topic: topic.value || undefined }); }, "Generating — it will land in Review").then(() => { topic.value = ""; refreshMeta().then(() => renderRail("programs")); }) }, topic.value ? "Generate from topic" : "Generate now")],
      isVideo ? h("button", { class: "btn sm", onclick: () => candidateDialog(p.id) }, "Add a video URL") : null,
      h("a", { class: "btn sm link", href: `#/items` }, "See its content")));
}
function linkPicker(options, onPick, label) {
  if (!options.length) return null;
  const s = h("select", { style: "width:auto;padding:2px 6px;font-size:12px", onchange: (e) => { if (e.target.value) onPick(e.target.value); } }, h("option", { value: "" }, label + "…"), options.map((o) => h("option", { value: o.id }, o.name)));
  return s;
}
function programDialog(p, brands, sources, adapters, styles, done) {
  const a = adapters || {};
  const opt = (keys, cur) => select(null, [["", "(default)"], ...(keys || []).map((k) => [k, k])], cur || "");
  const f = h("div", null,
    h("div", { class: "grid2" },
      field("Name", text("displayName", p?.display_name)),
      p ? null : field("Key", text("key", "", { placeholder: "e.g. bd_news" }), "Short unique id, letters/underscores."),
      p ? null : field("Brand", select("brandId", brands.map((b) => [b.id, b.name]))),
      field("Content type", select("contentType", CONTENT_TYPES.map((t) => [t, nice(t)]), p?.content_type || "NEWS_STATIC")),
      field("Language", text("language", p?.language || "en")),
      field("Country", text("country", p?.country || "Bangladesh")),
      field("Review", select("approvalMode", [["MANUAL", "Manual — waits for me"], ["AUTO_AFTER_WINDOW", "Auto-approve after a window"], ["AUTO", "Auto — publish immediately"]], p?.approval_mode || "MANUAL")),
      field("Review window (minutes)", num("reviewWindowMinutes", p?.review_window_minutes ?? 60)),
      field("Max items per day", num("maxItemsPerDay", p?.max_items_per_day), "Leave empty for no cap."),
      field("Style profile", select("styleProfileId", [["", "(none)"], ...styles.map((s) => [s.id, s.name])], p?.style_profile_id || ""))),
    field("Tone", text("tone", p?.tone || "clear, factual, click-worthy")),
    check("publishToPortal", "Also publish an article to the news portal", p ? yes(p.publish_to_portal) : true),
    h("fieldset", null, h("legend", null, "Adapters (empty = program default)"),
      h("div", { class: "grid3" },
        field("Topic source", Object.assign(opt(a.topicSources, p?.topic_source_adapter), { name: "topicSourceAdapter" })),
        field("Script / LLM", Object.assign(opt(a.scriptAdapters, p?.script_adapter), { name: "scriptAdapter" })),
        field("Image", Object.assign(opt(a.imageAdapters, p?.image_adapter), { name: "imageAdapter" })),
        field("Voice", Object.assign(opt(a.voiceAdapters, p?.voice_adapter), { name: "voiceAdapter" })),
        field("Render", Object.assign(opt(a.renderAdapters, p?.render_adapter), { name: "renderAdapter" })),
        field("Embeddings (dedup)", Object.assign(opt(a.embedAdapters, p?.embed_adapter), { name: "embedAdapter" })),
        field("Download (video)", Object.assign(opt(a.downloadAdapters, p?.download_adapter), { name: "downloadAdapter" })),
        field("Transcript (video)", Object.assign(opt(a.transcriptAdapters, p?.transcript_adapter), { name: "transcriptAdapter" })),
        field("Clipper (video)", Object.assign(opt(a.clipAdapters, p?.clip_adapter), { name: "clipAdapter" })))),
    p ? null : field("Sources to link", multi("sourceIds", sources.map((s) => [s.id, s.name]))),
  );
  formDialog(p ? "Edit program" : "New program", f, async (v) => {
    for (const k of Object.keys(v)) if (v[k] === "" && k !== "tone") delete v[k];
    if (v.sourceIds) v.sourceIds = Array.from(f.querySelector("[name=sourceIds]").selectedOptions).map((o) => o.value);
    if (p) { delete v.brandId; delete v.key; await patch(`/api/programs/${p.id}`, v); } else await post("/api/programs", v);
    toast(p ? "Program saved" : "Program created"); done();
  }, { wide: true });
}
function multi(name, options) { return h("select", { name, multiple: true, style: "min-height:90px" }, options.map(([v, l]) => h("option", { value: v }, l))); }
function brandDialog(brands) {
  const list = h("div", null, brands.map((b) => h("div", { class: "row", style: "padding:6px 0;border-bottom:1px solid var(--ink-3)" }, h("b", { style: "font-weight:500" }, b.name), h("span", { class: "mute small" }, b.description),
    h("button", { class: "btn sm danger right", onclick: () => run(() => del(`/api/brands/${b.id}`), "Brand deleted").then(route) }, "Delete"))));
  const name = text("name", "", { placeholder: "New brand name" }), desc = text("description", "", { placeholder: "Description (optional)" });
  modal("Brands", h("div", null, list.childElementCount ? list : h("p", { class: "mute" }, "No brands yet."), h("div", { class: "row", style: "margin-top:14px" }, name, desc, h("button", { class: "btn primary", onclick: () => run(() => post("/api/brands", { name: name.value, description: desc.value }), "Brand created").then(route) }, "Add"))));
}
function styleDialog(styles, brands) {
  const edit = (s) => formDialog(s ? "Edit style profile" : "New style profile", h("div", null,
    h("div", { class: "grid2" }, field("Name", text("name", s?.name)), field("Language", text("language", s?.language || "en")), field("Brand", select("brandId", [["", "(any)"], ...brands.map((b) => [b.id, b.name])], s?.brand_id || ""))),
    field("Tone", text("tone", s?.tone)), field("Writing rules", area("rules", s?.rules)), field("Examples of good output", area("examples", s?.examples)),
    field("Banned terms", text("bannedTerms", (s?.banned_terms || []).join(", "), { "data-list": "1" }), "Comma-separated."),
    field("Call to action", text("cta", s?.cta)), field("Default hashtags", text("hashtags", (s?.hashtags || []).join(", "), { "data-list": "1" }), "Comma-separated.")),
    async (v) => { if (!v.brandId) delete v.brandId; if (s) await patch(`/api/style-profiles/${s.id}`, v); else await post("/api/style-profiles", v); toast("Style profile saved"); route(); });
  modal("Style profiles", h("div", null,
    styles.length ? styles.map((s) => h("div", { class: "row", style: "padding:6px 0;border-bottom:1px solid var(--ink-3)" }, h("b", { style: "font-weight:500" }, s.name), h("span", { class: "mute small" }, s.tone),
      h("span", { class: "right row" }, h("button", { class: "btn sm", onclick: () => edit(s) }, "Edit"), h("button", { class: "btn sm danger", onclick: () => run(() => del(`/api/style-profiles/${s.id}`), "Deleted").then(route) }, "Delete")))) : h("p", { class: "mute" }, "A style profile tells the LLM how your brand writes. Programs pick one."),
    h("div", { class: "foot" }, h("button", { class: "btn primary", onclick: () => edit(null) }, "New style profile"))));
}

// ---------------------------------------------------------------- sources
pages.sources = async (sub) => {
  const [sources, impls, programs, brands] = await Promise.all([get("/api/sources"), get("/api/adapter-impls"), get("/api/programs"), get("/api/brands")]);
  const configs = await get("/api/adapter-configs");
  const ingestKeys = configs.filter((c) => c.stage === "INGEST" && yes(c.enabled)).map((c) => [c.key, `${c.label} (${c.key})`]);
  const root = h("div", null,
    pageHead("Sources", "Feeds the engine polls for new headlines and videos. Each new item is routed to every program linked to the source.",
      h("button", { class: "btn primary", onclick: () => sourceDialog(null, ingestKeys, programs, brands) }, "New source")));
  if (!sources.length) root.appendChild(h("div", { class: "empty" }, h("b", null, "No sources yet"), "Add an RSS feed, a NewsAPI query, a YouTube channel — or the mock feed for testing."));
  else root.appendChild(h("div", { class: "table-wrap" }, h("table", null,
    h("thead", null, h("tr", null, h("th", null, "Source"), h("th", null, "Adapter"), h("th", null, "Every"), h("th", null, "Feeds"), h("th", null, "Items"), h("th", null, "Last polled"), h("th"))),
    h("tbody", null, sources.map((s) => h("tr", null,
      h("td", null, s.name, yes(s.is_active) ? null : h("span", { class: "tag red", style: "margin-left:6px" }, "paused"), h("span", { class: "sub mono" }, Object.keys(s.config || {}).length ? JSON.stringify(s.config).slice(0, 80) : "")),
      h("td", { class: "mono" }, s.adapter_key), h("td", null, s.poll_interval_minutes, " min"),
      h("td", null, (s.programs || []).map((p) => p.name).join(", ") || h("span", { class: "mute" }, "nothing — link it from Programs")),
      h("td", null, h("a", { href: "#", onclick: (e) => { e.preventDefault(); inboxDialog(s); } }, s.item_count)),
      h("td", { class: "small" }, s.last_polled_at ? ago(s.last_polled_at) : "never", s.last_error ? h("span", { class: "sub", style: "color:var(--red)" }, s.last_error.slice(0, 90)) : null),
      h("td", { class: "row" },
        h("button", { class: "btn sm", onclick: () => run(() => post(`/api/sources/${s.id}/poll`), "Poll queued") }, "Poll now"),
        h("button", { class: "btn sm", onclick: () => run(async () => { const r = await post(`/api/sources/${s.id}/preview`); previewDialog(s, r); }) }, "Preview"),
        h("button", { class: "btn sm", onclick: () => sourceDialog(s, ingestKeys, programs, brands) }, "Edit"),
        h("button", { class: "btn sm", onclick: () => run(() => patch(`/api/sources/${s.id}`, { isActive: !yes(s.is_active) }), "Saved").then(route) }, yes(s.is_active) ? "Pause" : "Resume"),
        h("button", { class: "btn sm danger", onclick: () => confirmModal("Delete source?", `Delete "${s.name}" and its inbox items?`, () => run(() => del(`/api/sources/${s.id}`), "Deleted").then(route)) }, "Delete"))))))));
  return root;
};
const SOURCE_HINTS = { rss: '{"url": "https://example.com/feed.xml"}', newsapi: '{"q": "Bangladesh", "language": "en"}', youtube_api: '{"channelId": "UC...", "q": "search terms"}', ytdlp_list: '{"url": "https://www.youtube.com/@channel/videos", "limit": 20}', ingest_mock: "{}" };
function sourceDialog(s, ingestKeys, programs, brands) {
  const cfg = area("config", JSON.stringify(s?.config || {}, null, 2), { "data-json": "obj", class: "mono" });
  const adapter = select("adapterKey", ingestKeys, s?.adapter_key || "rss", { onchange: (e) => { if (!s && SOURCE_HINTS[e.target.value]) cfg.value = SOURCE_HINTS[e.target.value]; } });
  if (!s) cfg.value = SOURCE_HINTS.rss;
  formDialog(s ? "Edit source" : "New source", h("div", null,
    h("div", { class: "grid2" }, field("Name", text("name", s?.name)), field("Adapter", adapter), field("Poll every (minutes)", num("pollIntervalMinutes", s?.poll_interval_minutes ?? 30)),
      field("License policy", select("licensePolicy", [["ANY", "Any"], ["CC_ONLY", "Creative Commons only"], ["OWN", "Own content only"]], s?.license_policy || "ANY")),
      s ? null : field("Brand", select("brandId", [["", "(none)"], ...brands.map((b) => [b.id, b.name])]))),
    field("Adapter config (JSON)", cfg, "What the adapter needs: feed URL, query, channel id…"),
    s ? null : field("Programs to feed", multi("nicheIds", programs.map((p) => [p.id, p.display_name])))),
    async (v) => { if (!s) { v.nicheIds = Array.from(document.querySelector("[name=nicheIds]").selectedOptions).map((o) => o.value); if (!v.brandId) delete v.brandId; await post("/api/sources", v); } else { delete v.brandId; await patch(`/api/sources/${s.id}`, v); } toast("Source saved"); route(); });
}
function previewDialog(s, items) {
  modal(`Preview: ${s.name}`, h("div", null, !items.length ? h("p", { class: "mute" }, "The adapter returned nothing. Check the config.") :
    h("div", { class: "table-wrap" }, h("table", null, h("tbody", null, items.map((i) => h("tr", null, h("td", null, i.title, h("span", { class: "sub" }, i.summary?.slice(0, 140))), h("td", { class: "small" }, i.url ? h("a", { href: i.url, target: "_blank", rel: "noopener" }, "open") : ""))))))), { wide: true });
}
async function inboxDialog(s) {
  const items = await get(`/api/source-items?sourceId=${s.id}`);
  modal(`Inbox: ${s.name}`, h("div", null, !items.length ? h("p", { class: "mute" }, "Nothing polled yet.") :
    h("div", { class: "table-wrap" }, h("table", null, h("tbody", null, items.map((i) => h("tr", null,
      h("td", null, i.title, h("span", { class: "sub" }, i.kind, " · ", fmtDate(i.published_at || i.created_at))), h("td", null, tag(i.status)),
      h("td", { class: "row" }, i.url ? h("a", { class: "btn sm link", href: i.url, target: "_blank", rel: "noopener" }, "Open") : null,
        h("button", { class: "btn sm", onclick: () => run(async () => { const r = await post(`/api/source-items/${i.id}/route`); toast(`Routed to ${r.routed} program(s)`); }) }, "Route again")))))))), { wide: true });
}

// ---------------------------------------------------------------- video candidates
pages.candidates = async () => {
  const [cands, programs] = await Promise.all([get("/api/video-candidates"), get("/api/programs")]);
  const videoPrograms = programs.filter((p) => VIDEO_TYPES.has(p.content_type));
  const root = h("div", null,
    pageHead("Video candidates", "Source videos scored for clipping. Processing downloads, transcribes, picks clips and sends each clip into Review.",
      h("button", { class: "btn primary", disabled: !videoPrograms.length, title: videoPrograms.length ? "" : "Create a video-type program first", onclick: () => candidateDialog(null, videoPrograms) }, "Add a video URL")));
  if (!cands.length) root.appendChild(h("div", { class: "empty" }, h("b", null, "No candidates yet"), videoPrograms.length ? "Add a video URL, or link a YouTube source to a video program." : "Create a program with a clip content type (Podcast clip, Reaction clip, …) first."));
  else root.appendChild(h("div", { class: "table-wrap" }, h("table", null,
    h("thead", null, h("tr", null, h("th", null, "Video"), h("th", null, "Program"), h("th", null, "Score"), h("th", null, "Status"), h("th", null, "Clips"), h("th"))),
    h("tbody", null, cands.map((c) => h("tr", null,
      h("td", null, h("a", { href: c.source_url, target: "_blank", rel: "noopener" }, c.title || c.source_url), h("span", { class: "sub" }, c.platform || "", c.duration_seconds ? ` · ${Math.round(c.duration_seconds / 60)} min` : "", c.view_count ? ` · ${c.view_count} views` : "", c.license ? ` · ${c.license}` : "")),
      h("td", null, c.program_name), h("td", null, Number(c.score || 0).toFixed(2), h("span", { class: "sub" }, c.score_reason)),
      h("td", null, tag(c.status), c.error_message ? h("span", { class: "sub", style: "color:var(--red)" }, c.error_message) : null), h("td", null, c.clip_count),
      h("td", { class: "row" },
        h("button", { class: "btn sm", onclick: () => run(() => post(`/api/video-candidates/${c.id}/process`), "Processing queued").then(route) }, c.status === "FAILED" ? "Retry" : "Process"),
        c.clip_count ? h("button", { class: "btn sm", onclick: () => run(async () => { const full = await get(`/api/video-candidates/${c.id}`); clipsDialog(full); }) }, "Clips") : null,
        c.status !== "IGNORED" ? h("button", { class: "btn sm", onclick: () => run(() => post(`/api/video-candidates/${c.id}/ignore`), "Ignored").then(route) }, "Ignore") : null)))))));
  return root;
};
async function candidateDialog(nicheId, videoPrograms) {
  if (!videoPrograms) videoPrograms = (await get("/api/programs")).filter((p) => VIDEO_TYPES.has(p.content_type));
  formDialog("Add a video", h("div", null,
    field("Program", select("nicheId", videoPrograms.map((p) => [p.id, p.display_name]), nicheId)),
    field("Video URL", h("input", { type: "url", name: "url", placeholder: "https://www.youtube.com/watch?v=…" })),
    field("Title (optional)", text("title")),
    field("License", select("license", [["UNKNOWN", "Unknown"], ["CC", "Creative Commons"], ["OWN", "Own content"], ["PERMISSION", "Have permission"]]))),
    async (v) => { await post("/api/video-candidates", v); toast("Queued for processing"); route(); }, { saveLabel: "Queue it" });
}
function clipsDialog(c) {
  modal(`Clips from: ${c.title}`, h("div", null, h("div", { class: "table-wrap" }, h("table", null, h("tbody", null, c.clips.map((k) => h("tr", null,
    h("td", null, k.title, h("span", { class: "sub" }, k.hook)), h("td", { class: "small" }, `${Math.round(k.start_seconds)}s → ${Math.round(k.end_seconds)}s`), h("td", null, Number(k.score || 0).toFixed(2)), h("td", null, tag(k.status)))))))), { wide: true });
}

// ---------------------------------------------------------------- channels
pages.channels = async () => {
  const [channels, brands, programs, configs] = await Promise.all([get("/api/channels"), get("/api/brands"), get("/api/programs"), get("/api/adapter-configs")]);
  const publishers = configs.filter((c) => c.stage === "PUBLISH" && yes(c.enabled)).map((c) => [c.key, `${c.label} (${c.key})`]);
  const root = h("div", null, pageHead("Channels", "Where approved content goes: a Facebook page, an Instagram account, a YouTube channel. Each channel subscribes to programs.",
    h("button", { class: "btn primary", disabled: !brands.length, onclick: () => channelDialog(null, brands, programs, publishers) }, "New channel")));
  if (!channels.length) root.appendChild(h("div", { class: "empty" }, h("b", null, "No channels yet"), "Add one and subscribe it to a program."));
  for (const c of channels) root.appendChild(h("div", { class: "panel" }, h("div", { class: "row" },
    h("div", null, h("h3", { style: "margin:0" }, c.display_name, " ", yes(c.is_active) ? null : h("span", { class: "tag red" }, "inactive")),
      h("div", { class: "small mute" }, c.platform, " · ", nice(c.format), " · publisher ", h("span", { class: "mono" }, c.publisher_adapter || "(platform default)"), " · up to ", c.max_posts_per_day ?? "∞", "/day, ", c.min_gap_minutes ?? 0, " min apart · ", c.timezone),
      h("div", { class: "small", style: "margin-top:4px" }, "Programs: ", (c.niches || []).length ? c.niches.map((n) => n.display_name).join(", ") : h("span", { class: "mute" }, "none — subscribe from Programs"))),
    h("div", { class: "right row" },
      h("button", { class: "btn sm", onclick: () => run(async () => jsonDialog("Test publish result", await post(`/api/channels/${c.id}/test-publish`, { message: "Content Engine connection test" }))) }, "Test"),
      h("button", { class: "btn sm", onclick: () => channelDialog(c, brands, programs, publishers) }, "Edit"),
      h("button", { class: "btn sm", onclick: () => run(() => patch(`/api/channels/${c.id}`, { isActive: !yes(c.is_active) }), "Saved").then(route) }, yes(c.is_active) ? "Pause" : "Activate"),
      h("button", { class: "btn sm danger", onclick: () => confirmModal("Delete channel?", "Only works if nothing was ever published to it.", () => run(() => del(`/api/channels/${c.id}`), "Deleted").then(route)) }, "Delete")))));
  return root;
};
function channelDialog(c, brands, programs, publishers) {
  formDialog(c ? "Edit channel" : "New channel", h("div", null,
    h("div", { class: "grid2" },
      field("Name", text("displayName", c?.display_name)),
      c ? null : field("Key", text("key", "", { placeholder: "e.g. fb_main" })),
      c ? null : field("Brand", select("brandId", brands.map((b) => [b.id, b.name]))),
      field("Platform", select("platform", PLATFORMS, c?.platform || "FACEBOOK")),
      field("Format", select("format", FORMATS, c?.format || "STATIC_IMAGE_CAPTION"), "Short vertical is the only format that triggers 9:16 rendering and #Shorts tagging."),
      field("Publisher adapter", select("publisherAdapter", [["", "(platform default)"], ...publishers], c?.publisher_adapter || "")),
      field("Platform account id", text("platformAccountId", c?.platform_account_id), "Facebook Page ID, IG business account id, or YouTube channel id."),
      field("Timezone", text("timezone", c?.timezone || "Asia/Dhaka")),
      field("Max posts per day", num("maxPostsPerDay", c?.max_posts_per_day ?? 12)),
      field("Minimum gap (minutes)", num("minGapMinutes", c?.min_gap_minutes ?? 30))),
    field("Caption template", area("captionTemplate", c?.caption_template, { placeholder: "{caption}\n\n{hashtags}" }), "Placeholders: {caption} {headline} {hashtags} {portal_url}"),
    field("Platform config (JSON)", area("platformConfig", JSON.stringify(c?.platform_config || {}, null, 2), { "data-json": "obj", class: "mono" }), 'e.g. {"token_env": "META_ACCESS_TOKEN_PAGE2"} to use a different token for this page.'),
    c ? null : field("Subscribe to programs", multi("nicheIds", programs.map((p) => [p.id, p.display_name])))),
    async (v) => { if (!v.publisherAdapter) delete v.publisherAdapter; if (c) await patch(`/api/channels/${c.id}`, v); else { v.nicheIds = Array.from(document.querySelector("[name=nicheIds]").selectedOptions).map((o) => o.value); await post("/api/channels", v); } toast("Channel saved"); route(); }, { wide: true });
}

// ---------------------------------------------------------------- adapters
const STAGE_ORDER = ["INGEST", "TOPIC", "SCRIPT", "IMAGE", "VOICE", "RENDER", "DOWNLOAD", "TRANSCRIBE", "CLIP", "EMBED", "PUBLISH"];
const STAGE_HELP = { INGEST: "Pull items from feeds", TOPIC: "Pick a topic on demand", SCRIPT: "Write headlines, articles, captions (LLM)", IMAGE: "Generate the hero image", VOICE: "Text to speech", RENDER: "Assemble the video", DOWNLOAD: "Fetch source video", TRANSCRIBE: "Speech to text", CLIP: "Choose clip moments", EMBED: "Embeddings for duplicate detection", PUBLISH: "Post to a platform" };
pages.adapters = async () => {
  const [configs, impls, creds] = await Promise.all([get("/api/adapter-configs"), get("/api/adapter-impls"), get("/api/credentials")]);
  const root = h("div", null, pageHead("Adapters", "Each pipeline stage has named adapter instances. Mocks let everything run without keys; switch a program to a live instance when its key is in place.",
    h("button", { class: "btn primary", onclick: () => adapterDialog(null, impls, creds) }, "New instance")));
  for (const stage of STAGE_ORDER) {
    const rows = configs.filter((c) => c.stage === stage);
    if (!rows.length && !impls[stage]) continue;
    root.appendChild(h("h2", null, nice(stage), " ", h("span", { class: "small mute", style: "font-family:var(--sans);font-weight:400" }, STAGE_HELP[stage])));
    root.appendChild(h("div", { class: "table-wrap" }, h("table", null, h("tbody", null, rows.map((c) => h("tr", null,
      h("td", null, c.label, h("span", { class: "sub mono" }, c.key)),
      h("td", null, h("span", { class: "tag" + (c.impl.includes("mock") ? "" : " blue") }, (impls[stage] || []).find((i) => i.id === c.impl)?.label || c.impl)),
      h("td", { class: "small mono mute" }, Object.keys(c.config || {}).length ? JSON.stringify(c.config).slice(0, 60) : ""),
      h("td", null, yes(c.enabled) ? h("span", { class: "tag green" }, "enabled") : h("span", { class: "tag red" }, "disabled")),
      h("td", { class: "row" },
        h("button", { class: "btn sm", onclick: () => run(async () => jsonDialog(`Test: ${c.key}`, await post(`/api/adapter-configs/${c.key}/test`))) }, "Test"),
        h("button", { class: "btn sm", onclick: () => adapterDialog(c, impls, creds) }, "Edit"),
        h("button", { class: "btn sm", onclick: () => run(() => patch(`/api/adapter-configs/${c.id}`, { enabled: !yes(c.enabled) }), "Saved").then(route) }, yes(c.enabled) ? "Disable" : "Enable"),
        h("button", { class: "btn sm danger", onclick: () => confirmModal("Delete instance?", `Programs referencing "${c.key}" will fail at this stage.`, () => run(() => del(`/api/adapter-configs/${c.id}`), "Deleted").then(route)) }, "Delete"))))))));
  }
  return root;
};
function adapterDialog(c, impls, creds) {
  const stageSel = select("stage", STAGE_ORDER.filter((s) => impls[s]), c?.stage || "SCRIPT", { disabled: !!c });
  const implSel = select("impl", [], c?.impl);
  const schema = h("div", { class: "small mute" });
  const fillImpls = () => { implSel.innerHTML = ""; for (const i of impls[stageSel.value] || []) implSel.appendChild(h("option", { value: i.id, selected: i.id === (c?.impl) }, i.label)); showSchema(); };
  const showSchema = () => { const i = (impls[stageSel.value] || []).find((x) => x.id === implSel.value); schema.textContent = i && Object.keys(i.configSchema || {}).length ? "Config keys: " + Object.entries(i.configSchema).map(([k, v]) => `${k} (${typeof v === "string" ? v : v?.type || "any"})`).join(", ") : "No config needed."; };
  stageSel.onchange = fillImpls; implSel.onchange = showSchema; fillImpls();
  formDialog(c ? "Edit adapter instance" : "New adapter instance", h("div", null,
    h("div", { class: "grid2" }, field("Stage", stageSel), field("Implementation", implSel), c ? null : field("Key", text("key", "", { placeholder: "e.g. anthropic_live" }), "How programs refer to it."), field("Label", text("label", c?.label)),
      field("Credential", select("credentialId", [["", "(auto: any enabled key for the provider)"], ...creds.map((k) => [k.id, `${k.provider}: ${k.label}`])], c?.credential_id || ""))),
    field("Config (JSON)", area("config", JSON.stringify(c?.config || {}, null, 2), { "data-json": "obj", class: "mono" }), schema),
    check("enabled", "Enabled", c ? yes(c.enabled) : true)),
    async (v) => { if (!v.credentialId) v.credentialId = null; if (c) { delete v.stage; await patch(`/api/adapter-configs/${c.id}`, v); } else await post("/api/adapter-configs", v); toast("Adapter saved"); route(); });
}

// ---------------------------------------------------------------- API keys
pages.keys = async () => {
  const [creds, usage] = await Promise.all([get("/api/credentials"), get("/api/usage")]);
  const root = h("div", null, pageHead("API keys", "Keys never live in the database. Add the secret as an environment variable on Render, then register which variable holds it here so the engine can rotate between keys and track quota.",
    h("button", { class: "btn primary", onclick: () => credDialog(null) }, "Register a key")));
  root.appendChild(h("div", { class: "panel" }, h("h3", null, "Default environment variables"),
    h("p", { class: "muted small", style: "margin:0 0 8px" }, "If you set these on Render, the matching provider works with no registration. Register keys only when you want several per provider or a daily quota."),
    h("div", { class: "row" }, PROVIDERS.map((p) => h("span", { class: "tag" }, h("span", { class: "mono" }, PROVIDER_ENV[p]))))));
  if (!creds.length) root.appendChild(h("div", { class: "empty", style: "margin-top:12px" }, h("b", null, "No keys registered"), "Everything is running on mocks. That's fine until you're ready to go live."));
  else root.appendChild(h("div", { class: "table-wrap", style: "margin-top:12px" }, h("table", null,
    h("thead", null, h("tr", null, h("th", null, "Provider"), h("th", null, "Label"), h("th", null, "Env var"), h("th", null, "On Render?"), h("th", null, "Today"), h("th", null, "Quota"), h("th", null, "State"), h("th"))),
    h("tbody", null, creds.map((k) => h("tr", null,
      h("td", null, k.provider), h("td", null, k.label, h("span", { class: "sub" }, "priority ", k.priority)), h("td", { class: "mono" }, k.env_var),
      h("td", null, k.env_present ? h("span", { class: "tag green" }, "set") : h("span", { class: "tag red" }, "missing")),
      h("td", { class: "small" }, k.used_today, " units · ", usd(k.cost_today)), h("td", { class: "small" }, k.daily_quota || "—"),
      h("td", null, !yes(k.enabled) ? h("span", { class: "tag red" }, "disabled") : k.cooldown_until && new Date(k.cooldown_until) > Date.now() ? h("span", { class: "tag amber", title: k.last_error || "" }, "cooling down") : h("span", { class: "tag green" }, "ready"), k.last_error ? h("span", { class: "sub", style: "color:var(--red)" }, k.last_error.slice(0, 80)) : null),
      h("td", { class: "row" },
        k.cooldown_until ? h("button", { class: "btn sm", onclick: () => run(() => patch(`/api/credentials/${k.id}`, { clearCooldown: true }), "Cooldown cleared").then(route) }, "Clear cooldown") : null,
        h("button", { class: "btn sm", onclick: () => credDialog(k) }, "Edit"),
        h("button", { class: "btn sm", onclick: () => run(() => patch(`/api/credentials/${k.id}`, { enabled: !yes(k.enabled) }), "Saved").then(route) }, yes(k.enabled) ? "Disable" : "Enable"),
        h("button", { class: "btn sm danger", onclick: () => run(() => del(`/api/credentials/${k.id}`), "Removed").then(route) }, "Remove"))))))));
  if (usage.length) { root.appendChild(h("h2", null, "Usage, last 30 days")); root.appendChild(h("div", { class: "table-wrap" }, h("table", null,
    h("thead", null, h("tr", null, h("th", null, "Day"), h("th", null, "Provider"), h("th", null, "Units"), h("th", null, "Cost"))),
    h("tbody", null, usage.map((u) => h("tr", null, h("td", { class: "small" }, u.day?.slice(0, 10)), h("td", null, u.provider), h("td", null, u.units), h("td", null, usd(u.cost_usd)))))))); }
  return root;
};
function credDialog(k) {
  const prov = select("provider", PROVIDERS, k?.provider || "anthropic", { disabled: !!k });
  const env = text("envVar", k?.env_var || PROVIDER_ENV.anthropic);
  prov.onchange = () => { if (!k) env.value = PROVIDER_ENV[prov.value]; };
  formDialog(k ? "Edit key" : "Register a key", h("div", null,
    h("div", { class: "grid2" }, field("Provider", prov), field("Environment variable", env, "Set the secret under this name in Render → Environment."),
      field("Label", text("label", k?.label)), field("Priority", num("priority", k?.priority ?? 0), "Higher is tried first."), field("Daily quota (units)", num("dailyQuota", k?.daily_quota), "Empty for none.")),
    k ? check("enabled", "Enabled", yes(k.enabled)) : null),
    async (v) => { if (k) { delete v.provider; await patch(`/api/credentials/${k.id}`, v); } else await post("/api/credentials", v); toast("Key registered"); route(); });
}

// ---------------------------------------------------------------- settings
pages.settings = async () => {
  const s = await get("/api/settings");
  const val = (k, d) => (s[k] === undefined ? d : s[k]);
  const save = (k, v, msg) => run(() => put(`/api/settings/${k}`, { value: v }), msg || "Saved").then(route);
  const cap = num(null, val("budget.daily_cap_usd", 5), { step: "0.5", min: 0, style: "max-width:140px" });
  const thr = num(null, val("repurpose.view_threshold", 500), { min: 0, style: "max-width:140px" });
  const known = ["queues.enabled", "publishing.global_pause", "budget.daily_cap_usd", "ingest.enabled", "repurpose.view_threshold"];
  const other = Object.entries(s).filter(([k]) => !known.includes(k));
  return h("div", null, pageHead("Settings", "Global switches. Program-level behaviour lives on each program."),
    h("div", { class: "panel" }, h("h3", null, "Publishing"),
      h("div", { class: "row" }, h("span", { class: "grow" }, val("publishing.global_pause", false) ? "Publishing is paused. Approved items wait and retry every 10 minutes." : "Publishing is running."),
        h("button", { class: "btn" + (val("publishing.global_pause", false) ? " ok" : " danger"), onclick: () => save("publishing.global_pause", !val("publishing.global_pause", false), val("publishing.global_pause", false) ? "Publishing resumed" : "Publishing paused") }, val("publishing.global_pause", false) ? "Resume publishing" : "Pause all publishing"))),
    h("div", { class: "panel" }, h("h3", null, "Ingestion"),
      h("div", { class: "row" }, h("span", { class: "grow" }, val("ingest.enabled", true) ? "Sources are polled on their schedules." : "Automatic polling is off. You can still poll manually."),
        h("button", { class: "btn", onclick: () => save("ingest.enabled", !val("ingest.enabled", true)) }, val("ingest.enabled", true) ? "Stop automatic polling" : "Start automatic polling"))),
    h("div", { class: "panel" }, h("h3", null, "Daily spend cap"),
      h("p", { class: "muted small", style: "margin:0 0 8px" }, "When today's provider spend reaches this, generation pauses until tomorrow. Spent today: ", usd(stats?.spentTodayUsd), ". Set 0 for no cap."),
      h("div", { class: "row" }, h("span", null, "$"), cap, h("button", { class: "btn", onclick: () => save("budget.daily_cap_usd", Number(cap.value)) }, "Save cap"))),
    h("div", { class: "panel" }, h("h3", null, "Repurposing threshold"),
      h("p", { class: "muted small", style: "margin:0 0 8px" }, "Once a published post crosses this many views, a new draft is queued to repurpose it into other formats (still goes through Review)."),
      h("div", { class: "row" }, thr, h("span", { class: "small mute" }, "views"), h("button", { class: "btn", onclick: () => save("repurpose.view_threshold", Number(thr.value)) }, "Save threshold"))),
    h("div", { class: "panel" }, h("h3", null, "Worker lanes"), h("p", { class: "muted small", style: "margin:0" }, "Pause and resume individual lanes from the ", h("a", { href: "#/overview" }, "Overview"), " page.")),
    other.length ? h("div", { class: "panel" }, h("h3", null, "Other settings"), other.map(([k, v]) => h("div", { class: "row small", style: "padding:4px 0" }, h("span", { class: "mono" }, k), h("span", { class: "mute" }, JSON.stringify(v))))) : null,
    h("div", { class: "panel" }, h("h3", null, "Engine"),
      h("div", { class: "small muted" }, "Worker ", h("span", { class: "mono" }, health?.worker), " · storage ", health?.storage, " · ffmpeg ", health?.ffmpeg ? "available" : "missing", " · yt-dlp ", health?.ytdlp ? "available" : "missing (video download will use the mock)")),
  );
};

// ---------------------------------------------------------------- boot
window.addEventListener("hashchange", route);
$("#railToggle").onclick = () => $("#rail").classList.toggle("open");
route();
setInterval(async () => { if (document.hidden) return; await refreshMeta(); renderRail((location.hash.replace(/^#\/?/, "").split("/")[0]) || "overview"); }, 30000);

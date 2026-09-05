// Vanilla JS dashboard — no framework, no CDN, no build step. Works fully offline;
// the backend serves this file as a plain static asset.
 
// --- tiny DOM helper -------------------------------------------------------
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  attrs = attrs || {};
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "html") el.innerHTML = v;
    else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v === true ? "" : v);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}
 
// --- API ---------------------------------------------------------------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers: { "Content-Type": "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed: ${res.status}`);
  return data;
}
 
const STATUS_COLORS = {
  QUEUED: "gray", FETCHING_DATA: "gray", DRAFTING: "gray",
  PENDING_REVIEW: "yellow", APPROVED: "blue", REJECTED: "red",
  RENDERING: "blue", READY_TO_PUBLISH: "blue", PUBLISHED: "green",
  PARTIALLY_PUBLISHED: "yellow", FAILED: "red", TRACKED: "purple", REPURPOSED: "purple",
  PENDING: "gray", RENDERED: "blue", PUBLISHING: "blue", RETRY_SCHEDULED: "yellow",
};
 
function badge(status) {
  const color = STATUS_COLORS[status] || "gray";
  return h("span", { class: `badge ${color}` }, status.replace(/_/g, " "));
}
 
// --- toast ---------------------------------------------------------------
let toastTimer = null;
function toast(msg) {
  let node = document.getElementById("toast");
  if (!node) {
    node = h("div", { class: "toast", id: "toast" });
    document.body.appendChild(node);
  }
  node.textContent = msg;
  node.style.display = "block";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.style.display = "none"; }, 3500);
}
 
// --- modal ---------------------------------------------------------------
function openModal(title, bodyNode) {
  closeModal();
  const backdrop = h("div", { class: "modal-backdrop", id: "modal-backdrop", onClick: (e) => { if (e.target.id === "modal-backdrop") closeModal(); } },
    h("div", { class: "modal" },
      h("div", { class: "row between" },
        h("h2", {}, title),
        h("button", { class: "secondary small", onClick: closeModal }, "Close")
      ),
      bodyNode
    )
  );
  document.body.appendChild(backdrop);
}
function closeModal() {
  const node = document.getElementById("modal-backdrop");
  if (node) node.remove();
}
 
// ---------------------------------------------------------------------------
// Overview page
// ---------------------------------------------------------------------------
 
async function renderOverview(root) {
  root.appendChild(h("h1", {}, "Overview"));
  root.appendChild(h("p", { class: "page-sub" }, "Start with Configuration to define brands/niches/channels, then Pipeline to generate content."));
 
  const items = await api("/api/content-items");
  const pendingReview = items.filter((i) => i.status === "PENDING_REVIEW").length;
  const published = items.filter((i) => i.status === "PUBLISHED" || i.status === "PARTIALLY_PUBLISHED").length;
  const failed = items.filter((i) => i.status === "FAILED").length;
 
  root.appendChild(
    h("div", { class: "grid-3" },
      h("div", { class: "card" },
        h("div", { class: "kv" }, h("b", { style: { fontSize: "28px" } }, String(pendingReview))),
        h("div", { class: "page-sub", style: { margin: 0 } }, "Awaiting your review")
      ),
      h("div", { class: "card" },
        h("div", { class: "kv" }, h("b", { style: { fontSize: "28px" } }, String(published))),
        h("div", { class: "page-sub", style: { margin: 0 } }, "Published")
      ),
      h("div", { class: "card" },
        h("div", { class: "kv" }, h("b", { style: { fontSize: "28px", color: "#e6675e" } }, String(failed))),
        h("div", { class: "page-sub", style: { margin: 0 } }, "Failed")
      )
    )
  );
 
  root.appendChild(
    h("div", { class: "card" },
      h("h2", {}, "How the pipeline works"),
      h("p", { style: { color: "#9aa1ae", lineHeight: "1.7" }, html:
        "1. Fetch a topic from the niche's data source, and reject it automatically if it's too similar to " +
        "anything this series has covered before.<br/>" +
        "2. Generate a script and synthesize a voiceover.<br/>" +
        "3. Stop and wait for you at Pending Review — nothing publishes without a human approval.<br/>" +
        "4. On approval, render and publish independently to every channel subscribed to that niche.<br/>" +
        "5. Once a published asset crosses a view threshold, it's automatically queued as a new draft " +
        "for repurposing into other formats/channels — back through the same review gate."
      })
    )
  );
}
 
// ---------------------------------------------------------------------------
// Pipeline page
// ---------------------------------------------------------------------------
 
async function renderGenerateForm(container, onGenerated) {
  const niches = await api("/api/niches");
  let seriesOptions = [];
 
  const nicheSelect = h("select", {}, niches.map((n) => h("option", { value: n.id }, n.display_name)));
  const seriesSelect = h("select", {}, h("option", { value: "" }, "(none — one-off)"));
  const genBtn = h("button", { onClick: onGenerateClick }, "Generate now");
 
  async function loadSeries() {
    if (!nicheSelect.value) return;
    const s = await api(`/api/series?nicheId=${nicheSelect.value}`);
    seriesSelect.innerHTML = "";
    seriesSelect.appendChild(h("option", { value: "" }, "(none — one-off)"));
    s.forEach((series) => seriesSelect.appendChild(h("option", { value: series.id }, series.display_name)));
  }
  nicheSelect.addEventListener("change", loadSeries);
  if (niches.length) { nicheSelect.value = niches[0].id; await loadSeries(); }
 
  async function onGenerateClick() {
    if (!nicheSelect.value) return;
    genBtn.disabled = true;
    genBtn.textContent = "Generating...";
    try {
      const item = await api("/api/generate", {
        method: "POST",
        body: { nicheId: nicheSelect.value, seriesId: seriesSelect.value || null },
      });
      toast(item.status === "FAILED" ? `Generation failed: ${item.rejection_note}` : "New draft ready for review");
      onGenerated();
    } catch (e) {
      toast("Error: " + e.message);
    } finally {
      genBtn.disabled = false;
      genBtn.textContent = "Generate now";
    }
  }
 
  container.appendChild(
    h("div", { class: "card" },
      h("h2", {}, "Generate new content"),
      h("div", { class: "row wrap", style: { alignItems: "flex-end" } },
        h("div", { style: { flex: "1", minWidth: "180px" } }, h("label", {}, "Niche"), nicheSelect),
        h("div", { style: { flex: "1", minWidth: "180px" } }, h("label", {}, "Series (optional)"), seriesSelect),
        h("div", {}, genBtn)
      ),
      niches.length === 0
        ? h("p", { class: "page-sub", style: { marginTop: "12px", marginBottom: 0 } }, "Create a niche in Configuration first.")
        : null
    )
  );
}
 
async function renderPipeline(root) {
  root.appendChild(h("h1", {}, "Content Pipeline"));
  root.appendChild(h("p", { class: "page-sub" }, "Every generated idea, from draft through publish, in one ledger."));
 
  const genFormContainer = h("div");
  root.appendChild(genFormContainer);
 
  const ledgerCard = h("div", { class: "card" });
  root.appendChild(ledgerCard);
 
  const statusFilter = h(
    "select",
    { style: { width: "200px" } },
    h("option", { value: "" }, "All statuses"),
    Object.keys(STATUS_COLORS).slice(0, 13).map((s) => h("option", { value: s }, s))
  );
 
  async function loadLedger() {
    const q = statusFilter.value ? `?status=${statusFilter.value}` : "";
    const items = await api(`/api/content-items${q}`);
    ledgerCard.innerHTML = "";
    ledgerCard.appendChild(
      h("div", { class: "row between" }, h("h2", { style: { margin: 0 } }, "Ledger"), statusFilter)
    );
    if (items.length === 0) {
      ledgerCard.appendChild(h("div", { class: "empty-state" }, "Nothing here yet — generate your first draft above."));
      return;
    }
    const rows = items.map((it) =>
      h(
        "tr",
        { class: "clickable", onClick: () => openContentDetail(it.id, loadLedger) },
        h("td", {}, it.topic),
        h("td", {}, it.episode_number ?? "—"),
        h("td", {}, badge(it.status)),
        h("td", {}, new Date(it.created_at).toLocaleString())
      )
    );
    ledgerCard.appendChild(
      h("table", {},
        h("thead", {}, h("tr", {}, h("th", {}, "Topic"), h("th", {}, "Episode"), h("th", {}, "Status"), h("th", {}, "Created"))),
        h("tbody", {}, rows)
      )
    );
  }
 
  statusFilter.addEventListener("change", loadLedger);
  await renderGenerateForm(genFormContainer, loadLedger);
  await loadLedger();
}
 
function openContentDetail(itemId, onChanged) {
  api(`/api/content-items/${itemId}`).then((item) => {
    const body = h("div");
    openModal(item.topic, body);
    renderContentDetailBody(body, item, onChanged, () => openContentDetail(itemId, onChanged));
  });
}
 
function renderContentDetailBody(body, item, onChanged, refresh) {
  body.innerHTML = "";
  body.appendChild(
    h("div", { class: "row", style: { marginBottom: "12px" } },
      badge(item.status),
      item.episode_number ? h("span", { class: "badge gray" }, `Episode ${item.episode_number}`) : null
    )
  );
 
  if (item.rejection_note) {
    body.appendChild(h("div", { class: "card", style: { background: "#3d1f1e" } }, item.rejection_note));
  }
 
  const scriptWrap = h("div");
  body.appendChild(scriptWrap);
  renderScriptSection(scriptWrap, item, refresh);
 
  if (item.status === "PENDING_REVIEW") {
    const rejectSection = h("div");
    body.appendChild(
      h("div", { class: "row", style: { marginTop: "16px" } },
        h("button", { onClick: async () => {
          try {
            await api(`/api/content-items/${item.id}/approve`, { method: "POST" });
            toast("Approved — rendering and publishing to all subscribed channels");
            onChanged(); refresh();
          } catch (e) { toast("Error: " + e.message); }
        }}, "Approve & publish"),
        h("button", { class: "danger", onClick: () => {
          rejectSection.innerHTML = "";
          const noteInput = h("input", { value: "" });
          rejectSection.appendChild(
            h("div", { style: { marginTop: "12px" } },
              h("label", {}, "Rejection note"),
              noteInput,
              h("div", { class: "row", style: { marginTop: "8px" } },
                h("button", { class: "danger", onClick: async () => {
                  await api(`/api/content-items/${item.id}/reject`, { method: "POST", body: { note: noteInput.value || "Rejected" } });
                  toast("Rejected");
                  onChanged(); refresh();
                }}, "Confirm reject"),
                h("button", { class: "secondary", onClick: () => { rejectSection.innerHTML = ""; }}, "Cancel")
              )
            )
          );
        }}, "Reject")
      )
    );
    body.appendChild(rejectSection);
  }
 
  if (item.assets && item.assets.length > 0) {
    body.appendChild(
      h("div", { style: { marginTop: "20px" } },
        h("h2", {}, "Per-channel assets"),
        h("table", {},
          h("thead", {}, h("tr", {}, h("th", {}, "Status"), h("th", {}, "Render"), h("th", {}, "Published"), h("th", {}, "Actions"))),
          h("tbody", {}, item.assets.map((a) =>
            h("tr", {},
              h("td", {}, badge(a.status)),
              h("td", { style: { fontSize: "11px", color: "#9aa1ae" } }, a.render_url || "—"),
              h("td", { style: { fontSize: "11px", color: "#9aa1ae" } }, a.published_url || "—"),
              h("td", {},
                h("div", { class: "row" },
                  a.status === "FAILED" ? h("button", { class: "small secondary", onClick: async () => {
                    try { await api(`/api/assets/${a.id}/retry`, { method: "POST" }); toast("Retried"); onChanged(); refresh(); }
                    catch (e) { toast("Retry failed: " + e.message); }
                  }}, "Retry") : null,
                  a.status === "PUBLISHED" ? h("button", { class: "small secondary", onClick: async () => {
                    const views = prompt("Views to log for this asset (demo input):", "1200");
                    if (views === null) return;
                    await api(`/api/assets/${a.id}/performance`, { method: "POST", body: { views: Number(views) } });
                    const result = await api(`/api/assets/${a.id}/check-repurpose`, { method: "POST" });
                    toast(result.repurposed ? "Performance logged — repurpose triggered, new draft queued for review!" : "Performance logged");
                    onChanged(); refresh();
                  }}, "Log performance") : null
                )
              )
            )
          ))
        )
      )
    );
  }
}
 
function renderScriptSection(container, item, refresh) {
  container.innerHTML = "";
  container.appendChild(h("label", {}, "Script" + (item.status === "PENDING_REVIEW" ? " (editable before approval)" : "")));
  container.appendChild(h("div", { class: "script-box" }, item.script || "(no script yet)"));
  if (item.status === "PENDING_REVIEW") {
    container.appendChild(
      h("button", { class: "secondary small", style: { marginTop: "8px" }, onClick: () => {
        container.innerHTML = "";
        const textarea = h("textarea", { rows: 10 }, item.script || "");
        container.appendChild(
          h("div", {},
            textarea,
            h("div", { class: "row", style: { marginTop: "8px" } },
              h("button", { onClick: async () => {
                await api(`/api/content-items/${item.id}`, { method: "PATCH", body: { script: textarea.value } });
                toast("Script updated");
                item.script = textarea.value;
                renderScriptSection(container, item, refresh);
              }}, "Save script"),
              h("button", { class: "secondary", onClick: () => renderScriptSection(container, item, refresh) }, "Cancel")
            )
          )
        );
      }}, "Edit script")
    );
  }
}
 
// ---------------------------------------------------------------------------
// Series page
// ---------------------------------------------------------------------------
 
async function renderSeries(root) {
  root.appendChild(h("h1", {}, "Series"));
  root.appendChild(h("p", { class: "page-sub" }, "A series is a recurring show inside a niche. The engine auto-numbers episodes and checks new topics against this series' history so it never repeats itself."));
 
  const niches = await api("/api/niches");
 
  const nicheSelect = h("select", {}, niches.map((n) => h("option", { value: n.id }, n.display_name)));
  const keyInput = h("input", { placeholder: "e.g. daily_tech" });
  const nameInput = h("input", { placeholder: "e.g. Daily Tech Brief" });
  const createBtn = h("button", { disabled: niches.length === 0 }, "Create series");
 
  const listCard = h("div", { class: "card" });
 
  async function loadList() {
    const all = [];
    for (const n of niches) {
      const s = await api(`/api/series?nicheId=${n.id}`);
      s.forEach((series) => all.push({ ...series, nicheName: n.display_name }));
    }
    listCard.innerHTML = "";
    listCard.appendChild(h("h2", {}, "Existing series"));
    if (all.length === 0) {
      listCard.appendChild(h("div", { class: "empty-state" }, "No series yet."));
      return;
    }
    listCard.appendChild(
      h("table", {},
        h("thead", {}, h("tr", {}, h("th", {}, "Series"), h("th", {}, "Niche"), h("th", {}, "Episodes so far"))),
        h("tbody", {}, all.map((s) => h("tr", {}, h("td", {}, s.display_name), h("td", {}, s.nicheName), h("td", {}, s.episode_counter))))
      )
    );
  }
 
  createBtn.addEventListener("click", async () => {
    if (!nicheSelect.value || !keyInput.value || !nameInput.value) return;
    await api("/api/series", { method: "POST", body: { nicheId: nicheSelect.value, key: keyInput.value, displayName: nameInput.value } });
    toast("Series created");
    keyInput.value = ""; nameInput.value = "";
    loadList();
  });
 
  root.appendChild(
    h("div", { class: "card" },
      h("h2", {}, "New series"),
      h("label", {}, "Niche"), nicheSelect,
      h("label", {}, "Key"), keyInput,
      h("label", {}, "Display name"), nameInput,
      h("div", { style: { marginTop: "12px" } }, createBtn)
    )
  );
  root.appendChild(listCard);
  await loadList();
}
 
// ---------------------------------------------------------------------------
// Config page
// ---------------------------------------------------------------------------
 
async function renderConfig(root) {
  root.appendChild(h("h1", {}, "Configuration"));
  root.appendChild(h("p", { class: "page-sub" }, "Static config that rarely changes: brands, content-pillar niches, and destination channels. Toggle which niches feed which channel below — no code changes needed to add a channel or niche."));
 
  const adapters = await api("/api/adapters");
  let brands = await api("/api/brands");
  let activeBrandId = brands[0]?.id || null;
 
  const brandSelect = h("select", {}, brands.map((b) => h("option", { value: b.id }, b.name)));
  if (activeBrandId) brandSelect.value = activeBrandId;
 
  const nichesCard = h("div", { class: "card" });
  const channelsCard = h("div", { class: "card" });
 
  async function reload() {
    activeBrandId = brandSelect.value;
    if (!activeBrandId) return;
    const [niches, channels] = await Promise.all([
      api(`/api/niches?brandId=${activeBrandId}`),
      api(`/api/channels?brandId=${activeBrandId}`),
    ]);
 
    nichesCard.innerHTML = "";
    nichesCard.appendChild(
      h("div", { class: "row between" },
        h("h2", { style: { margin: 0 } }, "Niches (content pillars)"),
        h("button", { class: "secondary small", onClick: () => openNicheForm(activeBrandId, adapters, reload) }, "+ Add niche")
      )
    );
    if (niches.length === 0) nichesCard.appendChild(h("div", { class: "empty-state" }, "No niches yet."));
    niches.forEach((n) => {
      nichesCard.appendChild(
        h("div", { class: "card", style: { background: "#1f232c" } },
          h("div", { class: "row between" }, h("b", {}, n.display_name), h("span", { class: "badge gray" }, n.key)),
          h("div", { class: "kv" }, h("b", {}, "Tone:"), " " + n.tone),
          h("div", { class: "kv" }, h("b", {}, "Visual mode:"), " " + n.visual_mode),
          h("div", { class: "kv" }, h("b", {}, "Topic source:"), " " + n.topic_source_adapter),
          h("div", { class: "kv" }, h("b", {}, "Dedup threshold:"), " " + n.dedup_threshold)
        )
      );
    });
 
    channelsCard.innerHTML = "";
    channelsCard.appendChild(
      h("div", { class: "row between" },
        h("h2", { style: { margin: 0 } }, "Channels (destinations)"),
        h("button", { class: "secondary small", onClick: () => openChannelForm(activeBrandId, reload) }, "+ Add channel")
      )
    );
    if (channels.length === 0) channelsCard.appendChild(h("div", { class: "empty-state" }, "No channels yet."));
    channels.forEach((c) => {
      const pillList = h("div", { class: "pill-list" });
      niches.forEach((n) => {
        const enabled = c.niches.some((cn) => cn.id === n.id);
        const checkbox = h("input", { type: "checkbox", style: { width: "auto", marginRight: "6px" } });
        checkbox.checked = enabled;
        checkbox.addEventListener("change", async () => {
          if (checkbox.checked) await api(`/api/channels/${c.id}/niches/${n.id}`, { method: "POST" });
          else await api(`/api/channels/${c.id}/niches/${n.id}`, { method: "DELETE" });
          reload();
        });
        pillList.appendChild(h("label", { class: "pill", style: { cursor: "pointer" } }, checkbox, n.display_name));
      });
      channelsCard.appendChild(
        h("div", { class: "card", style: { background: "#1f232c" } },
          h("div", { class: "row between" }, h("b", {}, c.display_name), h("span", { class: "badge blue" }, c.platform)),
          h("div", { class: "kv" }, h("b", {}, "Format:"), " " + c.format),
          h("div", { style: { marginTop: "8px" } }, h("div", { class: "kv" }, h("b", {}, "Active niches:")), pillList)
        )
      );
    });
  }
 
  brandSelect.addEventListener("change", reload);
 
  root.appendChild(
    h("div", { class: "card" },
      h("div", { class: "row between" },
        h("h2", { style: { margin: 0 } }, "Brand"),
        h("button", { class: "secondary small", onClick: () => openBrandForm(async () => {
          brands = await api("/api/brands");
          brandSelect.innerHTML = "";
          brands.forEach((b) => brandSelect.appendChild(h("option", { value: b.id }, b.name)));
          reload();
        })}, "+ New brand")
      ),
      brandSelect
    )
  );
  root.appendChild(h("div", { class: "grid-2" }, nichesCard, channelsCard));
 
  if (activeBrandId) await reload();
}
 
function openBrandForm(onDone) {
  const nameInput = h("input", { placeholder: "e.g. Demo Media Co" });
  const descInput = h("textarea", { rows: 2 });
  const submitBtn = h("button", { disabled: true }, "Create brand");
  nameInput.addEventListener("input", () => { submitBtn.disabled = !nameInput.value; });
  submitBtn.addEventListener("click", async () => {
    await api("/api/brands", { method: "POST", body: { name: nameInput.value, description: descInput.value } });
    toast("Brand created");
    closeModal();
    onDone();
  });
  openModal("New brand", h("div", {},
    h("label", {}, "Name"), nameInput,
    h("label", {}, "Description"), descInput,
    h("div", { style: { marginTop: "16px" } }, submitBtn)
  ));
}
 
function openNicheForm(brandId, adapters, onDone) {
  const keyInput = h("input", {});
  const nameInput = h("input", {});
  const toneInput = h("input", { placeholder: "e.g. fast-paced, punchy" });
  const visualSelect = h("select", {},
    h("option", { value: "STATIC_IMAGE" }, "Static image"),
    h("option", { value: "STOCK_FOOTAGE" }, "Stock footage + voiceover"),
    h("option", { value: "ANIMATION" }, "Animation")
  );
  const sourceSelect = h("select", {}, adapters.topicSources.map((a) => h("option", { value: a }, a)));
  const dedupInput = h("input", { type: "number", step: "0.01", min: "0", max: "1", value: "0.82" });
  const submitBtn = h("button", { disabled: true }, "Create niche");
 
  function checkValid() { submitBtn.disabled = !(keyInput.value && nameInput.value); }
  keyInput.addEventListener("input", checkValid);
  nameInput.addEventListener("input", checkValid);
 
  submitBtn.addEventListener("click", async () => {
    await api("/api/niches", { method: "POST", body: {
      brandId, key: keyInput.value, displayName: nameInput.value, tone: toneInput.value,
      visualMode: visualSelect.value, topicSourceAdapter: sourceSelect.value, dedupThreshold: Number(dedupInput.value),
    }});
    toast("Niche profile created");
    closeModal();
    onDone();
  });
 
  openModal("New niche (content pillar)", h("div", {},
    h("label", {}, "Key (stable id, e.g. tech_ai_news)"), keyInput,
    h("label", {}, "Display name"), nameInput,
    h("label", {}, "Tone"), toneInput,
    h("label", {}, "Visual mode"), visualSelect,
    h("label", {}, "Topic source adapter"), sourceSelect,
    h("label", {}, "Dedup threshold (0-1, higher = stricter repeat blocking)"), dedupInput,
    h("div", { style: { marginTop: "16px" } }, submitBtn)
  ));
}
 
function openChannelForm(brandId, onDone) {
  const keyInput = h("input", {});
  const nameInput = h("input", {});
  const platformSelect = h("select", {}, ["YOUTUBE", "INSTAGRAM", "TIKTOK", "FACEBOOK", "X", "LINKEDIN"].map((p) => h("option", { value: p }, p)));
  const formatSelect = h("select", {}, ["LONG_FORM_VOICEOVER", "SHORT_FORM_VOICEOVER", "STATIC_IMAGE_CAPTION", "CAROUSEL", "TEXT_THREAD"].map((f) => h("option", { value: f }, f)));
  const submitBtn = h("button", { disabled: true }, "Create channel");
 
  function checkValid() { submitBtn.disabled = !(keyInput.value && nameInput.value); }
  keyInput.addEventListener("input", checkValid);
  nameInput.addEventListener("input", checkValid);
 
  submitBtn.addEventListener("click", async () => {
    await api("/api/channels", { method: "POST", body: {
      brandId, key: keyInput.value, displayName: nameInput.value, platform: platformSelect.value, format: formatSelect.value,
    }});
    toast("Channel profile created");
    closeModal();
    onDone();
  });
 
  openModal("New channel (destination account)", h("div", {},
    h("label", {}, "Key (stable id, e.g. yt_main)"), keyInput,
    h("label", {}, "Display name"), nameInput,
    h("label", {}, "Platform"), platformSelect,
    h("label", {}, "Post format"), formatSelect,
    h("div", { style: { marginTop: "16px" } }, submitBtn)
  ));
}
 
// ---------------------------------------------------------------------------
// App shell / router
// ---------------------------------------------------------------------------
 
const PAGES = {
  overview: { label: "Overview", render: renderOverview },
  pipeline: { label: "Pipeline", render: renderPipeline },
  series: { label: "Series", render: renderSeries },
  config: { label: "Configuration", render: renderConfig },
};
 
let currentPage = "overview";
 
function renderApp() {
  const root = document.getElementById("root");
  root.innerHTML = "";
 
  const sidebar = h("div", { class: "sidebar" },
    h("div", { class: "brand-title" }, "Content Engine", h("span", { class: "sub" }, "Automation control panel")),
    Object.entries(PAGES).map(([key, p]) =>
      h("div", { class: `nav-item ${key === currentPage ? "active" : ""}`, onClick: () => { currentPage = key; renderApp(); } }, p.label)
    )
  );
 
  const main = h("div", { class: "main" });
  root.appendChild(sidebar);
  root.appendChild(main);
 
  PAGES[currentPage].render(main).catch((err) => {
    main.appendChild(h("div", { class: "card" }, "Failed to load: " + err.message));
  });
}
 
renderApp();

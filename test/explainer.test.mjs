import { test } from "node:test";
import assert from "node:assert/strict";
import { startEngine, waitFor } from "./harness.mjs";

// A data explainer (6b) is the explainer pointed at numbers: the planner is told to build most scenes from charts,
// counted-up figures and timelines, with only the research's own numbers — and a plan made of those scenes is accepted.
// The studio is not needed to check either: the plan is accepted, and the description written from it, before the
// render, and the mock voice then stops the job at the render with its own message.
test("a data explainer asks the planner for data scenes, and a plan of figures and timelines is accepted", async () => {
  const eng = await startEngine({ env: { STUDIO_MIN_MEMORY_MB: "999999" } });   // no studio: each job stops after planning
  try {
    await eng.api("POST", "/api/adapter-configs", { key: "llm_data_planner", stage: "SCRIPT", impl: "llm_mock", config: { respond: [{ match: "This is a DATA explainer", json: {
      title: "Dhaka metro in numbers", description: "DATA PLAN", hashtags: ["data"], scenes: [
        { layout: "BigNumber", chapter: "Riders", data: { heading: "Riders every day", value: 410000, label: "people ride Line 6 on a weekday" }, parts: ["Four hundred and ten thousand people ride it every weekday."] },
        { layout: "Timeline", chapter: "Building it", data: { heading: "How it was built", events: [{ date: "2016", label: "Work begins" }, { date: "2022", label: "First section" }, { date: "2025", label: "Kamalapur" }] }, parts: ["Work began in 2016.", "The first section opened in 2022.", "It reached Kamalapur in 2025."] },
        { layout: "DataChart", chapter: "Growth", data: { heading: "Daily riders", kind: "line", unit: "k", data: [{ label: "2023", value: 180 }, { label: "2025", value: 410 }] }, parts: ["Ridership more than doubled."] }] } }] } });
    const b = await eng.api("POST", "/api/brands", { name: "Data brand" });
    const made = async (key, style) => {
      const p = await eng.api("POST", "/api/programs", { brandId: b.id, key, displayName: key, contentType: "ANIMATED_EXPLAINER", useMocks: true, autoStyle: false, autoSources: false,
        scriptAdapter: "llm_data_planner", scriptAdapterFallbacks: [], methodConfig: { explainer_minutes: 1, ...(style ? { explainer_style: style } : {}), qa: { enabled: false } } });
      const { id } = await eng.api("POST", "/api/generate", { nicheId: p.id, topic: "Dhaka metro ridership" });
      // The description is written from the accepted plan just before the render, so it is the check: whether the studio
      // is installed (it renders) or not (the job stops there) does not matter to what is being tested.
      return waitFor(async () => { const it = await eng.api("GET", `/api/content-items/${id}`); if (it.status === "FAILED" && !it.captions?.youtube) throw new Error(it.rejection_note); return it.captions?.youtube && it; }, { timeout: 60000, what: `${key} plan accepted` });
    };
    const data = await made("data_explainer", "data");
    assert.match(data.captions.youtube, /^DATA PLAN/, "the planner was asked for a data explainer, and its plan was used");
    assert.match(data.captions.youtube, /Riders[\s\S]*Building it[\s\S]*Growth/, "every BigNumber, Timeline and DataChart scene was accepted and timed");
    const general = await made("general_explainer", null);
    assert.doesNotMatch(general.captions.youtube, /^DATA PLAN/, "a general explainer is not asked for one");
  } finally { await eng.stop(); }
});

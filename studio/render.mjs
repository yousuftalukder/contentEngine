// Renders one composition: node render.mjs <props.json> <out.mp4|out.png> [NewsReel|Explainer] [video|still]
// server.js runs this as a child process so Chromium's memory and any crash stay out of the engine. Local file paths in
// the props (pictures, narration, music) are staged into the bundle's public folder, so Chromium reads them from the
// local static server instead of the network. The bundle is built once per source change (Docker builds it up front).
import { bundle } from "@remotion/bundler";
import { renderMedia, renderStill, selectComposition, ensureBrowser } from "@remotion/renderer";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const [propsPath, out, id = "NewsReel", kind = "video"] = process.argv.slice(2);
if (!propsPath || (!out && propsPath !== "--bundle-only")) { console.error("usage: node render.mjs <props.json> <out> [composition] [video|still]  |  node render.mjs --bundle-only"); process.exit(2); }
const log = (...a) => console.log(new Date().toISOString(), "[studio]", ...a);

const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
function sourceHash() { const h = createHash("sha1"); for (const f of walk(path.join(here, "src")).sort()) h.update(path.relative(here, f)).update(fs.readFileSync(f)); return h.digest("hex"); }
export async function ensureBundle() {
  const dir = process.env.REMOTION_BUNDLE_DIR || path.join(here, ".bundle"), hash = sourceHash(), stamp = path.join(dir, ".srchash");
  if (fs.existsSync(path.join(dir, "index.html")) && fs.existsSync(stamp) && fs.readFileSync(stamp, "utf8") === hash) return dir;
  log("bundling compositions…");
  await bundle({ entryPoint: path.join(here, "src", "index.ts"), outDir: dir, enableCaching: true });
  fs.writeFileSync(stamp, hash); return dir;
}
// Copies every absolute local path found in the props into <bundle>/public/jobs/<id>/ and rewrites it to a staticFile path.
function stage(props, dir) {
  const job = randomUUID(), pub = path.join(dir, "public", "jobs", job); let n = 0;
  const isLocal = (v) => typeof v === "string" && (path.isAbsolute(v) || /^[A-Za-z]:[\\/]/.test(v)) && !/^https?:/.test(v) && fs.existsSync(v);
  const visit = (v) => {
    if (isLocal(v)) { fs.mkdirSync(pub, { recursive: true }); const name = `${n++}-${path.basename(v)}`; fs.copyFileSync(v, path.join(pub, name)); return `jobs/${job}/${name}`; }
    if (Array.isArray(v)) return v.map(visit);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, visit(x)]));
    return v;
  };
  return { props: visit(props), cleanup: () => fs.rmSync(pub, { recursive: true, force: true }) };
}

const serveUrl = await ensureBundle();
if (propsPath === "--bundle-only") process.exit(0);
await ensureBrowser();
const staged = stage(JSON.parse(fs.readFileSync(propsPath, "utf8")), serveUrl);
try {
  const composition = await selectComposition({ serveUrl, id, inputProps: staged.props, timeoutInMilliseconds: 120000 });
  log(`${id}: ${composition.width}x${composition.height}, ${composition.durationInFrames} frames`);
  if (kind === "still") await renderStill({ composition, serveUrl, output: out, inputProps: staged.props, frame: Number(staged.props.stillFrame) || 20, timeoutInMilliseconds: 120000 });
  else {
    let last = -1;
    await renderMedia({ composition, serveUrl, codec: "h264", crf: 20, audioCodec: "aac", pixelFormat: "yuv420p", outputLocation: out, inputProps: staged.props,
      concurrency: Number(process.env.REMOTION_CONCURRENCY) || 1, timeoutInMilliseconds: 120000,
      onProgress: ({ progress }) => { const p = Math.floor(progress * 10); if (p !== last) { last = p; log(`rendered ${p * 10}%`); } } });
  }
  log("done", out);
} finally { staged.cleanup(); }

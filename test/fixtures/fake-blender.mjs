// Stands in for Blender in the tests: answers --version, and for a scene render (-b ... -P script -- spec.json out.mp4)
// writes a video of exactly the frames, size and rate the spec asks for, and notes the spec, so a test can check what the
// engine asked Blender to draw without Blender installed.
import { appendFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("Blender 4.2.0 (stand-in)"); process.exit(0); }
const rest = args.slice(args.indexOf("--") + 1), [specPath, out] = rest;
const spec = JSON.parse(readFileSync(specPath, "utf8"));
if (process.env.FAKE_BLENDER_LOG) appendFileSync(process.env.FAKE_BLENDER_LOG, JSON.stringify({ script: args[args.indexOf("-P") + 1], spec }) + "\n");
const seconds = (spec.frames / spec.fps).toFixed(3);
const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=0x203040:s=${spec.width}x${spec.height}:r=${spec.fps}`, "-t", seconds, "-c:v", "libx264", "-pix_fmt", "yuv420p", out]);
process.exit(r.status ?? 1);

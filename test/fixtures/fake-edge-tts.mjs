// Stands in for edge-tts in the tests: the same arguments, real audio out, and no network — so the adapter is tested
// end to end without asking Microsoft for anything. It writes down what it was asked for, so a test can check which
// voice the engine chose.
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("edge-tts 7.0.0 (test stand-in)"); process.exit(0); }
const get = (flag) => args[args.indexOf(flag) + 1];
const out = get("--write-media"), file = get("--file");
if (process.env.FAKE_EDGE_LOG) appendFileSync(process.env.FAKE_EDGE_LOG, JSON.stringify({ voice: get("--voice"), text: file ? readFileSync(file, "utf8") : null }) + "\n");
const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=300:duration=1.5", "-ac", "1", out]);
process.exit(r.status ?? 1);

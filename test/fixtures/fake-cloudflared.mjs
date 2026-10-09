// Stands in for cloudflared in tests: prints a quick-tunnel address the way cloudflared does (on stderr), then stays up
// like the real one. Each start appends a line to FAKE_CF_LOG, so a test can count how often the engine started it.
import { appendFileSync, readFileSync } from "node:fs";
const log = process.env.FAKE_CF_LOG;
let n = 1;
if (log) { try { n = readFileSync(log, "utf8").split("\n").filter(Boolean).length + 1; } catch {} appendFileSync(log, `start ${n}\n`); }
process.stderr.write(`INF |  https://fake-tunnel-${n}.trycloudflare.com  |\n`);
setInterval(() => {}, 1 << 30);

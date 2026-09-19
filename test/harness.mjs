// Test harness: boots the real server.js against an in-process Postgres (PGlite over a socket), so tests exercise the
// actual schema migration, job queue, sweeps and HTTP API. Only mock adapters are used — no network, no keys.
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import pg from "pg";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// Never let a developer's real keys reach a test run.
const SECRET_ENV = /^(ANTHROPIC|GEMINI|OPENAI|ELEVENLABS|NEWSAPI|YOUTUBE|META|R2|SUPABASE|DATABASE|SECRETS|DASHBOARD|PUBLIC_BASE|PORTAL_BASE|STORAGE)_?/;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

// Polls fn until it returns a truthy value (which is returned) or the timeout passes.
export async function waitFor(fn, { timeout = 20000, interval = 150, what = "condition" } = {}) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
    await sleep(interval);
  }
  throw new Error(`Timed out waiting for ${what}${last ? `: ${last.message}` : ""}`);
}

export async function startEngine({ env = {} } = {}) {
  const db = await PGlite.create({ extensions: { pgcrypto } });
  const dbPort = await freePort();
  const pgServer = new PGLiteSocketServer({ db, port: dbPort, host: "127.0.0.1", maxConnections: 16 });
  await pgServer.start();
  const databaseUrl = `postgres://postgres:postgres@127.0.0.1:${dbPort}/postgres`;

  const port = await freePort();
  const work = await mkdtemp(join(tmpdir(), "ce-test-"));
  const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !SECRET_ENV.test(k)));
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...baseEnv, DATABASE_URL: databaseUrl, PORT: String(port), WORK_DIR: work, QUEUE_POLL_INTERVAL_MS: "100", PG_POOL_MAX: "4", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));
  let exited = null;
  child.on("exit", (code) => (exited = code));

  const base = `http://127.0.0.1:${port}`;
  try {
    await waitFor(async () => { if (exited !== null) throw new Error(`server exited with ${exited}`); return (await fetch(`${base}/health`)).ok; }, { timeout: 60000, what: "server boot" });
  } catch (e) { child.kill(); await pgServer.stop(); await db.close(); throw new Error(`${e.message}\n--- server log ---\n${logs}`); }

  const sql = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  async function api(method, path, body) {
    const res = await fetch(base + path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => null);
    if (!res.ok) { const e = new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(data)}`); e.status = res.status; e.body = data; throw e; }
    return data;
  }
  const query = async (text, params) => (await sql.query(text, params)).rows;

  return {
    base, api, query, logs: () => logs,
    async stop() {
      child.kill();
      await new Promise((r) => (exited !== null ? r() : child.once("exit", r)));
      await sql.end().catch(() => {});
      await pgServer.stop().catch(() => {});
      await db.close().catch(() => {});
      await rm(work, { recursive: true, force: true }).catch(() => {});
    },
  };
}

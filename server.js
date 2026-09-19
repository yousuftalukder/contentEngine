// =====================================================================
// Content Engine — the whole backend in one file.
//
//   sources ─► ingest ─► router ─► generate (text/image/video) ─► REVIEW GATE
//           ─► approve ─► schedule per channel ─► publish ─► metrics ─► repurpose
//
// Sections (search for "// ==="):
//   1. config & utils         6. adapter impls (LLM, image, voice, embed,
//   2. database & migration      ingest, download, transcribe, clip, render, publish)
//   3. settings & credentials 7. dedup / router / scheduler / review
//   4. storage & processes    8. orchestrator (per content_type) + video methods
//   5. adapter registry       9. worker lanes   10. HTTP + routes   11. boot
//
// Runtime: Node 20+, `pg`. ffmpeg + yt-dlp on PATH for the video department
// (the Dockerfile installs both). Everything else is plain fetch().
// =====================================================================

import http from "node:http";
import { readFile, writeFile, mkdir, unlink, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash, createHmac, randomUUID, timingSafeEqual, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import pg from "pg";

// === 1. config & utils ================================================
const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV = process.env;
const PORT = Number(ENV.PORT) || 4000;
const DATABASE_URL = ENV.DATABASE_URL;
const TMP = join(ENV.WORK_DIR || tmpdir(), "content-engine");
const LOCAL_MEDIA_DIR = join(__dirname, "data", "media");
const FRONTEND_DIR = join(__dirname, "frontend");
const WORKER_ID = `${ENV.RENDER_INSTANCE_ID || "local"}-${process.pid}`;
const QUEUE_POLL_MS = Number(ENV.QUEUE_POLL_INTERVAL_MS) || 3000;
const LOCK_TIMEOUT_MIN = Number(ENV.JOB_LOCK_TIMEOUT_MINUTES) || 45;
const DEFAULTS = {
  ANTHROPIC_MODEL: ENV.ANTHROPIC_MODEL || "claude-sonnet-5",
  GEMINI_MODEL: ENV.GEMINI_MODEL || "gemini-flash-latest",
  // Tried in order when the main model is overloaded (503) or unknown (404). Comma-separated; "" disables.
  GEMINI_FALLBACK_MODELS: (ENV.GEMINI_FALLBACK_MODELS ?? "gemini-flash-lite-latest").split(",").map((s) => s.trim()).filter(Boolean),
  GEMINI_IMAGE_MODEL: ENV.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image",
  GEMINI_EMBED_MODEL: ENV.GEMINI_EMBED_MODEL || "gemini-embedding-001",
  ELEVENLABS_MODEL: ENV.ELEVENLABS_MODEL || "eleven_multilingual_v2",
  ELEVENLABS_VOICE: ENV.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM",
  META_API_VERSION: ENV.META_API_VERSION || "v21.0",
  OPENAI_MODEL: ENV.OPENAI_MODEL || "gpt-4o-mini",
  OPENAI_TTS_MODEL: ENV.OPENAI_TTS_MODEL || "gpt-4o-mini-tts",
  OPENAI_TTS_VOICE: ENV.OPENAI_TTS_VOICE || "alloy",
  OPENAI_IMAGE_MODEL: ENV.OPENAI_IMAGE_MODEL || "gpt-image-1",
  OPENAI_WHISPER_MODEL: ENV.OPENAI_WHISPER_MODEL || "whisper-1",
};
// $ per million tokens (in, out). Re-verify periodically; only used for budget accounting.
const PRICES = {
  "claude-opus": [15, 75], "claude-sonnet": [3, 15], "claude-haiku": [1, 5],
  "gemini-2.5-pro": [1.25, 10], "gemini-pro": [1.25, 10], "gemini-2.5-flash-lite": [0.1, 0.4],
  "gemini-flash-lite": [0.1, 0.4], "gemini-2.5-flash": [0.3, 2.5], "gemini-flash": [0.3, 2.5], "gemini": [0.3, 2.5],
  "gpt-4o-mini": [0.15, 0.6], "gpt-4o": [2.5, 10], "gpt-4.1-mini": [0.4, 1.6], "gpt-4.1-nano": [0.1, 0.4], "gpt-4.1": [2, 8], "gpt-5-mini": [0.25, 2], "gpt-5-nano": [0.05, 0.4], "gpt-5": [1.25, 10], "o4-mini": [1.1, 4.4],
};
const IMAGE_PRICE_USD = Number(ENV.IMAGE_PRICE_USD ?? 0.039);

const log = (...a) => console.log(new Date().toISOString(), ...a);
const warn = (...a) => console.warn(new Date().toISOString(), "WARN", ...a);
const newId = () => randomUUID();
const nowIso = () => new Date().toISOString();
const sha = (s) => createHash("sha256").update(String(s)).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const flag = (v) => v === true || v === 1 || v === "1" || v === "true";
const J = (v) => (v === undefined || v === null ? null : JSON.stringify(v));
const P = (v) => { if (v == null) return null; if (typeof v === "object") return v; try { return JSON.parse(v); } catch { return null; } };
const slugify = (s) => String(s).toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_-]+/g, "-").slice(0, 80) || "post";
const stripHtml = (s) => String(s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const decodeXml = (s) => String(s || "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&");
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const tmpPath = (ext) => join(TMP, `${randomUUID()}.${ext}`);
// Which worker lanes this process runs. Default: all. Split for production: web service LANES=ingest,text,image,publish,metrics
// and a Render Background Worker with LANES=video (ffmpeg/yt-dlp memory stays away from the dashboard). The periodic sweeps
// (polling sources, publishing due assets, review deadlines, metrics, cleanup) run where "ingest" runs unless RUN_SWEEPS overrides.
const ALL_QUEUES = ["ingest", "text", "image", "video", "publish", "metrics"];
const LANES = (ENV.LANES ? ENV.LANES.split(",").map((s) => s.trim()).filter((s) => ALL_QUEUES.includes(s)) : ALL_QUEUES);
const RUN_SWEEPS = ENV.RUN_SWEEPS != null ? flag(ENV.RUN_SWEEPS) : LANES.includes("ingest");
function tokenCost(model, inTok = 0, outTok = 0) {
  const hit = Object.entries(PRICES).find(([k]) => String(model || "").startsWith(k));
  const [i, o] = hit ? hit[1] : [0, 0];
  return ((inTok || 0) * i + (outTok || 0) * o) / 1e6;
}
function extractJson(text) {
  let t = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try { return JSON.parse(t); } catch {}
  const s = Math.min(...[t.indexOf("{"), t.indexOf("[")].filter((i) => i >= 0));
  if (!Number.isFinite(s)) throw new Error("LLM did not return JSON: " + t.slice(0, 200));
  for (let e = t.length; e > s; e--) {
    const c = t[e - 1]; if (c !== "}" && c !== "]") continue;
    try { return JSON.parse(t.slice(s, e)); } catch {}
  }
  throw new Error("LLM returned malformed JSON: " + t.slice(0, 200));
}
class ApiError extends Error { constructor(status, body, msg) { super(msg || `HTTP ${status}`); this.status = status; this.body = body; } }
async function fetchJson(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) throw new ApiError(res.status, body, `${opts.method || "GET"} ${url.split("?")[0]} -> ${res.status}: ${(typeof body === "string" ? body : JSON.stringify(body)).slice(0, 400)}`);
  return body;
}
async function fetchBytes(url, opts = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new ApiError(res.status, await res.text().catch(() => ""), `${url.split("?")[0]} -> ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
// Error classes drive retries. Transient = likely to work later (rate limit, overloaded model, 5xx, network) → retried
// with backoff. Permanent = retrying cannot help (bad request, auth, missing key, duplicate) → fail now.
// e.transient (true/false) set by a caller overrides the guess.
const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 529]);
const TRANSIENT_TEXT = /UNAVAILABLE|RESOURCE_EXHAUSTED|overloaded|high demand|try again later|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|timed out/i;
const PERMANENT_STATUS = new Set([400, 401, 404, 405, 409, 410, 413, 422]);
const PERMANENT_TEXT = /Dedup:|disabled|No API key|needs |cannot publish|credit balance|not registered|Unknown \w+ adapter/i;
function isTransient(e) {
  if (!e) return false;
  if (typeof e.transient === "boolean") return e.transient;
  const status = Number(e.status), msg = String(e.message || e);
  if (status === 403) return /quota|limit|exhausted/i.test(msg + JSON.stringify(e.body || ""));
  return TRANSIENT_STATUS.has(status) || (!PERMANENT_STATUS.has(status) && TRANSIENT_TEXT.test(msg));
}
function isPermanent(e) {
  if (!e || isTransient(e)) return false;
  return PERMANENT_STATUS.has(Number(e.status)) || Number(e.status) === 403 || PERMANENT_TEXT.test(String(e.message || e));
}
// Short in-call retry for transient failures. 429 is left to withKey, which rotates to the next key instead.
async function retryTransient(fn, { tries = 3, baseMs = 1500 } = {}) {
  for (let i = 1; ; i++) {
    try { return await fn(); }
    catch (e) { if (i >= tries || e.status === 429 || !isTransient(e)) throw e; await sleep(baseMs * i); }
  }
}
const form = (obj) => new URLSearchParams(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v) : String(v)]));

// === 2. database & migration ==========================================
if (!DATABASE_URL) { console.error("DATABASE_URL is required (Supabase session-mode pooler string, port 5432)."); process.exit(1); }
const pool = new pg.Pool({
  connectionString: DATABASE_URL, max: Number(ENV.PG_POOL_MAX) || 8,
  ssl: /localhost|127\.0\.0\.1|@postgres[:/]/.test(DATABASE_URL) ? undefined : { rejectUnauthorized: false },
});
pool.on("error", (e) => warn("pg pool error", e.message));
async function q(sql, params = []) { return (await pool.query(sql, params)).rows; }
async function one(sql, params = []) { return (await q(sql, params))[0]; }
async function migrate() {
  const sql = await readFile(join(__dirname, "schema.sql"), "utf8");
  await pool.query(sql);
  log("schema applied (idempotent)");
}
// Generic patch: whitelist map {bodyKey: column}
async function patchRow(table, id, body, map) {
  const sets = [], params = [id]; let i = 2;
  for (const [k, col] of Object.entries(map)) {
    if (!(k in body)) continue;
    let v = body[k];
    if (typeof v === "boolean") v = v ? 1 : 0;
    if (v !== null && typeof v === "object") v = JSON.stringify(v);
    sets.push(`${col} = $${i++}`); params.push(v);
  }
  if (!sets.length) throw new ApiError(400, null, "No fields to update");
  return one(`UPDATE ${table} SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, params);
}
const rowJson = (row, fields) => { if (!row) return row; const c = { ...row }; for (const f of fields) c[f] = P(row[f]); return c; };

// === 3. settings & credentials ========================================
const settingsCache = { at: 0, map: {} };
async function settings() {
  if (Date.now() - settingsCache.at < 10000) return settingsCache.map;
  settingsCache.map = Object.fromEntries((await q(`SELECT key, value FROM settings`)).map((r) => [r.key, P(r.value)]));
  settingsCache.at = Date.now();
  return settingsCache.map;
}
async function setting(key, def) { const m = await settings(); return m[key] === undefined ? def : m[key]; }
async function putSetting(key, value) {
  await q(`INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [key, JSON.stringify(value)]);
  settingsCache.at = 0;
}
async function spentTodayUsd() { return Number((await one(`SELECT COALESCE(SUM(cost_usd),0) AS c FROM api_usage_daily WHERE day = CURRENT_DATE`)).c) || 0; }
async function budgetOk() { const cap = Number(await setting("budget.daily_cap_usd", 0)); if (!cap) return true; return (await spentTodayUsd()) < cap; }

// ---- 3a. secrets vault. Secrets pasted in the dashboard are encrypted with AES-256-GCM under SECRETS_KEY
// (any long random string on Render; it is hashed to a 32-byte key). Without SECRETS_KEY the dashboard can
// still *register* env-var names, but cannot store secret values. Secrets are never returned by any route.
const SECRETS_KEY = ENV.SECRETS_KEY ? createHash("sha256").update(ENV.SECRETS_KEY).digest() : null;
const vaultReady = () => !!SECRETS_KEY;
function encryptSecret(plain) {
  if (!SECRETS_KEY) throw new ApiError(400, null, "SECRETS_KEY is not set on Render — add a long random string (e.g. `openssl rand -hex 32`) and redeploy before storing secrets in the dashboard.");
  const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", SECRETS_KEY, iv);
  const ct = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return `v1.${iv.toString("base64url")}.${c.getAuthTag().toString("base64url")}.${ct.toString("base64url")}`;
}
function decryptSecret(blob) {
  if (!blob) return null;
  if (!SECRETS_KEY) throw new Error("A stored secret exists but SECRETS_KEY is not set — restore the same SECRETS_KEY on Render");
  const [v, iv, tag, ct] = String(blob).split("."); if (v !== "v1") throw new Error("unknown secret format");
  const d = createDecipheriv("aes-256-gcm", SECRETS_KEY, Buffer.from(iv, "base64url")); d.setAuthTag(Buffer.from(tag, "base64url"));
  try { return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8"); }
  catch { throw new Error("Stored secret could not be decrypted — SECRETS_KEY on Render differs from the one used to store it"); }
}
const secretHint = (s) => { const t = String(s || "").trim(); return t.length > 8 ? `…${t.slice(-4)}` : "…"; };
// Some providers need several values (YouTube OAuth). Those are stored as one JSON secret and exposed as an object.
const MULTI_FIELD_PROVIDERS = { youtube_oauth: ["client_id", "client_secret", "refresh_token"], r2: ["account_id", "access_key_id", "secret_access_key", "bucket", "public_url"] };
const parseSecret = (provider, raw) => (MULTI_FIELD_PROVIDERS[provider] && raw ? (P(raw) || {}) : raw);

const DEFAULT_ENV = { anthropic: "ANTHROPIC_API_KEY", gemini: "GEMINI_API_KEY", openai: "OPENAI_API_KEY", newsapi: "NEWSAPI_KEY", elevenlabs: "ELEVENLABS_API_KEY", youtube: "YOUTUBE_API_KEY", meta: "META_ACCESS_TOKEN" };
const PROVIDERS = [...Object.keys(DEFAULT_ENV), "youtube_oauth", "r2"];
// Resolve the usable secret of one credential row: vault first, then the named env var.
function credSecret(r) {
  if (r.secret_enc) return { secret: parseSecret(r.provider, decryptSecret(r.secret_enc)), source: "vault" };
  if (r.env_var && ENV[r.env_var]) return { secret: parseSecret(r.provider, ENV[r.env_var]), source: "env" };
  return null;
}
async function credentialById(id) { const r = id ? await one(`SELECT * FROM api_credentials WHERE id=$1`, [id]) : null; if (!r) return null; const s = credSecret(r); return s ? { id: r.id, label: r.label, provider: r.provider, ...s } : null; }
// Ordered list of keys to try for a provider. `pin` (an api_credentials id from adapter_configs.credential_id) is tried first;
// if it is cooling down / over quota the rest of the provider's pool follows, then the default env var.
async function credentialsFor(provider, pin = null) {
  const rows = await q(
    `SELECT c.*, COALESCE(u.units,0) AS used_today FROM api_credentials c
       LEFT JOIN api_usage_daily u ON u.credential_id = c.id AND u.day = CURRENT_DATE
      WHERE c.provider = $1 AND c.enabled::int = 1 AND (c.cooldown_until IS NULL OR c.cooldown_until <= now())
      ORDER BY (c.id = $2) DESC, c.priority DESC, used_today ASC`, [provider, pin || ""]);
  const list = [];
  for (const r of rows) {
    if (r.daily_quota && Number(r.used_today) >= r.daily_quota) continue;
    let s; try { s = credSecret(r); } catch (e) { warn(`credential ${r.label}: ${e.message}`); continue; }
    if (s) list.push({ id: r.id, label: r.label, ...s });
  }
  const envName = DEFAULT_ENV[provider];
  if (!list.length && envName && ENV[envName]) list.push({ id: `env:${provider}`, label: envName, secret: ENV[envName], source: "env" });
  return list;
}
async function recordUsage(credId, provider, units = 1, cost = 0) {
  await q(`INSERT INTO api_usage_daily (id, credential_id, provider, day, units, cost_usd) VALUES ($1,$2,$3,CURRENT_DATE,$4,$5)
           ON CONFLICT (credential_id, provider, day) DO UPDATE SET units = api_usage_daily.units + EXCLUDED.units, cost_usd = api_usage_daily.cost_usd + EXCLUDED.cost_usd`,
    [newId(), credId, provider, units, cost]).catch((e) => warn("usage record failed", e.message));
}
// Runs fn(secret) against the best key; on 429/quota errors cools that key down and tries the next one.
async function withKey(provider, fn, pin = null) {
  const creds = await credentialsFor(provider, pin);
  if (!creds.length) throw new Error(`No API key for "${provider}". Add one on the API keys page${DEFAULT_ENV[provider] ? ` (or set ${DEFAULT_ENV[provider]} on Render)` : ""}.`);
  let last;
  for (const c of creds) {
    try {
      const out = await fn(c.secret, c);
      await recordUsage(c.id, provider, out?.units ?? 1, out?.cost ?? 0);
      return out;
    } catch (e) {
      last = e;
      const quota = e.status === 429 || (e.status === 403 && /quota|limit/i.test(JSON.stringify(e.body || "")));
      if (!quota) throw e;
      warn(`key ${c.label} for ${provider} hit quota; rotating`);
      if (!c.id.startsWith("env:")) await q(`UPDATE api_credentials SET cooldown_until = now() + interval '30 minutes', last_error = $2 WHERE id = $1`, [c.id, String(e.message).slice(0, 500)]);
    }
  }
  throw last;
}

// === 4. storage & processes ===========================================
// Backends: Cloudflare R2 (S3 API, SigV4 signed here — no SDK), Supabase Storage, or local disk.
// R2 config comes from env (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_URL) or from
// a vault credential with provider "r2" (one JSON secret with those five fields, set on the API keys page).
// STORAGE_BACKEND=r2|supabase|local forces a choice; otherwise the first configured one wins in that order.
const hmac = (k, s) => createHmac("sha256", k).update(s).digest();
const hex = (b) => Buffer.from(b).toString("hex");
function sigV4({ method, host, path, headers, body, region, service, accessKey, secretKey }) {
  const now = new Date(), amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ""), date = amzDate.slice(0, 8);
  const payloadHash = createHash("sha256").update(body || "").digest("hex");
  const hdr = { ...headers, host, "x-amz-date": amzDate, "x-amz-content-sha256": payloadHash };
  const signedKeys = Object.keys(hdr).map((k) => k.toLowerCase()).sort();
  const canonHeaders = signedKeys.map((k) => `${k}:${String(hdr[Object.keys(hdr).find((x) => x.toLowerCase() === k)]).trim()}\n`).join("");
  const canonPath = path.split("/").map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())).join("/");
  const canonical = [method, canonPath, "", canonHeaders, signedKeys.join(";"), payloadHash].join("\n");
  const scope = `${date}/${region}/${service}/aws4_request`;
  const sts = ["AWS4-HMAC-SHA256", amzDate, scope, createHash("sha256").update(canonical).digest("hex")].join("\n");
  const kSign = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, date), region), service), "aws4_request");
  hdr.Authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedKeys.join(";")}, Signature=${hex(hmac(kSign, sts))}`;
  return hdr;
}
async function r2Config() {
  const vault = (await credentialsFor("r2"))[0]?.secret;
  const c = vault && typeof vault === "object" ? vault : { account_id: ENV.R2_ACCOUNT_ID, access_key_id: ENV.R2_ACCESS_KEY_ID, secret_access_key: ENV.R2_SECRET_ACCESS_KEY, bucket: ENV.R2_BUCKET, public_url: ENV.R2_PUBLIC_URL };
  if (!c.account_id || !c.access_key_id || !c.secret_access_key || !c.bucket) return null;
  return { ...c, host: `${c.account_id}.r2.cloudflarestorage.com`, public_url: String(c.public_url || "").replace(/\/+$/, "") };
}
async function r2Request(method, path, body = null, contentType = null) {
  const c = await r2Config(); if (!c) throw new Error("R2 is not configured");
  const headers = sigV4({ method, host: c.host, path: `/${c.bucket}/${path}`, headers: contentType ? { "content-type": contentType } : {}, body, region: "auto", service: "s3", accessKey: c.access_key_id, secretKey: c.secret_access_key });
  const res = await fetch(`https://${c.host}/${c.bucket}/${path}`, { method, headers, body });
  if (!res.ok && !(method === "DELETE" && res.status === 404)) throw new ApiError(res.status, await res.text().catch(() => ""), `R2 ${method} ${path} -> ${res.status}`);
  return res;
}
const STORAGE = {
  r2: {
    // Not "available" without public_url: platforms fetch files by URL, so a bucket with no public address is useless
    // and the engine keeps using the next backend (and says so on the Storage page) instead of failing every upload.
    name: "r2", available: async () => !!(await r2Config())?.public_url,
    publicBase: async () => { const c = await r2Config(); if (!c.public_url) throw new Error("R2 needs public_url (R2_PUBLIC_URL): enable the r2.dev subdomain or a custom domain on the bucket"); return c.public_url; },
    put: async (path, bytes, ct) => { await r2Request("PUT", path, bytes, ct); return `${await STORAGE.r2.publicBase()}/${path}`; },
    del: async (path) => { await r2Request("DELETE", path); },
  },
  supabase: {
    name: "supabase", available: async () => !!(ENV.SUPABASE_URL && ENV.SUPABASE_SERVICE_ROLE_KEY),
    publicBase: async () => `${ENV.SUPABASE_URL}/storage/v1/object/public/${ENV.SUPABASE_BUCKET || "media"}`,
    put: async (path, bytes, ct) => { const bucket = ENV.SUPABASE_BUCKET || "media"; await fetchJson(`${ENV.SUPABASE_URL}/storage/v1/object/${bucket}/${path}`, { method: "POST", body: bytes, headers: { Authorization: `Bearer ${ENV.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": ct, "x-upsert": "true" } }); return `${await STORAGE.supabase.publicBase()}/${path}`; },
    del: async (path) => { await fetchJson(`${ENV.SUPABASE_URL}/storage/v1/object/${ENV.SUPABASE_BUCKET || "media"}`, { method: "DELETE", headers: { Authorization: `Bearer ${ENV.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ prefixes: [path] }) }).catch((e) => { if (e.status !== 404) throw e; }); },
  },
  local: {
    name: "local", available: async () => true,
    publicBase: async () => `${ENV.PUBLIC_BASE_URL || `http://localhost:${PORT}`}/media`,
    put: async (path, bytes) => { const full = join(LOCAL_MEDIA_DIR, path); await mkdir(dirname(full), { recursive: true }); await writeFile(full, bytes); return `${await STORAGE.local.publicBase()}/${path}`; },
    del: async (path) => { await unlink(join(LOCAL_MEDIA_DIR, path)).catch(() => {}); },
  },
};
const storageCache = { at: 0, backend: null };
async function storageBackend() {
  if (Date.now() - storageCache.at < 30000 && storageCache.backend) return storageCache.backend;
  const forced = (ENV.STORAGE_BACKEND || "").toLowerCase();
  let b = forced && STORAGE[forced] ? STORAGE[forced] : null;
  if (!b) for (const k of ["r2", "supabase", "local"]) if (await STORAGE[k].available()) { b = STORAGE[k]; break; }
  storageCache.backend = b; storageCache.at = Date.now(); return b;
}
async function storeFile(path, bytes, contentType) { return (await storageBackend()).put(path, bytes, contentType); }
async function storeLocal(localPath, destPath, contentType) { return storeFile(destPath, await readFile(localPath), contentType); }
// Work out which backend/path a stored URL belongs to so it can be deleted later, whichever backend is active now.
async function locateStored(url) {
  if (!url || !/^https?:/.test(url)) return null;
  for (const k of ["r2", "supabase", "local"]) { const b = STORAGE[k]; if (!(await b.available().catch(() => false))) continue; let base; try { base = await b.publicBase(); } catch { continue; } if (url.startsWith(base + "/")) return { backend: b, path: url.slice(base.length + 1) }; }
  return null;
}
async function deleteStored(url) { const loc = await locateStored(url); if (!loc) return false; await loc.backend.del(loc.path); return true; }
async function recordMedia({ contentItemId = null, kind, url, mime = null, duration = null, width = null, height = null, path = null, meta = {} }) {
  const id = newId();
  if (!path) path = (await locateStored(url))?.path || null;
  await q(`INSERT INTO media_assets (id, content_item_id, kind, url, mime, width, height, duration_seconds, storage_path, meta) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
    [id, contentItemId, kind, url, mime, width, height, duration, path, JSON.stringify(meta)]);
  return { id, kind, url, mime, duration_seconds: duration };
}
// Storage hygiene: once every asset of an item is PUBLISHED (platforms have copied the file) and enough time has
// passed, delete the item's media from storage. The media rows stay (with deleted_at) so history and metrics survive.
async function sweepStorageCleanup() {
  if (!(await setting("storage.cleanup_enabled", true))) return;
  const hours = Number(await setting("storage.cleanup_after_publish_hours", 48)) || 48;
  // Guards, in order: the item must have at least one channel asset (a portal-only item has none, and the guards below
  // would pass vacuously); every asset published; all of them older than the window; no other live item reuses the file;
  // and the file is not the hero image of a portal article — the portal serves it forever, so it is never cleaned.
  const rows = await q(`SELECT m.id, m.url FROM media_assets m JOIN content_items ci ON ci.id = m.content_item_id
    WHERE m.deleted_at IS NULL AND m.url LIKE 'http%' AND ci.status = 'PUBLISHED'
      AND EXISTS (SELECT 1 FROM content_assets a WHERE a.content_item_id = ci.id)
      AND NOT EXISTS (SELECT 1 FROM content_assets a WHERE a.content_item_id = ci.id AND a.status <> 'PUBLISHED')
      AND NOT EXISTS (SELECT 1 FROM content_assets a WHERE a.content_item_id = ci.id AND a.published_at > now() - ($1 || ' hours')::interval)
      AND NOT EXISTS (SELECT 1 FROM content_items d WHERE d.hero_media_id = m.id AND d.id <> ci.id AND d.status NOT IN ('PUBLISHED','REJECTED','FAILED'))
      AND NOT EXISTS (SELECT 1 FROM portal_articles pa WHERE pa.hero_image_url = m.url)
    LIMIT 40`, [String(hours)]);
  let n = 0;
  for (const m of rows) {
    try { await deleteStored(m.url); await q(`UPDATE media_assets SET deleted_at = now() WHERE id=$1`, [m.id]); n++; }
    catch (e) { warn(`cleanup ${m.id}: ${e.message}`); }
  }
  if (n) log(`storage cleanup: deleted ${n} file(s)`);
}
// Materialise any media URL (remote, local /media, or file path) as a tmp file.
async function toTmpFile(url, ext) {
  if (!url || url.startsWith("mock://")) throw new Error(`Cannot download mock/empty media "${url}" — a live render needs a real file`);
  const out = tmpPath(ext || (extname(url.split("?")[0]).slice(1) || "bin"));
  const localPrefix = `/media/`;
  const i = url.indexOf(localPrefix);
  if (!/^https?:/.test(url)) { await writeFile(out, await readFile(url)); return out; }
  if (i > 0 && (await storageBackend()).name === "local") { await writeFile(out, await readFile(join(LOCAL_MEDIA_DIR, url.slice(i + localPrefix.length)))); return out; }
  const gone = await one(`SELECT id FROM media_assets WHERE url=$1 AND deleted_at IS NOT NULL`, [url]);
  if (gone) throw new Error("This media file was already deleted by storage cleanup after publishing — regenerate the item to produce a new file");
  await writeFile(out, await fetchBytes(url));
  return out;
}
function exec(cmd, args, { timeoutMs = 45 * 60000, input = null } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
    const t = setTimeout(() => { p.kill("SIGKILL"); reject(new Error(`${cmd} timed out`)); }, timeoutMs);
    p.on("error", (e) => { clearTimeout(t); reject(new Error(`${cmd} is not available on this machine (${e.message}). On Render use the Dockerfile.`)); });
    p.on("close", (c) => { clearTimeout(t); c === 0 ? resolve({ out, err }) : reject(new Error(`${cmd} exited ${c}: ${err.slice(-1200)}`)); });
    if (input) p.stdin.write(input); p.stdin.end();
  });
}
async function ffprobeDuration(file) { try { const { out } = await exec("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]); return Number(out.trim()) || 0; } catch { return 0; } }
const cleanup = (...files) => Promise.all(files.filter(Boolean).map((f) => unlink(f).catch(() => {})));

// === 5. adapter registry ==============================================
// impl  = code (below). instance = adapter_configs row referencing an impl by id, with its own config.
// A niche/channel/source refers to an instance by key. If the key isn't in adapter_configs but matches
// an impl id, the impl runs with default config — so the original keys keep working.
const IMPLS = {};
function impl(stage, id, def) { (IMPLS[stage] ||= {})[id] = { id, stage, label: id, configSchema: {}, ...def }; }
const instCache = { at: 0, rows: [] };
async function instances(force = false) {
  if (!force && Date.now() - instCache.at < 10000) return instCache.rows;
  instCache.rows = await q(`SELECT * FROM adapter_configs`); instCache.at = Date.now();
  return instCache.rows;
}
async function resolve(stage, key) {
  if (!key) throw new Error(`No ${stage} adapter configured`);
  const row = (await instances()).find((r) => r.key === key && r.stage === stage);
  const implId = row ? row.impl : (IMPLS[stage]?.[key] ? key : null);
  const def = implId && IMPLS[stage]?.[implId];
  if (!def) throw new Error(`Unknown ${stage} adapter "${key}" (impl "${implId || key}" is not registered)`);
  if (row && !flag(row.enabled)) throw new Error(`${stage} adapter instance "${key}" is disabled`);
  const cfg = P(row?.config) || {};
  // Key pinning: adapter instance may name a specific credential (Adapters page → Credential), so e.g. a "gemini_writing"
  // instance uses one Gemini key and "gemini_image" another. Falls back to the provider pool if that key is unavailable.
  const a = def.create(cfg, { key, row, pin: row?.credential_id || cfg.credential_id || null });
  a.key = key; a.impl = implId;
  return a;
}
// Try primary then fallbacks; fn(adapter) is attempted per adapter. When several fail, the error lists all of them and
// stays retryable if any failure was transient — a fallback's missing key must not turn a temporary outage of the
// primary into a permanent failure.
async function withFallbacks(stage, primary, fallbacks, fn) {
  const keys = [...new Set([primary, ...(P(fallbacks) || [])].filter(Boolean))];
  const errors = [];
  for (const k of keys) {
    let a; try { a = await resolve(stage, k); } catch (e) { errors.push([k, e]); continue; }
    try { return await fn(a); } catch (e) { errors.push([k, e]); warn(`${stage} adapter ${k} failed: ${e.message}`); }
  }
  if (!errors.length) throw new Error(`No ${stage} adapter available`);
  if (errors.length === 1) throw errors[0][1];
  const e = new Error(errors.map(([k, x]) => `${k}: ${x.message}`).join(" | "));
  e.status = errors[0][1].status; e.transient = errors.some(([, x]) => isTransient(x));
  throw e;
}
// A program without its own fallback list uses the global one (Settings → llm.default_fallbacks / image.default_fallbacks).
async function fallbacksFor(own, settingKey) { const list = P(own) || []; return list.length ? list : (await setting(settingKey, [])) || []; }
function listAdapterKeys(rows) {
  const by = (stage) => rows.filter((r) => r.stage === stage && flag(r.enabled)).map((r) => r.key);
  return { topicSources: by("TOPIC"), scriptAdapters: by("SCRIPT"), voiceAdapters: by("VOICE"), renderAdapters: by("RENDER"),
    imageAdapters: by("IMAGE"), ingestAdapters: by("INGEST"), downloadAdapters: by("DOWNLOAD"), transcriptAdapters: by("TRANSCRIBE"),
    clipAdapters: by("CLIP"), publishAdapters: by("PUBLISH"), embedAdapters: by("EMBED") };
}

// === 6. adapter impls ==================================================
// ---- 6a. LLM (stage SCRIPT). Contract: complete({system, prompt, json, mock, maxTokens, grounding}) -> {text, data, cost}
// fail_first/fail_status make an instance fail its first N calls — used by tests to exercise retries and fallbacks.
const mockFailures = new Map();
impl("SCRIPT", "llm_mock", { label: "Mock LLM", configSchema: { fail_first: { type: "number", default: 0 }, fail_status: { type: "number", default: 503 } }, create: (cfg, ctx = {}) => ({
  async complete({ prompt, json, mock }) {
    if (cfg.fail_first) {
      const n = (mockFailures.get(ctx.key) || 0) + 1; mockFailures.set(ctx.key, n);
      if (n <= cfg.fail_first) throw new ApiError(cfg.fail_status || 503, null, `mock ${cfg.fail_status || 503}: simulated failure ${n} of ${cfg.fail_first}`);
    }
    if (json) return { text: JSON.stringify(mock ?? {}), data: mock ?? {}, cost: 0 };
    return { text: `[mock] ${String(prompt).slice(0, 160)}`, data: null, cost: 0 };
  } }) });
impl("SCRIPT", "anthropic", { label: "Anthropic Claude", configSchema: { model: { type: "string", default: DEFAULTS.ANTHROPIC_MODEL } }, create: (cfg, ctx = {}) => ({
  async complete({ system, prompt, json = false, maxTokens = 2500 }) {
    const model = cfg.model || DEFAULTS.ANTHROPIC_MODEL;
    return withKey("anthropic", async (key) => {
      const body = await retryTransient(() => fetchJson("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model, max_tokens: maxTokens, system: system || undefined, messages: [{ role: "user", content: prompt + (json ? "\n\nRespond with ONLY valid JSON, no prose, no code fences." : "") }] }),
      }));
      const text = (body.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
      const u = body.usage || {};
      return { text, data: json ? extractJson(text) : null, cost: tokenCost(model, u.input_tokens, u.output_tokens), model, units: 1 };
    }, ctx.pin);
  } }) });
// Runs call(model) on the main model, then on each fallback model while the failure is an overload (503/5xx) or an
// unknown model id (404). A 429 or a permanent error is thrown straight away (withKey rotates keys on 429).
async function withModelFallback(models, call) {
  let last, lastTransient;
  for (const model of [...new Set(models.filter(Boolean))]) {
    try { return await retryTransient(() => call(model)); }
    catch (e) {
      last = e;
      if (e.status === 429) throw e;
      if (isTransient(e)) { lastTransient = e; warn(`model ${model} unavailable (${e.status || e.message.slice(0, 60)}), trying the next one`); continue; }
      if (e.status === 404) continue;
      throw e;
    }
  }
  throw lastTransient || last;
}
impl("SCRIPT", "gemini", { label: "Google Gemini", configSchema: { model: { type: "string", default: DEFAULTS.GEMINI_MODEL }, fallback_models: { type: "array", default: DEFAULTS.GEMINI_FALLBACK_MODELS }, grounding: { type: "boolean", default: false } }, create: (cfg, ctx = {}) => ({
  async complete({ system, prompt, json = false, maxTokens = 4000, grounding = false }) {
    const models = [cfg.model || DEFAULTS.GEMINI_MODEL, ...(Array.isArray(cfg.fallback_models) ? cfg.fallback_models : DEFAULTS.GEMINI_FALLBACK_MODELS)];
    const useSearch = grounding || cfg.grounding;
    return withKey("gemini", async (key) => {
      const req = {
        system_instruction: system ? { parts: [{ text: system }] } : undefined,
        contents: [{ role: "user", parts: [{ text: prompt + (json && useSearch ? "\n\nRespond with ONLY valid JSON." : "") }] }],
        generationConfig: { maxOutputTokens: maxTokens, responseMimeType: json && !useSearch ? "application/json" : undefined },
        tools: useSearch ? [{ google_search: {} }] : undefined,
      };
      const { model, body } = await withModelFallback(models, async (m) => ({ model: m, body: await fetchJson(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
        method: "POST", headers: { "x-goog-api-key": key, "content-type": "application/json" }, body: JSON.stringify(req) }) }));
      const text = (body.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
      const u = body.usageMetadata || {};
      const cites = (body.candidates?.[0]?.groundingMetadata?.groundingChunks || []).map((c) => c.web?.uri).filter(Boolean);
      return { text, data: json ? extractJson(text) : null, cost: tokenCost(model, u.promptTokenCount, u.candidatesTokenCount), model, citations: cites, units: 1 };
    }, ctx.pin);
  } }) });
impl("SCRIPT", "openai", { label: "OpenAI (GPT)", configSchema: { model: { type: "string", default: DEFAULTS.OPENAI_MODEL }, temperature: { type: "number", default: 0.7 } }, create: (cfg, ctx = {}) => ({
  async complete({ system, prompt, json = false, maxTokens = 3000 }) {
    const model = cfg.model || DEFAULTS.OPENAI_MODEL;
    return withKey("openai", async (key) => {
      const messages = []; if (system) messages.push({ role: "system", content: system });
      messages.push({ role: "user", content: prompt + (json ? "\n\nRespond with ONLY valid JSON." : "") });
      const req = { model, messages, max_completion_tokens: maxTokens, response_format: json ? { type: "json_object" } : undefined };
      if (!/^(o\d|gpt-5)/.test(model) && cfg.temperature != null) req.temperature = Number(cfg.temperature);
      const body = await retryTransient(() => fetchJson("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(req) }));
      const text = body.choices?.[0]?.message?.content || ""; const u = body.usage || {};
      let data = null; if (json) { data = extractJson(text); if (data && !Array.isArray(data) && Object.keys(data).length === 1 && Array.isArray(Object.values(data)[0])) data = Object.values(data)[0]; }
      return { text, data, cost: tokenCost(model, u.prompt_tokens, u.completion_tokens), model, units: 1 };
    }, ctx.pin);
  } }) });

// ---- 6b. Legacy topic sources (stage TOPIC). fetchCandidate({nicheKey, excludeTopics}) -> {topic, sourceDataRef}
const MOCK_TOPICS = {
  newsapi_mock: ["A new open-weight model claims GPT-4-class reasoning at a tenth of the cost", "A major cloud provider cuts GPU instance prices after new chip competition",
    "A productivity app adds an AI agent that runs multi-step tasks on its own", "Researchers cut LLM hallucination rates in structured-data tasks", "A browser ships an AI assistant directly in the address bar",
    "A startup raises a large round for AI-native project management", "A benchmark shows coding assistants still fail multi-file refactors", "A chip maker unveils a consumer GPU for local AI inference"],
  tmdb_mock: ["a stranded astronaut who must choose between rescue and a world-changing discovery", "a heist crew whose plan unravels when their inside contact goes silent",
    "a detective who realizes the case points back to his own past", "a small-town teacher who uncovers a twenty-year-old conspiracy"],
  sportmonks_mock: ["a last-minute goal that flips a title race with two matches left", "a rookie's record-breaking debut season", "a mid-season coaching change that reverses a losing streak", "an underdog playoff run built on defense"],
};
for (const k of Object.keys(MOCK_TOPICS)) impl("TOPIC", k, { label: `Mock (${k})`, create: () => ({
  async fetchCandidate({ excludeTopics }) {
    const list = MOCK_TOPICS[k]; let i = Date.now() % list.length, tries = 0;
    while (excludeTopics.includes(list[i]) && tries++ < list.length) i = (i + 1) % list.length;
    return { topic: list[i], sourceDataRef: { provider: k, fetchedAt: nowIso(), note: "deterministic mock" } };
  } }) });
impl("TOPIC", "newsapi_topic", { label: "NewsAPI top headline", configSchema: { country: { type: "string", default: "us" }, category: { type: "string", default: "technology" }, query: { type: "string" } }, create: (cfg, ctx = {}) => ({
  async fetchCandidate({ excludeTopics }) {
    return withKey("newsapi", async (key) => {
      const p = form({ country: cfg.query ? undefined : cfg.country || "us", category: cfg.query ? undefined : cfg.category || "technology", q: cfg.query, pageSize: 20, apiKey: key });
      const body = await fetchJson(`https://newsapi.org/v2/top-headlines?${p}`);
      const art = (body.articles || []).find((a) => a.title && !excludeTopics.includes(a.title)) || body.articles?.[0];
      if (!art) throw new Error("NewsAPI returned no articles");
      return { topic: art.title, sourceDataRef: { provider: "newsapi", url: art.url, outlet: art.source?.name, description: art.description, publishedAt: art.publishedAt }, units: 1, cost: 0 };
    }, ctx.pin);
  } }) });

// ---- 6c. Ingest (stage INGEST). fetchItems(source) -> [{external_id,url,title,summary,published_at,thumbnail,kind,duration,views,platform,raw}]
function parseFeed(xml) {
  const get = (b, tag) => { const m = b.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i")); return m ? decodeXml(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")).trim() : null; };
  const items = [];
  for (const m of xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)) {
    const b = m[0];
    const link = get(b, "link") || (b.match(/<link[^>]*href="([^"]+)"/i) || [])[1];
    const title = stripHtml(get(b, "title")); if (!title || !link) continue;
    const img = (b.match(/<(?:media:content|media:thumbnail|enclosure)[^>]*url="([^"]+)"/i) || [])[1] || (b.match(/<img[^>]*src="([^"]+)"/i) || [])[1];
    const date = get(b, "pubDate") || get(b, "published") || get(b, "updated") || get(b, "dc:date");
    items.push({ external_id: get(b, "guid") || get(b, "id") || link, url: link.trim(), title, summary: stripHtml(get(b, "description") || get(b, "summary") || get(b, "content:encoded") || get(b, "content") || "").slice(0, 2000),
      published_at: date && !isNaN(Date.parse(date)) ? new Date(date).toISOString() : null, thumbnail: img ? decodeXml(img) : null, kind: "ARTICLE" });
  }
  return items;
}
impl("INGEST", "ingest_mock", { label: "Mock feed", create: () => ({
  async fetchItems(source) { const n = Date.now(); return [0, 1].map((i) => ({ external_id: `mock-${n}-${i}`, url: `https://example.com/story/${n}-${i}`, title: `Mock story ${n % 1000}-${i} from ${source.name}`, summary: "A deterministic mock story used to exercise the pipeline without any keys.", published_at: nowIso(), kind: "ARTICLE" })); } }) });
impl("INGEST", "rss", { label: "RSS / Atom", configSchema: { url: { type: "string", required: true }, limit: { type: "number", default: 30 } }, create: (cfg, ctx = {}) => ({
  async fetchItems(source) {
    const url = cfg.url || P(source.config)?.url; if (!url) throw new Error("RSS source needs config.url");
    const res = await fetch(url, { headers: { "user-agent": "ContentEngine/1.0 (+rss)" } }); if (!res.ok) throw new Error(`Feed ${url} -> ${res.status}`);
    return parseFeed(await res.text()).slice(0, cfg.limit || P(source.config)?.limit || 30);
  } }) });
impl("INGEST", "newsapi", { label: "NewsAPI", configSchema: { country: { type: "string" }, category: { type: "string" }, query: { type: "string" }, language: { type: "string" } }, create: (cfg, ctx = {}) => ({
  async fetchItems(source) {
    const c = { ...cfg, ...(P(source.config) || {}) };
    return withKey("newsapi", async (key) => {
      const endpoint = c.query && !c.country ? "everything" : "top-headlines";
      const p = form({ country: c.country, category: c.category, q: c.query, language: c.language, pageSize: c.limit || 30, sortBy: endpoint === "everything" ? "publishedAt" : undefined, apiKey: key });
      const body = await fetchJson(`https://newsapi.org/v2/${endpoint}?${p}`);
      return (body.articles || []).filter((a) => a.title && a.url).map((a) => ({ external_id: a.url, url: a.url, title: a.title, summary: a.description || a.content || "", published_at: a.publishedAt, thumbnail: a.urlToImage, kind: "ARTICLE", raw: { outlet: a.source?.name } }));
    }, ctx.pin);
  } }) });
const iso8601ToSec = (d) => { const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(d || ""); return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : null; };
impl("INGEST", "youtube_api", { label: "YouTube Data API", configSchema: { channel_id: { type: "string" }, query: { type: "string" }, limit: { type: "number", default: 20 }, hours: { type: "number", default: 72 } }, create: (cfg, ctx = {}) => ({
  async fetchItems(source) {
    const c = { ...cfg, ...(P(source.config) || {}) };
    return withKey("youtube", async (key) => {
      const p = form({ part: "snippet", type: "video", order: "date", maxResults: c.limit || 20, channelId: c.channel_id, q: c.query, publishedAfter: new Date(Date.now() - (c.hours || 72) * 3600e3).toISOString(), key });
      const s = await fetchJson(`https://www.googleapis.com/youtube/v3/search?${p}`);
      const ids = (s.items || []).map((i) => i.id?.videoId).filter(Boolean); if (!ids.length) return { items: [], units: 100 };
      const v = await fetchJson(`https://www.googleapis.com/youtube/v3/videos?${form({ part: "snippet,contentDetails,statistics,status", id: ids.join(","), key })}`);
      const items = (v.items || []).map((x) => ({ external_id: x.id, url: `https://www.youtube.com/watch?v=${x.id}`, title: x.snippet.title, summary: x.snippet.description?.slice(0, 2000), published_at: x.snippet.publishedAt,
        thumbnail: x.snippet.thumbnails?.high?.url, kind: "VIDEO", duration: iso8601ToSec(x.contentDetails?.duration), views: Number(x.statistics?.viewCount || 0), platform: "YOUTUBE", license: x.status?.license === "creativeCommon" ? "CC_BY" : "STANDARD", raw: { channel: x.snippet.channelTitle } }));
      items.units = 101; return items;
    }, ctx.pin).then((r) => Array.isArray(r) ? r : r.items);
  } }) });
impl("INGEST", "ytdlp_list", { label: "yt-dlp listing (any site)", configSchema: { url: { type: "string", required: true }, limit: { type: "number", default: 20 } }, create: (cfg, ctx = {}) => ({
  async fetchItems(source) {
    const c = { ...cfg, ...(P(source.config) || {}) }; if (!c.url) throw new Error("ytdlp_list source needs config.url (channel / videos page / playlist / search URL)");
    const args = ["-J", "--flat-playlist", "--playlist-end", String(c.limit || 20), "--no-warnings", c.url];
    if (ENV.YTDLP_COOKIES_FILE) args.unshift("--cookies", ENV.YTDLP_COOKIES_FILE);
    const { out } = await exec("yt-dlp", args, { timeoutMs: 180000 });
    const data = JSON.parse(out); const entries = data.entries || [data];
    const platform = /twitch/.test(c.url) ? "TWITCH" : /facebook|fb\.watch/.test(c.url) ? "FACEBOOK" : /youtu/.test(c.url) ? "YOUTUBE" : "OTHER";
    return entries.filter((e) => e && (e.url || e.webpage_url) && e.title).map((e) => ({ external_id: e.id, url: e.webpage_url || e.url, title: e.title, summary: e.description?.slice(0, 2000) || "", kind: "VIDEO",
      published_at: e.timestamp ? new Date(e.timestamp * 1000).toISOString() : e.upload_date ? new Date(`${e.upload_date.slice(0, 4)}-${e.upload_date.slice(4, 6)}-${e.upload_date.slice(6, 8)}`).toISOString() : null,
      thumbnail: e.thumbnails?.at(-1)?.url || e.thumbnail, duration: e.duration, views: e.view_count, platform, raw: { uploader: e.uploader || e.channel } }));
  } }) });

// ---- 6d. Download (stage DOWNLOAD). download(url) -> {path, duration}
impl("DOWNLOAD", "download_mock", { label: "Mock", create: () => ({ async download() { return { path: null, duration: 600, mock: true }; } }) });
impl("DOWNLOAD", "ytdlp", { label: "yt-dlp", configSchema: { format: { type: "string", default: "bv*[height<=1080]+ba/b[height<=1080]/b" }, max_minutes: { type: "number", default: 180 } }, create: (cfg, ctx = {}) => ({
  async download(url) {
    await mkdir(TMP, { recursive: true });
    const base = join(TMP, randomUUID());
    const args = ["-f", cfg.format || "bv*[height<=1080]+ba/b[height<=1080]/b", "--merge-output-format", "mp4", "--no-playlist", "--no-warnings", "-o", `${base}.%(ext)s`, url];
    if (cfg.max_minutes) args.unshift("--match-filter", `duration<=${cfg.max_minutes * 60}`);
    if (ENV.YTDLP_COOKIES_FILE) args.unshift("--cookies", ENV.YTDLP_COOKIES_FILE);
    await exec("yt-dlp", args, { timeoutMs: 40 * 60000 });
    const path = ["mp4", "mkv", "webm"].map((e) => `${base}.${e}`).find((p) => existsSync(p));
    if (!path) throw new Error("yt-dlp finished but produced no file (duration filter or format mismatch?)");
    return { path, duration: await ffprobeDuration(path) };
  } }) });

// ---- 6e. Transcribe (stage TRANSCRIBE). transcribe({path, language}) -> {segments:[{start,end,text}], text}
const joinSegments = (segs) => segs.map((s) => s.text).join(" ");
impl("TRANSCRIBE", "transcribe_mock", { label: "Mock", create: () => ({
  async transcribe({ duration = 600 }) { const segs = []; for (let t = 0; t < Math.min(duration, 1800); t += 8) segs.push({ start: t, end: t + 8, text: `Mock transcript sentence covering seconds ${t} to ${t + 8}; the speaker makes a surprising point here.` }); return { segments: segs, text: joinSegments(segs) }; } }) });
async function extractAudio(videoPath) { const out = tmpPath("mp3"); await exec("ffmpeg", ["-y", "-i", videoPath, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", out]); return out; }
impl("TRANSCRIBE", "gemini_transcribe", { label: "Gemini (audio → timestamped transcript)", configSchema: { model: { type: "string", default: DEFAULTS.GEMINI_MODEL } }, create: (cfg, ctx = {}) => ({
  async transcribe({ path, language }) {
    const audio = await extractAudio(path);
    try {
      const bytes = await readFile(audio);
      return await withKey("gemini", async (key) => {
        // Files API resumable upload
        const start = await fetch("https://generativelanguage.googleapis.com/upload/v1beta/files", { method: "POST", headers: { "x-goog-api-key": key, "X-Goog-Upload-Protocol": "resumable", "X-Goog-Upload-Command": "start", "X-Goog-Upload-Header-Content-Length": String(bytes.length), "X-Goog-Upload-Header-Content-Type": "audio/mpeg", "Content-Type": "application/json" }, body: JSON.stringify({ file: { display_name: "clip-audio" } }) });
        const uploadUrl = start.headers.get("x-goog-upload-url"); if (!uploadUrl) throw new ApiError(start.status, await start.text(), "Gemini file upload start failed");
        const fin = await fetchJson(uploadUrl, { method: "POST", headers: { "Content-Length": String(bytes.length), "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" }, body: bytes });
        let file = fin.file;
        for (let i = 0; i < 60 && file.state === "PROCESSING"; i++) { await sleep(3000); file = await fetchJson(`https://generativelanguage.googleapis.com/v1beta/${file.name}`, { headers: { "x-goog-api-key": key } }); }
        const model = cfg.model || DEFAULTS.GEMINI_MODEL;
        const body = await fetchJson(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { method: "POST", headers: { "x-goog-api-key": key, "content-type": "application/json" }, body: JSON.stringify({
          contents: [{ parts: [{ file_data: { file_uri: file.uri, mime_type: "audio/mpeg" } }, { text: `Transcribe this audio${language ? ` (language: ${language})` : ""} into a JSON array of segments: [{"start": seconds, "end": seconds, "text": "..."}]. Segments should be 3-10 seconds each with accurate timestamps. Output ONLY the JSON array.` }] }],
          generationConfig: { responseMimeType: "application/json", maxOutputTokens: 60000 } }) });
        const text = (body.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
        const segs = extractJson(text).filter((s) => s && typeof s.text === "string").map((s) => ({ start: Number(s.start) || 0, end: Number(s.end) || 0, text: s.text }));
        const u = body.usageMetadata || {};
        fetch(`https://generativelanguage.googleapis.com/v1beta/${file.name}`, { method: "DELETE", headers: { "x-goog-api-key": key } }).catch(() => {});
        return { segments: segs, text: joinSegments(segs), cost: tokenCost(model, u.promptTokenCount, u.candidatesTokenCount), units: 1 };
      }, ctx.pin);
    } finally { await cleanup(audio); }
  } }) });
impl("TRANSCRIBE", "whisper_api", { label: "OpenAI Whisper API", configSchema: { model: { type: "string", default: DEFAULTS.OPENAI_WHISPER_MODEL } }, create: (cfg, ctx = {}) => ({
  async transcribe({ path, language }) {
    const audio = await extractAudio(path);
    try {
      const bytes = await readFile(audio);
      if (bytes.length > 25 * 1024 * 1024) throw new Error("Audio exceeds Whisper's 25 MB limit — use whisper_local or gemini_transcribe for long videos");
      return await withKey("openai", async (key) => {
        const fd = new FormData(); fd.append("file", new Blob([bytes], { type: "audio/mpeg" }), "audio.mp3"); fd.append("model", cfg.model || DEFAULTS.OPENAI_WHISPER_MODEL);
        fd.append("response_format", "verbose_json"); fd.append("timestamp_granularities[]", "segment"); if (language) fd.append("language", language);
        const body = await fetchJson("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: fd });
        const segs = (body.segments || []).map((s) => ({ start: Number(s.start) || 0, end: Number(s.end) || 0, text: String(s.text || "").trim() }));
        const minutes = (body.duration || segs.at(-1)?.end || 0) / 60;
        return { segments: segs, text: body.text || joinSegments(segs), cost: minutes * Number(ENV.WHISPER_USD_PER_MINUTE || 0.006), units: 1 };
      }, ctx.pin);
    } finally { await cleanup(audio); }
  } }) });
impl("TRANSCRIBE", "whisper_local", { label: "Whisper CLI (local)", configSchema: { model: { type: "string", default: "base" } }, create: (cfg, ctx = {}) => ({
  async transcribe({ path, language }) {
    const audio = await extractAudio(path); const outDir = join(TMP, randomUUID()); await mkdir(outDir, { recursive: true });
    try {
      const args = [audio, "--model", cfg.model || "base", "--output_format", "json", "--output_dir", outDir]; if (language) args.push("--language", language);
      await exec("whisper", args, { timeoutMs: 60 * 60000 });
      const data = JSON.parse(await readFile(join(outDir, `${audio.split("/").pop().replace(/\.mp3$/, "")}.json`), "utf8"));
      const segs = (data.segments || []).map((s) => ({ start: s.start, end: s.end, text: String(s.text).trim() }));
      return { segments: segs, text: joinSegments(segs), cost: 0 };
    } finally { await cleanup(audio); await rm(outDir, { recursive: true, force: true }); }
  } }) });

// ---- 6f. Clip selection (stage CLIP). selectClips({transcript, niche, candidate}) -> [{start,end,title,hook,score,reason}]
const methodCfg = (niche) => ({ clip_min_seconds: 25, clip_max_seconds: 75, clips_per_video: 3, min_score: 0.5, orientation: "9:16", ...(P(niche.method_config) || {}) });
impl("CLIP", "clip_mock", { label: "Mock clipper", create: () => ({
  async selectClips({ transcript, niche }) { const c = methodCfg(niche); const dur = transcript.segments.at(-1)?.end || 300; const out = []; for (let i = 0; i < c.clips_per_video; i++) { const s = Math.min(i * 90, Math.max(0, dur - c.clip_max_seconds)); out.push({ start: s, end: Math.min(dur, s + c.clip_min_seconds + 20), title: `Mock clip ${i + 1}`, hook: "You won't believe this part", score: 0.8 - i * 0.1, reason: "mock" }); } return out; } }) });
impl("CLIP", "llm_clipper", { label: "LLM clipper (reads transcript)", configSchema: { llm: { type: "string", default: "(program's script adapter)" }, llm_fallbacks: { type: "array" } }, create: (cfg) => ({
  async selectClips({ transcript, niche, candidate }) {
    const c = methodCfg(niche);
    const lines = transcript.segments.map((s) => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`).join("\n").slice(0, 120000);
    // config.llm lets clipping run on a different SCRIPT instance (e.g. "openai_live") than the program's writer.
    const primary = cfg.llm || niche.script_adapter, fallbacks = cfg.llm ? (cfg.llm_fallbacks || []) : await fallbacksFor(niche.script_adapter_fallbacks, "llm.default_fallbacks");
    const r = await withFallbacks("SCRIPT", primary, fallbacks, (llm) => llm.complete({ json: true, maxTokens: 3000,
      system: `You are a senior short-form video editor. You find the most re-watchable, self-contained moments in long videos for ${niche.display_name}. Tone: ${niche.tone || "engaging"}.`,
      prompt: `Video: "${candidate.title}"\nTimestamped transcript:\n${lines}\n\nPick up to ${c.clips_per_video} clips, each ${c.clip_min_seconds}-${c.clip_max_seconds} seconds, that start and end on sentence boundaries and work with zero context. Score 0-1 for virality. JSON: [{"start": seconds, "end": seconds, "title": "short punchy title", "hook": "first-line on-screen hook", "score": 0.0, "reason": "why"}]`,
      mock: [{ start: 0, end: c.clip_min_seconds + 10, title: "Mock clip", hook: "Mock hook", score: 0.7, reason: "mock" }] }));
    const clips = (Array.isArray(r.data) ? r.data : r.data?.clips || []).map((x) => ({ start: Number(x.start) || 0, end: Number(x.end) || 0, title: x.title || candidate.title, hook: x.hook || "", score: Number(x.score) || 0, reason: x.reason || "" }))
      .filter((x) => x.end - x.start >= Math.min(10, c.clip_min_seconds * 0.5)).sort((a, b) => b.score - a.score);
    clips.cost = r.cost || 0; return clips;
  } }) });

// ---- 6g. Image (stage IMAGE). generate({prompt, headline, specs, contentItemId}) -> media row
function svgCard(headline, specs) {
  const w = specs.width || 1080, h = specs.height || 1080, words = String(headline || "").split(/\s+/), lines = []; let cur = "";
  for (const wd of words) { if ((cur + " " + wd).trim().length > 26) { lines.push(cur.trim()); cur = wd; } else cur += " " + wd; } if (cur.trim()) lines.push(cur.trim());
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0f1115"/><stop offset="1" stop-color="#22305a"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/><rect x="60" y="${h - 160}" width="180" height="10" fill="#6c8cff"/>${lines.slice(0, 6).map((l, i) => `<text x="60" y="${h / 2 - (lines.length * 30) + i * 70}" font-family="DejaVu Sans, Arial, sans-serif" font-size="56" font-weight="700" fill="#ffffff">${esc(l)}</text>`).join("")}<text x="60" y="${h - 90}" font-family="DejaVu Sans, Arial" font-size="28" fill="#9aa1ae">${esc(specs.brand || "Content Engine")}</text></svg>`;
}
// ---- Headline overlay (compose step) -------------------------------------------------------------------------------
// Image models are asked for the photo only; the headline is burned on afterwards with libass (the subtitles filter), which
// shapes Bangla correctly via HarfBuzz and wraps text itself. Layout: dark stepped band over the lower third, brand tag,
// headline. Set image_specs.render_text=true on a program to let the model draw the text instead (overlay is then skipped),
// or image_specs.overlay=false for no text at all.
const OVERLAY_FONT = ENV.OVERLAY_FONT || "Noto Sans Bengali";
const assEsc = (t) => String(t || "").replace(/[\r\n]+/g, " ").replace(/[{}\\]/g, "").trim();
const assColor = (hex, alpha = "00") => { const m = /^#?([0-9a-f]{6})$/i.exec(hex || ""); if (!m) return `&H${alpha}FFFFFF`; const h = m[1]; return `&H${alpha}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase(); };
async function imageDims(file) { const { out } = await exec("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file]); const [w, h] = out.trim().split(",").map(Number); return { width: w || 1080, height: h || 1080 }; }
async function composeHeadline(inPath, headline, specs = {}) {
  const { width: w, height: h } = await imageDims(inPath);
  const short = w > h, size = Math.round(h * (short ? 0.062 : 0.05) * (specs.overlay_scale || 1)), small = Math.round(size * 0.48);
  const mL = Math.round(w * 0.06), mV = Math.round(h * 0.075), accent = assColor(specs.accent_color || "#6c8cff"), fg = assColor(specs.text_color || "#ffffff");
  const ass = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${w}\nPlayResY: ${h}\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Head,${OVERLAY_FONT},${size},${fg},${fg},&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,${Math.max(1, Math.round(size * 0.03))},${Math.round(size * 0.04)},1,${mL},${mL},${mV},1\nStyle: Tag,${OVERLAY_FONT},${small},${accent},${accent},&H00000000,&H00000000,-1,0,0,0,100,100,${Math.round(small * 0.08)},0,1,0,0,1,${mL},${mL},${mV},1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${specs.brand ? `Dialogue: 0,0:00:00.00,0:00:10.00,Tag,,0,0,0,,{\\an7\\pos(${mL},${Math.round(h * 0.7)})}${assEsc(specs.brand).toUpperCase()}\n` : ""}Dialogue: 1,0:00:00.00,0:00:10.00,Head,,0,0,0,,${assEsc(headline)}\n`;
  const assPath = tmpPath("ass"), out = tmpPath("jpg"); await writeFile(assPath, ass);
  const band = [0.58, 0.68, 0.78].map((y, i) => `drawbox=x=0:y=ih*${y}:w=iw:h=ih:color=black@${0.18 + i * 0.16}:t=fill`).join(",");
  try { await exec("ffmpeg", ["-y", "-i", inPath, "-vf", `${band},subtitles=${assPath.replace(/\\/g, "/").replace(/:/g, "\\:")}`, "-frames:v", "1", "-q:v", "2", out], { timeoutMs: 90000 }); return out; }
  finally { await cleanup(assPath); }
}
// Instagram accepts JPEG only and Facebook prefers it; every generated raster image is stored as JPEG. SVG (mock) stays SVG
// unless this ffmpeg build can rasterise it. Falls back to the original bytes if conversion fails.
async function toJpeg(bytes, mime, quality = 3) {
  if (mime === "image/jpeg") return { bytes, mime, ext: "jpg" };
  const inp = tmpPath(mime === "image/svg+xml" ? "svg" : mime === "image/webp" ? "webp" : "png"), out = tmpPath("jpg");
  try { await writeFile(inp, bytes); await exec("ffmpeg", ["-y", "-i", inp, "-vf", "format=yuv420p", "-q:v", String(quality), out], { timeoutMs: 60000 }); return { bytes: await readFile(out), mime: "image/jpeg", ext: "jpg" }; }
  catch (e) { warn(`jpeg conversion skipped: ${e.message.slice(0, 120)}`); return { bytes, mime, ext: mime === "image/svg+xml" ? "svg" : mime === "image/webp" ? "webp" : "png" }; }
  finally { await cleanup(inp, out); }
}
async function storeImage(bytes, mime, contentItemId, meta = {}, dims = {}, compose = null) {
  let j = await toJpeg(bytes, mime);
  if (compose?.headline && compose.specs?.render_text !== true && compose.specs?.overlay !== false && j.mime === "image/jpeg") {
    const inp = tmpPath("jpg"); await writeFile(inp, j.bytes);
    try { const out = await composeHeadline(inp, compose.headline, compose.specs); j = { bytes: await readFile(out), mime: "image/jpeg", ext: "jpg" }; meta = { ...meta, overlay: true }; await cleanup(out); }
    catch (e) { warn(`headline overlay skipped: ${e.message.slice(0, 160)}`); }
    finally { await cleanup(inp); }
  }
  const url = await storeFile(`images/${newId()}.${j.ext}`, j.bytes, j.mime);
  return recordMedia({ contentItemId, kind: "IMAGE", url, mime: j.mime, width: dims.width || null, height: dims.height || null, meta: { ...meta, source_mime: mime } });
}
impl("IMAGE", "image_mock", { label: "Mock image (SVG card)", create: () => ({
  async generate({ headline, specs = {}, contentItemId }) {
    return storeImage(Buffer.from(svgCard(headline, specs)), "image/svg+xml", contentItemId, { mock: true }, { width: specs.width || 1080, height: specs.height || 1080 });
  } }) });
impl("IMAGE", "gemini_image", { label: "Gemini image generation", configSchema: { model: { type: "string", default: DEFAULTS.GEMINI_IMAGE_MODEL } }, create: (cfg, ctx = {}) => ({
  async generate({ prompt, headline, specs = {}, contentItemId }) {
    const model = cfg.model || DEFAULTS.GEMINI_IMAGE_MODEL;
    const ar = specs.aspect_ratio || (specs.height > specs.width ? "9:16" : specs.width > specs.height ? "16:9" : "1:1");
    const full = `${prompt || headline}. ${specs.style || "Photorealistic editorial news image, dramatic lighting, no watermarks."} ${specs.render_text === true ? `Render this headline as bold, legible overlay text: "${headline}".` : "Do not render any text, letters, captions or logos anywhere in the image; leave the lower third visually calm."} Aspect ratio ${ar}.`;
    return withKey("gemini", async (key) => {
      const body = await retryTransient(() => fetchJson(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { method: "POST", headers: { "x-goog-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: full }] }], generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: ar } } }) }));
      const part = (body.candidates?.[0]?.content?.parts || []).find((p) => p.inlineData || p.inline_data);
      if (!part) throw new Error("Gemini returned no image (blocked by safety, or wrong model id?)");
      const d = part.inlineData || part.inline_data; const mime = d.mimeType || d.mime_type || "image/png";
      const media = await storeImage(Buffer.from(d.data, "base64"), mime, contentItemId, { model, prompt: full }, {}, { headline, specs });
      return { ...media, cost: IMAGE_PRICE_USD, units: 1 };
    }, ctx.pin);
  } }) });

impl("IMAGE", "openai_image", { label: "OpenAI image generation", configSchema: { model: { type: "string", default: DEFAULTS.OPENAI_IMAGE_MODEL }, quality: { type: "string", default: "medium" } }, create: (cfg, ctx = {}) => ({
  async generate({ prompt, headline, specs = {}, contentItemId }) {
    const model = cfg.model || DEFAULTS.OPENAI_IMAGE_MODEL;
    const size = specs.height > specs.width ? "1024x1536" : specs.width > specs.height ? "1536x1024" : "1024x1024";
    const full = `${prompt || headline}. ${specs.style || "Photorealistic editorial news image, dramatic lighting, no watermarks."} ${specs.render_text === true ? `Render this headline as bold, legible overlay text: "${headline}".` : "Do not render any text, letters, captions or logos anywhere in the image; leave the lower third visually calm."}`;
    return withKey("openai", async (key) => {
      const body = await fetchJson("https://api.openai.com/v1/images/generations", { method: "POST", headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ model, prompt: full, size, quality: cfg.quality || "medium", n: 1 }) });
      const b64 = body.data?.[0]?.b64_json; if (!b64) throw new Error("OpenAI returned no image");
      const media = await storeImage(Buffer.from(b64, "base64"), "image/png", contentItemId, { model, prompt: full }, {}, { headline, specs });
      return { ...media, cost: Number(ENV.OPENAI_IMAGE_PRICE_USD ?? 0.04), units: 1 };
    }, ctx.pin);
  } }) });

// ---- 6h. Voice (stage VOICE). synthesize({script, voiceId, contentItemId}) -> media row (AUDIO, duration)
impl("VOICE", "tts_mock", { label: "Mock TTS (silent track)", create: () => ({
  async synthesize({ script, contentItemId }) {
    const dur = Math.max(2, script.split(/\s+/).filter(Boolean).length / 2.5);
    try { const f = tmpPath("mp3"); await exec("ffmpeg", ["-y", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", dur.toFixed(2), "-q:a", "9", f]); const url = await storeLocal(f, `audio/${newId()}.mp3`, "audio/mpeg"); await cleanup(f); return recordMedia({ contentItemId, kind: "AUDIO", url, mime: "audio/mpeg", duration: dur, meta: { mock: true } }); }
    catch { return { id: null, kind: "AUDIO", url: `mock://audio/${newId()}.mp3`, duration_seconds: dur, mock: true }; }
  } }) });
impl("VOICE", "elevenlabs", { label: "ElevenLabs", configSchema: { voice_id: { type: "string", default: DEFAULTS.ELEVENLABS_VOICE }, model: { type: "string", default: DEFAULTS.ELEVENLABS_MODEL } }, create: (cfg, ctx = {}) => ({
  async synthesize({ script, voiceId, contentItemId }) {
    const voice = voiceId || cfg.voice_id || DEFAULTS.ELEVENLABS_VOICE;
    return withKey("elevenlabs", async (key) => {
      const bytes = await fetchBytes(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`, { method: "POST", headers: { "xi-api-key": key, "content-type": "application/json" }, body: JSON.stringify({ text: script, model_id: cfg.model || DEFAULTS.ELEVENLABS_MODEL }) });
      const f = tmpPath("mp3"); await writeFile(f, bytes); const dur = await ffprobeDuration(f);
      const url = await storeLocal(f, `audio/${newId()}.mp3`, "audio/mpeg"); await cleanup(f);
      const media = await recordMedia({ contentItemId, kind: "AUDIO", url, mime: "audio/mpeg", duration: dur || script.length / 15, meta: { voice, chars: script.length } });
      return { ...media, units: script.length, cost: script.length * Number(ENV.ELEVENLABS_USD_PER_CHAR || 0.0002) };
    }, ctx.pin);
  } }) });

impl("VOICE", "openai_tts", { label: "OpenAI TTS", configSchema: { voice: { type: "string", default: DEFAULTS.OPENAI_TTS_VOICE }, model: { type: "string", default: DEFAULTS.OPENAI_TTS_MODEL }, instructions: { type: "string" } }, create: (cfg, ctx = {}) => ({
  async synthesize({ script, voiceId, contentItemId }) {
    const voice = voiceId || cfg.voice || DEFAULTS.OPENAI_TTS_VOICE, model = cfg.model || DEFAULTS.OPENAI_TTS_MODEL;
    return withKey("openai", async (key) => {
      // The endpoint caps input at 4096 chars. Long scripts (LONG_FORM_VIDEO) are split at sentence ends and joined.
      const parts = []; let cur = "";
      for (const s of script.split(/(?<=[.!?।])\s+/)) { if ((cur + " " + s).length > 3800 && cur) { parts.push(cur.trim()); cur = s; } else cur += " " + s; } if (cur.trim()) parts.push(cur.trim());
      const files = [];
      for (const p of parts) {
        const bytes = await fetchBytes("https://api.openai.com/v1/audio/speech", { method: "POST", headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ model, voice, input: p.slice(0, 4096), response_format: "mp3", instructions: cfg.instructions || undefined }) });
        const pf = tmpPath("mp3"); await writeFile(pf, bytes); files.push(pf);
      }
      let f = files[0];
      if (files.length > 1) { const list = tmpPath("txt"); await writeFile(list, files.map((x) => `file '${x}'`).join("\n")); f = tmpPath("mp3"); await exec("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", f]); await cleanup(list, ...files); }
      const dur = await ffprobeDuration(f);
      const url = await storeLocal(f, `audio/${newId()}.mp3`, "audio/mpeg"); await cleanup(f);
      const media = await recordMedia({ contentItemId, kind: "AUDIO", url, mime: "audio/mpeg", duration: dur || script.length / 15, meta: { voice, model, chars: script.length } });
      return { ...media, units: script.length, cost: script.length * Number(ENV.OPENAI_TTS_USD_PER_CHAR || 0.000015) };
    }, ctx.pin);
  } }) });

// ---- 6i. Embeddings (stage EMBED). embed(text) -> number[] | null
impl("EMBED", "embed_mock", { label: "None", create: () => ({ async embed() { return null; } }) });
impl("EMBED", "gemini_embed", { label: "Gemini embeddings", configSchema: { model: { type: "string", default: DEFAULTS.GEMINI_EMBED_MODEL } }, create: (cfg, ctx = {}) => ({
  async embed(text) {
    const model = cfg.model || DEFAULTS.GEMINI_EMBED_MODEL;
    const r = await withKey("gemini", async (key) => { const b = await retryTransient(() => fetchJson(`https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent`, { method: "POST", headers: { "x-goog-api-key": key, "content-type": "application/json" }, body: JSON.stringify({ content: { parts: [{ text: text.slice(0, 8000) }] } }) })); return { v: b.embedding?.values || null, units: 1, cost: 0 }; }, ctx.pin);
    return r.v;
  } }) });

// ---- 6j. Render (stage RENDER). ffmpeg helpers + renderForChannel({item, media, channel, niche}) -> {url, kind}
const srtTime = (s) => { const ms = Math.round(s * 1000); const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, sec = Math.floor(ms / 1000) % 60; return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`; };
async function writeSrt(segments, start, end) {
  const inRange = segments.filter((s) => s.end > start && s.start < end);
  const body = inRange.map((s, i) => `${i + 1}\n${srtTime(Math.max(0, s.start - start))} --> ${srtTime(Math.min(end, s.end) - start)}\n${s.text.replace(/\n/g, " ")}\n`).join("\n");
  const f = tmpPath("srt"); await writeFile(f, body || "1\n00:00:00,000 --> 00:00:01,000\n \n"); return f;
}
const VF_VERTICAL = "crop=min(iw\\,ih*9/16):ih,scale=1080:1920";
const VF_LANDSCAPE = "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black";
const captionsVf = (srt, marginV = 190) => `subtitles=${srt.replace(/\\/g, "/").replace(/:/g, "\\:")}:force_style='FontName=${OVERLAY_FONT},FontSize=17,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=2,Alignment=2,MarginV=${marginV}'`;
const X264 = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart"];
async function cutClip(input, start, end, { vertical = true, srt = null, hook = null } = {}) {
  const vf = [vertical ? VF_VERTICAL : VF_LANDSCAPE];
  if (hook) vf.push(`drawtext=text='${hook.replace(/[':\\]/g, " ").slice(0, 60)}':fontsize=54:fontcolor=white:borderw=3:bordercolor=black:x=(w-text_w)/2:y=${vertical ? 260 : 60}:enable='lt(t,4)'`);
  if (srt) vf.push(captionsVf(srt, vertical ? 190 : 40));
  const out = tmpPath("mp4");
  await exec("ffmpeg", ["-y", "-ss", String(start), "-t", String(Math.max(1, end - start)), "-i", input, "-vf", vf.join(","), ...X264, out]);
  return out;
}
async function publishRender(file, contentItemId, meta = {}) {
  const dur = await ffprobeDuration(file);
  const url = await storeLocal(file, `video/${newId()}.mp4`, "video/mp4"); await cleanup(file);
  return recordMedia({ contentItemId, kind: "VIDEO", url, mime: "video/mp4", duration: dur, meta });
}
impl("RENDER", "render_mock", { label: "Mock renderer", create: () => ({
  async renderForChannel({ media }) { return media ? { url: media.url, kind: media.kind } : { url: null, kind: "TEXT" }; },
  async renderClip({ clip, contentItemId }) { return recordMedia({ contentItemId, kind: "VIDEO", url: `mock://render/${newId()}.mp4`, mime: "video/mp4", duration: clip.end - clip.start, meta: { mock: true } }); },
  async renderSlideshow({ contentItemId, audio }) { return recordMedia({ contentItemId, kind: "VIDEO", url: `mock://render/${newId()}.mp4`, mime: "video/mp4", duration: audio?.duration_seconds || 30, meta: { mock: true } }); },
}) });
impl("RENDER", "ffmpeg", { label: "ffmpeg", create: () => ({
  // Per-channel conversion at publish time: vertical for short-form, otherwise passthrough.
  async renderForChannel({ media, channel, item }) {
    // No hero media = a text-only post (LONG_POST with cover_image:false). Publishers post the caption alone.
    if (!media) return { url: null, kind: "TEXT" };
    if (media.kind !== "VIDEO" || channel.format !== "SHORT_FORM_VOICEOVER") return { url: media.url, kind: media.kind };
    const meta = P(media.meta) || {}; if (meta.orientation === "9:16") return { url: media.url, kind: "VIDEO" };
    const src = await toTmpFile(media.url, "mp4"); const out = tmpPath("mp4");
    await exec("ffmpeg", ["-y", "-i", src, "-vf", VF_VERTICAL, ...X264, out]); await cleanup(src);
    const url = await storeLocal(out, `video/${newId()}.mp4`, "video/mp4"); await cleanup(out);
    await recordMedia({ contentItemId: item.id, kind: "VIDEO", url, mime: "video/mp4", meta: { orientation: "9:16", derived_from: media.id } });
    return { url, kind: "VIDEO" };
  },
  async renderClip({ clip, sourcePath, transcript, niche, contentItemId, extras = {} }) {
    const c = methodCfg(niche); const vertical = c.orientation !== "16:9";
    const srt = c.captions === false ? null : await writeSrt(transcript.segments, clip.start, clip.end);
    let file;
    switch (niche.production_method || "PODCAST_HIGHLIGHT") {
      case "REACTION_OVERLAY": {
        const main = await cutClip(sourcePath, clip.start, clip.end, { vertical: false, srt });
        const ovUrl = c.overlay_video_url; if (!ovUrl) throw new Error("REACTION_OVERLAY needs method_config.overlay_video_url (your own reaction clip)");
        const ov = await toTmpFile(ovUrl, "mp4"); file = tmpPath("mp4");
        const box = "scale=1080:960:force_original_aspect_ratio=decrease,pad=1080:960:(ow-iw)/2:(oh-ih)/2:color=black";
        const fc = `[0:v]${box}[m];[1:v]${box}[o];[m][o]vstack=inputs=2[v]`;
        try { await exec("ffmpeg", ["-y", "-i", main, "-stream_loop", "-1", "-i", ov, "-filter_complex", `${fc};[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=2[a]`, "-map", "[v]", "-map", "[a]", "-t", String(clip.end - clip.start), ...X264, file]); }
        catch { await exec("ffmpeg", ["-y", "-i", main, "-stream_loop", "-1", "-i", ov, "-filter_complex", fc, "-map", "[v]", "-map", "0:a", "-t", String(clip.end - clip.start), ...X264, file]); }
        await cleanup(main, ov); break;
      }
      case "VOICEOVER": {
        const main = await cutClip(sourcePath, clip.start, clip.end, { vertical, srt: null, hook: clip.hook });
        if (!extras.audio?.url) throw new Error("VOICEOVER render needs extras.audio");
        const a = await toTmpFile(extras.audio.url, "mp3"); file = tmpPath("mp4");
        await exec("ffmpeg", ["-y", "-i", main, "-i", a, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-shortest", file]); await cleanup(main, a); break;
      }
      case "MOVIE_RECAP": {
        // extras.scenes = [{start,end}], extras.audio = narration. Concat scenes, put narration on top.
        const scenes = extras.scenes?.length ? extras.scenes : [{ start: clip.start, end: clip.end }];
        const a = await toTmpFile(extras.audio.url, "mp3"); file = tmpPath("mp4");
        const trims = scenes.map((s, i) => `[0:v]trim=start=${s.start}:end=${s.end},setpts=PTS-STARTPTS[v${i}]`).join(";");
        const fc = `${trims};${scenes.map((_, i) => `[v${i}]`).join("")}concat=n=${scenes.length}:v=1:a=0,${vertical ? VF_VERTICAL : VF_LANDSCAPE}[v]`;
        await exec("ffmpeg", ["-y", "-i", sourcePath, "-i", a, "-filter_complex", fc, "-map", "[v]", "-map", "1:a", "-shortest", ...X264, file]); await cleanup(a); break;
      }
      default: file = await cutClip(sourcePath, clip.start, clip.end, { vertical, srt, hook: clip.hook });
    }
    await cleanup(srt);
    return publishRender(file, contentItemId, { method: niche.production_method, orientation: vertical ? "9:16" : "16:9", clip });
  },
  async renderSlideshow({ images, audio, contentItemId, orientation = "9:16", captions = [] }) {
    if (!images.length) throw new Error("slideshow needs at least one image");
    const a = await toTmpFile(audio.url, "mp3"); const dur = (await ffprobeDuration(a)) || audio.duration_seconds || images.length * 4;
    const per = dur / images.length; const files = [];
    for (const im of images) files.push(await toTmpFile(im.url));
    const list = tmpPath("txt"); await writeFile(list, files.map((f) => `file '${f}'\nduration ${per.toFixed(3)}`).join("\n") + `\nfile '${files.at(-1)}'\n`);
    const [w, h] = orientation === "16:9" ? [1920, 1080] : [1080, 1920];
    const vf = [`scale=${w}:${h}:force_original_aspect_ratio=increase`, `crop=${w}:${h}`, `zoompan=z='min(zoom+0.0008,1.12)':d=${Math.round(per * 30)}:s=${w}x${h}:fps=30`, "format=yuv420p"];
    let srt = null; if (captions.length) { srt = await writeSrt(captions, 0, dur); vf.push(captionsVf(srt, orientation === "16:9" ? 40 : 190)); }
    const out = tmpPath("mp4");
    await exec("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", list, "-i", a, "-vf", vf.join(","), "-r", "30", "-t", String(dur), ...X264, out]);
    await cleanup(list, a, srt, ...files);
    return publishRender(out, contentItemId, { method: "SLIDESHOW", orientation, slides: images.length });
  },
}) });

// ---- 6k. Publish (stage PUBLISH). publish({channel, mediaUrl, mediaKind, caption, title, hashtags}) -> {publishedUrl, externalId}
const PLATFORM_DEFAULT_PUBLISHER = { FACEBOOK: "meta_graph", INSTAGRAM: "meta_graph", YOUTUBE: "youtube_upload" };
impl("PUBLISH", "publish_mock", { label: "Mock", create: () => ({ async publish({ channel }) { const id = newId(); return { publishedUrl: `mock://published/${channel.platform.toLowerCase()}/${id}`, externalId: id }; },
  async metrics() { return { views: Math.floor(Math.random() * 2000), likes: 10, comments: 2 }; } }) });
// Channel secrets: channels.credential_id points at an api_credentials row (provider "meta" or "youtube_oauth") whose
// value lives in the vault or in a named env var. Legacy platform_config.*_env names still work as a fallback.
async function channelCredential(channel, provider) {
  const pc = P(channel.platform_config) || {};
  const id = channel.credential_id || pc.credential_id; if (!id) return null;
  const c = await credentialById(id); if (!c) throw new Error(`Channel "${channel.display_name}" points at credential ${id} but it has no usable secret (missing on Render, or SECRETS_KEY changed)`);
  if (c.provider !== provider) throw new Error(`Channel "${channel.display_name}" credential is for "${c.provider}", but this publisher needs "${provider}"`);
  return c.secret;
}
async function metaToken(channel, cfg) {
  const fromVault = await channelCredential(channel, "meta"); if (fromVault) return fromVault;
  const pc = P(channel.platform_config) || {}; const envName = pc.token_env || cfg.token_env || "META_ACCESS_TOKEN"; const t = ENV[envName];
  if (!t) throw new Error(`No Meta access token for this channel: pick a "meta" credential on the channel (API keys page → add one), or set ${envName} on Render`); return t;
}
impl("PUBLISH", "meta_graph", { label: "Facebook Page / Instagram", configSchema: { token_env: { type: "string", default: "META_ACCESS_TOKEN" }, api_version: { type: "string", default: DEFAULTS.META_API_VERSION } }, create: (cfg, ctx = {}) => {
  const base = `https://graph.facebook.com/${cfg.api_version || DEFAULTS.META_API_VERSION}`;
  const post = (path, body) => fetchJson(`${base}/${path}`, { method: "POST", body: form(body) });
  return {
    async publish({ channel, mediaUrl, mediaKind, caption, title }) {
      const token = await metaToken(channel, cfg); const acct = channel.platform_account_id; if (!acct) throw new Error("channel.platform_account_id (Page ID / IG user ID) is required");
      if (mediaUrl?.startsWith("mock://")) throw new Error("Cannot publish a mock:// media URL to a real platform — switch the program's image/render adapter to a live one");
      if (channel.platform === "FACEBOOK") {
        if (mediaKind === "VIDEO") { const r = await post(`${acct}/videos`, { file_url: mediaUrl, description: caption, title, access_token: token }); return { externalId: r.id, publishedUrl: `https://www.facebook.com/${r.id}` }; }
        if (mediaKind === "IMAGE") { const r = await post(`${acct}/photos`, { url: mediaUrl, message: caption, access_token: token }); return { externalId: r.post_id || r.id, publishedUrl: `https://www.facebook.com/${r.post_id || r.id}` }; }
        const r = await post(`${acct}/feed`, { message: caption, access_token: token }); return { externalId: r.id, publishedUrl: `https://www.facebook.com/${r.id}` };
      }
      if (channel.platform === "INSTAGRAM") {
        if (mediaKind !== "IMAGE" && mediaKind !== "VIDEO") throw new Error("Instagram cannot publish a text-only post — give this program a cover image or unlink the Instagram channel");
        const isVideo = mediaKind === "VIDEO";
        const c = await post(`${acct}/media`, isVideo ? { video_url: mediaUrl, media_type: "REELS", caption, access_token: token } : { image_url: mediaUrl, caption, access_token: token });
        for (let i = 0; i < 40; i++) { const s = await fetchJson(`${base}/${c.id}?${form({ fields: "status_code,status", access_token: token })}`); if (s.status_code === "FINISHED") break; if (s.status_code === "ERROR") throw new Error(`IG container error: ${s.status}`); if (!isVideo && i > 2) break; await sleep(5000); }
        const p = await post(`${acct}/media_publish`, { creation_id: c.id, access_token: token });
        const info = await fetchJson(`${base}/${p.id}?${form({ fields: "permalink", access_token: token })}`).catch(() => ({}));
        return { externalId: p.id, publishedUrl: info.permalink || `https://www.instagram.com/p/${p.id}` };
      }
      throw new Error(`meta_graph cannot publish to ${channel.platform}`);
    },
    async metrics({ channel, asset }) {
      const token = await metaToken(channel, cfg);
      if (channel.platform === "INSTAGRAM") { const r = await fetchJson(`${base}/${asset.external_id}?${form({ fields: "like_count,comments_count", access_token: token })}`); return { views: 0, likes: r.like_count, comments: r.comments_count }; }
      const r = await fetchJson(`${base}/${asset.external_id}?${form({ fields: "likes.summary(true),comments.summary(true),shares", access_token: token })}`);
      return { views: 0, likes: r.likes?.summary?.total_count, comments: r.comments?.summary?.total_count, shares: r.shares?.count };
    },
  }; } });
async function youtubeAccessToken(channel, cfg) {
  const pc = P(channel.platform_config) || {};
  const v = await channelCredential(channel, "youtube_oauth");
  const id = v?.client_id || ENV[pc.client_id_env || cfg.client_id_env || "YOUTUBE_CLIENT_ID"], secret = v?.client_secret || ENV[pc.client_secret_env || cfg.client_secret_env || "YOUTUBE_CLIENT_SECRET"], refresh = v?.refresh_token || ENV[pc.refresh_token_env || cfg.refresh_token_env || "YOUTUBE_REFRESH_TOKEN"];
  if (!id || !secret || !refresh) throw new Error('No YouTube OAuth for this channel: pick a "youtube_oauth" credential on the channel (API keys page → add one with client id, secret, refresh token), or set YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET / YOUTUBE_REFRESH_TOKEN on Render');
  const t = await fetchJson("https://oauth2.googleapis.com/token", { method: "POST", body: form({ client_id: id, client_secret: secret, refresh_token: refresh, grant_type: "refresh_token" }) });
  return t.access_token;
}
impl("PUBLISH", "youtube_upload", { label: "YouTube upload", configSchema: { privacy: { type: "string", default: "public" }, category_id: { type: "string", default: "22" } }, create: (cfg, ctx = {}) => ({
  async publish({ channel, mediaUrl, mediaKind, caption, title, hashtags = [] }) {
    if (mediaKind !== "VIDEO") throw new Error(`YouTube channel needs a VIDEO asset (got ${mediaKind})`);
    const token = await youtubeAccessToken(channel, cfg); const pc = P(channel.platform_config) || {};
    const file = await toTmpFile(mediaUrl, "mp4"); const bytes = await readFile(file); await cleanup(file);
    const isShort = channel.format === "SHORT_FORM_VOICEOVER";
    const meta = { snippet: { title: (isShort && !/#shorts/i.test(title) ? `${title} #Shorts` : title).slice(0, 100), description: caption?.slice(0, 4900) || "", tags: hashtags.map((h) => h.replace(/^#/, "")).slice(0, 20), categoryId: pc.category_id || cfg.category_id || "22" }, status: { privacyStatus: pc.privacy || cfg.privacy || "public", selfDeclaredMadeForKids: false } };
    const start = await fetch("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Upload-Content-Type": "video/mp4", "X-Upload-Content-Length": String(bytes.length) }, body: JSON.stringify(meta) });
    const loc = start.headers.get("location"); if (!loc) throw new ApiError(start.status, await start.text(), "YouTube resumable start failed");
    const r = await fetchJson(loc, { method: "PUT", headers: { "Content-Type": "video/mp4", "Content-Length": String(bytes.length) }, body: bytes });
    return { externalId: r.id, publishedUrl: `https://www.youtube.com/${isShort ? "shorts" : "watch?v="}${r.id}` };
  },
  async metrics({ asset }) {
    return withKey("youtube", async (key) => { const r = await fetchJson(`https://www.googleapis.com/youtube/v3/videos?${form({ part: "statistics", id: asset.external_id, key })}`); const s = r.items?.[0]?.statistics || {}; return { views: Number(s.viewCount || 0), likes: Number(s.likeCount || 0), comments: Number(s.commentCount || 0), units: 1 }; }, ctx.pin);
  } }) });

// === 7. dedup / router / scheduler / review helpers ===================
const tokenize = (t) => new Set(String(t).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 2));
function jaccard(a, b) { const A = tokenize(a), B = tokenize(b); if (!A.size || !B.size) return 0; let n = 0; for (const t of A) if (B.has(t)) n++; return n / (A.size + B.size - n); }
function cosine(a, b) { let d = 0, x = 0, y = 0; for (let i = 0; i < Math.min(a.length, b.length); i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return x && y ? d / Math.sqrt(x * y) : 0; }
async function checkDuplicate(text, niche, seriesId = null, excludeId = null) {
  // excludeId: the item being generated already has its topic set at routing time — never compare it with itself.
  // QUEUED siblings are skipped too: routed items carry their title as topic before they are drafted, so a near-duplicate
  // still waiting in the queue must not make the first one fail (the loser is caught when its own turn comes).
  const past = await q(`SELECT id, topic, topic_embedding FROM content_items WHERE niche_id = $1 ${seriesId ? "AND series_id = $2" : ""} AND status NOT IN ('FAILED','REJECTED','QUEUED') AND topic <> '' AND id <> $${seriesId ? 3 : 2} ORDER BY created_at DESC LIMIT 300`, seriesId ? [niche.id, seriesId, excludeId || ""] : [niche.id, excludeId || ""]);
  let vec = null;
  try { vec = await (await resolve("EMBED", niche.embed_adapter || "embed_mock")).embed(text); } catch (e) { warn("embedding failed, using Jaccard:", e.message); }
  let best = null;
  for (const p of past) {
    const pv = vec ? P(p.topic_embedding) : null;
    const score = pv && Array.isArray(pv) ? cosine(vec, pv) : jaccard(text, p.topic);
    if (!best || score > best.score) best = { topic: p.topic, score, id: p.id };
  }
  return { isDuplicate: !!best && best.score >= Number(niche.dedup_threshold || 0.82), best, embedding: vec };
}
function passesFilters(item, niche) {
  const f = P(niche.topic_filters) || {}; const hay = `${item.title} ${item.summary || ""}`.toLowerCase();
  if (f.exclude?.length && f.exclude.some((k) => hay.includes(String(k).toLowerCase()))) return false;
  if (f.include?.length && !f.include.some((k) => hay.includes(String(k).toLowerCase()))) return false;
  if (f.max_age_hours && item.published_at && Date.now() - Date.parse(item.published_at) > f.max_age_hours * 3600e3) return false;
  return true;
}
async function underDailyCap(niche) {
  if (!niche.max_items_per_day) return true;
  const r = await one(`SELECT COUNT(*)::int AS n FROM content_items WHERE niche_id = $1 AND created_at >= CURRENT_DATE AND status <> 'FAILED'`, [niche.id]);
  return r.n < niche.max_items_per_day;
}
const VIDEO_TYPES = new Set(["PODCAST_CLIP", "REACTION_CLIP", "VOICEOVER_CLIP", "MOVIE_RECAP"]);
const queueFor = (contentType) => VIDEO_TYPES.has(contentType) || contentType === "IMAGE_SLIDESHOW" || contentType === "LONG_FORM_VIDEO" ? "video" : "text";
function scoreCandidate(item, niche) {
  const c = methodCfg(niche); let s = 0.35; const reasons = [];
  if (item.views) { const v = Math.min(1, Math.log10(item.views + 1) / 6.5); s += 0.3 * v; reasons.push(`views ${item.views}`); }
  if (item.published_at) { const age = (Date.now() - Date.parse(item.published_at)) / 3600e3; if (age < 48) { s += 0.15; reasons.push("fresh"); } }
  if (item.duration) { if (item.duration < 60) { s -= 0.3; reasons.push("too short"); } else if (item.duration > (c.max_source_minutes || 240) * 60) { s -= 0.2; reasons.push("very long"); } else { s += 0.1; } }
  const f = P(niche.topic_filters) || {}; const hay = `${item.title} ${item.summary || ""}`.toLowerCase();
  if (f.include?.length && f.include.some((k) => hay.includes(String(k).toLowerCase()))) { s += 0.2; reasons.push("keyword match"); }
  return { score: Number(clamp(s, 0, 1).toFixed(3)), reason: reasons.join(", ") || "baseline" };
}
// Route one source_item to every program subscribed to its source.
async function routeSourceItem(item) {
  const niches = await q(`SELECT n.*, s.license_policy FROM niches n JOIN niche_sources ns ON ns.niche_id = n.id JOIN sources s ON s.id = ns.source_id WHERE ns.source_id = $1 AND n.is_active::int = 1 ORDER BY n.priority DESC`, [item.source_id]);
  let routed = 0;
  for (const niche of niches) {
    if (!passesFilters(item, niche)) continue;
    if (item.kind === "VIDEO") {
      if (!VIDEO_TYPES.has(niche.content_type)) continue;
      if (niche.license_policy === "CC_ONLY" && !/^CC/.test(item.license || "")) continue;
      const { score, reason } = scoreCandidate(item, niche);
      const cid = newId();
      await q(`INSERT INTO video_candidates (id, source_id, source_item_id, niche_id, platform, external_id, source_url, title, duration_seconds, view_count, published_at, thumbnail_url, license, score, score_reason, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [cid, item.source_id, item.id, niche.id, item.platform || null, item.external_id, item.url, item.title, item.duration || null, item.views || null, item.published_at, item.thumbnail || null, item.license || "UNKNOWN", score, reason, "NEW"]);
      const f = P(niche.topic_filters) || {};
      if (score >= (f.min_score ?? methodCfg(niche).min_score) && await underDailyCap(niche)) { await q(`UPDATE video_candidates SET status='QUEUED' WHERE id=$1`, [cid]); await enqueue("PROCESS_CANDIDATE", { candidateId: cid }, { queue: "video", priority: niche.priority, dedupeKey: `cand:${cid}` }); }
      routed++;
    } else {
      if (VIDEO_TYPES.has(niche.content_type)) continue;
      if (!(await underDailyCap(niche))) continue;
      const itemId = await createQueuedItem(niche, { sourceItemId: item.id, topic: item.title, sourceDataRef: { provider: "source_item", url: item.url, title: item.title, summary: item.summary, published_at: item.published_at, thumbnail: item.thumbnail } });
      await enqueue("GENERATE_CONTENT", { itemId }, { queue: queueFor(niche.content_type), priority: niche.priority, contentItemId: itemId });
      routed++;
    }
  }
  await q(`UPDATE source_items SET status = $2 WHERE id = $1`, [item.id, routed ? "ROUTED" : "IGNORED"]);
  return routed;
}
// Posting scheduler: earliest time satisfying windows, min gap and max posts/day.
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function tzParts(ms, tz) {
  try { const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz || "UTC", hour12: false, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return { dow: DOW.indexOf(p.weekday), minutes: (Number(p.hour) % 24) * 60 + Number(p.minute), day: `${p.year}-${p.month}-${p.day}` }; }
  catch { const d = new Date(ms); return { dow: d.getUTCDay(), minutes: d.getUTCHours() * 60 + d.getUTCMinutes(), day: d.toISOString().slice(0, 10) }; }
}
const toMin = (s) => { const [h, m] = String(s || "0:0").split(":").map(Number); return (h || 0) * 60 + (m || 0); };
async function nextSlot(channel, notBefore = Date.now()) {
  const windows = P(channel.posting_windows) || []; const gap = (channel.min_gap_minutes || 0) * 60000; const max = channel.max_posts_per_day || 0;
  const rows = await q(`SELECT COALESCE(published_at, scheduled_for, created_at) AS t FROM content_assets WHERE channel_id = $1 AND status IN ('PENDING','RENDERING','RENDERED','PUBLISHING','PUBLISHED') AND COALESCE(published_at, scheduled_for, created_at) > now() - interval '3 days'`, [channel.id]);
  const taken = rows.map((r) => new Date(r.t).getTime()); if (channel.last_published_at) taken.push(new Date(channel.last_published_at).getTime());
  let t = notBefore;
  for (let i = 0; i < 7 * 24 * 12; i++, t += 5 * 60000) {
    if (gap && taken.some((x) => Math.abs(x - t) < gap)) continue;
    const p = tzParts(t, channel.timezone);
    if (windows.length && !windows.some((w) => (!w.days?.length || w.days.includes(p.dow)) && p.minutes >= toMin(w.start || "00:00") && p.minutes <= toMin(w.end || "23:59"))) continue;
    if (max && taken.filter((x) => tzParts(x, channel.timezone).day === p.day).length >= max) continue;
    return new Date(t);
  }
  return new Date(t);
}
async function rollupItemStatus(itemId) {
  const assets = await q(`SELECT status FROM content_assets WHERE content_item_id = $1`, [itemId]);
  const item = await one(`SELECT portal_article_id, status FROM content_items WHERE id = $1`, [itemId]);
  if (!assets.length) { if (item?.portal_article_id && item.status !== "PUBLISHED") await q(`UPDATE content_items SET status='PUBLISHED' WHERE id=$1`, [itemId]); return; }
  const n = (s) => assets.filter((a) => a.status === s).length;
  const status = n("PUBLISHED") === assets.length ? "PUBLISHED" : n("FAILED") === assets.length ? "FAILED" : n("PUBLISHED") && n("FAILED") + n("PUBLISHED") === assets.length ? "PARTIALLY_PUBLISHED" : n("PUBLISHED") ? "PARTIALLY_PUBLISHED" : "READY_TO_PUBLISH";
  await q(`UPDATE content_items SET status = $2 WHERE id = $1`, [itemId, status]);
}
function renderCaption(item, channel, portalUrl) {
  const caps = P(item.captions) || {}; const tags = (P(item.hashtags) || []).map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ");
  const base = caps[channel.platform.toLowerCase()] || caps.default || item.summary || item.body || item.headline || item.topic || "";
  const tpl = channel.caption_template || "{caption}\n\n{url}\n\n{hashtags}";
  return tpl.replace("{caption}", base).replace("{headline}", item.headline || item.topic || "").replace("{url}", portalUrl || "").replace("{hashtags}", tags).replace(/\n{3,}/g, "\n\n").trim();
}
async function ensurePortalArticle(item, niche) {
  if (item.portal_article_id) return one(`SELECT * FROM portal_articles WHERE id = $1`, [item.portal_article_id]);
  const media = item.hero_media_id ? await one(`SELECT url FROM media_assets WHERE id = $1`, [item.hero_media_id]) : null;
  const src = P(item.source_data_ref) || {}; const id = newId(); const slug = `${slugify(item.headline || item.topic)}-${id.slice(0, 6)}`;
  const body = item.body || `<p>${(item.summary || "").replace(/</g, "&lt;")}</p>`;
  await q(`INSERT INTO portal_articles (id, content_item_id, brand_id, slug, title, summary, body_html, hero_image_url, source_url, language, country, status, published_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'PUBLISHED',now())`,
    [id, item.id, niche.brand_id, slug, item.headline || item.topic, item.summary, body, media?.url || null, src.url || null, niche.language || "en", niche.country || null]);
  await q(`UPDATE content_items SET portal_article_id = $2 WHERE id = $1`, [item.id, id]);
  return one(`SELECT * FROM portal_articles WHERE id = $1`, [id]);
}
const portalUrlFor = (article) => article ? `${(ENV.PORTAL_BASE_URL || ENV.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "")}/a/${article.slug}` : null;

// Approve = create per-channel assets, schedule each, publish to the portal immediately.
async function approveItem(itemId, { auto = false, scheduledFor = null } = {}) {
  const item = await one(`SELECT * FROM content_items WHERE id = $1`, [itemId]); if (!item) throw new ApiError(404, null, "Content item not found");
  if (item.status !== "PENDING_REVIEW") throw new ApiError(400, null, `Cannot approve item in status ${item.status}`);
  const niche = await one(`SELECT * FROM niches WHERE id = $1`, [item.niche_id]);
  const channels = await q(`SELECT c.* FROM channels c JOIN channel_niches cn ON cn.channel_id = c.id WHERE cn.niche_id = $1 AND c.is_active::int = 1`, [niche.id]);
  await q(`UPDATE content_items SET status='APPROVED', auto_approved=$2, review_deadline_at=NULL WHERE id=$1`, [itemId, auto ? 1 : 0]);
  let article = null;
  if (flag(niche.publish_to_portal)) { try { article = await ensurePortalArticle(item, niche); } catch (e) { warn("portal article failed", e.message); } }
  if (!channels.length && !article) { await q(`UPDATE content_items SET status='FAILED', rejection_note=$2 WHERE id=$1`, [itemId, "Approved, but no active channel is subscribed to this program and portal publishing is off — nothing to publish to."]); return one(`SELECT * FROM content_items WHERE id=$1`, [itemId]); }
  const purl = portalUrlFor(article);
  for (const ch of channels) {
    const when = scheduledFor ? new Date(scheduledFor) : await nextSlot(ch);
    await q(`INSERT INTO content_assets (id, content_item_id, channel_id, status, caption, media_asset_id, scheduled_for) VALUES ($1,$2,$3,'PENDING',$4,$5,$6) ON CONFLICT (content_item_id, channel_id) DO UPDATE SET status='PENDING', scheduled_for=EXCLUDED.scheduled_for, caption=EXCLUDED.caption, error_message=NULL`,
      [newId(), itemId, ch.id, renderCaption(item, ch, purl), item.hero_media_id, when.toISOString()]);
  }
  if (item.series_id) await q(`UPDATE series SET episode_counter = episode_counter + 1 WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM content_items WHERE id = $2 AND episode_number IS NULL)`, [item.series_id, itemId]);
  await rollupItemStatus(itemId);
  await sweepDueAssets();
  return one(`SELECT * FROM content_items WHERE id = $1`, [itemId]);
}
async function rejectItem(itemId, note) { return one(`UPDATE content_items SET status='REJECTED', rejection_note=$2 WHERE id=$1 RETURNING *`, [itemId, note || "Rejected by reviewer"]); }
async function finishGeneration(itemId, niche) {
  const mode = niche.approval_mode || "MANUAL";
  if (mode === "AUTO") { await q(`UPDATE content_items SET status='PENDING_REVIEW' WHERE id=$1`, [itemId]); return approveItem(itemId, { auto: true }); }
  const deadline = mode === "AUTO_AFTER_WINDOW" ? new Date(Date.now() + (niche.review_window_minutes || 60) * 60000).toISOString() : null;
  return one(`UPDATE content_items SET status='PENDING_REVIEW', review_deadline_at=$2 WHERE id=$1 RETURNING *`, [itemId, deadline]);
}

// === 8. orchestrator ===================================================
async function createQueuedItem(niche, { sourceItemId = null, seriesId = null, topic = "", sourceDataRef = null, contentType = null, candidateId = null, clipId = null, status = "QUEUED" }) {
  const id = newId();
  await q(`INSERT INTO content_items (id, niche_id, series_id, source_item_id, video_candidate_id, clip_id, content_type, status, topic, source_data_ref, niche_profile_version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id, niche.id, seriesId, sourceItemId, candidateId, clipId, contentType || niche.content_type, status, topic, J(sourceDataRef), J({ niche, capturedAt: nowIso() })]);
  return id;
}
async function setItem(id, fields) {
  const keys = Object.keys(fields); const sets = keys.map((k, i) => `${k} = $${i + 2}`);
  await q(`UPDATE content_items SET ${sets.join(", ")} WHERE id = $1`, [id, ...keys.map((k) => (fields[k] !== null && typeof fields[k] === "object" ? JSON.stringify(fields[k]) : fields[k]))]);
}
async function addCost(itemId, usd) { if (usd) await q(`UPDATE content_items SET generation_cost_usd = generation_cost_usd + $2 WHERE id = $1`, [itemId, usd]); }
function styleBlock(style) {
  if (!style) return "";
  return `\nWRITING STYLE "${style.name}": tone: ${style.tone}. Rules: ${style.rules}. ${style.examples ? `Examples of the voice:\n${style.examples}\n` : ""}${(P(style.banned_terms) || []).length ? `Never use these words/phrases: ${(P(style.banned_terms) || []).join(", ")}.` : ""} ${style.cta ? `End with this call to action: ${style.cta}.` : ""} ${(P(style.hashtags) || []).length ? `Always include hashtags: ${(P(style.hashtags) || []).join(" ")}.` : ""}`;
}
const llmFor = async (niche, fn) => withFallbacks("SCRIPT", niche.script_adapter, await fallbacksFor(niche.script_adapter_fallbacks, "llm.default_fallbacks"), fn);
const imageFor = async (niche, fn) => withFallbacks("IMAGE", niche.image_adapter || "image_mock", await fallbacksFor(niche.image_adapter_fallbacks, "image.default_fallbacks"), fn);

// Fetch the source page of an article and keep its main text, so the writer works from the real story instead of
// the one-line RSS summary. Readability-lite: drop scripts/nav/etc, prefer <article>, keep substantial <p> blocks.
// Result is cached in source_items.raw.article_text; failures are non-fatal (the summary is used as before).
const ARTICLE_TEXT_MAX = Number(ENV.ARTICLE_TEXT_MAX_CHARS) || 6000;
function extractArticleText(html) {
  let h = String(html).replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style|noscript|svg|iframe|form|nav|header|footer|aside|figure)\b[\s\S]*?<\/\1>/gi, " ");
  const art = h.match(/<article\b[\s\S]*?<\/article>/i)?.[0] || h.match(/<main\b[\s\S]*?<\/main>/i)?.[0] || h;
  const paras = [...art.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => decodeXml(stripHtml(m[1]))).filter((t) => t.length > 60 && /[.!?।]/.test(t));
  const text = paras.join("\n\n").trim();
  return text.length > 200 ? text.slice(0, ARTICLE_TEXT_MAX) : "";
}
async function articleText(sourceItem) {
  const raw = P(sourceItem.raw) || {};
  if (typeof raw.article_text === "string") return raw.article_text;                       // cached (may be "" = tried, nothing usable)
  if (!(await setting("ingest.fetch_article_text", true)) || !/^https?:/.test(sourceItem.url || "")) return "";
  let text = "";
  try {
    const res = await fetch(sourceItem.url, { redirect: "follow", signal: AbortSignal.timeout(15000), headers: { "user-agent": "Mozilla/5.0 (compatible; ContentEngine/1.0; +article-fetch)", accept: "text/html,*/*" } });
    if (res.ok && /html/i.test(res.headers.get("content-type") || "")) text = extractArticleText((await res.text()).slice(0, 1.5e6));
  } catch (e) { warn(`article fetch ${sourceItem.url}: ${e.message.slice(0, 120)}`); }
  await q(`UPDATE source_items SET raw = COALESCE(raw, '{}'::jsonb) || $2::jsonb WHERE id = $1`, [sourceItem.id, JSON.stringify({ article_text: text })]).catch(() => {});
  return text;
}
// Resolve the raw material for a text item: a routed source_item, or a legacy TOPIC adapter pull.
async function materialFor(item, niche) {
  if (item.source_item_id) { const s = await one(`SELECT * FROM source_items WHERE id = $1`, [item.source_item_id]); const text = s.kind === "ARTICLE" ? await articleText(s) : ""; return { title: s.title, summary: s.summary, text, url: s.url, published_at: s.published_at, thumbnail: s.thumbnail_url, raw: P(s.raw) }; }
  const src = P(item.source_data_ref); if (item.topic && src && src.provider !== "topic_adapter_pending") return { title: item.topic, summary: src.description || src.summary || "", url: src.url || null, raw: src };
  const past = (await q(`SELECT topic FROM content_items WHERE niche_id = $1 AND id <> $2 ORDER BY created_at DESC LIMIT 100`, [niche.id, item.id])).map((r) => r.topic);
  const ts = await resolve("TOPIC", niche.topic_source_adapter || "newsapi_mock");
  let cand = await ts.fetchCandidate({ nicheKey: niche.key, excludeTopics: past });
  for (let i = 0; i < 4; i++) { const d = await checkDuplicate(cand.topic, niche, item.series_id, item.id); if (!d.isDuplicate) break; cand = await ts.fetchCandidate({ nicheKey: niche.key, excludeTopics: [...past, cand.topic] }); }
  return { title: cand.topic, summary: cand.sourceDataRef?.description || "", url: cand.sourceDataRef?.url || null, raw: cand.sourceDataRef };
}

// ---- 8a. NEWS_STATIC / NICHE_STATIC: headline + captions (+ portal article) + branded image
async function generateStatic(item, niche, style) {
  const m = await materialFor(item, niche);
  const dedup = await checkDuplicate(m.title, niche, item.series_id, item.id);
  if (dedup.isDuplicate) throw new Error(`Dedup: too similar to "${dedup.best.topic}" (score ${dedup.best.score.toFixed(2)})`);
  await setItem(item.id, { status: "DRAFTING", topic: m.title, source_data_ref: { ...(m.raw || {}), url: m.url, summary: m.summary }, topic_embedding: J(dedup.embedding) });
  const portal = flag(niche.publish_to_portal); const lang = niche.language || "en";
  const r = await llmFor(niche, (llm) => llm.complete({ json: true, maxTokens: portal ? 4000 : 1500,
    system: `You are the editor of "${niche.display_name}"${niche.country ? ` for ${niche.country}` : ""}. Language: ${lang}. Tone: ${niche.tone || "clear and engaging"}. You never invent facts beyond the provided material${flag(niche.fact_check_strict) ? " and you attribute claims to the source" : ""}.${styleBlock(style)}`,
    prompt: `SOURCE MATERIAL\nTitle: ${m.title}\nSummary: ${m.summary || "(none)"}\nURL: ${m.url || "(none)"}\n${m.text ? `Full text of the source article:\n"""\n${m.text}\n"""\n` : "(Only the summary above is available — write ONLY what it supports; keep the article short rather than padding it.)\n"}\nProduce JSON with:\n- "headline": a click-worthy but accurate headline (max 12 words)\n- "summary": 2-3 sentence summary\n${portal ? `- "article_html": a news article as simple HTML (<p>, <h2>) written strictly from the material (${m.text ? "350-600 words" : "as long as the facts allow, 120-250 words"}), ending with a one-line source credit\n` : ""}- "image_prompt": a vivid visual description for a generated hero image (no text instructions, no logos, no real faces)\n- "captions": {"facebook": engaging 2-4 sentence caption, "instagram": caption with line breaks and emoji sparingly, "x": <=240 chars, "linkedin": professional 2-3 sentences}\n- "hashtags": 4-8 relevant hashtags without spaces`,
    mock: { headline: m.title, summary: m.summary || `Quick take on: ${m.title}`, article_html: `<p>${m.summary || m.title}</p><p>Source: ${m.url || "mock"}</p>`, image_prompt: `Editorial illustration for: ${m.title}`, captions: { facebook: `${m.title} — here's what you need to know.`, instagram: `${m.title} ✨`, x: m.title.slice(0, 200), linkedin: m.title }, hashtags: ["news", niche.key] } }));
  const d = r.data || {}; await addCost(item.id, r.cost);
  await setItem(item.id, { headline: d.headline || m.title, summary: d.summary || m.summary, body: portal ? d.article_html || null : null, captions: d.captions || {}, hashtags: Array.isArray(d.hashtags) ? d.hashtags : [], image_prompt: d.image_prompt || null });
  const specs = { width: 1080, height: 1080, brand: niche.display_name, ...(P(niche.image_specs) || {}) };
  const img = await imageFor(niche, (ia) => ia.generate({ prompt: d.image_prompt, headline: d.headline || m.title, specs, contentItemId: item.id }));
  await addCost(item.id, img.cost); await setItem(item.id, { hero_media_id: img.id });
}
// ---- 8b. LONG_POST: research first (notes with citations), then write in the style profile
async function generateLongPost(item, niche, style) {
  const m = await materialFor(item, niche);
  const dedup = await checkDuplicate(m.title, niche, item.series_id, item.id); if (dedup.isDuplicate) throw new Error(`Dedup: too similar to "${dedup.best.topic}"`);
  await setItem(item.id, { status: "DRAFTING", topic: m.title, source_data_ref: { ...(m.raw || {}), url: m.url }, topic_embedding: J(dedup.embedding) });
  const research = await llmFor(niche, (llm) => llm.complete({ json: true, grounding: true, maxTokens: 3000,
    system: "You are a meticulous researcher. Gather verifiable facts with sources. Never fabricate a citation.",
    prompt: `Topic: ${m.title}\nContext: ${m.summary || ""} ${m.url || ""}${m.text ? `\nSource article text:\n${m.text.slice(0, 3000)}` : ""}\nReturn JSON: {"notes": [{"fact": "...", "source_url": "https://...", "source_name": "..."}], "angle": "the most interesting angle for a long social post"} with 6-12 notes.`,
    mock: { notes: [{ fact: `Mock fact about ${m.title}`, source_url: m.url || "https://example.com", source_name: "mock" }], angle: "mock angle" } }));
  await addCost(item.id, research.cost);
  const notes = research.data?.notes || []; const cites = [...new Set([...(research.citations || []), ...notes.map((n) => n.source_url).filter(Boolean)])];
  await q(`INSERT INTO research_notes (id, niche_id, content_item_id, topic, notes, citations, created_by) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)`, [newId(), niche.id, item.id, m.title, JSON.stringify(notes), JSON.stringify(cites), research.model || "mock"]);
  const post = await llmFor(niche, (llm) => llm.complete({ json: true, maxTokens: 3000,
    system: `You write long-form Facebook posts for "${niche.display_name}". Language: ${niche.language || "en"}. Tone: ${niche.tone}.${styleBlock(style)} Use ONLY the research notes as facts.`,
    prompt: `Topic: ${m.title}\nAngle: ${research.data?.angle || ""}\nResearch notes:\n${notes.map((n) => `- ${n.fact} (${n.source_name || n.source_url || "source"})`).join("\n")}\n\nReturn JSON: {"headline": "first line hook", "post": "the full 250-600 word post with paragraph breaks", "hashtags": ["..."], "image_prompt": "visual for a cover image"}`,
    mock: { headline: m.title, post: `${m.title}\n\n${notes.map((n) => n.fact).join("\n\n")}`, hashtags: ["longpost"], image_prompt: `Cover for ${m.title}` } }));
  await addCost(item.id, post.cost); const d = post.data || {};
  await setItem(item.id, { headline: d.headline || m.title, body: d.post || "", summary: (d.post || "").slice(0, 280), captions: { facebook: d.post || "", default: d.post || "" }, hashtags: d.hashtags || [], image_prompt: d.image_prompt || null });
  if ((P(niche.method_config) || {}).cover_image !== false) { const img = await imageFor(niche, (ia) => ia.generate({ prompt: d.image_prompt, headline: d.headline || m.title, specs: { width: 1200, height: 630, brand: niche.display_name, ...(P(niche.image_specs) || {}) }, contentItemId: item.id })); await addCost(item.id, img.cost); await setItem(item.id, { hero_media_id: img.id }); }
}
// ---- 8c. IMAGE_SLIDESHOW / LONG_FORM_VIDEO (GENERATIVE): script → images → TTS → ffmpeg
async function generateSlideshowVideo(item, niche, style) {
  const m = await materialFor(item, niche); const long = item.content_type === "LONG_FORM_VIDEO"; const mc = methodCfg(niche);
  const dedup = await checkDuplicate(m.title, niche, item.series_id, item.id); if (dedup.isDuplicate) throw new Error(`Dedup: too similar to "${dedup.best.topic}"`);
  await setItem(item.id, { status: "DRAFTING", topic: m.title, source_data_ref: { ...(m.raw || {}), url: m.url }, topic_embedding: J(dedup.embedding) });
  const slides = mc.slides || (long ? 12 : 10);
  const r = await llmFor(niche, (llm) => llm.complete({ json: true, grounding: long, maxTokens: long ? 6000 : 2500,
    system: `You write ${long ? "researched long-form YouTube video scripts" : "punchy 60-90 second facts videos"} for "${niche.display_name}". Language: ${niche.language || "en"}. Tone: ${niche.tone}.${styleBlock(style)} Every sentence must be spoken narration — no stage directions.`,
    prompt: `Topic: ${m.title}\nContext: ${m.summary || ""}${m.text ? `\nSource article text:\n${m.text.slice(0, 3000)}` : ""}\nWrite a script split into exactly ${slides} sections. Return JSON: {"title": "video title", "sections": [{"narration": "spoken text for this section", "image_prompt": "what the viewer sees, no text"}], "description": "YouTube description", "hashtags": ["..."]}`,
    mock: { title: m.title, sections: Array.from({ length: Math.min(slides, 4) }, (_, i) => ({ narration: `Mock narration section ${i + 1} about ${m.title}.`, image_prompt: `Illustration ${i + 1} for ${m.title}` })), description: m.title, hashtags: ["facts"] } }));
  await addCost(item.id, r.cost); const d = r.data || {}; const sections = d.sections || [];
  const script = sections.map((s) => s.narration).join("\n\n");
  await setItem(item.id, { headline: d.title || m.title, script, summary: d.description || "", captions: { default: d.description || m.title, youtube: d.description || "" }, hashtags: d.hashtags || [] });
  const images = [];
  for (const s of sections) { const img = await imageFor(niche, (ia) => ia.generate({ prompt: s.image_prompt, headline: d.title || m.title, specs: { width: long ? 1920 : 1080, height: long ? 1080 : 1920, brand: niche.display_name, render_text: false, overlay: false, ...(P(niche.image_specs) || {}) }, contentItemId: item.id })); await addCost(item.id, img.cost); images.push(img); }
  const voice = await resolve("VOICE", niche.voice_adapter || "tts_mock");
  const audio = await voice.synthesize({ script, voiceId: niche.voice_id, contentItemId: item.id }); await addCost(item.id, audio.cost);
  await setItem(item.id, { voice_asset_url: audio.url, status: "RENDERING" });
  // rough per-section captions from narration length
  const totalChars = script.length || 1; let t = 0; const captions = sections.map((s) => { const d2 = (s.narration.length / totalChars) * (audio.duration_seconds || 30); const c = { start: t, end: t + d2, text: s.narration.slice(0, 90) }; t += d2; return c; });
  const renderer = await resolve("RENDER", niche.render_adapter || "render_mock");
  const video = await renderer.renderSlideshow({ images, audio, contentItemId: item.id, orientation: long ? "16:9" : mc.orientation || "9:16", captions: mc.captions === false ? [] : captions });
  await setItem(item.id, { hero_media_id: video.id });
}
// ---- 8d. Video candidate: download → transcribe → pick clips → one content_item per clip → RENDER_CLIP jobs
async function processCandidate(candidateId) {
  const cand = await one(`SELECT * FROM video_candidates WHERE id = $1`, [candidateId]); if (!cand) return;
  const niche = await one(`SELECT * FROM niches WHERE id = $1`, [cand.niche_id]); if (!niche) throw new Error("candidate has no program");
  await q(`UPDATE video_candidates SET status='PROCESSING', error_message=NULL WHERE id=$1`, [candidateId]);
  const dl = await resolve("DOWNLOAD", niche.download_adapter || "ytdlp");
  const file = cand.local_path && existsSync(cand.local_path) ? { path: cand.local_path, duration: cand.duration_seconds } : await dl.download(cand.source_url);
  await q(`UPDATE video_candidates SET local_path=$2, duration_seconds=COALESCE($3, duration_seconds) WHERE id=$1`, [candidateId, file.path, file.duration || null]);
  let transcript = P(cand.transcript);
  if (!transcript?.segments?.length) {
    const tr = await resolve("TRANSCRIBE", niche.transcript_adapter || "transcribe_mock");
    transcript = await tr.transcribe({ path: file.path, duration: file.duration, language: niche.language });
    await q(`UPDATE video_candidates SET transcript=$2::jsonb WHERE id=$1`, [candidateId, JSON.stringify({ segments: transcript.segments })]);
  }
  let clips;
  if (niche.content_type === "MOVIE_RECAP") clips = [{ start: 0, end: file.duration || transcript.segments.at(-1)?.end || 600, title: cand.title, hook: "", score: 1, reason: "whole film" }];
  else { clips = await withFallbacks("CLIP", niche.clip_adapter || "llm_clipper", niche.clip_adapter_fallbacks, (c) => c.selectClips({ transcript, niche, candidate: cand })); clips = clips.slice(0, methodCfg(niche).clips_per_video); }
  if (!clips.length) throw new Error("no clip-worthy moments found");
  for (const cl of clips) {
    const clipId = newId(); const text = transcript.segments.filter((s) => s.end > cl.start && s.start < cl.end).map((s) => s.text).join(" ");
    await q(`INSERT INTO clips (id, video_candidate_id, niche_id, start_seconds, end_seconds, title, hook, score, reason, transcript_text) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [clipId, candidateId, niche.id, cl.start, cl.end, cl.title, cl.hook, cl.score, cl.reason, text]);
    const itemId = await createQueuedItem(niche, { topic: cl.title || cand.title, candidateId, clipId, status: "QUEUED", sourceDataRef: { provider: "video_candidate", url: cand.source_url, title: cand.title, clip: cl } });
    await q(`UPDATE clips SET content_item_id=$2 WHERE id=$1`, [clipId, itemId]);
    await enqueue("RENDER_CLIP", { itemId, clipId }, { queue: "video", contentItemId: itemId, priority: niche.priority });
  }
  await q(`UPDATE video_candidates SET status='PROCESSED' WHERE id=$1`, [candidateId]);
}
async function renderClipItem(itemId, clipId) {
  const item = await one(`SELECT * FROM content_items WHERE id=$1`, [itemId]); const clip = await one(`SELECT * FROM clips WHERE id=$1`, [clipId]);
  const cand = await one(`SELECT * FROM video_candidates WHERE id=$1`, [clip.video_candidate_id]); const niche = await one(`SELECT * FROM niches WHERE id=$1`, [item.niche_id]);
  const style = niche.style_profile_id ? await one(`SELECT * FROM style_profiles WHERE id=$1`, [niche.style_profile_id]) : null;
  await setItem(itemId, { status: "RENDERING" });
  const transcript = P(cand.transcript) || { segments: [] }; const c = { start: Number(clip.start_seconds), end: Number(clip.end_seconds), title: clip.title, hook: clip.hook };
  if (!cand.local_path || !existsSync(cand.local_path)) { const dl = await resolve("DOWNLOAD", niche.download_adapter || "ytdlp"); const f = await dl.download(cand.source_url); await q(`UPDATE video_candidates SET local_path=$2 WHERE id=$1`, [cand.id, f.path]); cand.local_path = f.path; }
  const extras = {}; let script = clip.transcript_text || "";
  if (niche.production_method === "VOICEOVER" || niche.production_method === "MOVIE_RECAP") {
    const recap = niche.production_method === "MOVIE_RECAP";
    const r = await llmFor(niche, (llm) => llm.complete({ json: true, maxTokens: recap ? 4000 : 1200,
      system: `You write ${recap ? "gripping ~60 second movie recaps that preserve suspense and never spoil the ending" : "short punchy voice-over narration re-telling a clip in our own words"} for "${niche.display_name}". Language: ${niche.language || "en"}. Tone: ${niche.tone}.${styleBlock(style)}`,
      prompt: recap ? `Film: ${cand.title}\nTimestamped transcript:\n${transcript.segments.map((s) => `[${s.start}-${s.end}] ${s.text}`).join("\n").slice(0, 100000)}\n\nWrite a ${methodCfg(niche).recap_seconds || 60}-second narrated recap in ${Math.max(6, Math.round((methodCfg(niche).recap_seconds || 60) / 6))} beats. For each beat pick the source timestamps that visually match. Return JSON: {"title": "...", "beats": [{"narration": "...", "start": seconds, "end": seconds}], "hashtags": ["..."]}`
        : `Clip transcript (${(c.end - c.start).toFixed(0)}s): ${script}\n\nWrite narration of the same length that re-tells this in our voice. Return JSON: {"title": "...", "narration": "...", "hashtags": ["..."]}`,
      mock: recap ? { title: cand.title, beats: [{ narration: `Mock recap of ${cand.title}.`, start: 0, end: 10 }, { narration: "And then everything changes.", start: 30, end: 40 }], hashtags: ["recap"] } : { title: clip.title, narration: `Mock narration: ${script.slice(0, 200)}`, hashtags: ["clip"] } }));
    await addCost(itemId, r.cost); const d = r.data || {};
    script = recap ? (d.beats || []).map((b) => b.narration).join(" ") : d.narration || script;
    const voice = await resolve("VOICE", niche.voice_adapter || "tts_mock"); const audio = await voice.synthesize({ script, voiceId: niche.voice_id, contentItemId: itemId }); await addCost(itemId, audio.cost);
    extras.audio = audio;
    if (recap && d.beats?.length) { const total = d.beats.reduce((s, b) => s + Math.max(1, (Number(b.end) || 0) - (Number(b.start) || 0)), 0) || 1; const k = (audio.duration_seconds || total) / total; extras.scenes = d.beats.map((b) => ({ start: Number(b.start) || 0, end: (Number(b.start) || 0) + Math.max(1, (Number(b.end) || 0) - (Number(b.start) || 0)) * k })); }
    await setItem(itemId, { headline: d.title || clip.title, script, voice_asset_url: audio.url, hashtags: d.hashtags || [] });
  }
  const renderer = await resolve("RENDER", niche.render_adapter || "render_mock");
  const video = await renderer.renderClip({ clip: c, sourcePath: cand.local_path, transcript, niche, contentItemId: itemId, extras });
  await q(`UPDATE clips SET render_url=$2, status='RENDERED' WHERE id=$1`, [clipId, video.url]);
  const cap = await llmFor(niche, (llm) => llm.complete({ json: true, maxTokens: 600,
    system: `You write social captions for "${niche.display_name}". Language: ${niche.language || "en"}. Tone: ${niche.tone}.${styleBlock(style)}`,
    prompt: `Clip title: ${c.title}\nHook: ${c.hook}\nWhat is said: ${script.slice(0, 1500)}\nSource: ${cand.title}\nReturn JSON: {"headline": "video title max 90 chars", "captions": {"facebook": "...", "instagram": "...", "youtube": "description with credit to the source"}, "hashtags": ["..."]}`,
    mock: { headline: c.title, captions: { facebook: c.hook || c.title, instagram: c.hook || c.title, youtube: `Clip from ${cand.title}` }, hashtags: ["shorts"] } }));
  await addCost(itemId, cap.cost); const cd = cap.data || {};
  await setItem(itemId, { hero_media_id: video.id, headline: cd.headline || c.title, captions: cd.captions || {}, hashtags: cd.hashtags || [], summary: c.hook || "" });
  await finishGeneration(itemId, niche);
}
// ---- 8e. entry point for every text/slideshow item
async function runGeneration(itemId) {
  const item = await one(`SELECT * FROM content_items WHERE id=$1`, [itemId]); if (!item) return;
  const niche = await one(`SELECT * FROM niches WHERE id=$1`, [item.niche_id]);
  const style = niche.style_profile_id ? await one(`SELECT * FROM style_profiles WHERE id=$1`, [niche.style_profile_id]) : null;
  await setItem(itemId, { status: "FETCHING_DATA", rejection_note: null });
  const type = item.content_type || niche.content_type || "NICHE_STATIC";
  if (item.series_id && item.episode_number == null) { const s = await one(`SELECT episode_counter FROM series WHERE id=$1`, [item.series_id]); if (s) await setItem(itemId, { episode_number: s.episode_counter + 1 }); }
  if (type === "LONG_POST") await generateLongPost(item, niche, style);
  else if (type === "IMAGE_SLIDESHOW" || type === "LONG_FORM_VIDEO") await generateSlideshowVideo(item, niche, style);
  else await generateStatic(item, niche, style);
  return finishGeneration(itemId, niche);
}
// Regenerate one part of a reviewed item without touching the rest.
async function regenerate(itemId, part) {
  const item = await one(`SELECT * FROM content_items WHERE id=$1`, [itemId]); const niche = await one(`SELECT * FROM niches WHERE id=$1`, [item.niche_id]);
  const style = niche.style_profile_id ? await one(`SELECT * FROM style_profiles WHERE id=$1`, [niche.style_profile_id]) : null;
  if (part === "image") { const img = await imageFor(niche, (ia) => ia.generate({ prompt: item.image_prompt, headline: item.headline || item.topic, specs: { width: 1080, height: 1080, brand: niche.display_name, ...(P(niche.image_specs) || {}) }, contentItemId: itemId })); await addCost(itemId, img.cost); await setItem(itemId, { hero_media_id: img.id, status: "PENDING_REVIEW" }); return; }
  if (part === "all") { await setItem(itemId, { headline: null, summary: null, body: null, hero_media_id: null }); return runGeneration(itemId); }
  const r = await llmFor(niche, (llm) => llm.complete({ json: true, maxTokens: 1500, system: `You are the editor of "${niche.display_name}". Language: ${niche.language || "en"}. Tone: ${niche.tone}.${styleBlock(style)}`,
    prompt: `Current headline: ${item.headline}\nSummary: ${item.summary}\nBody: ${(item.body || "").slice(0, 3000)}\n\nRewrite ONLY the ${part} to be stronger, keeping the facts identical. Return JSON: ${part === "headline" ? '{"headline": "..."}' : part === "captions" ? '{"captions": {"facebook": "...", "instagram": "...", "x": "...", "linkedin": "..."}, "hashtags": ["..."]}' : '{"body": "..."}'}`,
    mock: part === "headline" ? { headline: `${item.headline} (v2)` } : part === "captions" ? { captions: P(item.captions), hashtags: P(item.hashtags) } : { body: item.body } }));
  await addCost(itemId, r.cost); const d = r.data || {};
  const upd = { status: "PENDING_REVIEW" }; if (d.headline) upd.headline = d.headline; if (d.captions) upd.captions = d.captions; if (d.hashtags) upd.hashtags = d.hashtags; if (d.body) upd.body = d.body;
  await setItem(itemId, upd);
}
// ---- 8f. publish one asset
async function publishAsset(assetId) {
  const asset = await one(`SELECT * FROM content_assets WHERE id=$1`, [assetId]); if (!asset || asset.status === "PUBLISHED") return;
  if (await setting("publishing.global_pause", false)) { await q(`UPDATE content_assets SET scheduled_for = now() + interval '10 minutes' WHERE id=$1`, [assetId]); return; }
  const item = await one(`SELECT * FROM content_items WHERE id=$1`, [asset.content_item_id]); const channel = await one(`SELECT * FROM channels WHERE id=$1`, [asset.channel_id]); const niche = await one(`SELECT * FROM niches WHERE id=$1`, [item.niche_id]);
  try {
    if (!flag(channel.is_active)) throw new Error("channel is inactive");
    const media = item.hero_media_id ? await one(`SELECT * FROM media_assets WHERE id=$1`, [item.hero_media_id]) : null;
    await q(`UPDATE content_assets SET status='RENDERING' WHERE id=$1`, [assetId]);
    const renderer = await resolve("RENDER", niche.render_adapter || "render_mock");
    const rendered = await renderer.renderForChannel({ media, channel, item, niche });
    await q(`UPDATE content_assets SET status='RENDERED', render_url=$2 WHERE id=$1`, [assetId, rendered.url]);
    const pubKey = channel.publisher_adapter || PLATFORM_DEFAULT_PUBLISHER[channel.platform] || "publish_mock";
    const publisher = await resolve("PUBLISH", pubKey);
    await q(`UPDATE content_assets SET status='PUBLISHING' WHERE id=$1`, [assetId]);
    const res = await publisher.publish({ channel, mediaUrl: rendered.url, mediaKind: rendered.kind, caption: asset.caption || renderCaption(item, channel, null), title: item.headline || item.topic, hashtags: P(item.hashtags) || [] });
    await q(`UPDATE content_assets SET status='PUBLISHED', published_url=$2, external_id=$3, published_at=now(), error_message=NULL WHERE id=$1`, [assetId, res.publishedUrl, res.externalId]);
    await q(`UPDATE channels SET last_published_at=now() WHERE id=$1`, [channel.id]);
  } catch (e) {
    await q(`UPDATE content_assets SET status='FAILED', error_message=$2, retry_count=retry_count+1 WHERE id=$1`, [assetId, String(e.message).slice(0, 1500)]);
    await rollupItemStatus(item.id); throw e;
  }
  await rollupItemStatus(item.id);
}
// ---- 8g. metrics + repurposing
async function pollMetrics(assetId) {
  const asset = await one(`SELECT * FROM content_assets WHERE id=$1 AND status='PUBLISHED'`, [assetId]); if (!asset || !asset.external_id) return;
  const channel = await one(`SELECT * FROM channels WHERE id=$1`, [asset.channel_id]);
  const publisher = await resolve("PUBLISH", channel.publisher_adapter || PLATFORM_DEFAULT_PUBLISHER[channel.platform] || "publish_mock");
  if (!publisher.metrics) return;
  const m = await publisher.metrics({ channel, asset });
  await q(`INSERT INTO performance_metrics (id, asset_id, views, likes, comments) VALUES ($1,$2,$3,$4,$5)`, [newId(), assetId, m.views || 0, m.likes || 0, m.comments || 0]);
  await q(`UPDATE content_assets SET last_metrics=$2::jsonb WHERE id=$1`, [assetId, JSON.stringify({ ...m, at: nowIso() })]);
  await checkAndRepurpose(assetId);
}
async function checkAndRepurpose(assetId) {
  const asset = await one(`SELECT * FROM content_assets WHERE id=$1`, [assetId]); if (!asset) return null;
  const latest = await one(`SELECT views FROM performance_metrics WHERE asset_id=$1 ORDER BY captured_at DESC LIMIT 1`, [assetId]);
  if (!latest || latest.views < Number(await setting("repurpose.view_threshold", 500))) return null;
  const src = await one(`SELECT * FROM content_items WHERE id=$1`, [asset.content_item_id]); if (!src || src.status === "REPURPOSED") return null;
  const id = newId();
  // Storage cleanup may have removed the original hero file (48h after publish, metrics run for 14 days). If so, start
  // the repurposed item without a hero and queue an image regeneration; it lands in review once the new image exists.
  const hero = src.hero_media_id ? await one(`SELECT id, kind, deleted_at FROM media_assets WHERE id=$1`, [src.hero_media_id]) : null;
  const heroGone = !!hero?.deleted_at;
  await q(`INSERT INTO content_items (id, niche_id, series_id, derived_from_id, content_type, topic, headline, summary, body, script, captions, hashtags, hero_media_id, image_prompt, status, source_data_ref) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [id, src.niche_id, src.series_id, src.id, src.content_type, `[Repurposed] ${src.topic}`, src.headline, src.summary, src.body, src.script, J(P(src.captions) || {}), J(P(src.hashtags) || []), heroGone ? null : src.hero_media_id, src.image_prompt, heroGone ? "DRAFTING" : "PENDING_REVIEW", J({ repurposedFrom: src.id, triggerViews: latest.views, heroRegenerated: heroGone })]);
  if (heroGone) {
    if (hero.kind === "IMAGE") await enqueue("REGENERATE", { itemId: id, part: "image" }, { queue: "image", priority: 5, contentItemId: id });
    else await setItem(id, { status: "FAILED", rejection_note: "Repurposed, but the original video/audio was removed by storage cleanup. Regenerate (all) to rebuild it." });
  }
  await q(`UPDATE content_items SET status='REPURPOSED' WHERE id=$1`, [src.id]);
  return one(`SELECT * FROM content_items WHERE id=$1`, [id]);
}

// === 9. worker lanes =====================================================
const QUEUES = ALL_QUEUES;
async function enqueue(type, payload, { queue = "text", priority = 0, runAfter = null, contentItemId = null, dedupeKey = null, maxAttempts = 3 } = {}) {
  if (dedupeKey) { const dup = await one(`SELECT id FROM jobs WHERE dedupe_key=$1 AND status IN ('PENDING','RUNNING')`, [dedupeKey]); if (dup) return dup.id; }
  const id = newId();
  await q(`INSERT INTO jobs (id, type, status, payload, queue, priority, run_after, content_item_id, dedupe_key, max_attempts) VALUES ($1,$2,'PENDING',$3,$4,$5,$6,$7,$8,$9)`, [id, type, JSON.stringify(payload), queue, priority, runAfter, contentItemId, dedupeKey, maxAttempts]);
  return id;
}
const HANDLERS = {
  async INGEST_SOURCE({ sourceId }) {
    const source = await one(`SELECT * FROM sources WHERE id=$1`, [sourceId]); if (!source || !flag(source.is_active)) return { skipped: true };
    try {
      const ing = await resolve("INGEST", source.adapter_key || "rss"); const items = await ing.fetchItems(source); let added = 0, routed = 0;
      for (const it of items) {
        const hash = sha(it.url); const id = newId();
        const ins = await q(`INSERT INTO source_items (id, source_id, external_id, url, url_hash, title, summary, published_at, thumbnail_url, kind, raw) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) ON CONFLICT (url_hash) DO NOTHING RETURNING id`,
          [id, sourceId, it.external_id || null, it.url, hash, it.title.slice(0, 500), it.summary || null, it.published_at || null, it.thumbnail || null, it.kind || "ARTICLE", JSON.stringify({ ...(it.raw || {}), duration: it.duration, views: it.views, platform: it.platform, license: it.license })]);
        if (!ins.length) continue; added++;
        routed += await routeSourceItem({ ...it, id, source_id: sourceId });
      }
      await q(`UPDATE sources SET last_polled_at=now(), last_error=NULL WHERE id=$1`, [sourceId]);
      return { fetched: items.length, added, routed };
    } catch (e) { await q(`UPDATE sources SET last_polled_at=now(), last_error=$2 WHERE id=$1`, [sourceId, String(e.message).slice(0, 800)]); throw e; }
  },
  async GENERATE_CONTENT({ itemId }, job) { if (!(await budgetOk())) { await deferJob(job, 60); return { deferred: "budget" }; } return runGeneration(itemId); },
  async REGENERATE({ itemId, part }) { return regenerate(itemId, part); },
  async PROCESS_CANDIDATE({ candidateId }, job) { if (!(await budgetOk())) { await deferJob(job, 60); return { deferred: "budget" }; } return processCandidate(candidateId); },
  async RENDER_CLIP({ itemId, clipId }) { return renderClipItem(itemId, clipId); },
  async PUBLISH_ASSET({ assetId }) { return publishAsset(assetId); },
  async POLL_METRICS({ assetId }) { return pollMetrics(assetId); },
};
// Seconds until the next attempt, or null to give up. Transient failures (overloaded model, rate limit, network) back
// off exponentially — 1, 2, 4 … 32 min, about an hour in all — for jobs that are safe to repeat. Publishing keeps its
// own small attempt count so a slow platform cannot cause double posts. Permanent failures stop at once.
const TRANSIENT_MAX_ATTEMPTS = Number(ENV.TRANSIENT_MAX_ATTEMPTS) || 7;
const PATIENT_JOBS = new Set(["INGEST_SOURCE", "GENERATE_CONTENT", "REGENERATE", "PROCESS_CANDIDATE", "RENDER_CLIP", "POLL_METRICS"]);
function retryDelay(job, e) {
  if (isPermanent(e)) return null;
  const transient = isTransient(e);
  const max = transient && PATIENT_JOBS.has(job.type) ? Math.max(job.max_attempts || 3, TRANSIENT_MAX_ATTEMPTS) : (job.max_attempts || 3);
  if (job.attempts >= max) return null;
  return transient ? Math.min(60 * 2 ** Math.max(0, job.attempts - 1), 3600) : 30 * job.attempts;
}
async function deferJob(job, minutes) { await q(`UPDATE jobs SET status='PENDING', run_after=now() + ($2 || ' minutes')::interval, attempts=attempts-1, locked_by=NULL WHERE id=$1`, [job.id, String(minutes)]); job._deferred = true; }
async function runJob(job) {
  const h = HANDLERS[job.type]; const payload = P(job.payload) || {};
  try {
    if (!h) throw new Error(`no handler for ${job.type}`);
    const result = await h(payload, job);
    if (job._deferred) return;
    await q(`UPDATE jobs SET status='SUCCEEDED', result=$2, finished_at=now(), locked_by=NULL WHERE id=$1`, [job.id, J(result ?? null)?.slice(0, 5000) ?? null]);
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 1500); const delay = retryDelay(job, e);
    warn(`job ${job.type} ${job.id} failed (attempt ${job.attempts}${delay != null ? `, retrying in ${delay}s` : ", giving up"}): ${msg}`);
    if (delay != null) await q(`UPDATE jobs SET status='PENDING', error_message=$2, run_after=now() + ($3 || ' seconds')::interval, locked_by=NULL WHERE id=$1`, [job.id, msg, String(delay)]);
    else {
      await q(`UPDATE jobs SET status='FAILED', error_message=$2, finished_at=now(), locked_by=NULL WHERE id=$1`, [job.id, msg]);
      const itemId = job.content_item_id || payload.itemId; if (itemId) await q(`UPDATE content_items SET status='FAILED', rejection_note=$2 WHERE id=$1 AND status NOT IN ('PUBLISHED','PARTIALLY_PUBLISHED','REJECTED')`, [itemId, msg]);
      if (payload.candidateId) await q(`UPDATE video_candidates SET status='FAILED', error_message=$2 WHERE id=$1`, [payload.candidateId, msg]);
    }
  }
}
async function workerLoop(queue) {
  log(`worker lane "${queue}" started`);
  for (;;) {
    let ran = false;
    try {
      const enabled = await setting("queues.enabled", {});
      if (enabled[queue] !== false) { const [job] = await q(`SELECT * FROM claim_job($1, $2)`, [queue, WORKER_ID]); if (job) { ran = true; await runJob(job); } }
    } catch (e) { warn(`lane ${queue}:`, e.message); }
    await sleep(ran ? 100 : QUEUE_POLL_MS);
  }
}
async function sweepDueSources() {
  if (!(await setting("ingest.enabled", true))) return;
  const due = await q(`SELECT id, priority_hint FROM (SELECT s.id, 0 AS priority_hint FROM sources s WHERE s.is_active::int = 1 AND (s.last_polled_at IS NULL OR s.last_polled_at + (s.poll_interval_minutes || ' minutes')::interval <= now()) AND EXISTS (SELECT 1 FROM niche_sources ns WHERE ns.source_id = s.id)) d`);
  for (const s of due) await enqueue("INGEST_SOURCE", { sourceId: s.id }, { queue: "ingest", dedupeKey: `ingest:${s.id}`, maxAttempts: 1 });
}
async function sweepDueAssets() {
  const due = await q(`SELECT id FROM content_assets WHERE status='PENDING' AND (scheduled_for IS NULL OR scheduled_for <= now()) LIMIT 50`);
  for (const a of due) await enqueue("PUBLISH_ASSET", { assetId: a.id }, { queue: "publish", dedupeKey: `publish:${a.id}`, maxAttempts: 2 });
}
async function sweepReviewDeadlines() {
  const due = await q(`SELECT id FROM content_items WHERE status='PENDING_REVIEW' AND review_deadline_at IS NOT NULL AND review_deadline_at <= now() LIMIT 20`);
  for (const it of due) { try { await approveItem(it.id, { auto: true }); log(`auto-approved ${it.id} after review window`); } catch (e) { warn("auto-approve failed", e.message); } }
}
async function sweepMetrics() {
  const rows = await q(`SELECT id FROM content_assets WHERE status='PUBLISHED' AND published_at > now() - interval '14 days' AND (last_metrics IS NULL OR (last_metrics->>'at')::timestamptz < now() - interval '6 hours') LIMIT 30`);
  for (const a of rows) await enqueue("POLL_METRICS", { assetId: a.id }, { queue: "metrics", dedupeKey: `metrics:${a.id}`, maxAttempts: 1 });
}
async function recoverAbandonedWork() {
  const r1 = await q(`UPDATE jobs SET status='PENDING', locked_by=NULL, attempts=GREATEST(attempts-1,0) WHERE status='RUNNING' AND locked_at < now() - ($1 || ' minutes')::interval RETURNING id`, [String(LOCK_TIMEOUT_MIN)]);
  const r2 = await q(`UPDATE content_items ci SET status='FAILED', rejection_note='Recovered at boot: generation was interrupted (process restarted). Regenerate to retry.' WHERE status IN ('FETCHING_DATA','DRAFTING','RENDERING') AND updated_at < now() - interval '90 minutes' AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.content_item_id = ci.id AND j.status IN ('PENDING','RUNNING')) RETURNING id`);
  if (r1.length || r2.length) log(`recovered ${r1.length} jobs, failed ${r2.length} stuck items`);
}
function startWorkers() {
  if (!LANES.length) { warn("LANES is set but names no known lane — this process serves HTTP only"); return; }
  for (const qn of LANES) workerLoop(qn);
  if (!RUN_SWEEPS) { log(`sweeps disabled on this instance (lanes: ${LANES.join(",")})`); return; }
  const every = (ms, fn) => { const tick = () => fn().catch((e) => warn(fn.name, e.message)); setTimeout(tick, 3000); setInterval(tick, ms); };
  every(60000, sweepDueSources); every(30000, sweepDueAssets); every(60000, sweepReviewDeadlines); every(30 * 60000, sweepMetrics);
  every(30 * 60000, async function recoverStale() { await recoverAbandonedWork(); });
  every(60 * 60000, sweepStorageCleanup);
}

// === 10. HTTP =============================================================
class App {
  routes = [];
  on(method, path, handler) { const names = []; const re = new RegExp("^" + path.split("/").map((s) => (s.startsWith(":") ? (names.push(s.slice(1)), "([^/]+)") : s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("/") + "/?$"); this.routes.push({ method, re, names, handler }); }
  get(p, h) { this.on("GET", p, h); } post(p, h) { this.on("POST", p, h); } patch(p, h) { this.on("PATCH", p, h); } put(p, h) { this.on("PUT", p, h); } delete(p, h) { this.on("DELETE", p, h); }
}
const app = new App();
const send = (res, status, data) => { if (res.headersSent) return; res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(data ?? null)); };
const json = (ctx, status, data) => send(ctx.res, status, data);
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".mp4": "video/mp4", ".mp3": "audio/mpeg", ".ico": "image/x-icon" };
const rateBuckets = new Map();
function rateLimited(key, limit) { const now = Date.now(); const b = rateBuckets.get(key) || []; const fresh = b.filter((t) => now - t < 60000); fresh.push(now); rateBuckets.set(key, fresh); return fresh.length > limit; }
function authOk(req) {
  const user = ENV.DASHBOARD_USERNAME || "admin", pass = ENV.DASHBOARD_PASSWORD; if (!pass) return true;
  const h = req.headers.authorization || ""; if (!h.startsWith("Basic ")) return false;
  const [u, p] = Buffer.from(h.slice(6), "base64").toString().split(":"); const a = Buffer.from(`${u}:${p}`), b = Buffer.from(`${user}:${pass}`);
  return a.length === b.length && timingSafeEqual(a, b);
}
async function readBody(req) { return new Promise((resolve, reject) => { let d = ""; req.on("data", (c) => { d += c; if (d.length > 1e6) { reject(new ApiError(413, null, "Body too large")); req.destroy(); } }); req.on("end", () => { if (!d) return resolve({}); try { resolve(JSON.parse(d)); } catch { reject(new ApiError(400, null, "Invalid JSON body")); } }); req.on("error", reject); }); }
async function serveFile(res, path) { try { const data = await readFile(path); res.writeHead(200, { "Content-Type": MIME[extname(path)] || "application/octet-stream", "Cache-Control": "public, max-age=300" }); res.end(data); return true; } catch { return false; } }
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost"); const pathname = decodeURIComponent(url.pathname);
  res.setHeader("Access-Control-Allow-Origin", ENV.CORS_ORIGIN || "*"); res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,PUT,DELETE,OPTIONS"); res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  const isPublic = pathname === "/health" || pathname.startsWith("/api/public/") || pathname.startsWith("/media/") || pathname.startsWith("/a/");
  if (!isPublic && !authOk(req)) { res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Content Engine"', "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "Unauthorized" })); }
  try {
    if (pathname.startsWith("/media/") && req.method === "GET") { const p = join(LOCAL_MEDIA_DIR, pathname.slice(7)); if (!p.startsWith(LOCAL_MEDIA_DIR) || !(await serveFile(res, p))) send(res, 404, { error: "Not found" }); return; }
    const match = app.routes.find((r) => r.method === req.method && r.re.test(pathname));
    if (!match) {
      if (req.method === "GET" && !pathname.startsWith("/api/")) { const p = join(FRONTEND_DIR, pathname === "/" ? "index.html" : pathname); if (p.startsWith(FRONTEND_DIR) && (await serveFile(res, p))) return; if (await serveFile(res, join(FRONTEND_DIR, "index.html"))) return; }
      return send(res, 404, { error: "Not found", path: pathname });
    }
    const groups = match.re.exec(pathname).slice(1); const params = {}; match.names.forEach((n, i) => (params[n] = groups[i]));
    const body = ["POST", "PATCH", "PUT"].includes(req.method) ? await readBody(req) : {};
    const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress;
    await match.handler({ req, res, params, query: url.searchParams, body, ip });
  } catch (e) { const status = e instanceof ApiError ? e.status : 500; if (status >= 500) warn(`${req.method} ${pathname}:`, e.message); send(res, status, { error: String(e.message || e) }); }
});

// ---- routes: meta / health
app.get("/health", async (ctx) => { const db = await one(`SELECT 1 AS ok`).then(() => true).catch(() => false); json(ctx, db ? 200 : 503, { ok: db, worker: WORKER_ID, lanes: LANES, sweeps: RUN_SWEEPS, spentTodayUsd: db ? await spentTodayUsd() : null, storage: (await storageBackend()).name, vault: vaultReady(), ffmpeg: await exec("ffmpeg", ["-version"]).then(() => true).catch(() => false), ytdlp: await exec("yt-dlp", ["--version"]).then(() => true).catch(() => false) }); });
app.get("/api/adapters", async (ctx) => json(ctx, 200, listAdapterKeys(await instances(true))));
app.get("/api/adapter-impls", (ctx) => json(ctx, 200, Object.fromEntries(Object.entries(IMPLS).map(([stage, m]) => [stage, Object.values(m).map((d) => ({ id: d.id, label: d.label, configSchema: d.configSchema }))]))));
app.get("/api/stats", async (ctx) => {
  const [items, assets, cand, srcs] = await Promise.all([q(`SELECT status, COUNT(*)::int AS n FROM content_items GROUP BY status`), q(`SELECT status, COUNT(*)::int AS n FROM content_assets GROUP BY status`), q(`SELECT status, COUNT(*)::int AS n FROM video_candidates GROUP BY status`), one(`SELECT COUNT(*)::int AS n FROM sources WHERE is_active::int=1`)]);
  json(ctx, 200, { items: Object.fromEntries(items.map((r) => [r.status, r.n])), assets: Object.fromEntries(assets.map((r) => [r.status, r.n])), candidates: Object.fromEntries(cand.map((r) => [r.status, r.n])), activeSources: srcs?.n ?? 0, spentTodayUsd: await spentTodayUsd(), budgetCapUsd: await setting("budget.daily_cap_usd", 0), globalPause: await setting("publishing.global_pause", false), queues: await setting("queues.enabled", {}) });
});
// ---- storage
app.get("/api/storage", async (ctx) => {
  const b = await storageBackend(); const r2 = await r2Config();
  const [live, gone] = await Promise.all([one(`SELECT COUNT(*)::int AS n FROM media_assets WHERE deleted_at IS NULL AND url LIKE 'http%'`), one(`SELECT COUNT(*)::int AS n FROM media_assets WHERE deleted_at IS NOT NULL`)]);
  json(ctx, 200, { backend: b.name, available: { r2: !!r2?.public_url, supabase: await STORAGE.supabase.available(), local: true }, r2: r2 ? { bucket: r2.bucket, public_url: r2.public_url || null, ready: !!r2.public_url, warning: r2.public_url ? null : "R2 keys are set but public_url is missing (R2_PUBLIC_URL or the r2 credential's public_url) — R2 is ignored until it is" } : null, filesLive: live.n, filesCleaned: gone.n, cleanupEnabled: await setting("storage.cleanup_enabled", true), cleanupAfterHours: await setting("storage.cleanup_after_publish_hours", 48) });
});
app.post("/api/storage/cleanup", async (ctx) => { await sweepStorageCleanup(); json(ctx, 200, { ok: true }); });
// ---- settings
app.get("/api/settings", async (ctx) => json(ctx, 200, await settings()));
app.put("/api/settings/:key", async (ctx) => { await putSetting(ctx.params.key, ctx.body.value); json(ctx, 200, { key: ctx.params.key, value: ctx.body.value }); });
// ---- credentials. A credential = provider + (secret in the vault OR name of an env var) + priority/quota.
// Secrets go IN through POST/PATCH `secret` (or `fields` for multi-field providers) and never come back out: GET only
// exposes has_secret and a 4-char hint. Storing needs SECRETS_KEY on Render.
const credView = (r) => { const { secret_enc, ...rest } = r; let vault_ok = true; if (secret_enc) { try { decryptSecret(secret_enc); } catch { vault_ok = false; } }
  return { ...rest, has_secret: !!secret_enc, vault_ok, env_present: !!(r.env_var && ENV[r.env_var]), source: secret_enc ? "vault" : (r.env_var && ENV[r.env_var]) ? "env" : "missing", fields: MULTI_FIELD_PROVIDERS[r.provider] || null }; };
function secretFromBody(provider, b) {
  const fields = MULTI_FIELD_PROVIDERS[provider];
  if (fields) { const f = b.fields || {}; const missing = fields.filter((k) => !String(f[k] ?? "").trim() && !(provider === "r2" && k === "public_url")); if (b.fields && missing.length) throw new ApiError(400, null, `Missing: ${missing.join(", ")}`); return b.fields ? JSON.stringify(Object.fromEntries(fields.map((k) => [k, String(f[k] ?? "").trim()]))) : null; }
  const sec = typeof b.secret === "string" ? b.secret.trim() : ""; return sec || null;
}
app.get("/api/credentials", async (ctx) => json(ctx, 200, (await q(`SELECT c.*, COALESCE(u.units,0) AS used_today, COALESCE(u.cost_usd,0) AS cost_today FROM api_credentials c LEFT JOIN api_usage_daily u ON u.credential_id=c.id AND u.day=CURRENT_DATE ORDER BY provider, priority DESC`)).map(credView)));
app.get("/api/credentials/meta", (ctx) => json(ctx, 200, { providers: PROVIDERS, defaultEnv: DEFAULT_ENV, multiField: MULTI_FIELD_PROVIDERS, vault: vaultReady() }));
app.get("/api/usage", async (ctx) => json(ctx, 200, await q(`SELECT day, provider, credential_id, units, cost_usd FROM api_usage_daily WHERE day > CURRENT_DATE - 30 ORDER BY day DESC, provider`)));
app.post("/api/credentials", async (ctx) => {
  const b = ctx.body; if (!b.provider) throw new ApiError(400, null, "provider is required"); if (!PROVIDERS.includes(b.provider)) throw new ApiError(400, null, `Unknown provider ${b.provider}`);
  if (rateLimited(`cred:${ctx.ip}`, 30)) throw new ApiError(429, null, "Too many credential changes; wait a minute");
  const plain = secretFromBody(b.provider, b); const envVar = String(b.envVar || "").trim() || null;
  if (!plain && !envVar) throw new ApiError(400, null, "Give either the secret itself or the name of an env var on Render");
  const enc = plain ? encryptSecret(plain) : null; const hint = plain ? (MULTI_FIELD_PROVIDERS[b.provider] ? "json" : secretHint(plain)) : null;
  const id = newId();
  await q(`INSERT INTO api_credentials (id, provider, label, env_var, priority, daily_quota, secret_enc, secret_hint) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [id, b.provider, b.label || envVar || `${b.provider} key`, envVar || "", b.priority ?? 0, b.dailyQuota ?? null, enc, hint]);
  json(ctx, 201, credView(await one(`SELECT * FROM api_credentials WHERE id=$1`, [id])));
});
app.patch("/api/credentials/:id", async (ctx) => {
  const row = await one(`SELECT * FROM api_credentials WHERE id=$1`, [ctx.params.id]); if (!row) throw new ApiError(404, null, "Credential not found");
  const b = ctx.body;
  const plain = secretFromBody(row.provider, b);
  if (plain) { if (rateLimited(`cred:${ctx.ip}`, 30)) throw new ApiError(429, null, "Too many credential changes; wait a minute"); await q(`UPDATE api_credentials SET secret_enc=$2, secret_hint=$3, cooldown_until=NULL, last_error=NULL WHERE id=$1`, [row.id, encryptSecret(plain), MULTI_FIELD_PROVIDERS[row.provider] ? "json" : secretHint(plain)]); }
  if (b.clearSecret) await q(`UPDATE api_credentials SET secret_enc=NULL, secret_hint=NULL WHERE id=$1`, [row.id]);
  const rest = { ...b, cooldownUntil: b.clearCooldown ? null : undefined }; delete rest.secret; delete rest.fields; delete rest.clearSecret; delete rest.clearCooldown;
  const r = Object.keys(rest).some((k) => ["label", "envVar", "priority", "dailyQuota", "enabled", "cooldownUntil"].includes(k) && rest[k] !== undefined)
    ? await patchRow("api_credentials", row.id, rest, { label: "label", envVar: "env_var", priority: "priority", dailyQuota: "daily_quota", enabled: "enabled", cooldownUntil: "cooldown_until" })
    : await one(`SELECT * FROM api_credentials WHERE id=$1`, [row.id]);
  json(ctx, 200, credView(r));
});
app.post("/api/credentials/:id/test", async (ctx) => {
  const c = await credentialById(ctx.params.id); if (!c) throw new ApiError(404, null, "Credential has no usable secret");
  const auth = (k) => ({ Authorization: `Bearer ${k}` });
  const tests = {
    anthropic: () => fetchJson("https://api.anthropic.com/v1/models?limit=1", { headers: { "x-api-key": c.secret, "anthropic-version": "2023-06-01" } }),
    gemini: () => fetchJson("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", { headers: { "x-goog-api-key": c.secret } }),
    openai: () => fetchJson("https://api.openai.com/v1/models?limit=1", { headers: auth(c.secret) }),
    elevenlabs: () => fetchJson("https://api.elevenlabs.io/v1/user", { headers: { "xi-api-key": c.secret } }),
    newsapi: () => fetchJson(`https://newsapi.org/v2/top-headlines?country=us&pageSize=1&apiKey=${encodeURIComponent(c.secret)}`),
    youtube: () => fetchJson(`https://www.googleapis.com/youtube/v3/videos?part=id&chart=mostPopular&maxResults=1&key=${encodeURIComponent(c.secret)}`),
    meta: () => fetchJson(`https://graph.facebook.com/${DEFAULTS.META_API_VERSION}/me?${form({ fields: "id,name", access_token: c.secret })}`),
    youtube_oauth: () => fetchJson("https://oauth2.googleapis.com/token", { method: "POST", body: form({ client_id: c.secret.client_id, client_secret: c.secret.client_secret, refresh_token: c.secret.refresh_token, grant_type: "refresh_token" }) }).then((t) => ({ token_type: t.token_type, expires_in: t.expires_in })),
    r2: async () => { const cfg = await r2Config(); if (!cfg) throw new Error("R2 fields incomplete"); await r2Request("PUT", "healthcheck.txt", Buffer.from("ok"), "text/plain"); await r2Request("DELETE", "healthcheck.txt"); return { bucket: cfg.bucket, public_url: cfg.public_url || "(none — set public_url so platforms can fetch files)" }; },
  };
  try { const r = await tests[c.provider](); json(ctx, 200, { ok: true, provider: c.provider, result: typeof r === "object" && r ? Object.fromEntries(Object.entries(r).slice(0, 4).map(([k, v]) => [k, typeof v === "string" ? v.slice(0, 80) : Array.isArray(v) ? `${v.length} item(s)` : v])) : r }); }
  catch (e) { json(ctx, 200, { ok: false, provider: c.provider, error: String(e.message).slice(0, 400) }); }
});
app.delete("/api/credentials/:id", async (ctx) => { const used = await one(`SELECT (SELECT COUNT(*) FROM channels WHERE credential_id=$1)::int + (SELECT COUNT(*) FROM adapter_configs WHERE credential_id=$1)::int AS n`, [ctx.params.id]); if (used.n) throw new ApiError(409, null, "Credential is still used by a channel or adapter instance — unlink it first"); await q(`DELETE FROM api_credentials WHERE id=$1`, [ctx.params.id]); json(ctx, 200, { ok: true }); });
// ---- adapter instances
app.get("/api/adapter-configs", async (ctx) => json(ctx, 200, (await instances(true)).map((r) => rowJson(r, ["config"]))));
app.post("/api/adapter-configs", async (ctx) => { const b = ctx.body; if (!b.key || !b.stage || !b.impl) throw new ApiError(400, null, "key, stage, impl are required"); if (!IMPLS[b.stage]?.[b.impl]) throw new ApiError(400, null, `Unknown impl ${b.impl} for stage ${b.stage}`); const id = newId(); await q(`INSERT INTO adapter_configs (id, key, stage, impl, label, config, credential_id, enabled) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`, [id, b.key, b.stage, b.impl, b.label || b.key, JSON.stringify(b.config || {}), b.credentialId || null, b.enabled === false ? 0 : 1]); instCache.at = 0; json(ctx, 201, rowJson(await one(`SELECT * FROM adapter_configs WHERE id=$1`, [id]), ["config"])); });
app.patch("/api/adapter-configs/:id", async (ctx) => { const r = await patchRow("adapter_configs", ctx.params.id, ctx.body, { label: "label", config: "config", credentialId: "credential_id", enabled: "enabled", impl: "impl" }); instCache.at = 0; json(ctx, 200, rowJson(r, ["config"])); });
app.delete("/api/adapter-configs/:id", async (ctx) => { await q(`DELETE FROM adapter_configs WHERE id=$1`, [ctx.params.id]); instCache.at = 0; json(ctx, 200, { ok: true }); });
app.post("/api/adapter-configs/:key/test", async (ctx) => { const row = (await instances(true)).find((r) => r.key === ctx.params.key); if (!row) throw new ApiError(404, null, "Unknown adapter key"); const a = await resolve(row.stage, row.key); let result; if (row.stage === "SCRIPT") result = await a.complete({ prompt: "Reply with the single word OK.", mock: {} }); else if (row.stage === "INGEST") result = { items: (await a.fetchItems({ name: "test", config: ctx.body.config || row.config })).slice(0, 3) }; else if (row.stage === "EMBED") result = { dims: (await a.embed("test"))?.length ?? null }; else result = { ok: true, note: "resolved; run it through a program to test end-to-end" }; json(ctx, 200, result); });
// ---- brands
app.get("/api/brands", async (ctx) => json(ctx, 200, await q(`SELECT * FROM brands ORDER BY created_at DESC`)));
app.post("/api/brands", async (ctx) => { if (!ctx.body.name) throw new ApiError(400, null, "name is required"); const id = newId(); await q(`INSERT INTO brands (id, name, description) VALUES ($1,$2,$3)`, [id, ctx.body.name, ctx.body.description ?? null]); json(ctx, 201, await one(`SELECT * FROM brands WHERE id=$1`, [id])); });
app.patch("/api/brands/:id", async (ctx) => json(ctx, 200, await patchRow("brands", ctx.params.id, ctx.body, { name: "name", description: "description" })));
app.delete("/api/brands/:id", async (ctx) => { const dep = await one(`SELECT (SELECT COUNT(*) FROM niches WHERE brand_id=$1)::int + (SELECT COUNT(*) FROM channels WHERE brand_id=$1)::int AS n`, [ctx.params.id]); if (dep.n) throw new ApiError(409, null, "Brand still has programs or channels"); await q(`DELETE FROM brands WHERE id=$1`, [ctx.params.id]); json(ctx, 200, { ok: true }); });
// ---- niches (programs)
const NICHE_JSON = ["method_config", "image_specs", "topic_filters", "clip_adapter_fallbacks", "script_adapter_fallbacks", "image_adapter_fallbacks"];
const NICHE_MAP = { displayName: "display_name", tone: "tone", visualMode: "visual_mode", topicSourceAdapter: "topic_source_adapter", scriptAdapter: "script_adapter", voiceAdapter: "voice_adapter", renderAdapter: "render_adapter", voiceId: "voice_id", factCheckStrict: "fact_check_strict", dedupThreshold: "dedup_threshold", isActive: "is_active",
  contentType: "content_type", productionMethod: "production_method", methodConfig: "method_config", language: "language", country: "country", approvalMode: "approval_mode", reviewWindowMinutes: "review_window_minutes", styleProfileId: "style_profile_id", publishToPortal: "publish_to_portal", imageAdapter: "image_adapter", imageSpecs: "image_specs", topicFilters: "topic_filters", maxItemsPerDay: "max_items_per_day", priority: "priority",
  downloadAdapter: "download_adapter", transcriptAdapter: "transcript_adapter", clipAdapter: "clip_adapter", clipAdapterFallbacks: "clip_adapter_fallbacks", scriptAdapterFallbacks: "script_adapter_fallbacks", imageAdapterFallbacks: "image_adapter_fallbacks", embedAdapter: "embed_adapter" };
app.get("/api/niches", async (ctx) => { const b = ctx.query.get("brandId"); const rows = b ? await q(`SELECT * FROM niches WHERE brand_id=$1 ORDER BY created_at DESC`, [b]) : await q(`SELECT * FROM niches ORDER BY created_at DESC`); json(ctx, 200, rows.map((r) => rowJson(r, NICHE_JSON))); });
app.get("/api/programs", async (ctx) => { const rows = await q(`SELECT n.*, (SELECT json_agg(json_build_object('id', s.id, 'name', s.name)) FROM sources s JOIN niche_sources ns ON ns.source_id=s.id WHERE ns.niche_id=n.id) AS sources, (SELECT json_agg(json_build_object('id', c.id, 'name', c.display_name, 'platform', c.platform)) FROM channels c JOIN channel_niches cn ON cn.channel_id=c.id WHERE cn.niche_id=n.id) AS channels FROM niches n ORDER BY created_at DESC`); json(ctx, 200, rows.map((r) => rowJson(r, NICHE_JSON))); });
app.post("/api/niches", async (ctx) => {
  const b = ctx.body; for (const r of ["brandId", "key", "displayName"]) if (!b[r]) throw new ApiError(400, null, `${r} is required`);
  const id = newId(); await q(`INSERT INTO niches (id, brand_id, key, display_name, tone, topic_source_adapter) VALUES ($1,$2,$3,$4,$5,$6)`, [id, b.brandId, b.key, b.displayName, b.tone || "", b.topicSourceAdapter || "newsapi_mock"]);
  const rest = { ...b }; delete rest.brandId; delete rest.key; delete rest.displayName; delete rest.tone; delete rest.topicSourceAdapter;
  const row = Object.keys(rest).some((k) => k in NICHE_MAP) ? await patchRow("niches", id, rest, NICHE_MAP) : await one(`SELECT * FROM niches WHERE id=$1`, [id]);
  if (Array.isArray(b.sourceIds)) for (const s of b.sourceIds) await q(`INSERT INTO niche_sources (id, niche_id, source_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [newId(), id, s]);
  json(ctx, 201, rowJson(row, NICHE_JSON));
});
app.post("/api/programs", async (ctx) => { ctx.req.url = "/api/niches"; const r = app.routes.find((x) => x.method === "POST" && x.re.test("/api/niches")); return r.handler(ctx); });
app.patch("/api/niches/:id", async (ctx) => json(ctx, 200, rowJson(await patchRow("niches", ctx.params.id, ctx.body, NICHE_MAP), NICHE_JSON)));
app.patch("/api/programs/:id", async (ctx) => json(ctx, 200, rowJson(await patchRow("niches", ctx.params.id, ctx.body, NICHE_MAP), NICHE_JSON)));
app.delete("/api/niches/:id", async (ctx) => { const dep = await one(`SELECT COUNT(*)::int AS n FROM content_items WHERE niche_id=$1`, [ctx.params.id]); if (dep.n) throw new ApiError(409, null, `Program has ${dep.n} content items — deactivate it instead (PATCH isActive:false)`); await q(`DELETE FROM series WHERE niche_id=$1`, [ctx.params.id]); await q(`DELETE FROM niches WHERE id=$1`, [ctx.params.id]); json(ctx, 200, { ok: true }); });
app.post("/api/niches/:id/sources/:sourceId", async (ctx) => { await q(`INSERT INTO niche_sources (id, niche_id, source_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [newId(), ctx.params.id, ctx.params.sourceId]); json(ctx, 200, { ok: true }); });
app.delete("/api/niches/:id/sources/:sourceId", async (ctx) => { await q(`DELETE FROM niche_sources WHERE niche_id=$1 AND source_id=$2`, [ctx.params.id, ctx.params.sourceId]); json(ctx, 200, { ok: true }); });
// ---- channels
const CHANNEL_MAP = { credentialId: "credential_id", displayName: "display_name", platform: "platform", format: "format", credentialRef: "credential_ref", scheduleCron: "schedule_cron", timezone: "timezone", isActive: "is_active", platformAccountId: "platform_account_id", platformConfig: "platform_config", publisherAdapter: "publisher_adapter", maxPostsPerDay: "max_posts_per_day", minGapMinutes: "min_gap_minutes", postingWindows: "posting_windows", captionTemplate: "caption_template" };
app.get("/api/channels", async (ctx) => { const b = ctx.query.get("brandId"); const rows = b ? await q(`SELECT * FROM channels WHERE brand_id=$1 ORDER BY created_at DESC`, [b]) : await q(`SELECT * FROM channels ORDER BY created_at DESC`); const out = []; for (const ch of rows) out.push({ ...rowJson(ch, ["platform_config", "posting_windows"]), niches: await q(`SELECT n.* FROM niches n JOIN channel_niches cn ON cn.niche_id=n.id WHERE cn.channel_id=$1`, [ch.id]) }); json(ctx, 200, out); });
app.post("/api/channels", async (ctx) => { const b = ctx.body; for (const r of ["brandId", "key", "displayName", "platform", "format"]) if (!b[r]) throw new ApiError(400, null, `${r} is required`); const id = newId(); await q(`INSERT INTO channels (id, brand_id, key, display_name, platform, format, timezone) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, b.brandId, b.key, b.displayName, b.platform, b.format, b.timezone || "Asia/Dhaka"]); const rest = { ...b }; for (const k of ["brandId", "key", "displayName", "platform", "format", "timezone"]) delete rest[k]; const row = Object.keys(rest).some((k) => k in CHANNEL_MAP) ? await patchRow("channels", id, rest, CHANNEL_MAP) : await one(`SELECT * FROM channels WHERE id=$1`, [id]); if (Array.isArray(b.nicheIds)) for (const n of b.nicheIds) await q(`INSERT INTO channel_niches (id, channel_id, niche_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [newId(), id, n]); json(ctx, 201, rowJson(row, ["platform_config", "posting_windows"])); });
app.patch("/api/channels/:id", async (ctx) => json(ctx, 200, rowJson(await patchRow("channels", ctx.params.id, ctx.body, CHANNEL_MAP), ["platform_config", "posting_windows"])));
app.delete("/api/channels/:id", async (ctx) => { const dep = await one(`SELECT COUNT(*)::int AS n FROM content_assets WHERE channel_id=$1`, [ctx.params.id]); if (dep.n) throw new ApiError(409, null, "Channel has publish history — deactivate instead"); await q(`DELETE FROM channels WHERE id=$1`, [ctx.params.id]); json(ctx, 200, { ok: true }); });
app.post("/api/channels/:id/niches/:nicheId", async (ctx) => { await q(`INSERT INTO channel_niches (id, channel_id, niche_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [newId(), ctx.params.id, ctx.params.nicheId]); json(ctx, 200, { ok: true }); });
app.delete("/api/channels/:id/niches/:nicheId", async (ctx) => { await q(`DELETE FROM channel_niches WHERE channel_id=$1 AND niche_id=$2`, [ctx.params.id, ctx.params.nicheId]); json(ctx, 200, { ok: true }); });
app.post("/api/channels/:id/test-publish", async (ctx) => { const ch = await one(`SELECT * FROM channels WHERE id=$1`, [ctx.params.id]); if (!ch) throw new ApiError(404, null, "Channel not found"); const pub = await resolve("PUBLISH", ch.publisher_adapter || PLATFORM_DEFAULT_PUBLISHER[ch.platform] || "publish_mock"); if (ch.platform !== "FACEBOOK" || pub.impl !== "meta_graph") return json(ctx, 200, { ok: true, note: `resolved publisher ${pub.key}; only Facebook text test-posts are supported here` }); json(ctx, 200, await pub.publish({ channel: ch, mediaKind: "TEXT", caption: ctx.body.message || "Content Engine connection test", title: "test" })); });
// ---- series
app.get("/api/series", async (ctx) => { const n = ctx.query.get("nicheId"); json(ctx, 200, n ? await q(`SELECT * FROM series WHERE niche_id=$1 ORDER BY created_at DESC`, [n]) : await q(`SELECT * FROM series ORDER BY created_at DESC`)); });
app.post("/api/series", async (ctx) => { const b = ctx.body; if (!b.nicheId || !b.key || !b.displayName) throw new ApiError(400, null, "nicheId, key, displayName are required"); const id = newId(); await q(`INSERT INTO series (id, niche_id, key, display_name) VALUES ($1,$2,$3,$4)`, [id, b.nicheId, b.key, b.displayName]); json(ctx, 201, await one(`SELECT * FROM series WHERE id=$1`, [id])); });
app.patch("/api/series/:id", async (ctx) => json(ctx, 200, await patchRow("series", ctx.params.id, ctx.body, { displayName: "display_name", isActive: "is_active", episodeCounter: "episode_counter" })));
// ---- style profiles
app.get("/api/style-profiles", async (ctx) => json(ctx, 200, (await q(`SELECT * FROM style_profiles ORDER BY name`)).map((r) => rowJson(r, ["banned_terms", "hashtags"]))));
app.post("/api/style-profiles", async (ctx) => { const b = ctx.body; if (!b.name) throw new ApiError(400, null, "name is required"); const id = newId(); await q(`INSERT INTO style_profiles (id, brand_id, name, language, tone, rules, examples, banned_terms, cta, hashtags) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb)`, [id, b.brandId || null, b.name, b.language || "en", b.tone || "", b.rules || "", b.examples || "", JSON.stringify(b.bannedTerms || []), b.cta || "", JSON.stringify(b.hashtags || [])]); json(ctx, 201, rowJson(await one(`SELECT * FROM style_profiles WHERE id=$1`, [id]), ["banned_terms", "hashtags"])); });
app.patch("/api/style-profiles/:id", async (ctx) => json(ctx, 200, rowJson(await patchRow("style_profiles", ctx.params.id, ctx.body, { name: "name", language: "language", tone: "tone", rules: "rules", examples: "examples", bannedTerms: "banned_terms", cta: "cta", hashtags: "hashtags", brandId: "brand_id" }), ["banned_terms", "hashtags"])));
app.delete("/api/style-profiles/:id", async (ctx) => { await q(`UPDATE niches SET style_profile_id=NULL WHERE style_profile_id=$1`, [ctx.params.id]); await q(`DELETE FROM style_profiles WHERE id=$1`, [ctx.params.id]); json(ctx, 200, { ok: true }); });
// ---- sources
app.get("/api/sources", async (ctx) => json(ctx, 200, (await q(`SELECT s.*, (SELECT json_agg(json_build_object('id', n.id, 'name', n.display_name)) FROM niches n JOIN niche_sources ns ON ns.niche_id=n.id WHERE ns.source_id=s.id) AS programs, (SELECT COUNT(*)::int FROM source_items si WHERE si.source_id=s.id) AS item_count FROM sources s ORDER BY created_at DESC`)).map((r) => rowJson(r, ["config"]))));
app.post("/api/sources", async (ctx) => { const b = ctx.body; if (!b.name || !b.adapterKey) throw new ApiError(400, null, "name and adapterKey are required"); const id = newId(); await q(`INSERT INTO sources (id, brand_id, name, kind, adapter_key, config, poll_interval_minutes, license_policy) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`, [id, b.brandId || null, b.name, b.kind || b.adapterKey.toUpperCase(), b.adapterKey, JSON.stringify(b.config || {}), b.pollIntervalMinutes ?? 30, b.licensePolicy || "ANY"]); if (Array.isArray(b.nicheIds)) for (const n of b.nicheIds) await q(`INSERT INTO niche_sources (id, niche_id, source_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [newId(), n, id]); json(ctx, 201, rowJson(await one(`SELECT * FROM sources WHERE id=$1`, [id]), ["config"])); });
app.patch("/api/sources/:id", async (ctx) => json(ctx, 200, rowJson(await patchRow("sources", ctx.params.id, ctx.body, { name: "name", kind: "kind", adapterKey: "adapter_key", config: "config", pollIntervalMinutes: "poll_interval_minutes", isActive: "is_active", licensePolicy: "license_policy" }), ["config"])));
app.delete("/api/sources/:id", async (ctx) => { await q(`DELETE FROM sources WHERE id=$1`, [ctx.params.id]); json(ctx, 200, { ok: true }); });
app.post("/api/sources/:id/poll", async (ctx) => { const jobId = await enqueue("INGEST_SOURCE", { sourceId: ctx.params.id }, { queue: "ingest", dedupeKey: `ingest:${ctx.params.id}`, priority: 10, maxAttempts: 1 }); json(ctx, 202, { jobId }); });
app.post("/api/sources/:id/preview", async (ctx) => { const s = await one(`SELECT * FROM sources WHERE id=$1`, [ctx.params.id]); if (!s) throw new ApiError(404, null, "Source not found"); const ing = await resolve("INGEST", s.adapter_key); json(ctx, 200, (await ing.fetchItems(s)).slice(0, 10)); });
app.get("/api/source-items", async (ctx) => { const s = ctx.query.get("sourceId"), st = ctx.query.get("status"); json(ctx, 200, await q(`SELECT si.*, s.name AS source_name FROM source_items si JOIN sources s ON s.id=si.source_id WHERE ($1::text IS NULL OR si.source_id=$1) AND ($2::text IS NULL OR si.status=$2) ORDER BY si.created_at DESC LIMIT 200`, [s, st])); });
app.post("/api/source-items/:id/route", async (ctx) => { const it = await one(`SELECT * FROM source_items WHERE id=$1`, [ctx.params.id]); if (!it) throw new ApiError(404, null, "Not found"); const raw = P(it.raw) || {}; const n = await routeSourceItem({ ...it, thumbnail: it.thumbnail_url, duration: raw.duration, views: raw.views, platform: raw.platform, license: raw.license }); json(ctx, 200, { routed: n }); });
// ---- video candidates & clips
app.get("/api/video-candidates", async (ctx) => { const st = ctx.query.get("status"), n = ctx.query.get("nicheId"); json(ctx, 200, (await q(`SELECT vc.*, n.display_name AS program_name, (SELECT COUNT(*)::int FROM clips c WHERE c.video_candidate_id=vc.id) AS clip_count FROM video_candidates vc LEFT JOIN niches n ON n.id=vc.niche_id WHERE ($1::text IS NULL OR vc.status=$1) AND ($2::text IS NULL OR vc.niche_id=$2) ORDER BY vc.score DESC, vc.created_at DESC LIMIT 200`, [st, n])).map((r) => ({ ...r, transcript: undefined, has_transcript: !!r.transcript }))); });
app.get("/api/video-candidates/:id", async (ctx) => { const r = await one(`SELECT * FROM video_candidates WHERE id=$1`, [ctx.params.id]); if (!r) throw new ApiError(404, null, "Not found"); json(ctx, 200, { ...rowJson(r, ["transcript"]), clips: await q(`SELECT * FROM clips WHERE video_candidate_id=$1 ORDER BY score DESC`, [r.id]) }); });
app.post("/api/video-candidates", async (ctx) => { const b = ctx.body; if (!b.nicheId || !b.url) throw new ApiError(400, null, "nicheId and url are required"); const niche = await one(`SELECT * FROM niches WHERE id=$1`, [b.nicheId]); if (!niche) throw new ApiError(404, null, "Program not found"); const id = newId(); await q(`INSERT INTO video_candidates (id, niche_id, source_url, title, platform, license, score, score_reason, status) VALUES ($1,$2,$3,$4,$5,$6,1,'manual','QUEUED')`, [id, b.nicheId, b.url, b.title || b.url, b.platform || null, b.license || "UNKNOWN"]); await enqueue("PROCESS_CANDIDATE", { candidateId: id }, { queue: "video", priority: 10, dedupeKey: `cand:${id}` }); json(ctx, 202, await one(`SELECT * FROM video_candidates WHERE id=$1`, [id])); });
app.post("/api/video-candidates/:id/process", async (ctx) => { await q(`UPDATE video_candidates SET status='QUEUED', error_message=NULL WHERE id=$1`, [ctx.params.id]); await enqueue("PROCESS_CANDIDATE", { candidateId: ctx.params.id }, { queue: "video", priority: 10, dedupeKey: `cand:${ctx.params.id}` }); json(ctx, 202, { ok: true }); });
app.post("/api/video-candidates/:id/ignore", async (ctx) => { await q(`UPDATE video_candidates SET status='IGNORED' WHERE id=$1`, [ctx.params.id]); json(ctx, 200, { ok: true }); });
app.get("/api/clips", async (ctx) => json(ctx, 200, await q(`SELECT c.*, vc.title AS source_title, vc.source_url FROM clips c JOIN video_candidates vc ON vc.id=c.video_candidate_id ORDER BY c.created_at DESC LIMIT 200`)));
// ---- media / portal / research
app.get("/api/media", async (ctx) => { const it = ctx.query.get("contentItemId"); json(ctx, 200, await q(`SELECT * FROM media_assets WHERE ($1::text IS NULL OR content_item_id=$1) ORDER BY created_at DESC LIMIT 200`, [it])); });
app.get("/api/portal-articles", async (ctx) => json(ctx, 200, await q(`SELECT * FROM portal_articles ORDER BY created_at DESC LIMIT 200`)));
app.patch("/api/portal-articles/:id", async (ctx) => json(ctx, 200, await patchRow("portal_articles", ctx.params.id, ctx.body, { title: "title", summary: "summary", bodyHtml: "body_html", status: "status", heroImageUrl: "hero_image_url" })));
app.get("/api/public/articles", async (ctx) => json(ctx, 200, await q(`SELECT id, slug, title, summary, hero_image_url, language, country, published_at FROM portal_articles WHERE status='PUBLISHED' ORDER BY published_at DESC LIMIT $1 OFFSET $2`, [Math.min(100, Number(ctx.query.get("limit")) || 30), Number(ctx.query.get("offset")) || 0])));
app.get("/api/public/articles/:slug", async (ctx) => { const a = await one(`SELECT * FROM portal_articles WHERE slug=$1 AND status='PUBLISHED'`, [ctx.params.slug]); if (!a) throw new ApiError(404, null, "Not found"); json(ctx, 200, a); });
app.get("/a/:slug", async (ctx) => { const a = await one(`SELECT * FROM portal_articles WHERE slug=$1 AND status='PUBLISHED'`, [ctx.params.slug]); if (!a) return send(ctx.res, 404, { error: "Not found" }); const esc = (s) => String(s || "").replace(/</g, "&lt;"); ctx.res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); ctx.res.end(`<!doctype html><html lang="${a.language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(a.title)}</title><meta property="og:title" content="${esc(a.title)}"><meta property="og:description" content="${esc(a.summary)}">${a.hero_image_url ? `<meta property="og:image" content="${a.hero_image_url}">` : ""}<style>body{font-family:system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 16px;line-height:1.7;color:#111}img{max-width:100%;border-radius:8px}h1{line-height:1.25}.meta{color:#666;font-size:14px}</style></head><body><h1>${esc(a.title)}</h1><div class="meta">${new Date(a.published_at).toLocaleString()}</div>${a.hero_image_url ? `<img src="${a.hero_image_url}" alt="">` : ""}<p><b>${esc(a.summary)}</b></p>${a.body_html}${a.source_url ? `<p class="meta">Source: <a href="${a.source_url}" rel="nofollow">${esc(a.source_url)}</a></p>` : ""}</body></html>`); });
app.get("/api/research-notes", async (ctx) => json(ctx, 200, (await q(`SELECT * FROM research_notes ORDER BY created_at DESC LIMIT 200`)).map((r) => rowJson(r, ["notes", "citations"]))));
// ---- content items (ledger + review)
const ITEM_JSON = ["source_data_ref", "script_meta", "niche_profile_version", "captions", "hashtags"];
async function itemWithMedia(row) { const r = rowJson(row, ITEM_JSON); r.hero_media = r.hero_media_id ? await one(`SELECT * FROM media_assets WHERE id=$1`, [r.hero_media_id]) : null; r.assets = await q(`SELECT a.*, c.display_name AS channel_name, c.platform FROM content_assets a JOIN channels c ON c.id=a.channel_id WHERE a.content_item_id=$1`, [r.id]); r.portal_url = r.portal_article_id ? portalUrlFor(await one(`SELECT slug FROM portal_articles WHERE id=$1`, [r.portal_article_id])) : null; return r; }
app.get("/api/content-items", async (ctx) => { const st = ctx.query.get("status"), n = ctx.query.get("nicheId"); const rows = await q(`SELECT ci.*, m.url AS hero_url, m.kind AS hero_kind, n.display_name AS program_name FROM content_items ci LEFT JOIN media_assets m ON m.id=ci.hero_media_id LEFT JOIN niches n ON n.id=ci.niche_id WHERE ($1::text IS NULL OR ci.status=$1) AND ($2::text IS NULL OR ci.niche_id=$2) ORDER BY ci.created_at DESC LIMIT 200`, [st, n]); json(ctx, 200, rows.map((r) => rowJson(r, ITEM_JSON))); });
app.get("/api/review", async (ctx) => { const rows = await q(`SELECT ci.*, m.url AS hero_url, m.kind AS hero_kind, n.display_name AS program_name, n.content_type AS program_type FROM content_items ci LEFT JOIN media_assets m ON m.id=ci.hero_media_id LEFT JOIN niches n ON n.id=ci.niche_id WHERE ci.status='PENDING_REVIEW' ORDER BY ci.review_deadline_at NULLS LAST, ci.created_at ASC LIMIT 100`); json(ctx, 200, rows.map((r) => rowJson(r, ITEM_JSON))); });
app.get("/api/content-items/:id", async (ctx) => { const it = await one(`SELECT * FROM content_items WHERE id=$1`, [ctx.params.id]); if (!it) throw new ApiError(404, null, "Not found"); json(ctx, 200, await itemWithMedia(it)); });
app.post("/api/generate", async (ctx) => {
  if (rateLimited(`gen:${ctx.ip}`, 20)) throw new ApiError(429, null, "Too many generate requests");
  const { nicheId, seriesId, sourceItemId, topic } = ctx.body; if (!nicheId) throw new ApiError(400, null, "nicheId is required");
  const niche = await one(`SELECT * FROM niches WHERE id=$1`, [nicheId]); if (!niche) throw new ApiError(404, null, "Program not found");
  if (VIDEO_TYPES.has(niche.content_type)) throw new ApiError(400, null, "Video-clip programs generate from video candidates (POST /api/video-candidates), not from Generate now");
  const itemId = await createQueuedItem(niche, { seriesId: seriesId || null, sourceItemId: sourceItemId || null, topic: topic || "", sourceDataRef: topic ? { provider: "manual", description: ctx.body.summary || "", url: ctx.body.url || null } : null });
  await enqueue("GENERATE_CONTENT", { itemId }, { queue: queueFor(niche.content_type), priority: 5, contentItemId: itemId });
  json(ctx, 202, await one(`SELECT * FROM content_items WHERE id=$1`, [itemId]));
});
app.post("/api/content-items/:id/approve", async (ctx) => { if (rateLimited(`appr:${ctx.ip}`, 30)) throw new ApiError(429, null, "Too many approve requests"); json(ctx, 200, await itemWithMedia(await approveItem(ctx.params.id, { scheduledFor: ctx.body.scheduledFor || null }))); });
app.post("/api/content-items/:id/reject", async (ctx) => json(ctx, 200, await rejectItem(ctx.params.id, ctx.body.note)));
app.post("/api/content-items/:id/regenerate", async (ctx) => { const part = ctx.body.part || "all"; if (!["all", "headline", "image", "captions", "body"].includes(part)) throw new ApiError(400, null, "part must be all|headline|image|captions|body"); const it = await one(`SELECT * FROM content_items WHERE id=$1`, [ctx.params.id]); if (!it) throw new ApiError(404, null, "Not found"); if (VIDEO_TYPES.has(it.content_type) && part === "all") { await enqueue("RENDER_CLIP", { itemId: it.id, clipId: it.clip_id }, { queue: "video", contentItemId: it.id }); } else { await setItem(it.id, { status: part === "all" ? "QUEUED" : "DRAFTING" }); await enqueue(part === "all" ? "GENERATE_CONTENT" : "REGENERATE", { itemId: it.id, part }, { queue: part === "image" ? "image" : queueFor(it.content_type), priority: 5, contentItemId: it.id }); } json(ctx, 202, { ok: true }); });
app.patch("/api/content-items/:id", async (ctx) => { const b = ctx.body; const map = { script: "script", headline: "headline", summary: "summary", body: "body", captions: "captions", hashtags: "hashtags", imagePrompt: "image_prompt", scheduledFor: "scheduled_for", heroMediaId: "hero_media_id" }; const row = await patchRow("content_items", ctx.params.id, b, map); json(ctx, 200, await itemWithMedia(row)); });
app.delete("/api/content-items/:id", async (ctx) => { await q(`DELETE FROM content_items WHERE id=$1 AND status IN ('FAILED','REJECTED')`, [ctx.params.id]); json(ctx, 200, { ok: true }); });
app.post("/api/content-items/:id/publish-now", async (ctx) => { await q(`UPDATE content_assets SET scheduled_for=now(), status='PENDING', error_message=NULL WHERE content_item_id=$1 AND status IN ('PENDING','FAILED')`, [ctx.params.id]); await sweepDueAssets(); json(ctx, 202, { ok: true }); });
// ---- assets / performance
app.post("/api/assets/:id/retry", async (ctx) => { await q(`UPDATE content_assets SET status='PENDING', scheduled_for=now(), error_message=NULL WHERE id=$1`, [ctx.params.id]); await enqueue("PUBLISH_ASSET", { assetId: ctx.params.id }, { queue: "publish", priority: 5, dedupeKey: `publish:${ctx.params.id}`, maxAttempts: 1 }); json(ctx, 202, { ok: true }); });
app.post("/api/assets/:id/performance", async (ctx) => { const b = ctx.body; const id = newId(); await q(`INSERT INTO performance_metrics (id, asset_id, views, avg_view_percent, ctr, likes, comments) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, ctx.params.id, b.views ?? 0, b.avgViewPercent ?? null, b.ctr ?? null, b.likes ?? 0, b.comments ?? 0]); json(ctx, 201, await one(`SELECT * FROM performance_metrics WHERE id=$1`, [id])); });
app.get("/api/assets/:id/performance", async (ctx) => json(ctx, 200, await q(`SELECT * FROM performance_metrics WHERE asset_id=$1 ORDER BY captured_at DESC`, [ctx.params.id])));
app.post("/api/assets/:id/check-repurpose", async (ctx) => { const r = await checkAndRepurpose(ctx.params.id); json(ctx, 200, { repurposed: !!r, newItem: r }); });
app.post("/api/assets/:id/poll-metrics", async (ctx) => { await pollMetrics(ctx.params.id); json(ctx, 200, await one(`SELECT last_metrics FROM content_assets WHERE id=$1`, [ctx.params.id])); });
// ---- jobs
app.get("/api/jobs", async (ctx) => { const it = ctx.query.get("contentItemId"), st = ctx.query.get("status"); json(ctx, 200, await q(`SELECT * FROM jobs WHERE ($1::text IS NULL OR content_item_id=$1) AND ($2::text IS NULL OR status=$2) ORDER BY created_at DESC LIMIT 200`, [it, st])); });
app.post("/api/jobs/:id/retry", async (ctx) => { await q(`UPDATE jobs SET status='PENDING', attempts=0, run_after=NULL, error_message=NULL WHERE id=$1 AND status='FAILED'`, [ctx.params.id]); json(ctx, 200, { ok: true }); });
// ---- seed (safe to call repeatedly)
app.post("/api/seed", async (ctx) => {
  let brand = await one(`SELECT * FROM brands WHERE name=$1`, ["Demo Media Co"]); if (!brand) { const id = newId(); await q(`INSERT INTO brands (id, name, description) VALUES ($1,$2,$3)`, [id, "Demo Media Co", "Starter brand"]); brand = await one(`SELECT * FROM brands WHERE id=$1`, [id]); }
  let niche = await one(`SELECT * FROM niches WHERE brand_id=$1 AND key=$2`, [brand.id, "bd_news"]); if (!niche) { const id = newId(); await q(`INSERT INTO niches (id, brand_id, key, display_name, tone, topic_source_adapter, content_type, country, language, publish_to_portal, approval_mode) VALUES ($1,$2,'bd_news','Bangladesh News','clear, factual, click-worthy','newsapi_mock','NEWS_STATIC','Bangladesh','en',1,'MANUAL')`, [id, brand.id]); niche = await one(`SELECT * FROM niches WHERE id=$1`, [id]); }
  let source = await one(`SELECT * FROM sources WHERE name=$1`, ["Mock BD feed"]); if (!source) { const id = newId(); await q(`INSERT INTO sources (id, brand_id, name, kind, adapter_key, config, poll_interval_minutes) VALUES ($1,$2,'Mock BD feed','MOCK','ingest_mock','{}',60)`, [id, brand.id]); source = await one(`SELECT * FROM sources WHERE id=$1`, [id]); }
  await q(`INSERT INTO niche_sources (id, niche_id, source_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [newId(), niche.id, source.id]);
  let ch = await one(`SELECT * FROM channels WHERE brand_id=$1 AND key=$2`, [brand.id, "fb_main"]); if (!ch) { const id = newId(); await q(`INSERT INTO channels (id, brand_id, key, display_name, platform, format, publisher_adapter, max_posts_per_day, min_gap_minutes) VALUES ($1,$2,'fb_main','Main Facebook Page','FACEBOOK','STATIC_IMAGE_CAPTION','publish_mock',12,30)`, [id, brand.id]); ch = await one(`SELECT * FROM channels WHERE id=$1`, [id]); }
  await q(`INSERT INTO channel_niches (id, channel_id, niche_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [newId(), ch.id, niche.id]);
  json(ctx, 200, { brandId: brand.id, nicheId: niche.id, sourceId: source.id, channelId: ch.id, note: "Mock source feeds a NEWS_STATIC program that publishes to the portal and a mock Facebook channel. Click 'Poll now' on the source or 'Generate now'." });
});

// === 11. boot ==============================================================
(async () => {
  await mkdir(TMP, { recursive: true }).catch(() => {});
  await migrate();
  if (process.argv.includes("--migrate")) { log("migration done, exiting"); await pool.end(); process.exit(0); }
  await recoverAbandonedWork();
  if (!ENV.DASHBOARD_PASSWORD) warn("DASHBOARD_PASSWORD is not set — the dashboard and API are OPEN. Fine locally, never on Render.");
  server.listen(PORT, async () => { log(`Content Engine listening on http://localhost:${PORT}  (worker ${WORKER_ID}, lanes: ${LANES.join(",") || "none"}, sweeps: ${RUN_SWEEPS}, storage: ${(await storageBackend()).name}, vault: ${vaultReady() ? "on" : "off — set SECRETS_KEY to store secrets from the dashboard"})`); startWorkers(); });
})().catch((e) => { console.error("boot failed:", e); process.exit(1); });

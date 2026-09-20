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
import { existsSync, createWriteStream, readFileSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import { createHash, createHmac, randomUUID, timingSafeEqual, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir, totalmem } from "node:os";
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
  // Tried in order when the main model is overloaded (503), unknown (404) or out of quota (429). Comma-separated; ""
  // disables. Quotas are counted per model, so a free key's small daily allowance is multiplied by this list.
  GEMINI_FALLBACK_MODELS: (ENV.GEMINI_FALLBACK_MODELS ?? "gemini-flash-lite-latest,gemini-2.5-flash,gemini-2.5-flash-lite").split(",").map((s) => s.trim()).filter(Boolean),
  GEMINI_IMAGE_MODEL: ENV.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image",
  GEMINI_TTS_MODELS: (ENV.GEMINI_TTS_MODELS ?? "gemini-2.5-flash-preview-tts,gemini-2.5-flash-tts,gemini-2.5-pro-preview-tts").split(",").map((s) => s.trim()).filter(Boolean),
  GEMINI_TTS_VOICE: ENV.GEMINI_TTS_VOICE || "Kore",
  GEMINI_EMBED_MODEL: ENV.GEMINI_EMBED_MODEL || "gemini-embedding-001",
  ELEVENLABS_MODEL: ENV.ELEVENLABS_MODEL || "eleven_multilingual_v2",
  ELEVENLABS_VOICE: ENV.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM",
  META_API_VERSION: ENV.META_API_VERSION || "v23.0",
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
// Feeds escape their punctuation in every style there is: &#039; and &#8217; for apostrophes, &hellip; for an ellipsis,
// and plenty are double-escaped (&amp;#039;). Numeric entities are decoded generically, named ones from the short list
// that actually appears in news, and the whole thing runs twice to undo one level of double-escaping.
const XML_NAMED = { lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", amp: "&" };
const decodeOnce = (s) => s
  .replace(/&#x([0-9a-f]{1,6});/gi, (m, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return m; } })
  .replace(/&#(\d{1,7});/g, (m, d) => { try { return String.fromCodePoint(Number(d)); } catch { return m; } })
  .replace(/&(lt|gt|quot|apos|nbsp|hellip|mdash|ndash|rsquo|lsquo|ldquo|rdquo|amp);/gi, (m, n) => XML_NAMED[n.toLowerCase()] ?? m);
const decodeXml = (s) => decodeOnce(decodeOnce(String(s || "")));
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const nice = (s) => String(s || "").replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
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
// "The model is experiencing high demand" is not this key's quota and not a network blip: the provider is busy, and it
// stays busy for minutes to hours. Worth waiting out rather than spending an hour of retries on.
const OVERLOAD_TEXT = /overloaded|high demand|UNAVAILABLE|currently unavailable|server is busy/i;
function isOverloaded(e) {
  if (!e) return false;
  if (e.causes?.length) return e.causes.every(isOverloaded);
  const s = `${e.message || ""} ${typeof e.body === "string" ? e.body : JSON.stringify(e.body || "")}`;
  return Number(e.status) === 503 || (isTransient(e) && OVERLOAD_TEXT.test(s));
}
// A provider's quota error, turned into how long to wait: a per-day (or free-tier) limit waits for the daily reset
// (midnight Pacific — Google's and OpenAI's reset), a per-minute one for the delay the API names. null = not a quota error.
function nextMidnightPacific() {
  const hour = (t) => Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: "America/Los_Angeles" }).format(t));
  let t = new Date(Date.now() + 3600e3); t.setUTCMinutes(5, 0, 0);
  for (let i = 0; i < 26 && hour(t) !== 0; i++) t = new Date(t.getTime() + 3600e3);
  return t;
}
// kind: "minute" (wait `seconds`), "day" (wait for the reset), "plan" (limit 0 — the plan doesn't include this model; no
// reset will help) or "billing" (out of prepaid credit). An error aggregated over fallbacks (e.causes) waits for the
// soonest reset among its quota causes, or backs off normally if one of them is an ordinary outage.
function quotaWait(e) {
  if (e?.causes?.length) {
    const qs = e.causes.map(quotaWait);
    if (e.causes.some((c, i) => !qs[i] && isTransient(c))) return null;
    return qs.filter((x) => x?.seconds).sort((a, b) => a.seconds - b.seconds)[0] || qs.find(Boolean) || null;
  }
  const s = `${e?.message || ""} ${typeof e?.body === "string" ? e.body : JSON.stringify(e?.body || "")}`;
  if (!(e?.status === 429 || /RESOURCE_EXHAUSTED|exceeded your current quota|rate limit/i.test(s))) return null;
  const freeTier = /free_tier|FreeTier/i.test(s), model = (/model: ([\w.-]+)/.exec(s) || [])[1] || null;
  if (/insufficient_quota/.test(s)) return { kind: "billing", seconds: null, freeTier, model };
  if (/limit: 0\b/.test(s)) return { kind: "plan", seconds: null, freeTier, model };
  if (/PerDay|per day|\bRPD\b/i.test(s)) return { kind: "day", seconds: Math.max(300, Math.round((nextMidnightPacific() - Date.now()) / 1000)), freeTier, model };
  const d = Number((/retry(?:Delay"?:\s*"| in )(\d+(?:\.\d+)?)s/i.exec(s) || [])[1]);
  return { kind: "minute", seconds: Math.max(30, Math.round(d || 60) + 5), freeTier, model };
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
  // settings.value is JSONB, so the driver hands back the value already parsed. Parsing it again turned every string
  // setting into null — a Telegram chat id set here was read as "not configured", and alerts went nowhere.
  settingsCache.map = Object.fromEntries((await q(`SELECT key, value FROM settings`)).map((r) => [r.key, typeof r.value === "string" ? r.value : P(r.value)]));
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

const DEFAULT_ENV = { anthropic: "ANTHROPIC_API_KEY", gemini: "GEMINI_API_KEY", openai: "OPENAI_API_KEY", pexels: "PEXELS_API_KEY", newsapi: "NEWSAPI_KEY", elevenlabs: "ELEVENLABS_API_KEY", youtube: "YOUTUBE_API_KEY", meta: "META_ACCESS_TOKEN", telegram: "TELEGRAM_BOT_TOKEN" };
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
      // A per-minute limit rests the key for as long as the API asks; a daily one for 30 min (other models on the key
      // may still have room); a plan limit (limit 0 on one model) says nothing about the key's other models.
      const qw = quotaWait(e), rest = qw?.kind === "minute" ? qw.seconds : qw?.kind === "plan" ? 0 : 1800;
      if (rest && !c.id.startsWith("env:")) await q(`UPDATE api_credentials SET cooldown_until = now() + ($3 || ' seconds')::interval, last_error = $2 WHERE id = $1`, [c.id, String(e.message).slice(0, 500), String(rest)]);
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
// Supabase Storage. The bucket is made on the first upload so setting the two env vars is all it takes; a bucket that
// already exists is used as it is, and a private one is reported rather than quietly opened — platforms fetch media by
// URL, so a private bucket means every post is published without its picture.
const supaUrl = () => String(ENV.SUPABASE_URL || "").replace(/\/+$/, "");
const supaBucket = () => ENV.SUPABASE_BUCKET || "media";
const supaAuth = () => ({ Authorization: `Bearer ${ENV.SUPABASE_SERVICE_ROLE_KEY}`, apikey: ENV.SUPABASE_SERVICE_ROLE_KEY });
let supabaseBucketChecked = false;
async function ensureSupabaseBucket() {
  if (supabaseBucketChecked) return;
  const bucket = supaBucket(), headers = { ...supaAuth(), "Content-Type": "application/json" };
  let existing = null;
  try { existing = await fetchJson(`${supaUrl()}/storage/v1/bucket/${bucket}`, { headers }); }
  catch (e) { if (e.status !== 404) throw e; }
  if (!existing) {
    await fetchJson(`${supaUrl()}/storage/v1/bucket`, { method: "POST", headers, body: JSON.stringify({ id: bucket, name: bucket, public: true }) })
      .catch((e) => { if (!/already exists|Duplicate/i.test(typeof e.body === "string" ? e.body : JSON.stringify(e.body || e.message))) throw e; });
    log(`supabase storage: created public bucket "${bucket}"`);
  } else if (existing.public === false) {
    warn(`supabase bucket "${bucket}" is private — media URLs will not open`);
    await notify("storage", `The Supabase bucket "${bucket}" is private`, "Facebook, Instagram and YouTube fetch media by URL, so posts will go out without their picture or video. Make the bucket public: Supabase → Storage → the bucket → Settings → Public.", { level: "error", key: "storage:private-bucket", cooldownHours: 24 }).catch(() => {});
  }
  supabaseBucketChecked = true;
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
    publicBase: async () => `${supaUrl()}/storage/v1/object/public/${supaBucket()}`,
    put: async (path, bytes, ct) => { await ensureSupabaseBucket(); await fetchJson(`${supaUrl()}/storage/v1/object/${supaBucket()}/${path}`, { method: "POST", body: bytes, headers: { ...supaAuth(), "Content-Type": ct, "x-upsert": "true" } }); return `${await STORAGE.supabase.publicBase()}/${path}`; },
    del: async (path) => { await fetchJson(`${supaUrl()}/storage/v1/object/${supaBucket()}`, { method: "DELETE", headers: { ...supaAuth(), "Content-Type": "application/json" }, body: JSON.stringify({ prefixes: [path] }) }).catch((e) => { if (e.status !== 404) throw e; }); },
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
// ffmpeg writes two kilobytes of build flags before anything else, so a failure that is kept as an error message ends
// up being mostly "--enable-libvorbis". Every call gets -hide_banner unless it asked for something else, which leaves
// the tail of stderr as what actually went wrong.
function exec(cmd, args, { timeoutMs = 45 * 60000, input = null } = {}) {
  if (/^(ffmpeg|ffprobe)/.test(cmd) && !args.includes("-hide_banner") && !args.includes("-version")) args = ["-hide_banner", ...args];
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
// `extra` lets a caller build an adapter with config it works out at runtime — one adapter standing in for another,
// without a configured instance for every combination.
async function resolve(stage, key, extra = null) {
  if (!key) throw new Error(`No ${stage} adapter configured`);
  const row = (await instances()).find((r) => r.key === key && r.stage === stage);
  const implId = row ? row.impl : (IMPLS[stage]?.[key] ? key : null);
  const def = implId && IMPLS[stage]?.[implId];
  if (!def) throw new Error(`Unknown ${stage} adapter "${key}" (impl "${implId || key}" is not registered)`);
  if (row && !flag(row.enabled)) throw new Error(`${stage} adapter instance "${key}" is disabled`);
  const cfg = { ...(P(row?.config) || {}), ...(extra || {}) };
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
  e.status = errors[0][1].status; e.transient = errors.some(([, x]) => isTransient(x)); e.causes = errors.map(([, x]) => x);
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
// respond = [{match, json}] returns json for calls whose system+prompt contains match (tests script the QA verdict etc.).
impl("SCRIPT", "llm_mock", { label: "Mock LLM", configSchema: { fail_first: { type: "number", default: 0 }, fail_status: { type: "number", default: 503 }, respond: { type: "array" } }, create: (cfg, ctx = {}) => ({
  async complete({ system, prompt, json, mock }) {
    if (cfg.fail_first) {
      const n = (mockFailures.get(ctx.key) || 0) + 1; mockFailures.set(ctx.key, n);
      if (n <= cfg.fail_first) throw new ApiError(cfg.fail_status || 503, null, cfg.fail_message || `mock ${cfg.fail_status || 503}: simulated failure ${n} of ${cfg.fail_first}`);
    }
    const rule = (cfg.respond || []).find((r) => `${system || ""}\n${prompt}`.includes(r.match));
    if (rule) return { text: JSON.stringify(rule.json), data: rule.json, cost: 0 };
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
// Runs call(model) on the main model, then on each fallback model while the failure is an overload (503/5xx), a quota
// (429 — Gemini's quotas are per model, so the next model often still has room), or an unknown model id (404).
// A permanent error is thrown straight away; when every model is out of quota, withKey tries the next key.
// A model whose daily allowance is spent, and when it comes back. The free tier grants that allowance per model
// (the quota Google names is PerDayPerProjectPerModel), so the rest of the account's models are untouched — this keeps
// the engine from spending a call on a model it already knows is finished for the day.
const modelSpent = new Map();
const spentUntil = (m) => modelSpent.get(m) || 0;
const isSpent = (m) => spentUntil(m) > Date.now();
// A model that is out for the day is skipped until it resets; one that is merely overloaded is skipped for a few
// minutes, so the next job starts on a different model instead of walking into the same wall.
function noteSpent(model, e) {
  const q = quotaWait(e);
  if (q?.kind === "day") modelSpent.set(model, Date.now() + q.seconds * 1000);
  else if (isOverloaded(e)) modelSpent.set(model, Date.now() + 180e3);
}
async function withModelFallback(models, call) {
  const errs = [], all = [...new Set(models.filter(Boolean))], fresh = all.filter((m) => !isSpent(m));
  for (const model of (fresh.length ? fresh : all)) {
    try { return await retryTransient(() => call(model)); }
    catch (e) {
      if (!isTransient(e) && e.status !== 404) throw e;
      errs.push(e); noteSpent(model, e);
      if (isTransient(e)) warn(`model ${model} unavailable (${e.status || ""} ${(quotaWait(e)?.kind || e.message).slice(0, 60)}), trying the next one`);
    }
  }
  // The error the caller should act on: an ordinary outage (retry soon) before a quota that resets soonest, before a
  // limit no reset will lift; all 404s → the last 404, so the caller can look for renamed models.
  const wait = (x) => quotaWait(x)?.seconds;
  if (!errs.length) throw new Error("No model is configured for this adapter");
  throw errs.find((x) => isTransient(x) && !quotaWait(x)) || errs.filter(wait).sort((a, b) => wait(a) - wait(b))[0] || errs.find(isTransient) || errs[errs.length - 1];
}
// Gemini model ids get renamed and retired. When every configured id of a kind answers 404, the account's live model list
// (cached 6 h) supplies the closest replacements of the same kind, so a retirement doesn't stop the pipeline.
const geminiCatalog = { at: 0, list: [] };
const GEMINI_KINDS = { text: (n) => /^gemini-.*(flash|pro)/.test(n) && !/image|tts|audio|live|embedding|vision|thinking-exp/.test(n), image: (n) => /image/.test(n) && /^gemini/.test(n), tts: (n) => /tts/.test(n) };
async function geminiReplacements(key, kind, tried, max = 3) {
  if (Date.now() - geminiCatalog.at > 6 * 3600e3 || !geminiCatalog.list.length) {
    const r = await fetchJson("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", { headers: { "x-goog-api-key": key } });
    geminiCatalog.list = (r.models || []).filter((m) => (m.supportedGenerationMethods || []).includes("generateContent")).map((m) => m.name.replace(/^models\//, "")); geminiCatalog.at = Date.now();
  }
  // Prefer "latest" aliases, then the highest version; flash before pro for text (cost), as configured defaults do.
  return geminiCatalog.list.filter((n) => GEMINI_KINDS[kind](n) && !tried.includes(n) && !isSpent(n))
    .sort((a, b) => Number(/latest/.test(b)) - Number(/latest/.test(a)) || Number(/lite/.test(a)) - Number(/lite/.test(b)) || Number(/flash/.test(b)) - Number(/flash/.test(a)) || b.localeCompare(a, undefined, { numeric: true })).slice(0, max);
}
// Two reasons to look past the configured models: they all answered 404 (renamed or retired), or they have all spent
// today's free allowance — which is granted per model, so the account's other models are a day's work the engine would
// otherwise leave on the table. Only when every model of that kind is spent does the job wait for the reset.
async function withGeminiModels(key, kind, models, call) {
  try { return await withModelFallback(models, call); }
  catch (e) {
    const spent = quotaWait(e)?.kind === "day";
    if (e.status !== 404 && !spent) throw e;
    const alt = await geminiReplacements(key, kind, models, spent ? 8 : 3).catch(() => []); if (!alt.length) throw e;
    warn(`Gemini ${kind}: ${models.join(", ")} ${spent ? "have spent today's free allowance" : "not found"}; trying ${alt.join(", ")}`);
    return withModelFallback(alt, call);
  }
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
      const { model, body } = await withGeminiModels(key, "text", models, async (m) => ({ model: m, body: await fetchJson(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
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
  async fetchItems(source) {
    // config.items = [{title, url, summary?}] makes the feed return exactly those (tests); otherwise two fresh mock stories.
    const fixed = P(source.config)?.items; if (Array.isArray(fixed)) return fixed.map((x) => ({ external_id: x.url, summary: "", published_at: nowIso(), kind: "ARTICLE", ...x }));
    const n = Date.now(); return [0, 1].map((i) => ({ external_id: `mock-${n}-${i}`, url: `https://example.com/story/${n}-${i}`, title: `Mock story ${n % 1000}-${i} from ${source.name}`, summary: "A deterministic mock story used to exercise the pipeline without any keys.", published_at: nowIso(), kind: "ARTICLE" })); } }) });
// Several Bangladeshi outlets answer 403 to non-browser user agents; feeds are public, so a browser UA is used.
// Outlets label their own headlines for their own site: "WATCH:", "LOOK:", "Report:", a section name before a pipe.
// None of it belongs on a card or in a narration — it is the outlet talking to its readers, not part of the story.
// "Opinion" and "Analysis" stay: they change what the piece is, and a news program presenting a column as reporting is
// a different and worse problem than an untidy headline.
const TITLE_LABEL = /^\s*(?:watch|look|listen|video|photos?|gallery|live|updates?|breaking|exclusive|explainer|read|must read|in pictures|in pics|just in|developing)\s*[:\-–—]\s*/i;
function tidyTitle(t) {
  let out = String(t || "").trim();
  for (let i = 0; i < 3 && TITLE_LABEL.test(out); i++) out = out.replace(TITLE_LABEL, "");
  return out.replace(/\s+\|\s+[^|]{1,40}$/, "").trim() || String(t || "").trim();
}
const FEED_UA = ENV.FEED_USER_AGENT || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
// Several outlets answer a datacenter IP differently depending on what is asking. A browser user agent is refused by
// some WAFs precisely because a browser would not be fetching XML; a declared feed reader is waved through by those and
// refused by others. So a refusal is retried as somebody else before it counts as a refusal — three cheap requests
// against losing an outlet's own summaries and photographs for good.
const FEED_AGENTS = [
  null,                                                                     // FEED_UA: a current desktop browser
  "Feedly/1.0 (+https://feedly.com/fetcher.html; like FeedFetcher-Google)",
  "Mozilla/5.0 (compatible; RSS reader)",
];
async function fetchFeed(url) {
  let last = null;
  for (const [i, ua] of FEED_AGENTS.entries()) {
    try {
      const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(25000),
        headers: { "user-agent": ua || FEED_UA, accept: "application/rss+xml,application/atom+xml,application/xml,text/xml;q=0.9,*/*;q=0.8", "accept-language": "en,bn;q=0.9" } });
      if (res.ok) { if (i) log(`feed ${url.split("?")[0]} needed a second identity (${i}) to answer`); return res.text(); }
      last = new ApiError(res.status, null, `Feed ${url.split("?")[0]} -> ${res.status}`);
      if (![403, 406, 429, 503].includes(res.status)) break;               // a 404 is a 404 whoever asks
    } catch (e) { last = e; break; }                                        // a network failure is not about identity
  }
  throw last || new Error(`Feed ${url.split("?")[0]} could not be read`);
}
// `via_site` is the outlet's domain, used only when its own feed cannot be read. An outlet's feed carries what Google
// News strips — the summary, the article's real url, and the photo it ran — so it is always tried first; but several
// Bangladeshi outlets answer 403 to datacenter IPs while opening fine from a home connection, and a source that works
// on a laptop and not on the server is worse than one that quietly falls back.
impl("INGEST", "rss", { label: "RSS / Atom", configSchema: { url: { type: "string", required: true }, limit: { type: "number", default: 30 }, via_site: { type: "string" } }, create: (cfg, ctx = {}) => ({
  async fetchItems(source) {
    const c = { ...(P(source.config) || {}), ...cfg };
    const url = c.url; if (!url) throw new Error("RSS source needs config.url");
    const limit = c.limit || 30; let why = "";
    try {
      const items = parseFeed(await fetchFeed(url));
      // Reading directly again clears the note the fallback leaves behind, so the dashboard tracks reality.
      if (items.length) { if (source.id) await q(`UPDATE sources SET read_mode='direct', read_note=NULL WHERE id=$1`, [source.id]).catch(() => {}); return items.slice(0, limit); }
      if (!c.via_site) return items;
      warn(`feed ${url} came back empty — reading ${c.via_site} through Google News instead`);
    } catch (e) {
      if (!c.via_site) throw e;
      why = e.message.slice(0, 90);
      warn(`feed ${url} unreadable (${why}) — reading ${c.via_site} through Google News instead`);
    }
    // Recorded on the source, because a feed that quietly drops to Google News looks perfectly healthy in the
    // dashboard while losing every photograph and every summary the outlet publishes.
    if (source.id) await q(`UPDATE sources SET read_mode='google_news', read_note=$2 WHERE id=$1`, [source.id, `The outlet's own feed did not answer this server${why ? ` (${why})` : ""}. Reading it through Google News instead: headlines only, no summary and no photo.`]).catch(() => {});
    const gnews = await resolve("INGEST", "google_news", { site: c.via_site, language: source.language || c.language });
    return (await gnews.fetchItems(source)).slice(0, limit);
  } }) });
// Google News needs no key and reaches outlets whose own feeds are blocked (Cloudflare) or missing: a search ("query"
// and/or "site") or an edition's top stories. Titles arrive as "Headline - Outlet"; the outlet is split off. Links are
// Google redirect URLs, so the article text usually comes from other outlets in the same story cluster (news desk).
const GN_NOISE = /e-?paper|ইপেপার|আর্কাইভ|\barchive\b|video gallery|photo gallery|today'?s'? paper|todays'? paper|^[\s\-–|]*$/i;
function googleNewsUrl(c, base = "https://news.google.com") {
  const bn = /^bn/i.test(c.language || c.hl || ""); const gl = c.gl || "BD";
  const hl = c.hl || (bn ? "bn" : "en-BD"), ceid = c.ceid || `${gl}:${bn ? "bn" : "en"}`;
  if (!c.query && !c.site) return `${base}/rss?${form({ hl, gl, ceid })}`;
  const q = [c.query, c.site ? `site:${c.site}` : null, c.when === "" ? null : `when:${c.when || "1d"}`].filter(Boolean).join(" ");
  return `${base}/rss/search?${form({ q, hl, gl, ceid })}`;
}
impl("INGEST", "google_news", { label: "Google News (search / edition, no key)", configSchema: { query: { type: "string" }, site: { type: "string" }, language: { type: "string", default: "en" }, when: { type: "string", default: "1d" }, limit: { type: "number", default: 40 } }, create: (cfg) => ({
  async fetchItems(source) {
    const c = { ...cfg, ...(P(source.config) || {}) }; const out = [];
    for (const m of (await fetchFeed(googleNewsUrl(c, await setting("google_news.base", "https://news.google.com")))).matchAll(/<item\b[\s\S]*?<\/item>/gi)) {
      const [it] = parseFeed(m[0]); if (!it) continue;
      const outlet = decodeXml((m[0].match(/<source[^>]*>([\s\S]*?)<\/source>/i) || [])[1] || "").trim();
      const title = outlet && it.title.endsWith(` - ${outlet}`) ? it.title.slice(0, -(outlet.length + 3)).trim() : it.title;
      // Google also indexes outlets' tag and section pages ("tech companies", "Tokyo Olympics"): real headlines are longer.
      if (!title || GN_NOISE.test(title) || title.split(/\s+/).filter(Boolean).length < 4) continue;
      // Google names the outlet, but sometimes only as a hostname ("today.thefinancialexpress.com.bd"), which would end
      // up in a photocard's source credit. For a single-outlet source the name on the source is the one a reader knows;
      // a mixed query feed keeps whatever Google said, since every item is a different outlet.
      const named = outlet && !/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(outlet) ? outlet : c.site ? source.name : outlet;
      out.push({ ...it, title, summary: "", raw: { outlet: named, via: "google_news" } });
    }
    return out.slice(0, c.limit || 40);
  } }) });
// A YouTube channel's public feed (latest 15 uploads, no key). Duration is unknown until download; views are included.
impl("INGEST", "youtube_rss", { label: "YouTube channel feed (no key)", configSchema: { channel_id: { type: "string", required: true }, limit: { type: "number", default: 15 } }, create: (cfg) => ({
  async fetchItems(source) {
    const c = { ...cfg, ...(P(source.config) || {}) }; if (!c.channel_id) throw new Error("youtube_rss source needs config.channel_id (UC…)");
    const xml = await fetchFeed(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(c.channel_id)}`);
    const channel = decodeXml((xml.match(/<author>\s*<name>([\s\S]*?)<\/name>/) || [])[1] || "").trim();
    const tag = (b, t) => decodeXml((b.match(new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)</${t}>`)) || [])[1] || "").trim();
    return [...xml.matchAll(/<entry>[\s\S]*?<\/entry>/g)].map(({ 0: b }) => {
      const id = tag(b, "yt:videoId"); if (!id) return null; const published = tag(b, "published");
      return { external_id: id, url: `https://www.youtube.com/watch?v=${id}`, title: tag(b, "title"), summary: tag(b, "media:description").slice(0, 2000), kind: "VIDEO", platform: "YOUTUBE", license: "STANDARD",
        published_at: published && !isNaN(Date.parse(published)) ? new Date(published).toISOString() : null, thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
        views: Number((b.match(/<media:statistics views="(\d+)"/) || [])[1] || 0), raw: { channel } };
    }).filter((x) => x && x.title).slice(0, c.limit || 15);
  } }) });
// Google News sitemaps (<news:title>, <news:publication_date>) for outlets without a usable RSS feed. {yyyy} {mm} {dd}
// in the URL are replaced with today's date (UTC) for sitemaps split by day.
impl("INGEST", "sitemap", { label: "News sitemap", configSchema: { url: { type: "string", required: true }, limit: { type: "number", default: 40 } }, create: (cfg) => ({
  async fetchItems(source) {
    const c = { ...cfg, ...(P(source.config) || {}) }; if (!c.url) throw new Error("sitemap source needs config.url");
    const d = new Date().toISOString(); const url = c.url.replace("{yyyy}", d.slice(0, 4)).replace("{mm}", d.slice(5, 7)).replace("{dd}", d.slice(8, 10));
    const tag = (b, t) => decodeXml(((b.match(new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)</${t}>`, "i")) || [])[1] || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")).trim();
    const items = [...(await fetchFeed(url)).matchAll(/<url>[\s\S]*?<\/url>/gi)].map(({ 0: b }) => {
      const loc = tag(b, "loc"), title = stripHtml(tag(b, "news:title")), date = tag(b, "news:publication_date") || tag(b, "lastmod");
      return loc && title ? { external_id: loc, url: loc, title, summary: "", kind: "ARTICLE", thumbnail: tag(b, "image:loc") || null, published_at: date && !isNaN(Date.parse(date)) ? new Date(date).toISOString() : null } : null;
    }).filter(Boolean);
    return items.sort((a, b) => Date.parse(b.published_at || 0) - Date.parse(a.published_at || 0)).slice(0, c.limit || 40);
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

// A direct file: an http(s) link to a video (your uploads, a CDN, a partner's link) streamed to disk, or a local path.
impl("DOWNLOAD", "direct", { label: "Direct link / uploaded file", create: () => ({
  async download(url) {
    await mkdir(TMP, { recursive: true });
    const out = join(TMP, `${randomUUID()}${extname(String(url).split("?")[0]) || ".mp4"}`);
    if (/^https?:/.test(url)) {
      const res = await fetch(url, { redirect: "follow" }); if (!res.ok || !res.body) throw new ApiError(res.status, null, `download ${url.split("?")[0]} -> ${res.status}`);
      await pipeline(Readable.fromWeb(res.body), createWriteStream(out));
    } else if (existsSync(url)) await writeFile(out, await readFile(url));
    else throw new Error(`Not a URL or an existing file: ${url}`);
    return { path: out, duration: await ffprobeDuration(out) };
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
// A file path as a filtergraph option value: quoted so the graph parser passes it through, colon escaped for the option
// parser (Windows drive letters), forward slashes throughout.
const ffPath = (p) => `'${String(p).replace(/\\/g, "/").replace(/'/g, "").replace(/:/g, "\\:")}'`;
const assColor = (hex, alpha = "00") => { const m = /^#?([0-9a-f]{6})$/i.exec(hex || ""); if (!m) return `&H${alpha}FFFFFF`; const h = m[1]; return `&H${alpha}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase(); };
async function imageDims(file) { const { out } = await exec("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file]); const [w, h] = out.trim().split(",").map(Number); return { width: w || 1080, height: h || 1080 }; }
async function composeHeadline(inPath, headline, specs = {}) {
  const { width: w, height: h } = await imageDims(inPath);
  const short = w > h, size = Math.round(h * (short ? 0.062 : 0.05) * (specs.overlay_scale || 1)), small = Math.round(size * 0.48);
  // The brand tag sits at the top. It used to be pinned just above the middle of the frame, where a headline set large
  // enough to be read at thumbnail size grows straight through it.
  const mL = Math.round(w * 0.06), mV = Math.round(h * 0.075), accent = assColor(specs.accent_color || "#6c8cff"), fg = assColor(specs.text_color || "#ffffff");
  const ass = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${w}\nPlayResY: ${h}\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Head,${OVERLAY_FONT},${size},${fg},${fg},&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,${Math.max(1, Math.round(size * 0.03))},${Math.round(size * 0.04)},1,${mL},${mL},${mV},1\nStyle: Tag,${OVERLAY_FONT},${small},${accent},${accent},&H00000000,&H00000000,-1,0,0,0,100,100,${/[ঀ-৿]/.test(String(specs.brand || "")) ? 0 : Math.round(small * 0.08)},0,1,0,0,1,${mL},${mL},${mV},1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${specs.brand ? `Dialogue: 0,0:00:00.00,0:00:10.00,Tag,,0,0,0,,{\\an7\\pos(${mL},${mV})}${assEsc(specs.brand).toUpperCase()}\n` : ""}Dialogue: 1,0:00:00.00,0:00:10.00,Head,,0,0,0,,${assEsc(headline)}\n`;
  const assPath = tmpPath("ass"), out = tmpPath("jpg"); await writeFile(assPath, ass);
  // A gradient, not three steps: at three the seams are visible straight lines across the picture. Twelve overlapping
  // boxes of low alpha compound into a smooth ramp from the middle of the frame to the bottom.
  // Big cover type sits over whatever the photo happens to be doing; the ramp deepens to carry it.
  const step = (specs.overlay_scale || 1) > 1.3 ? 0.135 : 0.11;
  const band = Array.from({ length: 12 }, (_, i) => `drawbox=x=0:y=ih*${(0.52 + i * 0.038).toFixed(3)}:w=iw:h=ih:color=black@${step}:t=fill`).join(",");
  try { await exec("ffmpeg", ["-y", "-i", inPath, "-vf", `${band},${assVf(assPath)}`, "-frames:v", "1", "-q:v", "2", out], { timeoutMs: 90000 }); return out; }
  finally { await cleanup(assPath); }
}
// ---- Photocard: the standard Bangladeshi news-page post. Picture on top, a panel in the brand colour holding the headline,
// an accent rule, the brand logo, the date (Bangla digits for Bangla cards) and the source credit. Also libass for text.
// Brand kit (brands.brand_kit): logo_url, primary_color, accent_color, text_color, font, fonts_url, handle, image_ratio,
// logo_scale, credit_sources. image_specs.layout on a program: "photocard" (default) | "overlay" (text over the photo).
function cardDate(lang, tz = "Asia/Dhaka") {
  try { return new Intl.DateTimeFormat(lang === "bn" ? "bn-BD" : "en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: tz }).format(new Date()); }
  catch { return new Date().toISOString().slice(0, 10); }
}
// Largest font size (from base down) at which the text, wrapped at an estimated glyph width, fits the box.
function fitFontSize(text, width, height, base, glyph) {
  let size = base;
  for (; size > base * 0.5; size -= 2) { const perLine = Math.max(6, Math.floor(width / (size * glyph))); if (Math.ceil(String(text).length / perLine) * size * 1.3 <= height) break; }
  return Math.round(size);
}
// A brand's custom fonts (fonts_url: a .ttf/.otf, or several comma-separated) are fetched once into a per-process fonts dir.
const fontsDirCache = new Map();
async function brandFontsDir(kit) {
  if (!kit?.fonts_url) return null;
  if (fontsDirCache.has(kit.fonts_url)) return fontsDirCache.get(kit.fonts_url);
  const dir = join(TMP, "fonts", sha(kit.fonts_url).slice(0, 12)); await mkdir(dir, { recursive: true });
  for (const u of String(kit.fonts_url).split(",").map((s) => s.trim()).filter(Boolean)) { try { await writeFile(join(dir, u.split("/").pop().split("?")[0] || "font.ttf"), await fetchBytes(u)); } catch (e) { warn(`brand font ${u}: ${e.message}`); } }
  fontsDirCache.set(kit.fonts_url, dir); return dir;
}
async function composePhotocard(inPath, headline, specs = {}) {
  const kit = specs.kit || {}, meta = specs.card_meta || {};
  const W = specs.width || 1080, H = specs.height || 1080, split = Math.round(H * (kit.image_ratio || 0.6)), m = Math.round(W * 0.055);
  const bn = /[ঀ-৿]/.test(headline), font = kit.font || OVERLAY_FONT;
  const metaSize = Math.round(H * 0.024), metaBand = Math.round(metaSize * 2.6);
  const size = fitFontSize(headline, W - 2 * m, H - split - metaBand - Math.round(m * 1.2), Math.round(H * 0.068), bn ? 0.54 : 0.5);
  const fg = assColor(kit.text_color || "#ffffff"), dim = assColor(kit.text_color || "#ffffff", "50"), acc = assColor(kit.accent_color || "#ffc400");
  const hex = (c, d) => (/^#?[0-9a-f]{6}$/i.test(c || "") ? c : d).replace("#", "0x");
  const metaLine = [meta.date, meta.credit].filter(Boolean).join("   •   ");
  const style = (name, sz, col, bold, align, mv) => `Style: ${name},${font},${sz},${col},${col},&H00000000,&H00000000,${bold ? -1 : 0},0,0,0,100,100,0,0,1,0,0,${align},${m},${m},${mv},1`;
  const ass = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${W}\nPlayResY: ${H}\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n`
    + [style("Head", size, fg, true, 7, split + Math.round(m * 0.8)), style("Meta", metaSize, dim, false, 1, Math.round(metaSize * 0.9)), style("Handle", metaSize, acc, true, 3, Math.round(metaSize * 0.9)),
      // A photo that only illustrates the story says so, in the corner of the picture, outlined so it reads on anything.
      `Style: Photo,${font},${Math.round(metaSize * 0.8)},${assColor("#ffffff")},${assColor("#ffffff")},&H96000000,&H00000000,0,0,0,0,100,100,0,0,1,${Math.max(1, Math.round(metaSize * 0.09))},0,3,${Math.round(m * 0.6)},${Math.round(m * 0.6)},${H - split + Math.round(metaSize * 0.5)},1`].join("\n")
    + `\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:10.00,Head,,0,0,0,,${assEsc(headline)}\n`
    + (metaLine ? `Dialogue: 0,0:00:00.00,0:00:10.00,Meta,,0,0,0,,${assEsc(metaLine)}\n` : "") + (kit.handle ? `Dialogue: 0,0:00:00.00,0:00:10.00,Handle,,0,0,0,,${assEsc(kit.handle)}\n` : "")
    + (specs.photo_credit ? `Dialogue: 1,0:00:00.00,0:00:10.00,Photo,,0,0,0,,${assEsc(specs.photo_credit)}\n` : "");
  const assPath = tmpPath("ass"), out = tmpPath("jpg"); await writeFile(assPath, ass);
  let logo = null; if (kit.logo_url) { try { logo = await toTmpFile(kit.logo_url, "png"); } catch (e) { warn(`brand logo: ${e.message}`); } }
  const fontsDir = await brandFontsDir(kit);
  let fc = `color=c=${hex(kit.primary_color, "#b3121f")}:s=${W}x${H}:d=1[bg];[0:v]scale=${W}:${split}:force_original_aspect_ratio=increase,crop=${W}:${split},setsar=1[img];[bg][img]overlay=0:0[b0];`
    + `[b0]drawbox=x=0:y=${split}:w=${W}:h=${Math.max(4, Math.round(H * 0.008))}:color=${hex(kit.accent_color, "#ffc400")}@1:t=fill[b1]`;
  let last = "b1";
  if (logo) { fc += `;[1:v]scale=${Math.round(W * (kit.logo_scale || 0.17))}:-1[lg];[${last}][lg]overlay=${m}:${m}[b2]`; last = "b2"; }
  fc += `;[${last}]${assVf(assPath, fontsDir)}[out]`;
  try { await exec("ffmpeg", ["-y", "-i", inPath, ...(logo ? ["-i", logo] : []), "-filter_complex", fc, "-map", "[out]", "-frames:v", "1", "-q:v", "2", out], { timeoutMs: 90000 }); return out; }
  finally { await cleanup(assPath, logo); }
}
// ---- Text card: the photocard without a picture, for when no picture can be made (no image key, a plan with no image
// quota, an outage) — the post still goes out, in the brand's colours: a gradient in the brand colour, the logo (and a
// faint oversized copy as texture), a small label, the headline set large above the same rule, date, credit and handle
// as the photocard. With an empty headline it is just the branded backdrop, which reel sections use as their picture.
const rgb255 = (c, dflt) => { const h = (/^#?[0-9a-f]{6}$/i.test(c || "") ? c : dflt).replace("#", ""); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
async function composeTextCard(headline, specs = {}) {
  const kit = specs.kit || {}, meta = specs.card_meta || {};
  const W = specs.width || 1080, H = specs.height || 1080, m = Math.round(W * 0.062);
  const text = String(headline || "").trim(), bn = /[ঀ-৿]/.test(text + (specs.brand || "")), font = kit.font || OVERLAY_FONT;
  const [R, G, B] = rgb255(kit.primary_color, "#b3121f");
  const fg = assColor(kit.text_color || "#ffffff"), dim = assColor(kit.text_color || "#ffffff", "55"), acc = assColor(kit.accent_color || "#ffc400");
  const hexc = (c, d) => (/^#?[0-9a-f]{6}$/i.test(c || "") ? c : d).replace("#", "0x");
  const metaSize = Math.round(H * 0.024), metaBand = Math.round(metaSize * 2.6);
  const labelSize = Math.round(H * 0.028), labelPad = Math.round(labelSize * 0.45);
  const label = text ? String(specs.label ?? (bn ? "সর্বশেষ" : "LATEST")).trim().slice(0, 28) : "";
  const logoBox = Math.round(W * (kit.logo_scale || 0.17));
  let logo = null; if (kit.logo_url) { try { logo = await toTmpFile(kit.logo_url, "png"); } catch (e) { warn(`brand logo: ${e.message}`); } }
  const alpha = logo ? await exec("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=pix_fmt", "-of", "csv=p=0", logo]).then(({ out }) => /^(rgba|bgra|argb|abgr|ya\d|yuva|gbrap)/.test(out.trim())).catch(() => false) : false;
  // The headline sits on the bottom margin and grows upward; the label rides just above it, so a short headline reads as
  // one block instead of floating. Both stay clear of the logo.
  const headBottom = metaBand + Math.round(m * 0.6), logoBottom = logo ? m + logoBox + Math.round(m * 0.55) : m;
  const labelH = label ? Math.round(labelSize * 2.6) : 0, glyph = bn ? 0.54 : 0.5;
  const size = fitFontSize(text, W - 2 * m, H - headBottom - logoBottom - labelH, Math.round(H * 0.105), glyph);
  const lines = Math.max(1, Math.ceil(text.length / Math.max(6, Math.floor((W - 2 * m) / (size * glyph)))));
  const labelTop = Math.max(logoBottom, H - headBottom - Math.round(lines * size * 1.34) - labelH - Math.round(m * 0.3));
  const st = (name, sz, col, bold, align, mv, box = null) => `Style: ${name},${font},${sz},${col},${col},${box || "&H00000000"},&H00000000,${bold ? -1 : 0},0,0,0,100,100,0,0,${box ? 3 : 1},${box ? labelPad : 0},0,${align},${m},${m},${mv},1`;
  const metaLine = [meta.date, meta.credit].filter(Boolean).join("   •   ");
  const ass = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${W}\nPlayResY: ${H}\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\n${ASS_FORMAT}\n`
    + [st("Head", size, fg, true, 1, headBottom), st("Label", labelSize, assColor(kit.label_color || "#141414"), true, 7, 0, acc), st("Meta", metaSize, dim, false, 1, Math.round(metaSize * 0.9)), st("Handle", metaSize, acc, true, 3, Math.round(metaSize * 0.9))].join("\n")
    + `\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`
    + (label ? `Dialogue: 0,0:00:00.00,0:00:10.00,Label,,0,0,0,,{\\an7\\pos(${m + labelPad},${labelTop + labelPad})}${assEsc(label)}\n` : "")
    + (text ? `Dialogue: 1,0:00:00.00,0:00:10.00,Head,,0,0,0,,${assEsc(text)}\n` : "")
    + (text && metaLine ? `Dialogue: 0,0:00:00.00,0:00:10.00,Meta,,0,0,0,,${assEsc(metaLine)}\n` : "")
    + (text && kit.handle ? `Dialogue: 0,0:00:00.00,0:00:10.00,Handle,,0,0,0,,${assEsc(kit.handle)}\n` : "");
  const assPath = tmpPath("ass"), out = tmpPath("jpg"); await writeFile(assPath, ass);
  const fontsDir = await brandFontsDir(kit);
  // A card is mostly covered by its headline, so a plain diagonal fade is enough. A backdrop is the whole frame of a
  // reel section, and a flat field there reads as a missing picture: a broad diagonal sheen and a soft vignette give it
  // somewhere to look. Written without commas, which a geq expression inside a filtergraph cannot carry.
  const depth = text ? "" : "*(1+0.10*sin((X+Y)/220))*(1-0.55*((X/W-0.5)*(X/W-0.5)+(Y/H-0.5)*(Y/H-0.5)))";
  const fade = (c) => `'${c}*(1-0.40*(X/W+Y/H)/2)${depth}'`;
  let fc = `color=c=black:s=${W}x${H}:d=1,format=gbrp,geq=r=${fade(R)}:g=${fade(G)}:b=${fade(B)}[bg]`;
  let last = "bg";
  if (text) { fc += `;[bg]drawbox=x=${m}:y=${H - metaBand - Math.max(3, Math.round(H * 0.004))}:w=${W - 2 * m}:h=${Math.max(3, Math.round(H * 0.004))}:color=${hexc(kit.accent_color, "#ffc400")}@0.85:t=fill[b1]`; last = "b1"; }
  if (logo) {
    fc += `;[0:v]${alpha ? "split[l0][l1]" : "null[l0]"};[l0]scale=${logoBox}:${logoBox}:force_original_aspect_ratio=decrease[lg]`;
    if (alpha) { fc += `;[l1]scale=${Math.round(W * 0.66)}:-1,format=rgba,colorchannelmixer=aa=0.07[wm];[${last}][wm]overlay=${Math.round(W * 0.46)}:${-Math.round(H * 0.05)}[bw]`; last = "bw"; }
    fc += `;[${last}][lg]overlay=${m}:${m}[bl]`; last = "bl";
  }
  fc += `;[${last}]${assVf(assPath, fontsDir)}[out]`;
  try { await exec("ffmpeg", ["-y", ...(logo ? ["-i", logo] : []), "-filter_complex", fc, "-map", "[out]", "-frames:v", "1", "-q:v", "2", out], { timeoutMs: 90000 }); return out; }
  finally { await cleanup(assPath, logo); }
}
// Gemini's supported aspect ratio closest to w:h — the picture area of a photocard is wider than the card.
const IMAGE_RATIOS = ["1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
const nearestRatio = (w, h) => IMAGE_RATIOS.map((r) => [r, Math.abs(Math.log((Number(r.split(":")[0]) / Number(r.split(":")[1])) / (w / h)))]).sort((a, b) => a[1] - b[1])[0][0];
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
    try {
      const card = (compose.specs.layout || (compose.specs.kit ? "photocard" : "overlay")) === "photocard";
      const out = card ? await composePhotocard(inp, compose.headline, compose.specs) : await composeHeadline(inp, compose.headline, compose.specs);
      // The clean picture is kept (IMAGE_BASE) so the card can be redrawn when the headline is edited.
      const base = await recordMedia({ contentItemId, kind: "IMAGE_BASE", url: await storeFile(`images/${newId()}-base.jpg`, j.bytes, "image/jpeg"), mime: "image/jpeg", meta: { purpose: "card background" } });
      j = { bytes: await readFile(out), mime: "image/jpeg", ext: "jpg" }; await cleanup(out);
      const { kit, card_meta, width, height, layout, brand, accent_color, text_color, overlay_scale, photo_credit } = compose.specs;
      meta = { ...meta, overlay: card ? "photocard" : true, base_media_id: base.id, compose_specs: { kit, card_meta, width, height, layout, brand, accent_color, text_color, overlay_scale, photo_credit } };
      if (card) dims = { width: compose.specs.width || 1080, height: compose.specs.height || 1080 };
    }
    catch (e) { warn(`headline overlay skipped: ${e.message.slice(0, 160)}`); }
    finally { await cleanup(inp); }
  }
  const url = await storeFile(`images/${newId()}.${j.ext}`, j.bytes, j.mime);
  return recordMedia({ contentItemId, kind: "IMAGE", url, mime: j.mime, width: dims.width || null, height: dims.height || null, meta: { ...meta, source_mime: mime } });
}
// A 1280x720 cover for the video: the section picture the story opens on, with the headline burned over it the way a
// person would set it. A frame is pulled out of stock footage where that is what the section holds.
async function makeThumbnail(contentItemId, niche, first, headline) {
  if (!first?.url) return null;
  const specs = await cardSpecs(niche, {}, { width: 1280, height: 720 });
  // YouTube wants 1280x720 whatever shape the section picture is, so the base is cropped to it before the headline
  // goes on: composeHeadline sizes its type from the image it is given.
  const file = await toTmpFile(first.url, first.kind === "VIDEO" ? "mp4" : undefined), still = tmpPath("jpg");
  const fit = "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,setsar=1";
  try {
    await exec("ffmpeg", ["-y", ...(first.kind === "VIDEO" ? ["-ss", "1"] : []), "-i", file, "-vf", fit, "-frames:v", "1", "-q:v", "2", still]);
    // A cover is read at the size of a thumbnail on a phone: short text is set as large as it will go, not at the
    // card's scale, because three big words get clicked and twelve small ones are a grey smudge.
    const words = String(headline || "").trim().split(/\s+/).filter(Boolean).length;
    const out = await composeHeadline(still, headline, { ...specs, layout: "overlay", overlay_scale: words <= 4 ? 1.9 : words <= 7 ? 1.55 : 1.2 });
    try {
      const url = await storeLocal(out, `images/${newId()}-thumb.jpg`, "image/jpeg");
      return await recordMedia({ contentItemId, kind: "THUMBNAIL", url, mime: "image/jpeg", width: 1280, height: 720, meta: { purpose: "youtube thumbnail", from: first.kind === "VIDEO" ? "footage frame" : "section picture" } });
    } finally { await cleanup(out); }
  } finally { await cleanup(file, still); }
}
// A text card as an item's hero image. It carries no IMAGE_BASE row: the card is drawn from scratch, so a later headline
// edit redraws it from compose_specs alone.
async function storeTextCard(contentItemId, headline, specs = {}, reason = null) {
  const out = await composeTextCard(headline, specs);
  try {
    const url = await storeLocal(out, `images/${newId()}.jpg`, "image/jpeg");
    const { kit, card_meta, width, height, brand, label } = specs;
    return await recordMedia({ contentItemId, kind: "IMAGE", url, mime: "image/jpeg", width: width || 1080, height: height || 1080,
      meta: { overlay: "textcard", ...(reason ? { fallback: String(reason).slice(0, 300) } : {}), compose_specs: { kit, card_meta, width, height, brand, label, layout: "textcard" } } });
  } finally { await cleanup(out); }
}
// A raster, not the SVG this used to return. An SVG needs an ffmpeg built with librsvg to decode, which most are not,
// so a program on mocks produced pictures that every video render then refused — a failure that looks like a bug in
// the renderer and is really the stand-in picture. A mock should be able to stand in.
impl("IMAGE", "image_mock", { label: "Mock image (flat card)", create: () => ({
  async generate({ headline, specs = {}, contentItemId }) {
    const w = specs.width || 1080, h = specs.height || 1080;
    const hue = (sha(String(headline || "mock")).charCodeAt(0) * 7) % 360;
    const out = tmpPath("jpg");
    try {
      await exec("ffmpeg", ["-y", "-f", "lavfi", "-i", `color=c=0x202838:s=${w}x${h}`,
        "-vf", `format=gbrp,geq=r='128+80*sin(${hue}+X/${w}*3)':g='120+70*sin(1+Y/${h}*3)':b='150+70*sin(2+(X+Y)/${w}*3)'`,
        "-frames:v", "1", "-q:v", "3", out], { timeoutMs: 60000 });
      return await storeImage(await readFile(out), "image/jpeg", contentItemId, { mock: true }, { width: w, height: h });
    } catch {
      // No ffmpeg at all: the SVG is still better than failing, and whatever consumes it can say so itself.
      return storeImage(Buffer.from(svgCard(headline, specs)), "image/svg+xml", contentItemId, { mock: true }, { width: w, height: h });
    } finally { await cleanup(out); }
  } }) });
impl("IMAGE", "gemini_image", { label: "Gemini image generation", configSchema: { model: { type: "string", default: DEFAULTS.GEMINI_IMAGE_MODEL } }, create: (cfg, ctx = {}) => ({
  async generate({ prompt, headline, specs = {}, contentItemId }) {
    const model = cfg.model || DEFAULTS.GEMINI_IMAGE_MODEL;
    const ar = specs.aspect_ratio || (specs.height > specs.width ? "9:16" : specs.width > specs.height ? "16:9" : "1:1");
    const full = `${prompt || headline}. ${specs.style || "Photorealistic editorial news image, dramatic lighting, no watermarks."} ${specs.render_text === true ? `Render this headline as bold, legible overlay text: "${headline}".` : "Do not render any text, letters, captions or logos anywhere in the image; leave the lower third visually calm."} Aspect ratio ${ar}.`;
    return withKey("gemini", async (key) => {
      const { model: used, body } = await withGeminiModels(key, "image", [model], async (m) => ({ model: m, body: await fetchJson(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, { method: "POST", headers: { "x-goog-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: full }] }], generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: ar } } }) }) }));
      const part = (body.candidates?.[0]?.content?.parts || []).find((p) => p.inlineData || p.inline_data);
      if (!part) throw new Error("Gemini returned no image (blocked by safety, or wrong model id?)");
      const d = part.inlineData || part.inline_data; const mime = d.mimeType || d.mime_type || "image/png";
      const media = await storeImage(Buffer.from(d.data, "base64"), mime, contentItemId, { model: used, prompt: full }, {}, { headline, specs });
      return { ...media, cost: IMAGE_PRICE_USD, units: 1 };
    }, ctx.pin);
  } }) });

// ---- Stock footage (Pexels, the same free key). A narrated section over real moving footage is the difference between
// a slideshow and a video, and it costs nothing. Returns a clip long enough for the section, in the right shape, or
// null — a section with no footage falls back to its picture, so a reel is never held up by a missing clip.
const pexelsClipUsed = new Map();
async function pexelsFootage(query, { vertical = true, seconds = 6, ctx = {} } = {}) {
  const q = String(query || "").trim().split(/\s+/).filter((w) => w.length > 2).slice(0, 5).join(" ");
  if (!q) return null;
  const base = await setting("footage.api_base", "https://api.pexels.com/videos");
  return withKey("pexels", async (key) => {
    const r = await fetchJson(`${base}/search?${form({ query: q, per_page: 12, orientation: vertical ? "portrait" : "landscape", size: "medium" })}`, { headers: { Authorization: key } });
    const want = vertical ? { w: 720, h: 1080 } : { w: 1280, h: 720 };
    const pool = (r.videos || []).filter((v) => v.duration >= Math.min(seconds, 4) && Date.now() - (pexelsClipUsed.get(v.id) || 0) > 14 * 86400e3);
    for (const v of pool.slice(0, 6)) {
      const file = (v.video_files || []).filter((f) => f.file_type === "video/mp4" && f.width >= want.w && f.height >= want.h).sort((a, b) => a.width * a.height - b.width * b.height)[0];
      if (!file) continue;
      pexelsClipUsed.set(v.id, Date.now());
      return { url: file.link, seconds: v.duration, photographer: v.user?.name || "Pexels", id: v.id, page: v.url };
    }
    return null;
  }, ctx.pin).catch((e) => { warn(`stock footage "${q}": ${e.message.slice(0, 120)}`); return null; });
}
// ---- Stock photography (Pexels, free key, commercial use). A real photo behind the headline where a generated
// picture is not available or not worth paying for. Two rules keep it honest: the writer decides whether a generic
// photo could mislead for this story and gives no search phrase when it could (the post then falls back to a text
// card), and every photo is marked as illustrative on the card, with the photographer credited.
const pexelsUsed = new Map();                                                    // photo id -> when it was last used
impl("IMAGE", "pexels_stock", { label: "Stock photo (Pexels)", configSchema: { orientation: { type: "string", default: "landscape" }, per_page: { type: "number", default: 15 }, api_base: { type: "string", default: "https://api.pexels.com/v1" } }, create: (cfg, ctx = {}) => ({
  async generate({ prompt, headline, specs = {}, contentItemId }) {
    // An explicit null is the writer's judgement that a library photo would mislead here: the post takes a text card
    // instead. An absent phrase (a program that doesn't produce one) falls back to what it was going to draw.
    if (specs.photo_query === null) { const e = new Error("A library photo could mislead for this story, so it has none"); e.editorial = true; throw e; }
    const query = String(specs.photo_query || prompt || headline || "").trim().split(/\s+/).filter((w) => w.length > 2).slice(0, 6).join(" ");
    if (!query) throw new Error("No stock photo search phrase for this story");
    return withKey("pexels", async (key) => {
      const r = await fetchJson(`${cfg.api_base || "https://api.pexels.com/v1"}/search?${form({ query, per_page: cfg.per_page || 15, orientation: cfg.orientation || "landscape" })}`, { headers: { Authorization: key } });
      const wide = specs.width && specs.height ? specs.width / specs.height : 1;
      const fresh = (r.photos || []).filter((p) => p?.src && Date.now() - (pexelsUsed.get(p.id) || 0) > 14 * 86400e3);
      const pool = (fresh.length ? fresh : r.photos || []).filter((p) => p.width >= 1000 && (wide < 1 || p.width >= p.height));
      if (!pool.length) throw new Error(`No usable stock photo for "${query}"`);
      const photo = pool[Math.floor(Math.random() * Math.min(5, pool.length))];   // vary the pick so a topic isn't always the same picture
      pexelsUsed.set(photo.id, Date.now());
      const bytes = await fetchBytes(photo.src.large2x || photo.src.large || photo.src.original);
      const credit = `${specs.lang === "bn" ? "প্রতীকী ছবি" : "Illustrative photo"} · Pexels/${photo.photographer}`;
      const media = await storeImage(bytes, "image/jpeg", contentItemId, { provider: "pexels", photo_id: photo.id, photographer: photo.photographer, photo_url: photo.url, query, alt: photo.alt || null },
        {}, { headline, specs: { ...specs, photo_credit: credit } });
      return { ...media, cost: 0, units: 1 };
    }, ctx.pin);
  } }) });
// The photo the outlet ran with the story — the actual people, the actual place. It is what every Bangladeshi news page
// on Facebook is built from, it is free, and no generated illustration competes with it for a story about real people.
// Small images are refused: a byline portrait, a section badge or a tracking pixel is worse than no picture at all.
impl("IMAGE", "source_photo", { label: "The story's own photo", configSchema: { min_width: { type: "number", default: 600 }, min_height: { type: "number", default: 340 } }, create: (cfg) => ({
  async generate({ headline, specs = {}, contentItemId }) {
    const url = specs.photo;
    if (!url) { const e = new Error("The story came without a photo of its own"); e.editorial = true; throw e; }
    const file = await toTmpFile(url);
    try {
      const { width, height } = await imageDims(file);
      if (width < (cfg.min_width || 600) || height < (cfg.min_height || 340)) throw new Error(`The story's photo is only ${width}×${height} — a badge or a byline portrait, not a news picture`);
      const outlet = specs.photo_outlet || null;
      const credit = outlet ? `${specs.lang === "bn" ? "ছবি" : "Photo"}: ${outlet}` : undefined;
      const media = await storeImage(await readFile(file), "image/jpeg", contentItemId, { provider: "source", photo_url: url, outlet, width, height },
        {}, { headline, specs: { ...specs, ...(credit ? { photo_credit: credit } : {}) } });
      return { ...media, cost: 0, units: 1 };
    } finally { await cleanup(file); }
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

// Gemini native TTS: uses the Gemini key the rest of the pipeline already has and speaks Bangla (bn-BD) as well as English.
// Returns raw 24 kHz PCM, converted to MP3 here. Long scripts are split at sentence ends and joined.
// Any speech engine that writes a file, run as a command. Piper and espeak-ng are free, run on the worker, speak
// Bangla, and cost no quota at all — which on a free Gemini key is the difference between a handful of videos a day
// and as many as the machine can render. {out} is the file to write, {text} the line to say; without {text} the line
// goes in on stdin. The result is levelled to the same -16 LUFS the narration joiner uses, so a local engine
// and a hosted one are the same loudness under the same music bed.
impl("VOICE", "tts_command", { label: "Local speech engine (piper, espeak, any command)",
  configSchema: { command: { type: "string", required: true }, args: { type: "array" }, format: { type: "string", default: "wav" }, voice: { type: "string" }, timeout_seconds: { type: "number", default: 300 } },
  create: (cfg) => ({
    async synthesize({ script, voiceId, contentItemId }) {
      const command = cfg.command; if (!command) throw new Error("tts_command needs config.command — the speech engine to run");
      const raw = tmpPath(cfg.format || "wav"), mp3 = tmpPath("mp3");
      const voice = voiceId || cfg.voice || "";
      const args = (cfg.args || []).map((a) => String(a).replace(/\{out\}/g, raw).replace(/\{voice\}/g, voice).replace(/\{text\}/g, script));
      const onStdin = !(cfg.args || []).some((a) => String(a).includes("{text}"));
      try {
        await exec(command, args, { input: onStdin ? script : null, timeoutMs: (cfg.timeout_seconds || 300) * 1000 });
        await exec("ffmpeg", ["-y", "-i", raw, "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-b:a", "128k", mp3]);
        const dur = await ffprobeDuration(mp3);
        if (!dur) throw new Error(`${command} produced no audible speech`);
        const url = await storeLocal(mp3, `audio/${newId()}.mp3`, "audio/mpeg");
        return { ...(await recordMedia({ contentItemId, kind: "AUDIO", url, mime: "audio/mpeg", duration: dur, meta: { provider: "command", command, voice: voice || null, chars: script.length } })), units: 1, cost: 0 };
      } finally { await cleanup(raw, mp3); }
    } }) });
impl("VOICE", "gemini_tts", { label: "Gemini TTS (Bangla + English)", configSchema: { voice: { type: "string", default: DEFAULTS.GEMINI_TTS_VOICE }, model: { type: "string", default: DEFAULTS.GEMINI_TTS_MODELS[0] }, style: { type: "string" } }, create: (cfg, ctx = {}) => ({
  async synthesize({ script, voiceId, contentItemId }) {
    const voice = voiceId || cfg.voice || DEFAULTS.GEMINI_TTS_VOICE;
    const models = [cfg.model, ...DEFAULTS.GEMINI_TTS_MODELS];
    const parts = []; let cur = "";
    for (const s of String(script).split(/(?<=[.!?।])\s+/)) { if ((cur + " " + s).length > 2800 && cur) { parts.push(cur.trim()); cur = s; } else cur += " " + s; } if (cur.trim()) parts.push(cur.trim());
    return withKey("gemini", async (key) => {
      const files = [];
      try {
        for (const p of parts) {
          const text = cfg.style ? `${cfg.style}: ${p}` : p;
          const body = await withGeminiModels(key, "tts", models.filter(Boolean), (m) => fetchJson(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, { method: "POST", headers: { "x-goog-api-key": key, "content-type": "application/json" },
            body: JSON.stringify({ contents: [{ parts: [{ text }] }], generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } } }) }));
          const d = (body.candidates?.[0]?.content?.parts || []).find((x) => x.inlineData || x.inline_data); if (!d) throw new Error("Gemini TTS returned no audio");
          const inl = d.inlineData || d.inline_data; const rate = Number((/rate=(\d+)/.exec(inl.mimeType || inl.mime_type || "") || [])[1]) || 24000;
          const pcm = tmpPath("pcm"), mp3 = tmpPath("mp3"); await writeFile(pcm, Buffer.from(inl.data, "base64"));
          await exec("ffmpeg", ["-y", "-f", "s16le", "-ar", String(rate), "-ac", "1", "-i", pcm, "-b:a", "128k", mp3]); await cleanup(pcm); files.push(mp3);
        }
        let f = files[0];
        if (files.length > 1) { const list = tmpPath("txt"); await writeFile(list, files.map((x) => `file '${x.replace(/\\/g, "/")}'`).join("\n")); f = tmpPath("mp3"); await exec("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", f]); await cleanup(list); }
        const dur = await ffprobeDuration(f);
        const url = await storeLocal(f, `audio/${newId()}.mp3`, "audio/mpeg"); await cleanup(f);
        const media = await recordMedia({ contentItemId, kind: "AUDIO", url, mime: "audio/mpeg", duration: dur || script.length / 15, meta: { voice, provider: "gemini", chars: script.length } });
        return { ...media, units: 1, cost: (dur || 0) * 25 * 10 / 1e6 };
      } finally { await cleanup(...files); }
    }, ctx.pin);
  } }) });

// ---- 6i. Embeddings (stage EMBED). embed(text) -> number[] | null
// embedMany(texts, {dimensions, task}) -> (number[] | null)[] — batched for the news desk, which embeds every new headline.
impl("EMBED", "embed_mock", { label: "None", create: () => ({ async embed() { return null; }, async embedMany(texts) { return texts.map(() => null); } }) });
impl("EMBED", "gemini_embed", { label: "Gemini embeddings", configSchema: { model: { type: "string", default: DEFAULTS.GEMINI_EMBED_MODEL } }, create: (cfg, ctx = {}) => ({
  async embed(text) {
    const model = cfg.model || DEFAULTS.GEMINI_EMBED_MODEL;
    const r = await withKey("gemini", async (key) => { const b = await retryTransient(() => fetchJson(`https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent`, { method: "POST", headers: { "x-goog-api-key": key, "content-type": "application/json" }, body: JSON.stringify({ content: { parts: [{ text: text.slice(0, 8000) }] } }) })); return { v: b.embedding?.values || null, units: 1, cost: 0 }; }, ctx.pin);
    return r.v;
  },
  async embedMany(texts, { dimensions = 256, task = "CLUSTERING" } = {}) {
    const model = cfg.model || DEFAULTS.GEMINI_EMBED_MODEL; const out = [];
    for (let i = 0; i < texts.length; i += 100) {
      const chunk = texts.slice(i, i + 100);
      const r = await withKey("gemini", async (key) => { const b = await retryTransient(() => fetchJson(`https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents`, { method: "POST", headers: { "x-goog-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({ requests: chunk.map((t) => ({ model: `models/${model}`, content: { parts: [{ text: String(t).slice(0, 2000) }] }, taskType: task, outputDimensionality: dimensions })) }) })); return { v: (b.embeddings || []).map((e) => e.values || null), units: 1, cost: 0 }; }, ctx.pin);
      out.push(...chunk.map((_, j) => r.v[j] || null));
    }
    return out;
  } }) });

// ---- 6j. Render (stage RENDER). ffmpeg helpers + renderForChannel({item, media, channel, niche}) -> {url, kind}
// Burned-in text is always an ASS file drawn by the `ass` filter with complex shaping: ffmpeg's `subtitles` filter and
// drawtext use simple shaping, which scrambles Bangla (vowel signs and conjuncts render in the wrong place).
const assTime = (s) => { const cs = Math.max(0, Math.round(s * 100)); return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, "0")}:${String(Math.floor(cs / 100) % 60).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`; };
const assVf = (file, fontsDir = null) => `ass=filename=${ffPath(file)}:shaping=complex${fontsDir ? `:fontsdir=${ffPath(fontsDir)}` : ""}`;
const ASS_FORMAT = "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding";
// Captions for [start, end] of a timed transcript, shifted to 0 and cut into short phrases (a few words, timed by character
// count). Karaoke colours each word as it is spoken. An optional hook sits in a box at the top for the first four seconds.
async function writeCaptionsAss(segments, start, end, { width = 1080, height = 1920, hook = null, font = OVERLAY_FONT, karaoke = true, accent = "#ffd400" } = {}) {
  const vertical = height > width, size = Math.round(height * (vertical ? 0.04 : 0.052)), maxWords = vertical ? 4 : 8, events = [];
  const weight = (w) => w.length + 1;
  for (const s of (segments || []).filter((x) => x.end > start && x.start < end)) {
    const s0 = Math.max(s.start, start) - start, s1 = Math.min(s.end, end) - start; if (s1 - s0 < 0.2) continue;
    const words = String(s.text || "").trim().split(/\s+/).filter(Boolean); if (!words.length) continue;
    const total = words.reduce((n, w) => n + weight(w), 0); let t = s0;
    for (let i = 0; i < words.length; i += maxWords) {
      const chunk = words.slice(i, i + maxWords), cw = chunk.reduce((n, w) => n + weight(w), 0), d = ((s1 - s0) * cw) / total;
      const text = karaoke ? chunk.map((w) => `{\\k${Math.max(1, Math.round((d * 100 * weight(w)) / cw))}}${assEsc(w)}`).join(" ") : assEsc(chunk.join(" "));
      events.push(`Dialogue: 0,${assTime(t)},${assTime(t + d)},Cap,,0,0,0,,${text}`); t += d;
    }
  }
  if (hook) events.push(`Dialogue: 1,${assTime(0)},${assTime(Math.min(4, Math.max(1, end - start)))},Hook,,0,0,0,,${assEsc(hook).slice(0, 90)}`);
  const white = assColor("#ffffff"), mx = Math.round(width * 0.07);
  const ass = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\n${ASS_FORMAT}\n`
    // Karaoke: SecondaryColour = not yet spoken, PrimaryColour = spoken.
    + `Style: Cap,${font},${size},${karaoke ? assColor(accent) : white},${white},&H00000000,&H90000000,-1,0,0,0,100,100,0,0,1,${Math.max(2, Math.round(size * 0.09))},${Math.round(size * 0.05)},2,${mx},${mx},${Math.round(height * (vertical ? 0.22 : 0.07))},1\n`
    + `Style: Hook,${font},${Math.round(size * 1.05)},${white},${white},&H70000000,&H70000000,-1,0,0,0,100,100,0,0,3,${Math.round(size * 0.3)},0,8,${mx},${mx},${Math.round(height * (vertical ? 0.12 : 0.06))},1\n`
    + `\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${events.join("\n")}\n`;
  const f = tmpPath("ass"); await writeFile(f, ass); return f;
}
// What a news editor burns into a video and the ffmpeg path never did: the label, the headline, the handle. Without
// these a rendered reel is a caption track over a colour field — the studio drew them, ffmpeg drew nothing, and ffmpeg
// is what runs on an instance too small for Chromium. The headline holds for the opening seconds, where a viewer
// decides whether to stay, and then gets out of the way of the captions.
async function writeBrandAss({ headline, hook, kicker, handle, credit, width, height, seconds, primary = "#b3121f", accent = "#ffc400", font = OVERLAY_FONT }) {
  const vertical = height > width, pad = Math.round(width * 0.055);
  // Letter-spacing pulls Bangla conjuncts apart into separate glyphs — "সূত্র" comes out as five loose letters. It is a
  // Latin typographic nicety, so it is only applied to Latin text.
  const track = (text, px) => (/[ঀ-৿]/.test(String(text || "")) ? 0 : px);
  const head = Math.round(height * (vertical ? 0.036 : 0.05)), kick = Math.round(head * 0.62), small = Math.round(head * 0.46);
  const hold = Math.max(3.5, Math.min(7.5, seconds * 0.35)), events = [];
  const top = Math.round(height * (vertical ? 0.085 : 0.07));
  if (kicker) events.push(`Dialogue: 2,${assTime(0.15)},${assTime(seconds)},Kick,,0,0,${top},,{\\fad(250,0)}${assEsc(kicker).toUpperCase().slice(0, 28)}`);
  // The hook owns the first two and a half seconds, big, where the decision to keep watching is made; the headline
  // takes over behind it and holds while the story is told.
  const headAt = top + Math.round(kick * 2.1), hookEnd = Math.min(2.6, Math.max(1.4, seconds * 0.12));
  if (hook) events.push(`Dialogue: 3,${assTime(0.2)},${assTime(hookEnd)},Hook,,0,0,${headAt},,{\\fad(180,260)}${assEsc(hook).slice(0, 60)}`);
  if (headline) events.push(`Dialogue: 2,${assTime(hook ? hookEnd : 0.35)},${assTime(Math.max(hold, hookEnd + 2))},Head,,0,0,${headAt},,{\\fad(350,500)}${assEsc(headline).slice(0, 120)}`);
  const foot = [handle, credit].filter(Boolean).join("   ");
  if (foot) events.push(`Dialogue: 2,${assTime(0.5)},${assTime(seconds)},Foot,,0,0,${Math.round(height * 0.035)},,{\\fad(400,0)}${assEsc(foot).slice(0, 70)}`);
  if (!events.length) return null;
  // BorderStyle 3 paints BackColour behind the text, which is how the label pill and the headline plate are drawn.
  const ass = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\n${ASS_FORMAT}\n`
    + `Style: Kick,${font},${kick},${assColor("#111111")},${assColor("#111111")},${assColor(accent)},${assColor(accent)},-1,0,0,0,100,100,${track(kicker, Math.round(kick * 0.1))},0,3,${Math.round(kick * 0.34)},0,7,${pad},${pad},0,1\n`
    + `Style: Head,${font},${head},${assColor("#ffffff")},${assColor("#ffffff")},${assColor(primary, "18")},${assColor(primary, "18")},-1,0,0,0,100,100,0,0,3,${Math.round(head * 0.34)},0,7,${pad},${vertical ? pad : Math.round(width * 0.34)},0,1\n`
    + `Style: Hook,${font},${Math.round(head * 1.45)},${assColor("#111111")},${assColor("#111111")},${assColor(accent, "08")},${assColor(accent, "08")},-1,0,0,0,100,100,0,0,3,${Math.round(head * 0.38)},0,7,${pad},${vertical ? pad : Math.round(width * 0.42)},0,1\n`
    + `Style: Foot,${font},${small},${assColor("#ffffff", "50")},${assColor("#ffffff", "50")},${assColor("#000000", "60")},${assColor("#000000", "90")},0,0,0,0,100,100,${track(`${handle || ""} ${credit || ""}`, Math.round(small * 0.08))},0,1,${Math.max(1, Math.round(small * 0.08))},0,1,${pad},${pad},0,1\n`
    + `\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${events.join("\n")}\n`;
  const f = tmpPath("ass"); await writeFile(f, ass); return f;
}
const VF_VERTICAL = "crop=min(iw\\,ih*9/16):ih,scale=1080:1920";
// Landscape footage in a vertical frame without cropping: the whole picture (TV chyrons included) over a blurred fill.
const VF_VERTICAL_BLURPAD = "split[a][b];[a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=24:4,eq=brightness=-0.18[bg];[b]scale=1080:-2[fg];[bg][fg]overlay=0:(H-h)/2,setsar=1";
const VF_LANDSCAPE = "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black";
const X264 = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart"];
// A music bed under narration. Not a flat quiet layer fighting the words: the bed is faded in and out, and a sidechain
// compressor keyed on the narration itself pulls it down under every phrase and lets it back up in the gaps — the duck
// an editor rides by hand. `mi` and `vi` are the ffmpeg input indexes of the music and of the voice.
// Both chains are forced to one format first: sidechaincompress and amix want their inputs to agree, and the music and
// the narration arrive as whatever their encoders felt like.
const AFMT = "aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo";
const duckUnder = (mi, vi, dur) =>
  `[${mi}:a]${AFMT},volume=0.22,afade=t=in:st=0:d=1.5,afade=t=out:st=${Math.max(0, dur - 2.5).toFixed(2)}:d=2.5[bed];` +
  `[${vi}:a]${AFMT},asplit=2[voice][key];` +
  `[bed][key]sidechaincompress=threshold=0.03:ratio=12:attack=15:release=350[duck];` +
  // normalize=0 matters: amix divides every input by their number by default, so mixing a bed in would quietly drop
  // the narration 6 dB. The bed's level is set by its own volume filter, and alimiter catches whatever peaks.
  `[voice][duck]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95[mix]`;
async function cutClip(input, start, end, { vertical = true, ass = null, layout = "crop" } = {}) {
  const vf = [vertical ? (layout === "blurpad" ? VF_VERTICAL_BLURPAD : VF_VERTICAL) : VF_LANDSCAPE];
  if (ass) vf.push(assVf(ass));
  const out = tmpPath("mp4");
  await exec("ffmpeg", ["-y", "-ss", String(start), "-t", String(Math.max(1, end - start)), "-i", input, "-vf", vf.join(","), ...X264, out]);
  return out;
}
const hasAudio = async (file) => { try { const { out } = await exec("ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", file]); return out.trim().length > 0; } catch { return false; } };
// Last pass on every footage video: the brand logo in a corner and loudness normalised for social platforms (-14 LUFS).
async function brandFinish(file, niche, { vertical = true } = {}) {
  const { brand } = await studioBrand(niche); const out = tmpPath("mp4"), audio = await hasAudio(file);
  const logoW = Math.round((vertical ? 1080 : 1920) * (vertical ? 0.2 : 0.12)), margin = vertical ? 48 : 40;
  try {
    const args = ["-y", "-i", file, ...(brand.logo ? ["-i", brand.logo] : [])];
    const fc = brand.logo ? `[1:v]scale=${logoW}:-1,format=rgba,colorchannelmixer=aa=0.88[lg];[0:v][lg]overlay=${margin}:${margin}[v]` : "[0:v]null[v]";
    await exec("ffmpeg", [...args, "-filter_complex", fc + (audio ? ";[0:a]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[a]" : ""), "-map", "[v]", ...(audio ? ["-map", "[a]"] : []), ...X264, out]);
    await cleanup(file); return out;
  } catch (e) { warn(`brand finish skipped: ${e.message.slice(0, 160)}`); await cleanup(out); return file; }
  finally { await cleanup(brand.logo, brand.fontUrl); }
}
// Long-form reaction: the source plays in segments with the reactor picture-in-picture; between them the video pauses on a
// blurred still while the commentary is spoken, the reactor large beside the frozen frame, with captions. Without a
// reactor clip the "unique video" is the commentary's own waveform beside the brand logo. Segments share one format and
// are joined without re-encoding. beats: [{type:"play", start, end} | {type:"comment", text, audio:{url, duration_seconds}}]
// A reaction is the commentary, not the clip. A planner left to itself drifts towards long unbroken playback, which is
// both duller to watch and the shape that gets a channel claimed, so the plan is shaped before it is rendered: no clip
// runs longer than max_play_seconds, the source stays inside its total budget, the whole thing opens and closes on the
// host's voice, and if commentary is thinner than min_commentary_share the clips are trimmed until it is not.
function shapeReaction(beats, cfg = {}) {
  // `?? ` rather than `||`: a program that deliberately sets one of these to zero means zero.
  const num = (v, dflt) => (v === undefined || v === null || Number.isNaN(Number(v)) ? dflt : Number(v));
  const maxClip = num(cfg.max_play_seconds, 45);
  const budget = num(cfg.max_play_minutes, 6) * 60;
  const minShare = num(cfg.min_commentary_share, 0.35);
  const spoken = (b) => Math.max(2, String(b.text || "").split(/\s+/).filter(Boolean).length / 2.4);
  let out = beats.map((b) => (b.type === "play" ? { ...b, end: Math.min(b.end, b.start + maxClip) } : b)).filter((b) => b.type !== "play" || b.end - b.start >= 2);
  // Keep the source inside its budget, oldest first, so a long video does not become a re-upload.
  let used = 0;
  out = out.filter((b) => { if (b.type !== "play") return true; if (used >= budget) return false; const d = Math.min(b.end - b.start, budget - used); used += d; b.end = b.start + d; return d >= 2; });
  // Open and close on the host: a reaction that starts on someone else's footage is someone else's video.
  const firstComment = out.findIndex((b) => b.type === "comment");
  if (firstComment > 0) out = [out[firstComment], ...out.filter((_, i) => i !== firstComment)];
  // Closing on the host too — but never by moving the comment that is now the opening hook: with a single remark, the
  // hook is the one worth keeping in place.
  if (out.length && out[out.length - 1].type !== "comment" && out.filter((b) => b.type === "comment").length > 1) {
    const lastComment = [...out].reverse().find((b) => b.type === "comment" && b !== out[0]);
    if (lastComment) out = [...out.filter((b) => b !== lastComment), lastComment];
  }
  const commentSeconds = out.filter((b) => b.type === "comment").reduce((a, b) => a + spoken(b), 0);
  let playSeconds = out.filter((b) => b.type === "play").reduce((a, b) => a + (b.end - b.start), 0);
  // Too little commentary for the amount of source: trim every clip by the same proportion rather than dropping any,
  // so the plan keeps its shape and each moment still gets its remark.
  const allowed = commentSeconds * (1 - minShare) / minShare;
  if (playSeconds > allowed && allowed > 0) {
    const k = allowed / playSeconds;
    out = out.map((b) => (b.type === "play" ? { ...b, end: b.start + Math.max(3, (b.end - b.start) * k) } : b));
    playSeconds = out.filter((b) => b.type === "play").reduce((a, b) => a + (b.end - b.start), 0);
  }
  const total = commentSeconds + playSeconds;
  return { beats: out, stats: { comments: out.filter((b) => b.type === "comment").length, plays: out.filter((b) => b.type === "play").length, commentSeconds, playSeconds, commentShare: total ? commentSeconds / total : 1 } };
}
async function renderReactionLong({ beats, sourcePath, niche, reactorUrl }) {
  const W = 1920, H = 1080, FMT = ["-r", "30", "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2"];
  const { brand } = await studioBrand(niche); const reactor = reactorUrl ? await toTmpFile(reactorUrl, "mp4") : null;
  const accent = (brand.accent || "#ffc400").replace("#", "0x"), srcAudio = await hasAudio(sourcePath), segs = [], temp = [];
  try {
    let lastT = 0;
    for (const [i, b] of beats.entries()) {
      const seg = tmpPath("mp4"); segs.push(seg);
      if (b.type === "play") {
        const dur = Math.max(1, b.end - b.start); lastT = b.end;
        const inputs = ["-ss", String(b.start), "-t", String(dur), "-i", sourcePath, ...(reactor ? ["-stream_loop", "-1", "-i", reactor] : []), ...(srcAudio ? [] : ["-f", "lavfi", "-t", String(dur), "-i", "anullsrc=r=48000:cl=stereo"])];
        const fc = `[0:v]${VF_LANDSCAPE},fps=30,setsar=1[m]` + (reactor ? `;[1:v]scale=520:-2,fps=30,setsar=1,pad=iw+8:ih+8:4:4:color=${accent}[r];[m][r]overlay=W-w-40:H-h-40:shortest=1[v]` : ";[m]null[v]");
        const aIn = srcAudio ? "0:a" : `${reactor ? 2 : 1}:a`;
        await exec("ffmpeg", ["-y", ...inputs, "-filter_complex", fc, "-map", "[v]", "-map", aIn, "-t", String(dur), ...FMT, seg], { timeoutMs: 30 * 60000 });
      } else {
        const vo = await toTmpFile(b.audio.url, "mp3"), dur = (await ffprobeDuration(vo)) || b.audio.duration_seconds || 5, still = tmpPath("jpg"); temp.push(vo, still);
        await exec("ffmpeg", ["-y", "-ss", String(Math.max(0, lastT - 0.1)), "-i", sourcePath, "-frames:v", "1", "-q:v", "2", still]);
        // The chapter name rides the top of the commentary, which is where a viewer works out whether to stay.
        const ass = await writeCaptionsAss([{ start: 0, end: dur, text: b.text }], 0, dur, { width: W, height: H, accent: brand.accent, hook: b.chapter || null }); temp.push(ass);
        // Both panels are cut to the same height, so they share a top and bottom edge and read as one deliberate
        // two-up rather than two boxes floating at different sizes. The host sits on the right at the same scale as
        // the clip: during commentary the person talking is not a thumbnail of themselves.
        const panel = Math.round(H * 0.56), py = Math.round((H - panel) / 2), mx = Math.round(W * 0.05);
        const side = reactor ? `[1:v]scale=-2:${panel},fps=30,setsar=1,pad=iw+10:ih+10:5:5:color=${accent}[r]`
          : `[2:a]showwaves=s=640x${panel}:mode=cline:colors=${accent}:rate=30,format=yuva420p[r]`;
        const fc = `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=30:3,eq=brightness=-0.3[bg];`
          + `[0:v]scale=-2:${panel},pad=iw+10:ih+10:5:5:color=black@0.6[fz];[bg][fz]overlay=${mx}:${py}[a];`
          + `${side};[a][r]overlay=W-w-${mx}:${py}[b];[b]${assVf(ass)},fps=30,format=yuv420p[v]`;
        const inputs = ["-loop", "1", "-t", String(dur), "-i", still, ...(reactor ? ["-stream_loop", "-1", "-i", reactor] : ["-f", "lavfi", "-i", "color=c=black:s=16x16"]), "-i", vo];
        await exec("ffmpeg", ["-y", ...inputs, "-filter_complex", fc, "-map", "[v]", "-map", "2:a", "-t", String(dur), ...FMT, seg], { timeoutMs: 30 * 60000 });
      }
    }
    const list = tmpPath("txt"), joined = tmpPath("mp4"); temp.push(list);
    await writeFile(list, segs.map((s) => `file '${s.replace(/\\/g, "/")}'`).join("\n"));
    await exec("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", joined], { timeoutMs: 30 * 60000 });
    return joined;
  } finally { await cleanup(reactor, brand.logo, brand.fontUrl, ...segs, ...temp); }
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
    const c = methodCfg(niche); const vertical = c.orientation !== "16:9" && niche.production_method !== "REACTION_LONG", layout = c.vertical_layout || "crop";
    const segs = c.captions === false ? [] : transcript.segments;
    const assFor = (v, withHook = true, s = segs, start = clip.start, end = clip.end) => writeCaptionsAss(s, start, end, { width: v ? 1080 : 1920, height: v ? 1920 : 1080, hook: withHook ? clip.hook : null });
    const caps = []; let file;
    switch (niche.production_method || "PODCAST_HIGHLIGHT") {
      case "REACTION_LONG": {
        if (!extras.beats?.length) throw new Error("REACTION_LONG render needs extras.beats (the planned play/comment timeline)");
        file = await renderReactionLong({ beats: extras.beats, sourcePath, niche, reactorUrl: c.reactor_url || extras.reactorUrl || null }); break;
      }
      case "REACTION_OVERLAY": {
        // The captions go on after the stack, not into the clip before it. Burned in first they are sized for a
        // 1920-wide frame and then squashed into a half-height box, which halves the type and leaves it unreadable
        // on a phone — which is the only place a 9:16 video is watched.
        const main = await cutClip(sourcePath, clip.start, clip.end, { vertical: false });
        const ovUrl = c.overlay_video_url; if (!ovUrl) throw new Error("REACTION_OVERLAY needs method_config.overlay_video_url (your own reaction clip)");
        const ov = await toTmpFile(ovUrl, "mp4"); file = tmpPath("mp4");
        const stackAss = caps[caps.push(await assFor(true, false)) - 1];
        const box = "scale=1080:960:force_original_aspect_ratio=decrease,pad=1080:960:(ow-iw)/2:(oh-ih)/2:color=black";
        const fc = `[0:v]${box}[m];[1:v]${box}[o];[m][o]vstack=inputs=2,${assVf(stackAss)}[v]`;
        try { await exec("ffmpeg", ["-y", "-i", main, "-stream_loop", "-1", "-i", ov, "-filter_complex", `${fc};[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=2[a]`, "-map", "[v]", "-map", "[a]", "-t", String(clip.end - clip.start), ...X264, file]); }
        catch { await exec("ffmpeg", ["-y", "-i", main, "-stream_loop", "-1", "-i", ov, "-filter_complex", fc, "-map", "[v]", "-map", "0:a", "-t", String(clip.end - clip.start), ...X264, file]); }
        await cleanup(main, ov); break;
      }
      case "VOICEOVER": {
        // Our narration over the clip: the cut covers the whole narration, captions follow the new words, and the original
        // sound stays underneath at a low level instead of being dropped.
        if (!extras.audio?.url) throw new Error("VOICEOVER render needs extras.audio");
        const a = await toTmpFile(extras.audio.url, "mp3"); const nd = (await ffprobeDuration(a)) || extras.audio.duration_seconds || clip.end - clip.start;
        const end = Math.max(clip.end, clip.start + nd + 0.3);
        const main = await cutClip(sourcePath, clip.start, end, { vertical, layout, ass: caps[caps.push(await assFor(vertical, true, c.captions === false ? [] : [{ start: clip.start, end: clip.start + nd, text: extras.script || "" }], clip.start, end)) - 1] });
        file = tmpPath("mp4");
        if (await hasAudio(main)) await exec("ffmpeg", ["-y", "-i", main, "-i", a, "-filter_complex", "[0:a]volume=0.12[bg];[1:a]volume=1.0[vo];[bg][vo]amix=inputs=2:duration=longest:dropout_transition=0[a]", "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-t", String(nd + 0.3), file]);
        else await exec("ffmpeg", ["-y", "-i", main, "-i", a, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-shortest", file]);
        await cleanup(main, a); break;
      }
      case "MOVIE_RECAP": {
        // extras.scenes = [{start,end}], extras.audio = narration. Concat scenes, put narration on top.
        const scenes = extras.scenes?.length ? extras.scenes : [{ start: clip.start, end: clip.end }];
        const a = await toTmpFile(extras.audio.url, "mp3"); file = tmpPath("mp4");
        const trims = scenes.map((s, i) => `[0:v]trim=start=${s.start}:end=${s.end},setpts=PTS-STARTPTS[v${i}]`).join(";");
        // The narration, captioned. A recap is scrolled past with the sound off more often than it is listened to, and
        // the scenes are cut from someone else's film: without the words on screen there is nothing of ours in it.
        const nd = (await ffprobeDuration(a)) || extras.audio?.duration_seconds || scenes.reduce((n, x) => n + (x.end - x.start), 0);
        const said = extras.audio?.spoken || extras.script || "";
        const recapAss = c.captions === false || !said ? null
          : caps[caps.push(await writeCaptionsAss([{ start: 0, end: nd, text: said }], 0, nd, { width: vertical ? 1080 : 1920, height: vertical ? 1920 : 1080, accent: (await studioBrand(niche)).brand.accent })) - 1];
        const fc = `${trims};${scenes.map((_, i) => `[v${i}]`).join("")}concat=n=${scenes.length}:v=1:a=0,${vertical ? VF_VERTICAL : VF_LANDSCAPE}${recapAss ? `,${assVf(recapAss)}` : ""}[v]`;
        await exec("ffmpeg", ["-y", "-i", sourcePath, "-i", a, "-filter_complex", fc, "-map", "[v]", "-map", "1:a", "-shortest", ...X264, file]); await cleanup(a); break;
      }
      default: file = await cutClip(sourcePath, clip.start, clip.end, { vertical, layout, ass: caps[caps.push(await assFor(vertical)) - 1] });
    }
    await cleanup(...caps);
    if (c.brand_finish !== false) file = await brandFinish(file, niche, { vertical });
    return publishRender(file, contentItemId, { method: niche.production_method, orientation: vertical ? "9:16" : "16:9", clip });
  },
  // durations (seconds per picture) follow the narration section by section; without them the pictures share it equally.
  async renderSlideshow({ images, audio, durations = null, contentItemId, orientation = "9:16", captions = [], niche = null, headline = null, kicker = null, credit = null, hook = null }) {
    if (!images.length) throw new Error("slideshow needs at least one image");
    const a = await toTmpFile(audio.url, "mp3"); const dur = (await ffprobeDuration(a)) || audio.duration_seconds || images.length * 4;
    const per = durations?.length === images.length ? durations.map((x) => Math.max(0.5, Number(x) || 0)) : images.map(() => dur / images.length);
    const [w, h] = orientation === "16:9" ? [1920, 1080] : [1080, 1920];
    // One Ken Burns segment per picture, exactly as long as its narration, zooming in and out alternately; then joined.
    const segs = [], files = [];
    try {
      for (const [i, im] of images.entries()) {
        const f = await toTmpFile(im.url); files.push(f); const frames = Math.max(15, Math.round(per[i] * 30)), seg = tmpPath("mp4");
        if (im.kind === "VIDEO" || /^video\//.test(im.mime || "")) {
          // Footage: cover the section's narration, looping a short clip rather than freezing on its last frame, filled
          // to the frame and silent — the narration is the only voice.
          await exec("ffmpeg", ["-y", "-stream_loop", "-1", "-i", f, "-t", per[i].toFixed(2), "-an",
            "-vf", `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,fps=30,format=yuv420p`,
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", seg]);
        } else {
          // A press photo is landscape and a reel is not. Cropping a 16:9 photograph to 9:16 throws away two thirds of
          // it — usually including whoever the story is about — and an infographic cropped that way is unreadable.
          // When the shapes are far apart the picture is fitted whole, over a blurred enlargement of itself; when they
          // are close it fills the frame with the slow push that makes a still look alive.
          const { width: iw, height: ih } = await imageDims(f).catch(() => ({ width: w, height: h }));
          const shapeGap = Math.abs(Math.log((iw / ih) / (w / h)));
          if (shapeGap > 0.4) {
            // A fitted picture that does not move is a freeze-frame, and a news reel that returns to the same photo
            // twice would show it frozen twice. It is pushed in slowly instead, re-centred every frame.
            const grow = (i % 2 ? -0.00035 : 0.00035).toFixed(5);
            await exec("ffmpeg", ["-y", "-loop", "1", "-t", per[i].toFixed(2), "-i", f, "-filter_complex",
              `[0:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},boxblur=28:2,eq=brightness=-0.18:saturation=0.7,fps=30[bg];`
              + `[0:v]scale=${Math.round(w * 0.95)}:${Math.round(h * 0.95)}:force_original_aspect_ratio=decrease,fps=30,`
              + `scale=w='iw*(1${i % 2 ? "+0.035" : ""}${grow >= 0 ? "+" : ""}${grow}*n)':h=-2:eval=frame[fg];`
              + `[bg][fg]overlay=(W-w)/2:(H-h)/2:shortest=1,setsar=1,format=yuv420p[v]`,
              "-map", "[v]", "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", seg]);
          } else {
            const z = i % 2 ? `if(eq(on,0),1.12,max(zoom-0.0008,1.0))` : `min(zoom+0.0008,1.12)`;
            await exec("ffmpeg", ["-y", "-i", f, "-vf", `scale=${Math.round(w * 1.25)}:${Math.round(h * 1.25)}:force_original_aspect_ratio=increase,crop=${Math.round(w * 1.25)}:${Math.round(h * 1.25)},zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${w}x${h}:fps=30,format=yuv420p`,
              "-frames:v", String(frames), "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", seg]);
          }
        }
        segs.push(seg);
      }
      const list = tmpPath("txt"); await writeFile(list, segs.map((s) => `file '${s.replace(/\\/g, "/")}'`).join("\n"));
      let ass = null; if (captions.length) ass = await writeCaptionsAss(captions, 0, dur, { width: w, height: h });
      // The brand's music, if it has any. A slideshow with nothing under the voice sounds like a slideshow.
      // The brand's music and the brand's own colours, if the render was told which program it is for.
      const { brand, music } = niche ? await studioBrand(niche).catch(() => ({ brand: {} })) : { brand: {} };
      const chrome = await writeBrandAss({ headline, hook, kicker, handle: brand.handle, credit, width: w, height: h, seconds: dur, primary: brand.primary, accent: brand.accent });
      const out = tmpPath("mp4");
      const run = async (bed) => {
        const vf = [...(chrome ? [assVf(chrome)] : []), ...(ass ? [assVf(ass)] : [])].join(",");
        const fc = [...(vf ? [`[0:v]${vf}[v]`] : []), ...(bed ? [duckUnder(2, 1, dur)] : [])];
        await exec("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", list, "-i", a, ...(bed ? ["-stream_loop", "-1", "-i", bed] : []),
          ...(fc.length ? ["-filter_complex", fc.join(";")] : []), "-map", vf ? "[v]" : "0:v", "-map", bed ? "[mix]" : "1:a", "-shortest", ...X264, out]);
      };
      // An ffmpeg without sidechaincompress or alimiter must still produce the video, just without the bed.
      try { await run(music).catch((e) => { if (!music) throw e; warn(`music bed: ${e.message.slice(0, 140)}`); return run(null); }); }
      finally { await cleanup(list, ass, chrome, music); }
      return publishRender(out, contentItemId, { method: "SLIDESHOW", orientation, slides: images.length });
    } finally { await cleanup(a, ...files, ...segs); }
  },
}) });

// ---- 6j2. Studio (Remotion). News reels and animated explainers are rendered by studio/render.mjs in a child process,
// so Chromium's memory and any crash stay out of the engine. Pictures, narration, music, logo and font are handed over as
// local files; render.mjs stages them into the bundle. The "remotion" RENDER adapter uses the studio for made videos and
// ffmpeg for everything built from footage (clips, per-channel conversion).
const STUDIO_DIR = join(__dirname, "studio");
// The container's real memory limit (cgroup v2 / v1), not the host's: headless Chrome needs room, and on a 512 MB instance
// a render would take the whole service down with it. Below STUDIO_MIN_MEMORY_MB the studio is treated as unavailable.
function memoryLimitMb() {
  for (const f of ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]) {
    try { const v = readFileSync(f, "utf8").trim(); if (v && v !== "max" && Number(v) < 2 ** 50) return Math.round(Number(v) / 2 ** 20); } catch {}
  }
  return Math.round(totalmem() / 2 ** 20);
}
const STUDIO_MIN_MEMORY_MB = Number(ENV.STUDIO_MIN_MEMORY_MB) || 1400;
const studioInstalled = () => existsSync(join(STUDIO_DIR, "render.mjs")) && existsSync(join(STUDIO_DIR, "node_modules", "@remotion", "renderer"));
const studioReady = () => studioInstalled() && memoryLimitMb() >= STUDIO_MIN_MEMORY_MB;
const STUDIO_FPS = 30;
async function studioRender(composition, props, { kind = "video", ext = "mp4", timeoutMs = 90 * 60000 } = {}) {
  if (!studioInstalled()) throw new Error("The video studio is not installed here (studio/node_modules is missing). The Docker image installs it; locally run `npm install` in studio/.");
  if (!studioReady()) throw new Error(`This instance has ${memoryLimitMb()} MB of memory; the video studio needs ${STUDIO_MIN_MEMORY_MB} MB. Run the video lane on a bigger instance (the render.yaml worker is 2 GB).`);
  const propsPath = tmpPath("json"), out = tmpPath(ext);
  await writeFile(propsPath, JSON.stringify(props));
  try { await exec(process.execPath, [join(STUDIO_DIR, "render.mjs"), propsPath, out, composition, kind], { timeoutMs }); return out; }
  finally { await cleanup(propsPath); }
}
// The brand kit as the studio's brand, with logo, font and a music bed fetched to local files for the render.
async function studioBrand(niche) {
  const b = await one(`SELECT name, brand_kit FROM brands WHERE id=$1`, [niche.brand_id]); const k = P(b?.brand_kit) || {}, mc = methodCfg(niche);
  const local = async (url, ext) => { if (!url) return undefined; try { return await toTmpFile(url, ext); } catch (e) { warn(`brand asset ${url}: ${e.message}`); return undefined; } };
  const fontUrl = String(k.fonts_url || "").split(",")[0].trim();
  const musicList = mc.music === false || mc.music === "none" ? [] : [].concat(mc.music || k.music_urls || []).filter(Boolean);
  const brand = { name: k.display_name || b?.name || niche.display_name, primary: k.primary_color || "#b3121f", accent: k.accent_color || "#ffc400", text: k.text_color || "#ffffff",
    handle: k.handle || undefined, logo: await local(k.logo_url), font: fontUrl ? k.font || "BrandFont" : undefined, fontUrl: fontUrl ? await local(fontUrl, extname(fontUrl.split("?")[0]).slice(1) || "ttf") : undefined };
  return { brand, music: musicList.length ? await local(musicList[Math.floor(Math.random() * musicList.length)], "mp3") : undefined };
}
// Word timings for captions: the words spread over the part's measured duration by character count.
function wordTimings(text, frames, offset = 0) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean), total = words.reduce((n, w) => n + w.length + 1, 0) || 1; let t = offset;
  return words.map((w) => { const d = (frames * (w.length + 1)) / total, o = { text: w, from: Math.round(t), to: Math.round(t + d) }; t += d; return o; });
}
// Narration spoken part by part, so each part's duration is measured rather than guessed, then joined into one track.
// ---- Saying it properly. A speech model reads "BNP" as a word and "ACC" as a syllable, which is the most audible
// thing wrong with machine narration in Bangladeshi and American news alike. Any short run of capitals is spelled out
// letter by letter instead — in Bangla letter names for a Bangla voice — except the ones that really are read as words
// (NASA, UNESCO, RAB). A brand or a program can add its own spellings for names the voice keeps getting wrong:
// brand_kit.pronounce or method_config.pronounce, as {"written": "how to say it"}.
const SAID_AS_WORD = new Set(["NASA", "UNESCO", "UNICEF", "OPEC", "NATO", "RAB", "BRAC", "SAARC", "FIFA", "UEFA", "NCAA", "NASCAR", "ESPN", "AIDS", "COVID", "LASER", "RADAR", "SWAT", "PIN", "ZIP"]);
const BN_LETTER = { A: "এ", B: "বি", C: "সি", D: "ডি", E: "ই", F: "এফ", G: "জি", H: "এইচ", I: "আই", J: "জে", K: "কে", L: "এল", M: "এম", N: "এন", O: "ও", P: "পি", Q: "কিউ", R: "আর", S: "এস", T: "টি", U: "ইউ", V: "ভি", W: "ডাব্লিউ", X: "এক্স", Y: "ওয়াই", Z: "জেড" };
function sayable(text, { lang = "en", map = {} } = {}) {
  let out = String(text || "");
  // A person's own spellings win, and are applied first so they are not then broken up letter by letter.
  for (const [written, spoken] of Object.entries(map)) {
    if (!written) continue;
    const quoted = written.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`(^|[^\\p{L}\\p{N}])${quoted}(?=$|[^\\p{L}\\p{N}])`, "giu"), (_, pre) => `${pre}${spoken}`);
  }
  return out.replace(/(^|[^\p{L}\p{N}])([A-Z]{2,5})(?=$|[^\p{L}\p{N}])/gu, (whole, pre, acr) =>
    SAID_AS_WORD.has(acr) ? whole : `${pre}${acr.split("").map((c) => (lang === "bn" ? BN_LETTER[c] || c : c)).join(" ")}`);
}
// The program's voice, with everything it is asked to say run through the spellings first.
// The voice is the one stage that had no second option. A hosted TTS runs out of characters, refuses a language, or
// has a bad hour, and without a fallback every video the program makes stops until somebody notices. The chain is the
// same one the writer uses; a local engine (tts_command → piper, espeak) makes a good last resort because it cannot
// run out.
async function voiceFor(niche) {
  const own = niche.voice_adapter || "tts_mock";
  const fb = await fallbacksFor(niche.voice_adapter_fallbacks, "voice.default_fallbacks");
  const a = fb.length ? { synthesize: (args) => withFallbacks("VOICE", own, fb, (v) => v.synthesize(args)) } : await resolve("VOICE", own);
  const brand = niche.brand_id ? await one(`SELECT brand_kit FROM brands WHERE id = $1`, [niche.brand_id]) : null;
  const opts = { lang: (niche.language || "en").slice(0, 2), map: { ...((P(brand?.brand_kit) || {}).pronounce || {}), ...((P(niche.method_config) || {}).pronounce || {}) } };
  return { ...a, synthesize: async (args) => {
    const spoken = sayable(args.script, opts);
    const out = await a.synthesize({ ...args, script: spoken });
    return { ...out, spoken };                                   // what the voice was actually given, for the record
  } };
}
async function narrateParts(niche, parts, contentItemId) {
  const voice = await voiceFor(niche); const made = []; let cost = 0;
  for (const text of parts) { const a = await voice.synthesize({ script: text, voiceId: niche.voice_id, contentItemId }); cost += a.cost || 0; made.push(a); }
  if (made.some((a) => !a.url || a.url.startsWith("mock://"))) {
    const durations = made.map((a) => Number(a.duration_seconds) || 2);
    return { audio: { url: made[0]?.url || null, duration_seconds: durations.reduce((x, y) => x + y, 0), mock: true }, durations, cost };
  }
  const files = []; for (const a of made) files.push(await toTmpFile(a.url, "mp3"));
  const durations = []; for (const [i, f] of files.entries()) durations.push((await ffprobeDuration(f)) || Number(made[i].duration_seconds) || 2);
  const list = tmpPath("txt"), joined = tmpPath("mp3");
  await writeFile(list, files.map((f) => `file '${f.replace(/\\/g, "/")}'`).join("\n"));
  // Levelled as it is joined: speech models drift in loudness between calls, so a reel narrated in six pieces arrives
  // with six volumes. -16 LUFS with a 1.5 dB ceiling is what a phone speaker and a platform both expect of speech.
  try { await exec("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", list, "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-c:a", "libmp3lame", "-b:a", "160k", joined]); }
  catch (e) {
    warn(`narration loudness pass failed (${e.message.slice(0, 120)}); joining as recorded`);
    await exec("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", list, "-c:a", "libmp3lame", "-b:a", "160k", joined]);
  }
  finally { await cleanup(list, ...files); }
  const url = await storeLocal(joined, `audio/${newId()}.mp3`, "audio/mpeg"); const total = await ffprobeDuration(joined); await cleanup(joined);
  const audio = await recordMedia({ contentItemId, kind: "AUDIO", url, mime: "audio/mpeg", duration: total,
    meta: { parts: parts.length, voice: niche.voice_adapter, levelled: true, spoken: made.map((m) => m.spoken).filter(Boolean) } });
  return { audio, durations, cost };
}
impl("RENDER", "remotion", { label: "Studio (Remotion) for made videos, ffmpeg for footage", create: (cfg, ctx) => {
  const ff = IMPLS.RENDER.ffmpeg.create(cfg, ctx);
  return {
    // Everything the studio does not draw itself stays with ffmpeg — including the slideshow this falls back to when
    // the instance is too small for Chromium, which is what makes picking "remotion" safe on any size of machine.
    renderForChannel: (a) => ff.renderForChannel(a), renderClip: (a) => ff.renderClip(a), renderSlideshow: (a) => ff.renderSlideshow(a),
    // sections: [{image: url, narration, seconds}], audio: media row; returns a VIDEO media row.
    async renderReel({ sections, audio, niche, headline, kicker, credit, orientation = "9:16", contentItemId }) {
      const vertical = orientation !== "16:9", { brand, music } = await studioBrand(niche), locals = [];
      try {
        const props = { width: vertical ? 1080 : 1920, height: vertical ? 1920 : 1080, fps: STUDIO_FPS, lang: (niche.language || "en").slice(0, 2), brand, headline, kicker, credit, music, outroFrames: Math.round(2.5 * STUDIO_FPS), sections: [] };
        props.audio = audio?.url && !audio.mock ? locals[locals.push(await toTmpFile(audio.url, "mp3")) - 1] : undefined;
        for (const s of sections) {
          const frames = Math.max(STUDIO_FPS, Math.round(s.seconds * STUDIO_FPS));
          props.sections.push({ image: locals[locals.push(await toTmpFile(s.image, s.video ? "mp4" : undefined)) - 1], video: !!s.video, durationInFrames: frames, narration: s.narration, words: wordTimings(s.narration, frames) });
        }
        const out = await studioRender("NewsReel", props);
        return publishRender(out, contentItemId, { method: "STUDIO_REEL", orientation, sections: sections.length });
      } finally { await cleanup(...locals, brand.logo, brand.fontUrl, music); }
    },
  };
} });

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
        // Vertical short videos go out as Reels (start → hosted-file upload → finish), which reach far more people than
        // page videos; everything else is a normal page video.
        if (mediaKind === "VIDEO" && channel.format === "SHORT_FORM_VOICEOVER") {
          const s = await post(`${acct}/video_reels`, { upload_phase: "start", access_token: token });
          const up = await fetchJson(`https://rupload.facebook.com/video-upload/${cfg.api_version || DEFAULTS.META_API_VERSION}/${s.video_id}`, { method: "POST", headers: { Authorization: `OAuth ${token}`, file_url: mediaUrl } });
          if (up.success === false) throw new Error(`Facebook Reel upload failed: ${JSON.stringify(up).slice(0, 300)}`);
          await post(`${acct}/video_reels`, { upload_phase: "finish", video_id: s.video_id, video_state: "PUBLISHED", description: caption, title, access_token: token });
          return { externalId: s.video_id, publishedUrl: `https://www.facebook.com/reel/${s.video_id}` };
        }
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
    // Read-only connection check: is there a token, does it open the account the channel names, and is it the right
    // kind of token and id? Answered at setup instead of at the first post, where it would cost a real story.
    async check({ channel }) {
      const token = await metaToken(channel, cfg), acct = channel.platform_account_id, notes = [];
      if (!acct) return { ok: false, error: `This channel has no ${channel.platform === "INSTAGRAM" ? "Instagram user ID" : "Facebook Page ID"} — add it on the channel (Edit → account id).` };
      if (channel.platform === "INSTAGRAM") {
        // A Page has a "username" too, so that field cannot tell the two apart. media_count exists only on an
        // Instagram account; when the id is really a Page, the Page names the Instagram account linked to it.
        const ig = await fetchJson(`${base}/${acct}?${form({ fields: "id,username,media_count", access_token: token })}`).catch(() => null);
        if (ig?.username && ig.media_count !== undefined) return { ok: true, account: { id: ig.id, name: `@${ig.username}` }, notes };
        const page = await fetchJson(`${base}/${acct}?${form({ fields: "id,name,instagram_business_account{id,username}", access_token: token })}`).catch(() => null);
        const linked = page?.instagram_business_account;
        return { ok: false, error: linked
          ? `That is the Facebook Page "${page.name}", not an Instagram account. Its Instagram id is ${linked.id} (@${linked.username}) — put that on the channel.`
          : `${acct} does not open an Instagram account with this token. Instagram publishing needs the IG user id of a professional account linked to the Page.` };
      }
      const account = await fetchJson(`${base}/${acct}?${form({ fields: "id,name", access_token: token })}`);
      const me = await fetchJson(`${base}/me?${form({ fields: "id,name", access_token: token })}`).catch(() => null);
      if (me && me.id !== String(acct)) notes.push(`This is a token for "${me.name}", not for the Page itself. Posting is more reliable with a Page access token.`);
      return { ok: true, account: { id: account.id, name: account.name }, notes };
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
  async publish({ channel, mediaUrl, mediaKind, caption, title, hashtags = [], thumbnailUrl = null }) {
    if (mediaKind !== "VIDEO") throw new Error(`YouTube channel needs a VIDEO asset (got ${mediaKind})`);
    const token = await youtubeAccessToken(channel, cfg); const pc = P(channel.platform_config) || {};
    const file = await toTmpFile(mediaUrl, "mp4"); const bytes = await readFile(file); await cleanup(file);
    const isShort = channel.format === "SHORT_FORM_VOICEOVER";
    const meta = { snippet: { title: (isShort && !/#shorts/i.test(title) ? `${title} #Shorts` : title).slice(0, 100), description: caption?.slice(0, 4900) || "", tags: hashtags.map((h) => h.replace(/^#/, "")).slice(0, 20), categoryId: pc.category_id || cfg.category_id || "22" }, status: { privacyStatus: pc.privacy || cfg.privacy || "public", selfDeclaredMadeForKids: false } };
    const start = await fetch("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Upload-Content-Type": "video/mp4", "X-Upload-Content-Length": String(bytes.length) }, body: JSON.stringify(meta) });
    const loc = start.headers.get("location"); if (!loc) throw new ApiError(start.status, await start.text(), "YouTube resumable start failed");
    const r = await fetchJson(loc, { method: "PUT", headers: { "Content-Type": "video/mp4", "Content-Length": String(bytes.length) }, body: bytes });
    // Custom thumbnails need a verified channel; a refusal is logged, never fatal to the upload.
    if (thumbnailUrl && !isShort) { try { const t = await toTmpFile(thumbnailUrl, "jpg"); const tb = await readFile(t); await cleanup(t); await fetchJson(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${r.id}&uploadType=media`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "image/jpeg", "Content-Length": String(tb.length) }, body: tb }); } catch (e) { warn(`YouTube thumbnail for ${r.id}: ${e.message.slice(0, 200)}`); } }
    return { externalId: r.id, publishedUrl: `https://www.youtube.com/${isShort ? "shorts/" : "watch?v="}${r.id}` };
  },
  // Read-only: the refresh token still works and names the channel it will upload to.
  async check({ channel }) {
    const token = await youtubeAccessToken(channel, cfg);
    const r = await fetchJson("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", { headers: { Authorization: `Bearer ${token}` } });
    const ch = r.items?.[0];
    if (!ch) return { ok: false, error: "The OAuth token works but owns no YouTube channel — authorise with the Google account that owns the channel." };
    return { ok: true, account: { id: ch.id, name: ch.snippet?.title }, notes: [] };
  },
  async metrics({ channel, asset }) {
    const read = async (params, opts = {}) => {
      const r = await fetchJson(`https://www.googleapis.com/youtube/v3/videos?${form({ part: "statistics", id: asset.external_id, ...params })}`, opts);
      const s = r.items?.[0]?.statistics || {};
      return { views: Number(s.viewCount || 0), likes: Number(s.likeCount || 0), comments: Number(s.commentCount || 0), units: 1 };
    };
    // A data-API key if there is one; otherwise the channel's own OAuth token, which reads its videos' statistics too —
    // uploading should not also require a second key just to count views.
    if ((await credentialsFor("youtube", ctx.pin)).length) return withKey("youtube", (key) => read({ key }), ctx.pin);
    return read({}, { headers: { Authorization: `Bearer ${await youtubeAccessToken(channel, cfg)}` } });
  } }) });

// === 7. dedup / router / scheduler / review helpers ===================
// \p{M} keeps combining marks: Bangla vowel signs (া ি ে …) are marks, and stripping them shredded every Bangla word.
const tokenize = (t) => new Set(String(t).toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 2));
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
// What a sports or entertainment desk carries that is not a story: betting promos, streaming guides, shopping posts,
// score tickers. A program should not have to be told about any of it — the user creates a brand and a program, not a
// blocklist — so the desk it is on supplies the floor, and topic_filters.exclude adds to it rather than replacing it.
// A program that genuinely wants this sets topic_filters.desk_noise = false.
const DESK_NOISE = {
  // The betting-preview family is endless and all of it is the same article: who to bet on. Matching the whole family
  // rather than one phrasing of it, because "prediction, odds" and "prediction, picks" are the same piece twice.
  sports: ["promo code", "betting", "odds", "parlay", "draftkings", "fanduel", "bet365", "sportsbook", "how to watch",
    "live stream", "livestream", "where to watch", "start 'em", "sit 'em", "fantasy start", "waiver wire", "dfs picks",
    "best bets", "prediction", "predictions", "preview:", "over/under", "player props", "how to bet", "against the spread",
    "picks and prediction", "prediction, picks", "picks, preview", "expert picks", "top picks", "picks against",
    "gameday", "injury report", "final score:", "recap and highlights", "fight card:", "what channel",
    // The football-preview family, which is most of what a soccer wire carries: who might play, not what happened.
    "match preview", "team news", "predicted lineup", "predicted xi", "starting lineups", "confirmed lineups",
    "probable lineups", "preview and team news", "how to watch and stream"],
  entertainment: ["deal of the day", "best deals", "where to buy", "shop now", "shopping", "horoscope", "sponsored",
    "where to watch", "how to watch", "watch online", "streaming guide", "best vpn", "promo code", "gift guide",
    "everything coming to netflix", "what to watch this weekend"],
  // Applied to every program, whatever desk it is on: a shopping post, a sponsored slot or a link to the e-paper is
  // not a story anywhere. Deliberately short — anything arguable belongs on a desk list, not on the floor under all
  // of them.
  general: ["deal of the day", "best deals", "sponsored post", "promo code", "gift guide", "e-paper", "epaper",
    "ইপেপার", "photo gallery", "video gallery", "ছবির গ্যালারি", "সাপ্তাহিক রাশিফল", "আজকের রাশিফল"],
};
function passesFilters(item, niche) {
  const f = P(niche.topic_filters) || {}; const hay = `${item.title} ${item.summary || ""}`.toLowerCase();
  if (f.desk_noise !== false) {
    const topics = methodCfg(niche).topics || [];
    const noise = [...DESK_NOISE.general, ...topics.flatMap((t) => (String(t).toLowerCase() === "general" ? [] : DESK_NOISE[String(t).toLowerCase()] || []))];
    if (noise.some((k) => hay.includes(k))) return false;
  }
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
// Made videos (narrated reels, explainers) are written from articles like text posts but rendered on the video lane.
const MADE_VIDEO_TYPES = new Set(["IMAGE_SLIDESHOW", "LONG_FORM_VIDEO", "NEWS_REEL", "ANIMATED_EXPLAINER"]);
const CONTENT_TYPE_SET = new Set(["NEWS_STATIC", "NICHE_STATIC", "LONG_POST", ...MADE_VIDEO_TYPES, ...VIDEO_TYPES]);
const queueFor = (contentType) => VIDEO_TYPES.has(contentType) || MADE_VIDEO_TYPES.has(contentType) ? "video" : "text";
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

// ---- 7b. Source catalog. Bangladeshi sources verified live on 2026-09-19. Outlets whose own feeds are blocked or missing
// are reached through Google News (site search). A new program with country Bangladesh gets the entries in its language
// linked automatically (video programs get the TV channels); anything else can be added from the Sources page.
const gn = (key, name, language, site, weight = 1) => ({ key, name, language, adapter: "google_news", config: { site, language }, weight, poll: 20 });
// `site` is the outlet's domain: the feed is read directly where the server can reach it, and through Google News where
// it cannot. Direct is worth insisting on — it is the difference between a headline and a story with a photo.
const rss = (key, name, language, url, weight = 1, site = null) => ({ key, name, language, adapter: "rss", config: { url, ...(site ? { via_site: site } : {}) }, weight, poll: 10 });
const ytc = (key, name, channel_id, weight = 1) => ({ key, name, language: "bn", adapter: "youtube_rss", config: { channel_id }, weight, poll: 15, kind: "VIDEO" });
const BD_CATALOG = [
  // Every one of these feeds was checked: the ones listed with a domain serve their own items — with the summary, the
  // real article url and the photo the outlet ran — and fall back to Google News only if the server cannot reach them.
  // The remaining outlets have no working feed at all and are read through Google News, which gives a headline only.
  rss("bd-en-dailystar", "The Daily Star", "en", "https://www.thedailystar.net/news/bangladesh/rss.xml", 1.2, "thedailystar.net"),
  rss("bd-en-prothomalo", "Prothom Alo English", "en", "https://en.prothomalo.com/feed", 1.1, "en.prothomalo.com"),
  rss("bd-en-dhakatribune", "Dhaka Tribune", "en", "https://www.dhakatribune.com/feed/", 1, "dhakatribune.com"),
  rss("bd-en-tbs", "The Business Standard", "en", "https://www.tbsnews.net/top-news/rss.xml", 1, "tbsnews.net"),
  rss("bd-en-observer", "The Daily Observer", "en", "https://www.observerbd.com/rss", 0.8, "observerbd.com"),
  rss("bd-en-bss", "BSS (state news agency)", "en", "https://www.bssnews.net/rss/rss.xml", 0.8, "bssnews.net"),
  gn("bd-en-bdnews24", "bdnews24.com", "en", "bdnews24.com", 1.1),
  gn("bd-en-fe", "The Financial Express", "en", "thefinancialexpress.com.bd", 0.9),
  gn("bd-en-newage", "New Age", "en", "newagebd.net", 0.9),
  gn("bd-en-unb", "UNB", "en", "unb.com.bd", 0.8),
  { key: "bd-en-gnews", name: "Google News: Bangladesh", language: "en", adapter: "google_news", config: { query: "Bangladesh", language: "en" }, weight: 0.7, poll: 20 },
  rss("bd-bn-prothomalo", "প্রথম আলো", "bn", "https://www.prothomalo.com/feed", 1.3, "prothomalo.com"),
  rss("bd-bn-bbc", "বিবিসি বাংলা", "bn", "https://feeds.bbci.co.uk/bengali/rss.xml", 1.2),
  rss("bd-bn-banglatribune", "বাংলা ট্রিবিউন", "bn", "https://www.banglatribune.com/feed/", 1, "banglatribune.com"),
  rss("bd-bn-samakal", "সমকাল", "bn", "https://www.samakal.com/rss", 1, "samakal.com"),
  rss("bd-bn-ittefaq", "ইত্তেফাক", "bn", "https://www.ittefaq.com.bd/feed/", 1, "ittefaq.com.bd"),
  rss("bd-bn-deshrupantor", "দেশ রূপান্তর", "bn", "https://www.deshrupantor.com/feed/", 0.95, "deshrupantor.com"),
  rss("bd-bn-banglanews24", "বাংলানিউজ২৪", "bn", "https://banglanews24.com/rss.xml", 0.95, "banglanews24.com"),
  rss("bd-bn-dhakapost", "ঢাকা পোস্ট", "bn", "https://www.dhakapost.com/rss/rss.xml", 0.9, "dhakapost.com"),
  rss("bd-bn-inqilab", "দৈনিক ইনকিলাব", "bn", "https://www.dailyinqilab.com/rss/rss.xml", 0.85, "dailyinqilab.com"),
  rss("bd-bn-ajkerpatrika", "আজকের পত্রিকা", "bn", "https://www.ajkerpatrika.com/feed", 0.85, "ajkerpatrika.com"),
  rss("bd-bn-dw", "ডয়চে ভেলে বাংলা", "bn", "https://rss.dw.com/xml/rss-ben-all", 0.9),
  rss("bd-bn-risingbd", "রাইজিংবিডি", "bn", "https://www.risingbd.com/rss/rss.xml", 0.8, "risingbd.com"),
  gn("bd-bn-bdnews24", "বিডিনিউজ টোয়েন্টিফোর", "bn", "bangla.bdnews24.com", 1.1),
  gn("bd-bn-kalerkantho", "কালের কণ্ঠ", "bn", "kalerkantho.com", 1),
  gn("bd-bn-jugantor", "যুগান্তর", "bn", "jugantor.com", 1),
  gn("bd-bn-jagonews24", "জাগো নিউজ", "bn", "jagonews24.com", 0.9),
  gn("bd-bn-kalbela", "কালবেলা", "bn", "kalbela.com", 0.9),
  gn("bd-bn-bdpratidin", "বাংলাদেশ প্রতিদিন", "bn", "bd-pratidin.com", 0.9),
  { key: "bd-bn-gnews", name: "Google News: বাংলাদেশ", language: "bn", adapter: "google_news", config: { query: "বাংলাদেশ", language: "bn" }, weight: 0.7, poll: 20 },
  ytc("bd-tv-somoy", "SOMOY TV", "UCxHoBXkY88Tb8z1Ssj6CWsQ"),
  ytc("bd-tv-jamuna", "Jamuna TV", "UCN6sm8iHiPd0cnoUardDAnw"),
  ytc("bd-tv-channel24", "Channel 24", "UCHLqIOMPk20w-6cFgkA90jw"),
  ytc("bd-tv-ekattor", "Ekattor TV", "UCtqvtAVmad5zywaziN6CbfA"),
  ytc("bd-tv-independent", "Independent Television", "UCATUkaOHwO9EP_W87zCiPbA"),
  ytc("bd-tv-atn", "ATN News", "UC9Rgo0CrNyd7OWliLekqqGA", 0.9),
  ytc("bd-tv-ntv", "NTV News", "UCUDQdVsKssximyFwg4IxnOQ", 0.9),
  ytc("bd-tv-channeli", "Channel i News", "UC8NcXMG3A3f2aFQyGTpSNww", 0.9),
  ytc("bd-tv-dbc", "DBC NEWS", "UCUvXoiDEKI8VZJrr58g4VAw", 0.8),
  ytc("bd-tv-rtv", "Rtv News", "UC2P5Fd5g41Gtdqf0Uzh8Qaw", 0.8),
].map((e) => ({ country: "Bangladesh", kind: "ARTICLE", ...e }));

// United States, for programs aimed at that audience: sports, entertainment, technology and general news. Feeds that
// answer datacenter IPs are read directly; ESPN returns an empty body and Bleacher Report a 403, so those come through
// Google News like the blocked Bangladeshi outlets do. `topic` lets a program take only the desk it is about.
// Same as the Bangladesh catalog: the domain is the fallback route, used only when the server cannot read the feed.
const rssUs = (key, name, url, topic, weight = 1, site = null) => ({ key, name, adapter: "rss", config: { url, ...(site ? { via_site: site } : {}) }, weight, poll: 10, topic });
const gnUs = (key, name, site, topic, weight = 1) => ({ key, name, adapter: "google_news", config: { site, language: "en", gl: "US", hl: "en-US", ceid: "US:en" }, weight, poll: 20, topic });
const US_CATALOG = [
  rssUs("us-sport-cbs", "CBS Sports", "https://www.cbssports.com/rss/headlines/", "sports", 1.1, "cbssports.com"),
  rssUs("us-sport-yahoo", "Yahoo Sports", "https://sports.yahoo.com/rss/", "sports", 1, "sports.yahoo.com"),
  gnUs("us-sport-espn", "ESPN", "espn.com", "sports", 1.2),
  gnUs("us-sport-br", "Bleacher Report", "bleacherreport.com", "sports", 0.9),
  rssUs("us-sport-si", "Sports Illustrated", "https://www.si.com/feed", "sports", 0.9, "si.com"),
  rssUs("us-sport-aa", "Awful Announcing", "https://awfulannouncing.com/feed", "sports", 0.7, "awfulannouncing.com"),
  { key: "us-sport-gnews", name: "Google News: US sport", adapter: "google_news", config: { query: "NFL OR NBA OR MLB", language: "en", gl: "US", hl: "en-US", ceid: "US:en" }, weight: 0.7, poll: 20, topic: "sports" },
  rssUs("us-ent-variety", "Variety", "https://variety.com/feed/", "entertainment", 1.2, "variety.com"),
  rssUs("us-ent-deadline", "Deadline", "https://deadline.com/feed/", "entertainment", 1.1, "deadline.com"),
  rssUs("us-ent-thr", "The Hollywood Reporter", "https://www.hollywoodreporter.com/feed/", "entertainment", 1.1, "hollywoodreporter.com"),
  rssUs("us-ent-billboard", "Billboard", "https://www.billboard.com/feed/", "entertainment", 1, "billboard.com"),
  rssUs("us-ent-rollingstone", "Rolling Stone", "https://www.rollingstone.com/feed/", "entertainment", 0.9, "rollingstone.com"),
  rssUs("us-ent-screenrant", "Screen Rant", "https://screenrant.com/feed/", "entertainment", 0.8, "screenrant.com"),
  rssUs("us-ent-collider", "Collider", "https://collider.com/feed/", "entertainment", 0.8, "collider.com"),
  rssUs("us-ent-pitchfork", "Pitchfork", "https://pitchfork.com/feed/feed-news/rss", "entertainment", 0.8, "pitchfork.com"),
  gnUs("us-ent-ew", "Entertainment Weekly", "ew.com", "entertainment", 0.8),
  { key: "us-ent-gnews", name: "Google News: US entertainment", adapter: "google_news", config: { query: "box office OR streaming series OR celebrity", language: "en", gl: "US", hl: "en-US", ceid: "US:en" }, weight: 0.7, poll: 20, topic: "entertainment" },
  rssUs("us-tech-verge", "The Verge", "https://www.theverge.com/rss/index.xml", "tech", 1.1, "theverge.com"),
  rssUs("us-tech-techcrunch", "TechCrunch", "https://techcrunch.com/feed/", "tech", 1, "techcrunch.com"),
  rssUs("us-news-npr", "NPR", "https://feeds.npr.org/1001/rss.xml", "general", 1.2, "npr.org"),
  rssUs("us-news-abc", "ABC News", "https://abcnews.go.com/abcnews/topstories", "general", 1.1, "abcnews.go.com"),
  { key: "us-news-gnews", name: "Google News: United States", adapter: "google_news", config: { query: "United States", language: "en", gl: "US", hl: "en-US", ceid: "US:en" }, weight: 0.7, poll: 20, topic: "general" },
].map((e) => ({ country: "United States", language: "en", kind: "ARTICLE", ...e }));

const SOURCE_CATALOG = [...BD_CATALOG, ...US_CATALOG];
// Catalog entries a program should start with: same country, its language, articles or TV depending on the program type.
function catalogFor(niche) {
  const c = String(niche.country || "").trim().toLowerCase();
  const country = /^(bangladesh|bd)$/.test(c) ? "Bangladesh" : /^(united states|usa|us|america)$/.test(c) ? "United States" : null;
  if (!country) return [];
  const video = VIDEO_TYPES.has(niche.content_type);
  // A program says what it is about in method_config.topics (["sports"], ["entertainment"] …); without that it takes
  // every desk for its country, which is what a general news program wants.
  const topics = ((P(niche.method_config) || {}).topics || []).map((t) => String(t).toLowerCase());
  return SOURCE_CATALOG.filter((e) => e.country === country)
    .filter((e) => (video ? e.kind === "VIDEO" : e.kind === "ARTICLE" && e.language === (niche.language || "en").slice(0, 2)))
    .filter((e) => !topics.length || !e.topic || topics.includes(e.topic));
}
// Creates catalog sources that don't exist yet (one shared row per catalog key) and links them to the given programs.
async function installCatalogSources(entries, nicheIds = []) {
  const ids = [];
  for (const e of entries) {
    let s = await one(`SELECT id FROM sources WHERE catalog_key = $1`, [e.key]);
    if (!s) {
      await q(`INSERT INTO sources (id, name, kind, adapter_key, config, poll_interval_minutes, weight, catalog_key, language) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
        [newId(), e.name, e.kind, e.adapter, JSON.stringify(e.config), e.poll || 15, e.weight || 1, e.key, e.language]);
      s = await one(`SELECT id FROM sources WHERE catalog_key = $1`, [e.key]);
    }
    ids.push(s.id);
    for (const n of nicheIds) await q(`INSERT INTO niche_sources (id, niche_id, source_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [newId(), n, s.id]);
  }
  return ids;
}

// ---- 7c. News desk. New articles are grouped into story clusters across outlets and languages (embeddings when a
// program has an embedding adapter, word overlap otherwise). A sweep hands each program its best uncovered stories —
// ranked by how many outlets carry them, outlet weight and freshness — and the writer then gets every outlet's version,
// so a story is written once, from several sources, instead of once per outlet from one.
const DESK_TYPES = new Set(["NEWS_STATIC", "NICHE_STATIC", "LONG_POST", ...MADE_VIDEO_TYPES]);
// Per program (method_config.desk): min_sources = outlets required; settle_minutes = wait for more outlets unless already
// corroborated; max_age_hours = oldest publication date taken; per_sweep / min_gap_minutes = pacing.
const deskCfg = (niche) => ({ min_sources: 1, settle_minutes: 5, max_age_hours: 12, per_sweep: 2, min_gap_minutes: 10, max_pending: 3, ...((P(niche.method_config) || {}).desk || {}) });
const trimVec = (v, n = 256) => (Array.isArray(v) ? v.slice(0, n).map((x) => Math.round(x * 1e4) / 1e4) : null);
async function deskEmbedder() {
  const key = await setting("desk.embed_adapter", null) || (await one(`SELECT embed_adapter AS k, COUNT(*) AS n FROM niches WHERE is_active::int = 1 AND embed_adapter <> 'embed_mock' GROUP BY embed_adapter ORDER BY n DESC LIMIT 1`))?.k;
  if (!key) return null;
  try { const a = await resolve("EMBED", key); return a.embedMany ? a : null; } catch { return null; }
}
async function clusterItems(items, source) {
  const threshold = Number(await setting("desk.similarity", 0.84)), overlap = Number(await setting("desk.word_overlap", 0.5));
  let vecs = items.map(() => null);
  const emb = await deskEmbedder();
  if (emb) { try { vecs = await emb.embedMany(items.map((i) => `${i.title}. ${String(i.summary || "").slice(0, 300)}`)); } catch (e) { warn("desk embedding failed, clustering by word overlap:", e.message); } }
  const open = (await q(`SELECT id, title, embedding, outlets, weight_sum, item_count, published_at FROM story_clusters WHERE last_seen_at > now() - interval '36 hours' ORDER BY last_seen_at DESC LIMIT 800`))
    .map((c) => ({ ...c, vec: P(c.embedding), outlets: P(c.outlets) || [] }));
  const outlet = (it) => (it.raw?.outlet || source.name);
  for (const [i, it] of items.entries()) {
    const v = trimVec(vecs[i]);
    let best = null, bestScore = 0;
    for (const c of open) {
      const s = v && Array.isArray(c.vec) ? cosine(v, c.vec) : jaccard(it.title, c.title) * (threshold / overlap);
      if (s > bestScore) { best = c; bestScore = s; }
    }
    const name = outlet(it), weight = Number(source.weight) || 1;
    if (best && bestScore >= threshold) {
      const known = best.outlets.some((o) => o.name === name);
      if (!known) { best.outlets.push({ name, weight }); best.weight_sum = Number(best.weight_sum) + weight; }
      best.item_count = Number(best.item_count) + 1;
      if (v && Array.isArray(best.vec)) best.vec = trimVec(best.vec.map((x, k) => (x * (best.item_count - 1) + (v[k] || 0)) / best.item_count));
      const pub = it.published_at && (!best.published_at || new Date(it.published_at) < new Date(best.published_at)) ? it.published_at : best.published_at;
      best.published_at = pub;
      await q(`UPDATE story_clusters SET item_count=$2, source_count=$3, outlets=$4::jsonb, weight_sum=$5, embedding=$6, published_at=$7, last_seen_at=now(), title = CASE WHEN $8 THEN $9 ELSE title END WHERE id=$1`,
        [best.id, best.item_count, best.outlets.length, JSON.stringify(best.outlets), best.weight_sum, best.vec ? JSON.stringify(best.vec) : null, pub, !known && weight > Math.max(...best.outlets.filter((o) => o.name !== name).map((o) => o.weight)), it.title]);
      await q(`UPDATE source_items SET cluster_id=$2, embedding=$3, status='CLUSTERED' WHERE id=$1`, [it.id, best.id, v ? JSON.stringify(v) : null]);
    } else {
      const c = { id: newId(), title: it.title, vec: v, outlets: [{ name, weight }], weight_sum: weight, item_count: 1, published_at: it.published_at || null };
      await q(`INSERT INTO story_clusters (id, title, embedding, outlets, weight_sum, item_count, source_count, published_at) VALUES ($1,$2,$3,$4::jsonb,$5,1,1,$6)`, [c.id, c.title, v ? JSON.stringify(v) : null, JSON.stringify(c.outlets), weight, c.published_at]);
      await q(`UPDATE source_items SET cluster_id=$2, embedding=$3, status='CLUSTERED' WHERE id=$1`, [it.id, c.id, v ? JSON.stringify(v) : null]);
      open.unshift(c);
    }
  }
}
let deskTimer = null;
const deskSoon = () => { if (!deskTimer) deskTimer = setTimeout(() => { deskTimer = null; sweepNewsDesk().catch((e) => warn("news desk", e.message)); }, 1000); };
async function sweepNewsDesk() {
  if (!(await setting("desk.enabled", true))) return;
  const programs = (await q(`SELECT * FROM niches WHERE is_active::int = 1 ORDER BY priority DESC`)).filter((n) => DESK_TYPES.has(n.content_type));
  for (const niche of programs) {
    const cfg = deskCfg(niche);
    if (!(await underDailyCap(niche))) continue;
    // Don't take stories the writer cannot get to: while its quota is used up, and whenever work is already piling up.
    const pause = await setting(`quota.pause.${niche.id}`, null);
    if (pause?.until && new Date(pause.until) > new Date()) continue;
    const pending = await one(`SELECT COUNT(*)::int AS n FROM jobs j JOIN content_items ci ON ci.id = j.content_item_id
      WHERE ci.niche_id = $1 AND j.status IN ('PENDING','RUNNING') AND j.type IN ('GENERATE_CONTENT','RENDER_CLIP','PROCESS_CANDIDATE')`, [niche.id]);
    if (pending.n >= cfg.max_pending) continue;
    const last = await one(`SELECT max(created_at) AS t FROM content_items WHERE niche_id = $1 AND cluster_id IS NOT NULL`, [niche.id]);
    if (last?.t && Date.now() - new Date(last.t).getTime() < cfg.min_gap_minutes * 60000) continue;
    const rows = await q(`SELECT c.*, LEAST(c.weight_sum, 6) * exp(-extract(epoch FROM now() - c.first_seen_at) / 64800.0) AS score FROM story_clusters c
      WHERE COALESCE(c.published_at, c.first_seen_at) > now() - ($2 || ' hours')::interval AND c.source_count >= $3
        AND (c.source_count >= 2 OR c.first_seen_at < now() - ($4 || ' minutes')::interval)
        AND EXISTS (SELECT 1 FROM source_items si JOIN niche_sources ns ON ns.source_id = si.source_id WHERE si.cluster_id = c.id AND ns.niche_id = $1)
        AND NOT EXISTS (SELECT 1 FROM content_items ci WHERE ci.niche_id = $1 AND ci.cluster_id = c.id)
      ORDER BY score DESC LIMIT 40`, [niche.id, String(cfg.max_age_hours), cfg.min_sources, String(cfg.settle_minutes)]);
    let taken = 0;
    for (const c of rows) {
      if (taken >= cfg.per_sweep || taken + pending.n >= cfg.max_pending || !(await underDailyCap(niche))) break;
      // The lead version comes from the program's own sources, preferring its language and the heaviest outlet.
      const rep = await one(`SELECT si.* FROM source_items si JOIN sources s ON s.id = si.source_id JOIN niche_sources ns ON ns.source_id = si.source_id AND ns.niche_id = $2
        WHERE si.cluster_id = $1 ORDER BY COALESCE(s.language = $3, false) DESC, s.weight DESC, si.created_at ASC LIMIT 1`, [c.id, niche.id, (niche.language || "en").slice(0, 2)]);
      if (!rep || !passesFilters({ title: c.title, summary: rep.summary, published_at: c.published_at }, niche)) continue;
      const itemId = await createQueuedItem(niche, { sourceItemId: rep.id, clusterId: c.id, topic: rep.title, sourceDataRef: { provider: "news_desk", url: rep.url, title: rep.title, summary: rep.summary, published_at: rep.published_at, outlets: (P(c.outlets) || []).map((o) => o.name) } });
      await enqueue("GENERATE_CONTENT", { itemId }, { queue: queueFor(niche.content_type), priority: niche.priority, contentItemId: itemId });
      await q(`UPDATE source_items SET status = 'ROUTED' WHERE id = $1`, [rep.id]);
      taken++;
    }
  }
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
async function rejectItem(itemId, note) {
  const row = await one(`UPDATE content_items SET status='REJECTED', rejection_note=$2 WHERE id=$1 RETURNING *`, [itemId, note || "Rejected by reviewer"]);
  if (row && note) await logStyleFeedback(row, "REJECT", [{ note }]).catch((e) => warn("style feedback", e.message));
  return row;
}
// Every draft passes the quality gate. MANUAL: always waits for a person (the report is shown in Review). AUTO: a clean
// draft publishes, a flagged one waits, a REJECT is set aside. AUTO_AFTER_WINDOW: only a clean draft gets the countdown.
async function finishGeneration(itemId, niche) {
  const mode = niche.approval_mode || "MANUAL";
  if (await setting(`quota.pause.${niche.id}`, null)) await putSetting(`quota.pause.${niche.id}`, null);   // the writer answered: take stories again
  const qa = await qualityGate(itemId, niche), clean = qa.status === "PASS" || qa.status === "SKIPPED";
  if (mode === "AUTO" && qa.status === "REJECT") return one(`UPDATE content_items SET status='REJECTED', rejection_note=$2 WHERE id=$1 RETURNING *`, [itemId, `Quality gate: ${qa.report?.summary || "flagged as unsafe to publish"}`]);
  if (mode === "AUTO" && clean) { await q(`UPDATE content_items SET status='PENDING_REVIEW' WHERE id=$1`, [itemId]); return approveItem(itemId, { auto: true }); }
  const deadline = mode === "AUTO_AFTER_WINDOW" && clean ? new Date(Date.now() + (niche.review_window_minutes || 60) * 60000).toISOString() : null;
  return one(`UPDATE content_items SET status='PENDING_REVIEW', review_deadline_at=$2 WHERE id=$1 RETURNING *`, [itemId, deadline]);
}

// === 8. orchestrator ===================================================
async function createQueuedItem(niche, { sourceItemId = null, seriesId = null, topic = "", sourceDataRef = null, contentType = null, candidateId = null, clipId = null, clusterId = null, status = "QUEUED" }) {
  const id = newId();
  await q(`INSERT INTO content_items (id, niche_id, series_id, source_item_id, video_candidate_id, clip_id, cluster_id, content_type, status, topic, source_data_ref, niche_profile_version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [id, niche.id, seriesId, sourceItemId, candidateId, clipId, clusterId, contentType || niche.content_type, status, topic, J(sourceDataRef), J({ niche, capturedAt: nowIso() })]);
  return id;
}
async function setItem(id, fields) {
  const keys = Object.keys(fields); const sets = keys.map((k, i) => `${k} = $${i + 2}`);
  await q(`UPDATE content_items SET ${sets.join(", ")} WHERE id = $1`, [id, ...keys.map((k) => (fields[k] !== null && typeof fields[k] === "object" ? JSON.stringify(fields[k]) : fields[k]))]);
}
async function addCost(itemId, usd) { if (usd) await q(`UPDATE content_items SET generation_cost_usd = generation_cost_usd + $2 WHERE id = $1`, [itemId, usd]); }
// A call to action that points at a link only belongs on a post that carries one. A style written before the program
// had a portal (or written by a model that assumed one) would otherwise end every caption with a dead promise.
const LINK_CTA = /link in (our |the )?bio|link below|read more at|swipe up|tap the link|click the link|full story at/i;
function styleBlock(style, niche = null) {
  if (!style) return "";
  // A CTA a person typed is theirs to keep — they know what is in their bio. A generated one is only trusted to send
  // readers somewhere when the program actually attaches a link, which today means the portal is on.
  const hasLink = !flag(style.generated) || flag(niche?.publish_to_portal);
  const cta = style.cta && (hasLink || !LINK_CTA.test(style.cta)) ? style.cta : null;
  return `\nWRITING STYLE "${style.name}": tone: ${style.tone}. Rules: ${style.rules}. ${style.examples ? `Examples of the voice:\n${style.examples}\n` : ""}${(P(style.banned_terms) || []).length ? `Never use these words/phrases: ${(P(style.banned_terms) || []).join(", ")}.` : ""} ${cta ? `End with this call to action: ${cta}.` : hasLink ? "" : "These posts carry no link: never tell readers to tap a link, read more elsewhere or check the bio."} ${(P(style.hashtags) || []).length ? `Always include hashtags: ${(P(style.hashtags) || []).join(" ")}.` : ""}`;
}
// Specs for a text item's hero picture: photocard layout with the brand kit and a date / source-credit line, overridden by
// the program's image_specs. News pictures default to illustration: a realistic "photo" of a real event would mislead.
async function cardSpecs(niche, m = {}, { width = 1080, height = 1080 } = {}) {
  const brand = await one(`SELECT name, brand_kit FROM brands WHERE id = $1`, [niche.brand_id]);
  const kit = P(brand?.brand_kit) || {}, own = P(niche.image_specs) || {}, lang = (niche.language || "en").slice(0, 2);
  // The kit's colours are lifted out of it, because the overlay composer reads them at the top level — without this a
  // brand's own accent is quietly replaced by a default blue on every headline burned over a picture.
  const specs = { width, height, brand: kit.display_name || brand?.name || niche.display_name, layout: "photocard", lang, kit,
    accent_color: kit.accent_color, text_color: kit.text_color, photo: m.photo || null, photo_outlet: m.photo_outlet || null, ...own };
  if (specs.layout === "photocard") {
    const outlets = [...new Set((m.versions?.length ? m.versions.map((v) => v.outlet) : [m.raw?.outlet]).filter(Boolean))].slice(0, 2);
    specs.card_meta = { date: cardDate(lang, /bangladesh/i.test(niche.country || "") ? "Asia/Dhaka" : "UTC"), credit: kit.credit_sources === false || !outlets.length ? null : `${lang === "bn" ? "সূত্র" : "Source"}: ${outlets.join(", ")}` };
    specs.aspect_ratio = own.aspect_ratio || nearestRatio(specs.width, Math.round(specs.height * (kit.image_ratio || 0.6)));
  }
  if (!own.style && niche.content_type === "NEWS_STATIC") specs.style = "Editorial illustration in a modern digital-painting style: rich colour, dramatic light, clearly an illustration rather than a photograph, no identifiable real people, no text.";
  return specs;
}
// The little label on a text card: news says "latest" in the program's language, anything else says which program it is.
const cardLabel = (niche) => (/^NEWS/.test(niche.content_type || "") ? undefined : niche.display_name);
const llmFor = async (niche, fn) => withFallbacks("SCRIPT", niche.script_adapter, await fallbacksFor(niche.script_adapter_fallbacks, "llm.default_fallbacks"), fn);
// `lead` puts an adapter in front of the program's own, without disturbing what the program is configured to use: the
// story's own photo is tried first when it has one, and what the program would have drawn is the fallback.
const imageFor = async (niche, fn, lead = null, tail = null) => {
  const own = niche.image_adapter || "image_mock", fb = await fallbacksFor(niche.image_adapter_fallbacks, "image.default_fallbacks");
  const chain = [...(lead ? [own] : []), ...fb, ...(tail ? [tail] : [])];
  return withFallbacks("IMAGE", lead || own, chain, fn);
};
// The hero picture — or, when every image adapter fails (no key, a plan without image generation, an outage), a text
// card in the brand's colours so the post still goes out. The reason is kept on the media row and raised once as an
// alert rather than per item. `backdrop` asks for the card without text (a reel section's background), `skipApi` says
// an earlier picture in the same item already failed, so don't call the API again.
async function imageOrCard(niche, itemId, { prompt, headline, specs, label = undefined, backdrop = false, skipApi = null }) {
  let err = skipApi;
  if (!err) {
    // A real photo of the story beats any illustration of it, and costs nothing, so it goes first — except on a reel's
    // later sections, where `photo_lead: false` puts it last instead: footage or a generated picture gives the video
    // somewhere new to look, and the story's photo coming back a second time is still better than an empty colour field.
    const wantPhoto = specs.photo && methodCfg(niche).source_photos !== false;
    const lead = wantPhoto && specs.photo_lead !== false ? "source_photo" : null;
    const tail = wantPhoto && specs.photo_lead === false ? "source_photo" : null;
    try { return await imageFor(niche, (ia) => ia.generate({ prompt, headline, specs, contentItemId: itemId }), lead, tail); }
    catch (e) { if (!(await setting("image.text_card_fallback", true))) throw e; err = e; }
  }
  const kit = specs.kit || P((await one(`SELECT brand_kit FROM brands WHERE id=$1`, [niche.brand_id]))?.brand_kit) || {};
  let card;
  try { card = await storeTextCard(itemId, backdrop ? "" : headline, { ...specs, kit, label }, err.message); }
  catch (e2) { warn(`text card failed: ${e2.message.slice(0, 160)}`); throw err; }
  if (!skipApi) {
    warn(`no picture (${err.message.slice(0, 140)}) — used a ${backdrop ? "brand backdrop" : "text card"}`);
    // An editorial decision not to illustrate a story is a normal outcome, not something for a person to fix.
    const editorial = err.editorial || (err.causes?.length > 0 && err.causes.every((c) => c.editorial));
    if (!editorial) await notifyNoPictures(err).catch((e) => warn("alert", e.message));
  }
  return { ...card, cost: 0, fallbackError: err };
}
async function notifyNoPictures(e) {
  const qw = quotaWait(e), provider = PROVIDER_HOSTS.find(([h]) => e.message.includes(h))?.[1] || "The image model";
  const hint = qw && qw.kind !== "minute" && qw.freeTier ? `${provider}'s free tier does not generate pictures. Enable billing on the key (Google AI Studio → Billing — about $0.04 a picture) and pictures come back on their own.`
    : qw ? `${provider} is over its image quota. It resumes when the quota resets; enabling billing or adding a second key lifts it.`
    : /No API key/i.test(e.message) ? `Add an image key on the API keys page (or set it on Render) to get pictures back.`
    : `${provider} could not make a picture.`;
  await notify("provider", "Posts are going out as text cards (no pictures)", `${hint}\n\nLast error: ${String(e.message).slice(0, 400)}`, { key: "image-fallback", cooldownHours: 12 });
}

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
// The picture the outlet ran with the story, taken off the page it is already fetching for the text: og:image is what
// every newsroom CMS writes for Facebook, so it is the same photo the outlet's own post uses.
const ogImage = (html) => {
  for (const re of [/<meta[^>]+property=["']og:image(?::url)?["'][^>]+content=["']([^"']+)["']/i,
                    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::url)?["']/i,
                    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i]) {
    const m = re.exec(html); if (m && /^https?:\/\//i.test(m[1])) return decodeXml(m[1]);
  }
  return "";
};
// The story's own photo: what the feed carried, else what the article page declared.
const leadPhoto = (sourceItem) => sourceItem.thumbnail_url || P(sourceItem.raw)?.lead_image || null;
async function articleText(sourceItem) {
  const raw = P(sourceItem.raw) || {};
  if (typeof raw.article_text === "string") return raw.article_text;                       // cached (may be "" = tried, nothing usable)
  if (!(await setting("ingest.fetch_article_text", true)) || !/^https?:/.test(sourceItem.url || "")) return "";
  if (/^https?:\/\/news\.google\.com\//.test(sourceItem.url)) return "";                   // redirect page, no article text
  let text = "", image = "";
  try {
    const res = await fetch(sourceItem.url, { redirect: "follow", signal: AbortSignal.timeout(15000), headers: { "user-agent": FEED_UA, accept: "text/html,*/*" } });
    if (res.ok && /html/i.test(res.headers.get("content-type") || "")) { const html = (await res.text()).slice(0, 1.5e6); text = extractArticleText(html); image = ogImage(html); }
  } catch (e) { warn(`article fetch ${sourceItem.url}: ${e.message.slice(0, 120)}`); }
  await q(`UPDATE source_items SET raw = COALESCE(raw, '{}'::jsonb) || $2::jsonb WHERE id = $1`, [sourceItem.id, JSON.stringify({ article_text: text, ...(image ? { lead_image: image } : {}) })]).catch(() => {});
  if (image) sourceItem.raw = { ...raw, lead_image: image };                               // so the caller can use it without re-reading
  return text;
}
// A news-desk item's material: up to four outlets' versions of the story (the program's lead source first), each with
// its article text when the outlet's page can be read.
async function clusterMaterial(item) {
  const rows = await q(`SELECT si.*, s.name AS source_name, s.weight FROM source_items si JOIN sources s ON s.id = si.source_id WHERE si.cluster_id = $1 ORDER BY (si.id = $2) DESC, s.weight DESC, si.created_at ASC LIMIT 16`, [item.cluster_id, item.source_item_id || ""]);
  if (!rows.length) return null;
  const versions = [], seen = new Set();
  for (const r of rows) {
    const outlet = P(r.raw)?.outlet || r.source_name; if (seen.has(outlet)) continue; seen.add(outlet);
    const text = r.kind === "ARTICLE" ? await articleText(r) : "";                       // also fills in the page's own photo
    versions.push({ outlet, title: r.title, summary: r.summary || "", text, url: r.url, published_at: r.published_at, photo: leadPhoto(r) });
    if (versions.length >= 4) break;
  }
  // The heaviest outlet is not always the one with anything to read. An outlet read through Google News gives a
  // headline and a redirect url — no summary, no article, no photograph — so leading on it throws away the story that
  // another outlet in the same cluster actually published. The lead for *material* is the first version that has
  // something in it; every outlet is still credited, and the corroboration count is unchanged.
  const lead = versions.find((v) => v.text) || versions.find((v) => v.summary) || versions[0];
  // The heaviest outlet that ran a picture: the lead's own if it has one, otherwise a corroborating outlet's, since the
  // story is the same story. Which outlet it came from is kept, because the credit on the card has to be true.
  const withPhoto = versions.find((v) => v.photo);
  return { title: lead.title, summary: lead.summary, text: lead.text, url: lead.url, published_at: lead.published_at,
    photo: withPhoto?.photo || null, photo_outlet: withPhoto?.outlet || null, raw: { outlets: versions.map((v) => v.outlet) }, versions };
}
// The material as prompt text. Several outlets' versions are each clipped so the total stays near ARTICLE_TEXT_MAX, and
// the writer is told how to treat agreement and conflict between them.
function materialBlock(m) {
  const vs = m.versions?.length ? m.versions : [{ outlet: null, title: m.title, summary: m.summary, text: m.text, url: m.url }];
  const per = Math.max(1200, Math.floor(ARTICLE_TEXT_MAX / vs.length));
  const body = vs.map((v, i) => `--- Source ${i + 1}${v.outlet ? `: ${v.outlet}` : ""}${v.url ? ` (${v.url})` : ""}\nHeadline: ${v.title}\n${v.summary ? `Summary: ${v.summary}\n` : ""}${v.text ? `Text:\n"""\n${v.text.slice(0, per)}\n"""\n` : "(headline and summary only)\n"}`).join("\n");
  return `SOURCE MATERIAL — ${vs.length} source${vs.length > 1 ? "s" : ""} reporting this story\n${body}\n`
    + (vs.length > 1 ? "Use only facts the sources state. Prefer facts several sources agree on; where they differ (numbers, names, times) use the most careful wording or say that reports differ. Never merge details from different incidents.\n" : "")
    + (vs.some((v) => v.text) ? "" : "Only headlines/summaries are available — write ONLY what they support and keep it short rather than padding it.\n");
}
// A bare language code in front of English source material is not an instruction a model reliably follows: it reads
// the sources, and it answers in their language. Naming the language and saying explicitly that the sources are not
// the language to write in is the difference between a Bangladeshi channel posting in Bangla and posting in English.
// The language a country's audience actually reads, used only when a program does not say.
const COUNTRY_LANGUAGE = { bangladesh: "bn", "united states": "en", "united kingdom": "en", india: "en", pakistan: "ur", indonesia: "id", "saudi arabia": "ar", nepal: "ne" };
const LANG_NAMES = { bn: "Bangla (Bengali)", en: "English", hi: "Hindi", ur: "Urdu", ar: "Arabic", es: "Spanish", fr: "French", pt: "Portuguese", id: "Indonesian", ta: "Tamil", ne: "Nepali" };
const langLine = (code) => {
  const c = String(code || "en").slice(0, 2).toLowerCase(), name = LANG_NAMES[c] || c;
  return c === "en" ? `Language: ${name}.`
    : `Language: ${name} — write EVERY word you produce in ${name}: headline, summary, narration, captions and hashtags. The source material is often in English; translate its facts into ${name} rather than copying its wording, and never answer in the language of the sources. Proper nouns keep their usual local spelling.`;
};
const richMaterial = (m) => (m.versions?.length ? m.versions.some((v) => v.text) : !!m.text);
// Resolve the raw material for a text item: a news-desk story cluster, a routed source_item, or a legacy TOPIC adapter pull.
async function materialFor(item, niche) {
  if (item.cluster_id) { const m = await clusterMaterial(item); if (m) return m; }
  if (item.source_item_id) { const s = await one(`SELECT * FROM source_items WHERE id = $1`, [item.source_item_id]); const text = s.kind === "ARTICLE" ? await articleText(s) : ""; return { title: s.title, summary: s.summary, text, url: s.url, published_at: s.published_at, thumbnail: s.thumbnail_url, photo: leadPhoto(s), photo_outlet: P(s.raw)?.outlet || null, raw: P(s.raw) }; }
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
  await setItem(item.id, { status: "DRAFTING", topic: m.title, source_data_ref: { ...(m.raw || {}), url: m.url, summary: m.summary, photo: m.photo || null, photo_outlet: m.photo_outlet || null }, topic_embedding: J(dedup.embedding) });
  const portal = flag(niche.publish_to_portal); const lang = niche.language || "en";
  const r = await llmFor(niche, (llm) => llm.complete({ json: true, maxTokens: portal ? 4000 : 1500,
    system: `You are the editor of "${niche.display_name}"${niche.country ? ` for ${niche.country}` : ""}. ${langLine(lang)} Tone: ${niche.tone || "clear and engaging"}. You never invent facts beyond the provided material${flag(niche.fact_check_strict) ? " and you attribute claims to the source" : ""}.${styleBlock(style, niche)}${item._series || ""}`,
    prompt: `${materialBlock(m)}\nProduce JSON with:\n- "headline": a click-worthy but accurate headline (max 12 words)\n- "summary": 2-3 sentence summary\n${portal ? `- "article_html": a news article as simple HTML (<p>, <h2>) written strictly from the material (${richMaterial(m) ? "350-600 words" : "as long as the facts allow, 120-250 words"}), ending with a one-line credit naming the source outlet(s)\n` : ""}- "image_prompt": a vivid visual description for a generated hero image (no text instructions, no logos, no real faces)\n- "photo_query": 2-5 words to find a library photo that honestly illustrates this story (a place, an activity, an object) — or null when a generic photo could mislead a reader: a specific incident, crime, accident or death, a named person, or a claim a reader would take the photo as evidence for\n- "captions": {"facebook": engaging 2-4 sentence caption, "instagram": caption with line breaks and emoji sparingly, "x": <=240 chars, "linkedin": professional 2-3 sentences}\n- "hashtags": 4-8 relevant hashtags without spaces`,
    mock: { headline: m.title, summary: m.summary || `Quick take on: ${m.title}`, article_html: `<p>${m.summary || m.title}</p><p>Source: ${m.url || "mock"}</p>`, image_prompt: `Editorial illustration for: ${m.title}`, photo_query: "dhaka city", captions: { facebook: `${m.title} — here's what you need to know.`, instagram: `${m.title} ✨`, x: m.title.slice(0, 200), linkedin: m.title }, hashtags: ["news", niche.key] } }));
  const d = r.data || {}; await addCost(item.id, r.cost);
  await setItem(item.id, { headline: d.headline || m.title, summary: d.summary || m.summary, body: portal ? d.article_html || null : null, captions: d.captions || {}, hashtags: Array.isArray(d.hashtags) ? d.hashtags : [], image_prompt: d.image_prompt || null });
  // photo_query is the writer's judgement that a library photo can illustrate this story honestly; no phrase, no photo.
  const specs = { ...(await cardSpecs(niche, m)), photo_query: typeof d.photo_query === "string" ? d.photo_query : null };
  const img = await imageOrCard(niche, item.id, { prompt: d.image_prompt, headline: d.headline || m.title, specs, label: cardLabel(niche) });
  await addCost(item.id, img.cost); await setItem(item.id, { hero_media_id: img.id });
}
// ---- 8b. LONG_POST: research first (notes with citations), then write in the style profile
async function generateLongPost(item, niche, style) {
  const m = await materialFor(item, niche);
  const dedup = await checkDuplicate(m.title, niche, item.series_id, item.id); if (dedup.isDuplicate) throw new Error(`Dedup: too similar to "${dedup.best.topic}"`);
  await setItem(item.id, { status: "DRAFTING", topic: m.title, source_data_ref: { ...(m.raw || {}), url: m.url }, topic_embedding: J(dedup.embedding) });
  const research = await llmFor(niche, (llm) => llm.complete({ json: true, grounding: true, maxTokens: 3000,
    system: "You are a meticulous researcher. Gather verifiable facts with sources. Never fabricate a citation.",
    prompt: `Topic: ${m.title}\n${materialBlock(m)}\nReturn JSON: {"notes": [{"fact": "...", "source_url": "https://...", "source_name": "..."}], "angle": "the most interesting angle for a long social post"} with 6-12 notes.`,
    mock: { notes: [{ fact: `Mock fact about ${m.title}`, source_url: m.url || "https://example.com", source_name: "mock" }], angle: "mock angle" } }));
  await addCost(item.id, research.cost);
  const notes = research.data?.notes || []; const cites = [...new Set([...(research.citations || []), ...notes.map((n) => n.source_url).filter(Boolean)])];
  await q(`INSERT INTO research_notes (id, niche_id, content_item_id, topic, notes, citations, created_by) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)`, [newId(), niche.id, item.id, m.title, JSON.stringify(notes), JSON.stringify(cites), research.model || "mock"]);
  const post = await llmFor(niche, (llm) => llm.complete({ json: true, maxTokens: 3000,
    system: `You write long-form Facebook posts for "${niche.display_name}". ${langLine(niche.language)} Tone: ${niche.tone}.${styleBlock(style, niche)} Use ONLY the research notes as facts.${item._series || ""}`,
    prompt: `Topic: ${m.title}\nAngle: ${research.data?.angle || ""}\nResearch notes:\n${notes.map((n) => `- ${n.fact} (${n.source_name || n.source_url || "source"})`).join("\n")}\n\nReturn JSON: {"headline": "first line hook", "post": "the full 250-600 word post with paragraph breaks", "hashtags": ["..."], "image_prompt": "visual for a cover image"}`,
    mock: { headline: m.title, post: `${m.title}\n\n${notes.map((n) => n.fact).join("\n\n")}`, hashtags: ["longpost"], image_prompt: `Cover for ${m.title}` } }));
  await addCost(item.id, post.cost); const d = post.data || {};
  await setItem(item.id, { headline: d.headline || m.title, body: d.post || "", summary: (d.post || "").slice(0, 280), captions: { facebook: d.post || "", default: d.post || "" }, hashtags: d.hashtags || [], image_prompt: d.image_prompt || null });
  if ((P(niche.method_config) || {}).cover_image !== false) { const img = await imageOrCard(niche, item.id, { prompt: d.image_prompt, headline: d.headline || m.title, label: cardLabel(niche), specs: { width: 1200, height: 630, brand: niche.display_name, ...(P(niche.image_specs) || {}) } }); await addCost(item.id, img.cost); await setItem(item.id, { hero_media_id: img.id }); }
}
// ---- 8c. Narrated reels: NEWS_REEL (a story in 35-60 s), IMAGE_SLIDESHOW (facts video), LONG_FORM_VIDEO (researched,
// 16:9). Script in sections → one picture per section → narration per section (measured) → the studio renders a branded
// reel with karaoke captions; without the studio, ffmpeg renders a slideshow with the same per-section timing.
// A newspaper lede and a short-form hook are not the same thing, and the engine was writing ledes. A reader who has
// already opened the paper will read "Officials said on Tuesday that"; a viewer decides inside two seconds and is gone.
// So: the most surprising concrete fact first, a question the video has to answer, and an ending that answers it.
// None of this loosens the rule that every fact comes from the sources — an invented hook is worse than a dull one.
const RETENTION = "Structure, in order: (1) the single most surprising concrete fact, said plainly — a number, a name, a"
  + " thing that happened; (2) why it matters or who it hits; (3) the detail that makes it real; (4) the turn — what"
  + " was expected instead, or what changed; (5) the answer to the question the opening raised; (6) what happens next."
  + " Never open with the date, the outlet, 'Breaking', 'In a stunning turn' or any throat-clearing: the first words"
  + " are the fact itself. Never tease something you do not then deliver. Short sentences, spoken not written.";
// A hook that ends on "over", "of" or "the" reads as a sentence someone cut in half — which is exactly what it looks
// like on a cover, where it is the only text. Trailing joining words come off; if that leaves nothing, there is no hook
// and the headline is used instead.
const HOOK_TAIL = /^(?:a|an|the|of|for|over|under|in|on|to|and|or|with|as|at|by|from|that|than|after|before|into|about|is|was|are|were|has|have|had|but|its|his|her|their)$/i;
function tidyHook(raw) {
  const w = String(raw || "").trim().replace(/[\s–—-]+$/, "").split(/\s+/).filter(Boolean).slice(0, 8);
  while (w.length && HOOK_TAIL.test(w[w.length - 1].replace(/[^\p{L}\p{N}']/gu, ""))) w.pop();
  return w.length >= 2 ? w.join(" ") : null;
}
const REEL_SPEC = {
  NEWS_REEL: { sections: 6, words: "1-2 short spoken sentences", system: `You turn a news story into a 35-60 second vertical news reel that people watch to the end. ${RETENTION} Facts only from the sources.` },
  IMAGE_SLIDESHOW: { sections: 8, words: "2-3 spoken sentences", system: `You write punchy 60-90 second facts videos that people watch to the end. ${RETENTION}` },
  LONG_FORM_VIDEO: { sections: 12, words: "4-6 spoken sentences", system: "You write researched long-form YouTube video scripts. The first 15 seconds say what the viewer will know by the end and why it is worth their time — state the payoff, do not tease it. Then earn it: each section raises the question the next one answers, and the last one closes the loop the first one opened. No filler, no recap of what was just said, no 'in this video we will'." },
};
async function generateReel(item, niche, style) {
  const m = await materialFor(item, niche); const type = item.content_type || niche.content_type, spec = REEL_SPEC[type] || REEL_SPEC.IMAGE_SLIDESHOW, mc = methodCfg(niche);
  const long = type === "LONG_FORM_VIDEO", orientation = long ? "16:9" : mc.orientation || "9:16", vertical = orientation !== "16:9", lang = niche.language || "en";
  const dedup = await checkDuplicate(m.title, niche, item.series_id, item.id); if (dedup.isDuplicate) throw new Error(`Dedup: too similar to "${dedup.best.topic}"`);
  await setItem(item.id, { status: "DRAFTING", topic: m.title, source_data_ref: { ...(m.raw || {}), url: m.url, summary: m.summary, photo: m.photo || null, photo_outlet: m.photo_outlet || null }, topic_embedding: J(dedup.embedding) });
  const count = mc.slides || spec.sections;
  const r = await llmFor(niche, (llm) => llm.complete({ json: true, grounding: long, maxTokens: long ? 6000 : 3000,
    system: `${spec.system} Channel: "${niche.display_name}". ${langLine(lang)} Tone: ${niche.tone || "clear"}.${styleBlock(style, niche)} Every sentence is spoken narration: short, natural, no stage directions, no invented facts.${item._series || ""}`,
    prompt: `${materialBlock(m)}\nWrite the video in exactly ${count} sections. JSON: {"hook": "3-7 words that stop a scroll: the most surprising concrete thing in this story, stated as a claim — not a tease, not a question", "title": "on-screen headline, max 12 words", "kicker": "1-2 word label in ${lang}, e.g. Breaking / Politics / Sports", "sections": [{"narration": "${spec.words}", "image_prompt": "what the viewer sees: an editorial illustration, no text, no real faces", "footage_query": "2-4 words to find real stock footage for this section (a place, an action, a scene) — or null where only a specific real event would do"}], "description": "post caption / video description", "hashtags": ["..."]}`,
    mock: { hook: m.title.split(/\s+/).slice(0, 5).join(" "), title: m.title, kicker: "News", sections: Array.from({ length: Math.min(count, 3) }, (_, i) => ({ narration: `Mock narration ${i + 1} about ${m.title}.`, image_prompt: `Illustration ${i + 1} for ${m.title}` })), description: m.title, hashtags: ["news"] } }));
  await addCost(item.id, r.cost); const d = r.data || {}; const sections = (d.sections || []).filter((s) => s && s.narration);
  if (!sections.length) throw new Error("The script came back without sections");
  const title = d.title || m.title, script = sections.map((s) => s.narration).join("\n\n");
  const hook = tidyHook(d.hook);
  await setItem(item.id, { script_meta: { ...(P(item.script_meta) || {}), ...(hook ? { hook } : {}) }, headline: title, script, summary: d.description || "", captions: { default: d.description || title, facebook: d.description || title, instagram: d.description || title, youtube: d.description || "" }, hashtags: d.hashtags || [] });
  const style2 = (P(niche.image_specs) || {}).style || "Editorial illustration in a modern digital-painting style, cinematic light, clearly not a photograph, no text, no identifiable real people.";
  // Each section is backed by real footage where the library has some — a narrated section over moving pictures is the
  // difference between a video and a slideshow, and the clips are free. A section with no clip keeps its picture.
  const broll = mc.broll !== false && (await credentialsFor("pexels")).length > 0;
  const images = []; let noPics = null, footage = 0;
  for (const [i, s] of sections.entries()) {
    // An explicit null is the writer saying only the real event would do here; that section keeps a picture.
    const query = s.footage_query === null ? null : s.footage_query || s.image_prompt;
    if (broll && query) {
      // Narration length is only measured later, so the clip is chosen against a reading-speed estimate of this section.
      const spoken = Math.max(4, Math.round(String(s.narration).split(/\s+/).filter(Boolean).length / 2.2));
      const clip = await pexelsFootage(query, { vertical, seconds: spoken + 1 });
      if (clip) {
        const media = await recordMedia({ contentItemId: item.id, kind: "VIDEO", url: clip.url, mime: "video/mp4",
          meta: { provider: "pexels", clip_id: clip.id, photographer: clip.photographer, page: clip.page, section: i, purpose: "b-roll" } });
        images.push({ ...media, kind: "VIDEO", cost: 0 }); footage++; continue;
      }
    }
    // The story's own photo opens the video and nothing else: a news reel where every section is the same press photo
    // is a slideshow of one picture. The rest of the sections run on footage or the brand's backdrop.
    const img = await imageOrCard(niche, item.id, { prompt: s.image_prompt, headline: title, backdrop: true, skipApi: noPics,
      specs: { width: vertical ? 1080 : 1920, height: vertical ? 1920 : 1080, brand: niche.display_name, render_text: false, overlay: false,
        photo: m.photo || null, photo_outlet: m.photo_outlet || null, photo_lead: i === 0, ...(P(niche.image_specs) || {}), style: style2 } });
    noPics = noPics || img.fallbackError; await addCost(item.id, img.cost); images.push(img);
  }
  if (footage) log(`reel ${item.id}: ${footage} of ${sections.length} sections on stock footage`);
  const narr = await narrateParts(niche, sections.map((s) => s.narration), item.id); await addCost(item.id, narr.cost);
  await setItem(item.id, { voice_asset_url: narr.audio.url, status: "RENDERING" });
  const renderer = await resolve("RENDER", niche.render_adapter || "render_mock");
  const outlets = (m.versions || []).map((v) => v.outlet).filter(Boolean).slice(0, 2);
  const credit = outlets.length ? `${lang.startsWith("bn") ? "সূত্র" : "Source"}: ${outlets.join(", ")}` : undefined;
  let video;
  if (renderer.renderReel && studioReady() && !narr.audio.mock) {
    video = await renderer.renderReel({ niche, headline: title, kicker: d.kicker, credit, orientation, contentItemId: item.id, audio: narr.audio,
      sections: sections.map((s, i) => ({ image: images[i].url, video: images[i].kind === "VIDEO", narration: s.narration, seconds: narr.durations[i] + 0.15 })) });
  } else {
    let t = 0; const captions = sections.map((s, i) => { const c = { start: t, end: t + narr.durations[i], text: s.narration }; t += narr.durations[i]; return c; });
    video = await renderer.renderSlideshow({ images, audio: narr.audio, durations: narr.durations, contentItemId: item.id, orientation,
      captions: mc.captions === false ? [] : captions, niche, headline: title, kicker: d.kicker, credit, hook });
  }
  // A landscape video is a YouTube video, and a YouTube video without a thumbnail is a grey frame in a list of covers.
  // A cover is read at the size of a thumbnail on a phone, where a twelve-word headline is a grey smudge. The hook is
  // three to seven words, which is what fits and what gets clicked.
  if (!vertical) await makeThumbnail(item.id, niche, images[0], hook || title).catch((e) => warn(`thumbnail: ${e.message.slice(0, 140)}`));
  await setItem(item.id, { hero_media_id: video.id });
}

// ---- 8c2. ANIMATED_EXPLAINER (the animation blueprint). Research → a scene plan in six fixed layouts → narration per
// scene (measured) → element cues from the narration → the studio renders it; plus a thumbnail and YouTube chapters.
const EXPLAINER_LAYOUTS = {
  TitleCard: '{"title": "...", "subtitle": "..."} — an opener or a section title; parts: [one line]',
  BulletReveal: '{"heading": "...", "bullets": ["3-5 short bullets"]} — parts: one narration line per bullet, in order',
  IconGrid: '{"heading": "...", "items": [{"icon": "<icon>", "label": "1-3 words"}]} — 2-6 items; parts: one line per item',
  Comparison: '{"heading": "...", "left": {"title": "...", "points": ["..."]}, "right": {"title": "...", "points": ["..."]}} — parts: [left, right]',
  DataChart: '{"heading": "...", "kind": "bar|line", "unit": "...", "data": [{"label": "...", "value": 0}]} — ONLY numbers stated in the research; parts: [one line]',
  FullQuote: '{"quote": "...", "attribution": "..."} — a real quote from the research only; parts: [one line]',
};
const EXPLAINER_ICONS = "train-front bus car plane ship bike zap battery sun cloud-rain droplets flame leaf tree-pine factory building-2 house landmark school hospital stethoscope pill heart-pulse users user baby graduation-cap briefcase banknote coins wallet piggy-bank chart-line chart-column trending-up trending-down scale gavel shield shield-check lock key globe map map-pin flag vote megaphone newspaper tv radio smartphone laptop wifi cpu server database cloud rocket lightbulb target clock calendar timer search check x alert-triangle info wheat fish shopping-cart package truck anchor mountain waves";
function sceneParts(s) { const parts = (Array.isArray(s.parts) ? s.parts : [s.parts]).map((x) => String(x || "").trim()).filter(Boolean); return { intro: String(s.intro || "").trim(), parts: parts.length ? parts : [String(s.narration || s.data?.title || "").trim()].filter(Boolean) }; }
async function generateExplainer(item, niche, style) {
  const m = await materialFor(item, niche); const mc = methodCfg(niche), lang = niche.language || "en";
  const orientation = mc.orientation === "9:16" ? "9:16" : "16:9", vertical = orientation === "9:16", minutes = Number(mc.explainer_minutes) || 3;
  const dedup = await checkDuplicate(m.title, niche, item.series_id, item.id); if (dedup.isDuplicate) throw new Error(`Dedup: too similar to "${dedup.best.topic}"`);
  await setItem(item.id, { status: "DRAFTING", topic: m.title, source_data_ref: { ...(m.raw || {}), url: m.url, summary: m.summary, photo: m.photo || null, photo_outlet: m.photo_outlet || null }, topic_embedding: J(dedup.embedding) });
  const research = await llmFor(niche, (llm) => llm.complete({ json: true, grounding: true, maxTokens: 3000,
    system: "You are a meticulous researcher. Gather verifiable facts, figures and quotes with sources. Never fabricate a number, quote or citation.",
    prompt: `Topic: ${m.title}\n${materialBlock(m)}\nReturn JSON: {"notes": [{"fact": "...", "source_url": "https://...", "source_name": "..."}], "angle": "the clearest way to explain this"} with 8-15 notes.`,
    mock: { notes: [{ fact: `Mock fact about ${m.title}`, source_url: m.url || "https://example.com", source_name: "mock" }], angle: "mock angle" } }));
  await addCost(item.id, research.cost);
  const notes = research.data?.notes || [];
  await q(`INSERT INTO research_notes (id, niche_id, content_item_id, topic, notes, citations, created_by) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)`, [newId(), niche.id, item.id, m.title, JSON.stringify(notes), JSON.stringify([...new Set(notes.map((n) => n.source_url).filter(Boolean))]), research.model || "mock"]);
  const sceneCount = Math.max(4, Math.round(minutes * 3.5));
  const plan = await llmFor(niche, (llm) => llm.complete({ json: true, maxTokens: 8000,
    system: `You script animated explainer videos for "${niche.display_name}". ${langLine(lang)} Tone: ${niche.tone || "clear, friendly"}.${styleBlock(style, niche)} The narration drives the animation: every on-screen element is introduced by the sentence that speaks it. Use only facts from the research notes.${item._series || ""}`,
    prompt: `Topic: ${m.title}\nAngle: ${research.data?.angle || ""}\nResearch notes:\n${notes.map((n) => `- ${n.fact} (${n.source_name || n.source_url || "source"})`).join("\n")}\n\nWrite a ${minutes}-minute explainer (about ${minutes * 140} spoken words) as about ${sceneCount} scenes, using only these layouts:\n${Object.entries(EXPLAINER_LAYOUTS).map(([k, v]) => `- ${k}: data ${v}`).join("\n")}\nIcons for IconGrid (use these names only): ${EXPLAINER_ICONS}\nStart with a TitleCard; vary the layouts; mark a new chapter with a short "chapter" name on the scene that starts it (at least 3 chapters).\nJSON: {"title": "video title", "description": "YouTube description without timestamps", "hashtags": ["..."], "scenes": [{"layout": "...", "chapter": "... or null", "data": {...}, "intro": "optional spoken lead-in before the elements", "parts": ["spoken line per element"]}]}`,
    mock: { title: m.title, description: `About ${m.title}`, hashtags: ["explained"], scenes: [
      { layout: "TitleCard", chapter: "Intro", data: { title: m.title, subtitle: "Explained" }, parts: [`Here is ${m.title}, explained.`] },
      { layout: "BulletReveal", chapter: "Key points", data: { heading: "Key points", bullets: ["First", "Second"] }, parts: ["The first point.", "The second point."] },
      { layout: "FullQuote", chapter: "Wrap-up", data: { quote: "Mock quote", attribution: "Mock" }, parts: ["That is the story."] }] } }));
  await addCost(item.id, plan.cost);
  const p = plan.data || {}; const scenes = (p.scenes || []).filter((s) => s && EXPLAINER_LAYOUTS[s.layout] && s.data).map((s) => ({ ...s, ...sceneParts(s) })).filter((s) => s.parts.length);
  if (!scenes.length) throw new Error("The explainer plan came back without usable scenes");
  const texts = scenes.map((s) => [s.intro, ...s.parts].filter(Boolean).join(" "));
  const title = p.title || m.title;
  await setItem(item.id, { headline: title, script: texts.join("\n\n"), summary: p.description || "", hashtags: p.hashtags || [] });
  const narr = await narrateParts(niche, texts, item.id); await addCost(item.id, narr.cost);
  await setItem(item.id, { voice_asset_url: narr.audio.url, status: "RENDERING" });
  // Cue i = when part i starts being spoken; chapters for the description from the cumulative scene times.
  let at = 0; const chapters = [];
  const built = scenes.map((s, i) => {
    const frames = Math.max(STUDIO_FPS * 2, Math.round((narr.durations[i] + 0.35) * STUDIO_FPS)), weight = (x) => x.length + 1;
    const total = weight(s.intro) * (s.intro ? 1 : 0) + s.parts.reduce((n, x) => n + weight(x), 0) || 1; let pos = s.intro ? weight(s.intro) : 0;
    const cues = s.parts.map((x) => { const c = Math.round((pos / total) * frames * 0.97); pos += weight(x); return c; });
    if (s.chapter) chapters.push(`${Math.floor(at / 60)}:${String(Math.floor(at % 60)).padStart(2, "0")} ${s.chapter}`);
    at += frames / STUDIO_FPS;
    return { layout: s.layout, chapter: s.chapter || undefined, transition: i % 3 === 1 ? "slide" : "fade", data: s.data, durationInFrames: frames, cues, words: wordTimings(texts[i], frames) };
  });
  if (chapters.length && !chapters[0].startsWith("0:00 ")) chapters.unshift(`0:00 ${lang.startsWith("bn") ? "শুরু" : "Intro"}`);
  const description = [p.description || "", chapters.length >= 3 ? `\n${chapters.join("\n")}` : ""].join("\n").trim();
  await setItem(item.id, { captions: { youtube: description, default: p.description || title, facebook: p.description || title } });
  if (narr.audio.mock || !studioReady()) throw new Error("ANIMATED_EXPLAINER needs the video studio and a real voice adapter (the studio renders the animation)");
  const { brand, music } = await studioBrand(niche); const audioFile = await toTmpFile(narr.audio.url, "mp3");
  const props = { width: vertical ? 1080 : 1920, height: vertical ? 1920 : 1080, fps: STUDIO_FPS, lang: lang.slice(0, 2), brand, title, audio: audioFile, music, subtitles: mc.subtitles !== false, outroFrames: Math.round(2.5 * STUDIO_FPS), scenes: built };
  try {
    const out = await studioRender("Explainer", props);
    const video = await publishRender(out, item.id, { method: "EXPLAINER", orientation, scenes: built.length });
    try { const png = await studioRender("Explainer", { ...props, stillFrame: Math.min(45, built[0].durationInFrames - 1) }, { kind: "still", ext: "png" }); const bytes = await readFile(png); await cleanup(png);
      const j = await toJpeg(bytes, "image/png"); await recordMedia({ contentItemId: item.id, kind: "THUMBNAIL", url: await storeFile(`images/${newId()}-thumb.jpg`, j.bytes, j.mime), mime: j.mime, width: props.width, height: props.height, meta: { purpose: "youtube thumbnail" } }); }
    catch (e) { warn(`explainer thumbnail: ${e.message.slice(0, 160)}`); }
    await setItem(item.id, { hero_media_id: video.id });
  } finally { await cleanup(audioFile, brand.logo, brand.fontUrl, music); }
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
  // Recaps and long reactions work on the whole video (a long reaction then plans its own segments); others pick clips.
  if (niche.content_type === "MOVIE_RECAP" || niche.production_method === "REACTION_LONG") clips = [{ start: 0, end: file.duration || transcript.segments.at(-1)?.end || 600, title: cand.title, hook: "", score: 1, reason: "whole video" }];
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
      system: `You write ${recap ? "gripping ~60 second movie recaps that preserve suspense and never spoil the ending" : "short punchy voice-over narration re-telling a clip in our own words"} for "${niche.display_name}". ${langLine(niche.language)} Tone: ${niche.tone}.${styleBlock(style, niche)}`,
      prompt: recap ? `Film: ${cand.title}\nTimestamped transcript:\n${transcript.segments.map((s) => `[${s.start}-${s.end}] ${s.text}`).join("\n").slice(0, 100000)}\n\nWrite a ${methodCfg(niche).recap_seconds || 60}-second narrated recap in ${Math.max(6, Math.round((methodCfg(niche).recap_seconds || 60) / 6))} beats. For each beat pick the source timestamps that visually match. Return JSON: {"title": "...", "beats": [{"narration": "...", "start": seconds, "end": seconds}], "hashtags": ["..."]}`
        : `Clip transcript (${(c.end - c.start).toFixed(0)}s): ${script}\n\nWrite narration of the same length that re-tells this in our voice. Return JSON: {"title": "...", "narration": "...", "hashtags": ["..."]}`,
      mock: recap ? { title: cand.title, beats: [{ narration: `Mock recap of ${cand.title}.`, start: 0, end: 10 }, { narration: "And then everything changes.", start: 30, end: 40 }], hashtags: ["recap"] } : { title: clip.title, narration: `Mock narration: ${script.slice(0, 200)}`, hashtags: ["clip"] } }));
    await addCost(itemId, r.cost); const d = r.data || {};
    script = recap ? (d.beats || []).map((b) => b.narration).join(" ") : d.narration || script;
    const voice = await voiceFor(niche); const audio = await voice.synthesize({ script, voiceId: niche.voice_id, contentItemId: itemId }); await addCost(itemId, audio.cost);
    extras.audio = audio; extras.script = script;
    if (recap && d.beats?.length) { const total = d.beats.reduce((s, b) => s + Math.max(1, (Number(b.end) || 0) - (Number(b.start) || 0)), 0) || 1; const k = (audio.duration_seconds || total) / total; extras.scenes = d.beats.map((b) => ({ start: Number(b.start) || 0, end: (Number(b.start) || 0) + Math.max(1, (Number(b.end) || 0) - (Number(b.start) || 0)) * k })); }
    await setItem(itemId, { headline: d.title || clip.title, script, voice_asset_url: audio.url, hashtags: d.hashtags || [] });
  }
  if (niche.production_method === "REACTION_LONG") {
    // Plan the reaction: which parts of the source play, and what we say between them (at least ~30% commentary, so the
    // video is our own work rather than a re-upload). Each comment is voiced separately and timed by its measured audio.
    const mcfg = methodCfg(niche), maxPlay = Number(mcfg.max_play_minutes) || 6;
    const lines = transcript.segments.map((s) => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`).join("\n").slice(0, 110000);
    const r = await llmFor(niche, (llm) => llm.complete({ json: true, maxTokens: 5000,
      system: `You host a reaction and commentary show for "${niche.display_name}". Language of the commentary: ${niche.language || "en"}. Tone: ${niche.tone || "sharp, fair, engaging"}.${styleBlock(style, niche)} You react with context, analysis and opinion clearly framed as opinion; you never invent facts about the video.`,
      prompt: `Source video: "${cand.title}" (${Math.round((cand.duration_seconds || c.end) / 60)} min)
Timestamped transcript:
${lines}

Plan a reaction video: alternate "play" segments of the source (each 15-45 s, ${maxPlay} min of source at most in total, in order) with "comment" segments where we pause and talk (1-4 spoken sentences each).

What makes the commentary worth watching:
- Every comment answers the moment it follows. Quote or name the thing just said or shown, then add what the viewer does not already have: the background, the number, what it means, where it is wrong, what happens next.
- Vary what you are doing — context, a correction, a prediction, a disagreement you argue for, a comparison to something the audience knows. Never two of the same kind in a row.
- No empty reactions. "Wow", "that’s crazy", "let that sink in" and anything that would fit any video at all are worth nothing; cut them.
- Opinion is welcome and must be framed as yours. Never assert a fact the transcript does not support.
- Open on a hook under 15 words that says why this clip matters. Close on your verdict.
Commentary must be at least 35% of the total runtime. Mark 3+ chapters.
JSON: {"title": "video title", "beats": [{"type": "comment", "text": "...", "chapter": "optional chapter name"}, {"type": "play", "start": seconds, "end": seconds, "chapter": "optional"}], "description": "YouTube description", "hashtags": ["..."]}`,
      mock: { title: `Reacting to ${cand.title}`, beats: [{ type: "comment", text: `Let's watch ${cand.title}.`, chapter: "Intro" }, { type: "play", start: 0, end: Math.min(20, c.end), chapter: "The clip" }, { type: "comment", text: "That is our take.", chapter: "Verdict" }], description: `Our reaction to ${cand.title}`, hashtags: ["reaction"] } }));
    await addCost(itemId, r.cost); const d = r.data || {};
    const beats = (d.beats || []).filter((b) => (b.type === "comment" && b.text) || (b.type === "play" && Number(b.end) > Number(b.start))).map((b) => (b.type === "play" ? { ...b, start: clamp(Number(b.start), 0, c.end), end: clamp(Number(b.end), 0, c.end) } : b));
    if (!beats.some((b) => b.type === "play") || !beats.some((b) => b.type === "comment")) throw new Error("The reaction plan needs both play and comment segments");
    const shaped = shapeReaction(beats, mcfg);
    log(`reaction ${itemId}: ${shaped.stats.comments} comments over ${Math.round(shaped.stats.commentSeconds)}s, ${shaped.stats.plays} clips totalling ${Math.round(shaped.stats.playSeconds)}s (${Math.round(shaped.stats.commentShare * 100)}% commentary)`);
    beats.length = 0; beats.push(...shaped.beats);
    const voice = await voiceFor(niche); let at = 0; const chapters = [];
    for (const b of beats) {
      if (b.type === "comment") { b.audio = await voice.synthesize({ script: b.text, voiceId: niche.voice_id, contentItemId: itemId }); await addCost(itemId, b.audio.cost); }
      if (b.chapter) chapters.push(`${Math.floor(at / 60)}:${String(Math.floor(at % 60)).padStart(2, "0")} ${b.chapter}`);
      at += b.type === "play" ? b.end - b.start : Number(b.audio?.duration_seconds) || 5;
    }
    if (chapters.length && !chapters[0].startsWith("0:00 ")) chapters.unshift("0:00 Intro");
    extras.beats = beats; script = beats.filter((b) => b.type === "comment").map((b) => b.text).join("\n\n");
    // The plan is kept with the item: a reviewer can see how the video is built, and how much of it is someone else's
    // footage, without opening the file.
    await setItem(itemId, { script_meta: { beats, reaction: shaped.stats } });
    await setItem(itemId, { headline: d.title || clip.title, script, summary: d.description || "", hashtags: d.hashtags || [], captions: { youtube: [d.description || "", chapters.length >= 3 ? `\n${chapters.join("\n")}` : ""].join("\n").trim(), default: d.description || d.title || "" } });
  }
  const renderer = await resolve("RENDER", niche.render_adapter || "render_mock");
  const video = await renderer.renderClip({ clip: c, sourcePath: cand.local_path, transcript, niche, contentItemId: itemId, extras });
  await q(`UPDATE clips SET render_url=$2, status='RENDERED' WHERE id=$1`, [clipId, video.url]);
  const cap = await llmFor(niche, (llm) => llm.complete({ json: true, maxTokens: 600,
    system: `You write social captions for "${niche.display_name}". ${langLine(niche.language)} Tone: ${niche.tone}.${styleBlock(style, niche)}`,
    prompt: `Clip title: ${c.title}\nHook: ${c.hook}\nWhat is said: ${script.slice(0, 1500)}\nSource: ${cand.title}\nReturn JSON: {"headline": "video title max 90 chars", "captions": {"facebook": "...", "instagram": "...", "youtube": "description with credit to the source"}, "hashtags": ["..."]}`,
    mock: { headline: c.title, captions: { facebook: c.hook || c.title, instagram: c.hook || c.title, youtube: `Clip from ${cand.title}` }, hashtags: ["shorts"] } }));
  await addCost(itemId, cap.cost); const cd = cap.data || {};
  // A long reaction already has its title and a YouTube description with chapters from its plan; keep those.
  const planned = niche.production_method === "REACTION_LONG" ? await one(`SELECT headline, captions, summary FROM content_items WHERE id=$1`, [itemId]) : null;
  await setItem(itemId, { hero_media_id: video.id, headline: planned?.headline || cd.headline || c.title, captions: { ...(cd.captions || {}), ...(planned ? { youtube: P(planned.captions)?.youtube } : {}) }, hashtags: cd.hashtags || [], summary: planned?.summary || c.hook || "" });
  await finishGeneration(itemId, niche);
}
// ---- 8e. entry point for every text/slideshow item
async function runGeneration(itemId) {
  const item = await one(`SELECT * FROM content_items WHERE id=$1`, [itemId]); if (!item) return;
  const niche = await one(`SELECT * FROM niches WHERE id=$1`, [item.niche_id]);
  const style = niche.style_profile_id ? await one(`SELECT * FROM style_profiles WHERE id=$1`, [niche.style_profile_id]) : null;
  await setItem(itemId, { status: "FETCHING_DATA", rejection_note: null });
  const type = item.content_type || niche.content_type || "NICHE_STATIC";
  if (item.series_id && item.episode_number == null) { const s = await one(`SELECT episode_counter FROM series WHERE id=$1`, [item.series_id]); if (s) { await setItem(itemId, { episode_number: s.episode_counter + 1 }); item.episode_number = s.episode_counter + 1; } }
  item._series = await seriesBlock(item);
  if (type === "LONG_POST") await generateLongPost(item, niche, style);
  else if (type === "ANIMATED_EXPLAINER") await generateExplainer(item, niche, style);
  else if (MADE_VIDEO_TYPES.has(type)) await generateReel(item, niche, style);
  else await generateStatic(item, niche, style);
  return finishGeneration(itemId, niche);
}
// Regenerate one part of a reviewed item without touching the rest.
async function regenerate(itemId, part) {
  const item = await one(`SELECT * FROM content_items WHERE id=$1`, [itemId]); const niche = await one(`SELECT * FROM niches WHERE id=$1`, [item.niche_id]);
  const style = niche.style_profile_id ? await one(`SELECT * FROM style_profiles WHERE id=$1`, [niche.style_profile_id]) : null;
  if (part === "image") { const sdr = P(item.source_data_ref) || {}; const specs = await cardSpecs(niche, { versions: (sdr.outlets || []).map((outlet) => ({ outlet })), photo: sdr.photo, photo_outlet: sdr.photo_outlet }); const img = await imageOrCard(niche, itemId, { prompt: item.image_prompt, headline: item.headline || item.topic, specs, label: cardLabel(niche) }); await addCost(itemId, img.cost); await setItem(itemId, { hero_media_id: img.id, status: "PENDING_REVIEW" }); return; }
  if (part === "all") { await setItem(itemId, { headline: null, summary: null, body: null, hero_media_id: null }); return runGeneration(itemId); }
  const r = await llmFor(niche, (llm) => llm.complete({ json: true, maxTokens: 1500, system: `You are the editor of "${niche.display_name}". ${langLine(niche.language)} Tone: ${niche.tone}.${styleBlock(style, niche)}`,
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
    const thumb = await one(`SELECT url FROM media_assets WHERE content_item_id=$1 AND kind='THUMBNAIL' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`, [item.id]);
    const res = await publisher.publish({ channel, mediaUrl: rendered.url, mediaKind: rendered.kind, caption: asset.caption || renderCaption(item, channel, null), title: item.headline || item.topic, hashtags: P(item.hashtags) || [], thumbnailUrl: thumb?.url || null });
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
  await q(`INSERT INTO performance_metrics (id, asset_id, views, likes, comments, shares) VALUES ($1,$2,$3,$4,$5,$6)`, [newId(), assetId, m.views || 0, m.likes || 0, m.comments || 0, m.shares || 0]);
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

// ---- 8h. Quality gate. Every draft is checked by the LLM against its own source material before it can publish:
// claims the sources don't support, a headline more alarming or certain than the facts, legal and safety risks
// (defamation, communal or political incitement, graphic detail, minors), and language. The verdict is computed from the
// findings as well as taken from the model, whichever is stricter. PASS lets automatic programs publish; a REVIEW draft
// is revised once from the report and re-checked (auto_fix); what is still not clean waits for a person.
// Asked for 0-1, models answer on whatever scale they please: production came back with a flat 10, which cleared a
// threshold of 0.75 without meaning anything, so the score never gated anything. Read 8 and 85 as 0.8 and 0.85 too.
function qaScore(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n <= 1 ? n : n <= 10 ? n / 10 : n <= 100 ? n / 100 : 1;
}
async function qaCfg(niche) {
  const own = (P(niche.method_config) || {}).qa || {};
  return { enabled: own.enabled ?? (await setting("qa.enabled", true)), min_score: Number(own.min_score ?? (await setting("qa.min_score", 0.75))), auto_fix: own.auto_fix ?? (await setting("qa.auto_fix", true)) };
}
function draftText(item) {
  const caps = P(item.captions) || {};
  return [`Headline: ${item.headline || item.topic}`, item.summary && `Summary: ${item.summary}`, item.body && `Body:\n${stripHtml(item.body).slice(0, 6000)}`,
    item.script && !item.body && `Script:\n${String(item.script).slice(0, 6000)}`, Object.keys(caps).length && `Captions:\n${Object.entries(caps).map(([k, v]) => `- ${k}: ${v}`).join("\n")}`].filter(Boolean).join("\n");
}
// The facts a draft may use: its story cluster / source article, a clip's transcript, a long post's research notes, or
// (for planner and manual topics) only what was given — never a fresh topic pull.
async function qaMaterial(item, niche) {
  if (item.clip_id) { const c = await one(`SELECT title, transcript_text FROM clips WHERE id=$1`, [item.clip_id]); return { title: c?.title || item.topic, summary: "", text: c?.transcript_text || "", url: P(item.source_data_ref)?.url || null }; }
  const src = P(item.source_data_ref) || {};
  const m = item.cluster_id || item.source_item_id ? await materialFor(item, niche) : { title: item.topic, summary: src.summary || src.description || "", text: "", url: src.url || null };
  const notes = await one(`SELECT notes FROM research_notes WHERE content_item_id=$1 ORDER BY created_at DESC LIMIT 1`, [item.id]);
  if (notes && (P(notes.notes) || []).length) {
    const versions = m.versions?.length ? [...m.versions] : [{ outlet: "Source", title: m.title, summary: m.summary, text: m.text, url: m.url }];
    versions.push({ outlet: "Research notes", title: m.title, summary: "", text: (P(notes.notes) || []).map((n) => `- ${n.fact} (${n.source_name || n.source_url || "source"})`).join("\n") });
    return { ...m, versions };
  }
  return m;
}
// A model asked to write Bangla will sometimes answer in the language of the sources instead, and a standards editor
// made of the same model is not the thing to catch it. The script is: a Bangla headline containing no Bangla letters
// is not a Bangla headline, whatever anyone says about it.
const LANG_SCRIPT = { bn: /[ঀ-৿]/gu, hi: /[ऀ-ॿ]/gu, ne: /[ऀ-ॿ]/gu, ur: /[؀-ۿ]/gu, ar: /[؀-ۿ]/gu, ta: /[஀-௿]/gu, si: /[඀-෿]/gu };
function wrongScript(text, lang) {
  const re = LANG_SCRIPT[String(lang || "").slice(0, 2).toLowerCase()];
  if (!re) return false;                                                   // nothing to check for a Latin-script language
  const t = String(text || ""), letters = (t.match(/\p{L}/gu) || []).length;
  if (letters < 12) return false;                                          // too short to judge
  return (t.match(re) || []).length / letters < 0.3;
}
async function runQa(itemId, niche) {
  const item = await one(`SELECT * FROM content_items WHERE id=$1`, [itemId]);
  const m = await qaMaterial(item, niche), lang = niche.language || "en", cfg = await qaCfg(niche);
  const style = niche.style_profile_id ? await one(`SELECT * FROM style_profiles WHERE id=$1`, [niche.style_profile_id]) : null;
  const r = await llmFor(niche, (llm) => llm.complete({ json: true, maxTokens: 1500,
    system: `You are the standards editor of "${niche.display_name}"${niche.country ? ` (${niche.country})` : ""}. Before anything is published you check it against its sources and for legal and safety risks. Be specific and strict, and do not rewrite the draft. Answer in English JSON even when the draft is in another language.${style ? `\nHouse style the draft should follow:${styleBlock(style, niche)}` : ""}`,
    prompt: `${materialBlock(m)}\nDRAFT (language: ${lang})\n${draftText(item)}\n\nCheck:\n1. Facts: list each claim in the draft the sources do not support (numbers, names, places, dates, quotes, causes, blame). Rewording is fine; new facts are not.\n2. Headline: accurate, and not more alarming or certain than the sources?\n3. Safety: defamation (wrongdoing attributed to a named person as fact without attribution), religious, communal or political incitement, graphic detail of violence or suicide, identifying minors or victims of sexual violence, health or financial claims, rumour presented as fact.\n4. Language: natural, correct ${lang}.\nReturn JSON: {"fact_issues": ["..."], "headline_ok": true, "headline_issue": "", "safety_flags": [{"type": "...", "severity": "low|medium|high", "detail": "..."}], "language_issues": ["..."], "score": 0.0, "verdict": "PASS|REVIEW|REJECT", "summary": "one sentence"}\nThe score is a number between 0 and 1, where 1 means publishable exactly as written — not a mark out of 10.`,
    mock: { fact_issues: [], headline_ok: true, safety_flags: [], language_issues: [], score: 0.95, verdict: "PASS", summary: "mock review: no issues" } }));
  await addCost(itemId, r.cost);
  const d = r.data || {}, flags = (Array.isArray(d.safety_flags) ? d.safety_flags : []).filter((f) => f && f.type), facts = (Array.isArray(d.fact_issues) ? d.fact_issues : []).filter(Boolean);
  const score = qaScore(d.score);
  let status = flags.some((f) => /high/i.test(f.severity)) ? "REJECT"
    : facts.length || d.headline_ok === false || flags.some((f) => /medium/i.test(f.severity)) || !(score >= cfg.min_score) ? "REVIEW" : "PASS";
  const rank = { PASS: 0, REVIEW: 1, REJECT: 2 }, said = String(d.verdict || "").toUpperCase();
  if (rank[said] > rank[status]) status = said;
  // Checked here rather than believed from the model: publishing a Bangladeshi story in English is not a small slip.
  const offLanguage = wrongScript(`${item.headline || ""} ${item.summary || item.script || ""}`, lang);
  if (offLanguage) { (d.language_issues || (d.language_issues = [])).unshift(`The draft is not written in ${LANG_NAMES[lang] || lang}. This channel publishes in ${LANG_NAMES[lang] || lang}: rewrite every field in it, translating the sources rather than copying them.`); if (rank[status] < 1) status = "REVIEW"; }
  const report = { summary: d.summary || "", score, fact_issues: facts, headline_ok: d.headline_ok !== false, headline_issue: d.headline_issue || "", safety_flags: flags, language_issues: (d.language_issues || []).filter(Boolean), verdict: status, model: r.model || null, checked_at: nowIso() };
  await q(`UPDATE content_items SET qa_status=$2, qa_score=$3, qa_report=$4::jsonb WHERE id=$1`, [itemId, status, report.score, JSON.stringify(report)]);
  return { status, report };
}
async function reviseFromQa(itemId, niche, report) {
  const item = await one(`SELECT * FROM content_items WHERE id=$1`, [itemId]); const m = await qaMaterial(item, niche);
  const style = niche.style_profile_id ? await one(`SELECT * FROM style_profiles WHERE id=$1`, [niche.style_profile_id]) : null;
  const notes = [...report.fact_issues.map((x) => `- Not supported by the sources: ${x}`), report.headline_ok ? null : `- Headline: ${report.headline_issue}`, ...report.language_issues.map((x) => `- Language: ${x}`), ...report.safety_flags.map((f) => `- ${f.type} (${f.severity}): ${f.detail}`)].filter(Boolean);
  if (!notes.length) return false;
  const caps = P(item.captions) || {};
  const r = await llmFor(niche, (llm) => llm.complete({ json: true, maxTokens: 4000,
    system: `You are the editor of "${niche.display_name}". ${langLine(niche.language)} Tone: ${niche.tone || "clear"}.${styleBlock(style, niche)} Fix exactly what the standards editor flagged, keep everything else, and never add a fact the sources do not state.`,
    prompt: `${materialBlock(m)}\nCURRENT DRAFT\n${draftText(item)}\n\nSTANDARDS EDITOR'S NOTES\n${notes.join("\n")}\n\nReturn JSON with the corrected fields: {"headline": "...", "summary": "..."${item.body ? ', "body": "... (same HTML format)"' : ""}${Object.keys(caps).length ? `, "captions": {${Object.keys(caps).map((k) => `"${k}": "..."`).join(", ")}}` : ""}}`,
    mock: {} }));
  await addCost(itemId, r.cost); const d = r.data || {}, upd = {};
  for (const k of ["headline", "summary", "body", "captions"]) if (d[k] && (k !== "body" || item.body)) upd[k] = d[k];
  if (!Object.keys(upd).length) return false;
  await setItem(itemId, upd);
  if (upd.headline && upd.headline !== item.headline) await recomposeCard(itemId).catch((e) => warn(`card recompose ${itemId}: ${e.message}`));
  return true;
}
async function qualityGate(itemId, niche) {
  const cfg = await qaCfg(niche); if (!cfg.enabled) return { status: "SKIPPED" };
  try {
    let qa = await runQa(itemId, niche);
    if (qa.status === "REVIEW" && cfg.auto_fix && (await reviseFromQa(itemId, niche, qa.report))) {
      qa = await runQa(itemId, niche);
      await q(`UPDATE content_items SET qa_report = qa_report || '{"revised": true}'::jsonb WHERE id=$1`, [itemId]);
    }
    return qa;
  } catch (e) {
    warn(`quality gate ${itemId}: ${e.message}`);
    await q(`UPDATE content_items SET qa_status='REVIEW', qa_report=$2::jsonb WHERE id=$1`, [itemId, JSON.stringify({ verdict: "REVIEW", summary: `The quality check could not run (${e.message.slice(0, 200)}) — review by hand.` })]);
    return { status: "REVIEW" };
  }
}
// Photocards carry the headline, so a changed headline (QA fix, reviewer edit) redraws the card from the stored picture.
async function recomposeCard(itemId) {
  const item = await one(`SELECT * FROM content_items WHERE id=$1`, [itemId]); if (!item?.hero_media_id) return null;
  const hero = await one(`SELECT * FROM media_assets WHERE id=$1`, [item.hero_media_id]); const meta = P(hero?.meta) || {};
  if (!meta.overlay || !meta.compose_specs) return null;
  const card = meta.overlay === "textcard";                                        // drawn from scratch: no stored picture
  if (!card && !meta.base_media_id) return null;
  const base = card ? null : await one(`SELECT * FROM media_assets WHERE id=$1 AND deleted_at IS NULL`, [meta.base_media_id]);
  if (!card && !base) return null;
  const file = card ? null : await toTmpFile(base.url, "jpg");
  try {
    const out = card ? await composeTextCard(item.headline || item.topic, meta.compose_specs)
      : meta.overlay === "photocard" ? await composePhotocard(file, item.headline || item.topic, meta.compose_specs) : await composeHeadline(file, item.headline || item.topic, meta.compose_specs);
    const url = await storeLocal(out, `images/${newId()}.jpg`, "image/jpeg"); await cleanup(out);
    const media = await recordMedia({ contentItemId: itemId, kind: "IMAGE", url, mime: "image/jpeg", width: hero.width, height: hero.height, meta: { ...meta, recomposed_at: nowIso() } });
    await setItem(itemId, { hero_media_id: media.id }); return media;
  } finally { await cleanup(file); }
}

// ---- 8i. House style. A profile per brand + program is written by the LLM from the brand, the program and optional
// sample posts. Reviewers' edits and rejection notes are logged as feedback; a refinement pass folds them — and the
// program's best-performing posts — back into the rules and examples, keeping earlier versions in history.
const pseudoNiche = async (brand) => { const d = await smartAdapterDefaults(); return { display_name: brand.name, language: "en", script_adapter: d.scriptAdapter, script_adapter_fallbacks: JSON.stringify(d.scriptAdapterFallbacks) }; };
const asText = (v, sep = "\n") => (Array.isArray(v) ? v.join(sep) : String(v ?? ""));
async function generateStyle({ brandId, nicheId = null, samples = "", name = null, apply = false }) {
  const brand = await one(`SELECT * FROM brands WHERE id=$1`, [brandId]); if (!brand) throw new ApiError(404, null, "Brand not found");
  const niche = nicheId ? await one(`SELECT * FROM niches WHERE id=$1`, [nicheId]) : null;
  const lang = (niche?.language || "en").slice(0, 2), kit = P(brand.brand_kit) || {};
  // A call to action can only promise what exists: the portal gives posts an article to link to, and a brand kit may
  // name a website. With neither, "tap the link in our bio" is a promise every post breaks.
  const linkTarget = niche && flag(niche.publish_to_portal) ? "the brand's own article page" : kit.website || null;
  const r = await llmFor(niche || (await pseudoNiche(brand)), (llm) => llm.complete({ json: true, maxTokens: 2500,
    system: "You write house style guides for news and social-media brands. Your guides are concrete, short and directly usable by a writer.",
    prompt: `Brand: ${brand.name}${brand.description ? ` — ${brand.description}` : ""}${kit.handle ? ` (${kit.handle})` : ""}\n${niche ? `Program: ${niche.display_name} — ${nice(niche.content_type)} in ${lang}${niche.country ? ` for ${niche.country}` : ""}. Requested tone: ${niche.tone || "(none)"}.\n` : ""}Platforms: Facebook, Instagram, YouTube.\n${linkTarget ? `Posts carry a link to ${linkTarget}, so a call to action may send readers there.\n` : "These posts carry NO link — there is no article page and nothing in the bio to tap. The call to action must work with nothing to click (a question to readers, an invitation to follow), or be empty. Never write \"link in bio\", \"read more at\", \"swipe up\" or \"tap the link\".\n"}${samples ? `The brand's own posts, showing its voice:\n"""\n${String(samples).slice(0, 6000)}\n"""\n` : ""}${lang === "bn" ? "For Bangla: standard written Bangla (প্রমিত বাংলা), Bangla digits, no Banglish, names spelled as the major Bangladeshi outlets spell them.\n" : ""}Write the style guide. Return JSON: {"name": "short name", "tone": "one line", "rules": "10-14 short bullet rules: headlines, sentence length, attribution, numbers and dates, sensitive topics, emoji, per-platform captions", "examples": "3 short example posts in this style${lang === "bn" ? ", in Bangla" : ""}", "banned_terms": ["..."], "cta": "one short call to action", "hashtags": ["3-6 brand hashtags"]}`,
    mock: { name: `${brand.name} house style`, tone: niche?.tone || "clear, factual", rules: "- Lead with the news.\n- Attribute every claim to its source.", examples: "", banned_terms: [], cta: "", hashtags: [] } }));
  const d = r.data || {}, id = newId();
  await q(`INSERT INTO style_profiles (id, brand_id, niche_id, name, language, tone, rules, examples, banned_terms, cta, hashtags, generated) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::jsonb,1)`,
    [id, brand.id, niche?.id || null, name || d.name || `${brand.name} — ${niche?.display_name || "house style"}`, lang, d.tone || "", asText(d.rules), asText(d.examples, "\n\n"), JSON.stringify(d.banned_terms || []), d.cta || "", JSON.stringify(d.hashtags || [])]);
  if (niche && (apply || !niche.style_profile_id)) await q(`UPDATE niches SET style_profile_id=$2 WHERE id=$1`, [niche.id, id]);
  return one(`SELECT * FROM style_profiles WHERE id=$1`, [id]);
}
async function logStyleFeedback(item, kind, fields) {
  const niche = await one(`SELECT id, style_profile_id FROM niches WHERE id=$1`, [item.niche_id]); if (!niche?.style_profile_id) return;
  for (const f of fields) await q(`INSERT INTO style_feedback (id, style_profile_id, niche_id, content_item_id, kind, field, old_text, new_text, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [newId(), niche.style_profile_id, niche.id, item.id, kind, f.field || null, f.old ?? null, f.new ?? null, f.note ?? null]);
}
async function refineStyle(profileId) {
  const p = await one(`SELECT * FROM style_profiles WHERE id=$1`, [profileId]); if (!p) return null;
  const fb = await q(`SELECT * FROM style_feedback WHERE style_profile_id=$1 AND used_at IS NULL ORDER BY created_at DESC LIMIT 40`, [profileId]);
  const top = p.niche_id ? await q(`SELECT ci.headline, MAX(COALESCE((a.last_metrics->>'views')::int, 0)) AS views, MAX(COALESCE((a.last_metrics->>'likes')::int, 0)) AS likes FROM content_items ci JOIN content_assets a ON a.content_item_id = ci.id
    WHERE ci.niche_id = $1 AND a.status = 'PUBLISHED' AND a.published_at > now() - interval '30 days' GROUP BY ci.id
    ORDER BY MAX(COALESCE((a.last_metrics->>'views')::int, 0)) + 10 * MAX(COALESCE((a.last_metrics->>'likes')::int, 0)) DESC LIMIT 5`, [p.niche_id]) : [];
  if (!fb.length && !top.length) return null;
  const niche = p.niche_id ? await one(`SELECT * FROM niches WHERE id=$1`, [p.niche_id]) : await pseudoNiche(await one(`SELECT * FROM brands WHERE id=$1`, [p.brand_id]) || { name: p.name });
  const clip = (s) => String(s || "").replace(/\s+/g, " ").slice(0, 300);
  const r = await llmFor(niche, (llm) => llm.complete({ json: true, maxTokens: 2500,
    system: "You maintain a brand's house style guide. Update it from evidence: keep what works, change what the editors corrected, and keep it short.",
    prompt: `CURRENT GUIDE\nTone: ${p.tone}\nRules:\n${p.rules}\nExamples:\n${p.examples}\nBanned terms: ${(P(p.banned_terms) || []).join(", ")}\nCall to action: ${p.cta}\n\nEDITOR CORRECTIONS (AI draft -> what the editor changed it to)\n${fb.filter((f) => f.kind === "EDIT").map((f) => `[${f.field}] "${clip(f.old_text)}" -> "${clip(f.new_text)}"`).join("\n") || "(none)"}\n\nREJECTED DRAFTS (editor's reason)\n${fb.filter((f) => f.kind === "REJECT").map((f) => `- ${clip(f.note)}`).join("\n") || "(none)"}\n\nBEST-PERFORMING POSTS (last 30 days)\n${top.map((t) => `- "${t.headline}" (${t.views} views, ${t.likes} likes)`).join("\n") || "(none)"}\n\nReturn the full updated guide as JSON: {"tone": "...", "rules": "...", "examples": "...", "banned_terms": ["..."], "cta": "...", "changes": "one line: what changed and why"}`,
    mock: { tone: p.tone, rules: p.rules, examples: p.examples, banned_terms: P(p.banned_terms) || [], cta: p.cta, changes: "mock refinement" } }));
  const d = r.data || {};
  const history = [...(P(p.history) || []), { at: nowIso(), tone: p.tone, rules: p.rules, examples: p.examples, banned_terms: P(p.banned_terms) || [], cta: p.cta, changes: d.changes || "" }].slice(-10);
  await q(`UPDATE style_profiles SET tone=$2, rules=$3, examples=$4, banned_terms=$5::jsonb, cta=$6, history=$7::jsonb, refined_at=now() WHERE id=$1`,
    [p.id, d.tone || p.tone, asText(d.rules) || p.rules, asText(d.examples, "\n\n") || p.examples, JSON.stringify(d.banned_terms || P(p.banned_terms) || []), d.cta ?? p.cta, JSON.stringify(history)]);
  if (fb.length) await q(`UPDATE style_feedback SET used_at = now() WHERE id = ANY($1)`, [fb.map((f) => f.id)]);
  return { changes: d.changes || "" };
}
async function sweepStyleRefinement() {
  if (!(await setting("style.auto_refine", true))) return;
  const due = await q(`SELECT sp.id FROM style_profiles sp WHERE (SELECT COUNT(*) FROM style_feedback f WHERE f.style_profile_id = sp.id AND f.used_at IS NULL) >= 5 AND (sp.refined_at IS NULL OR sp.refined_at < now() - interval '1 day') LIMIT 5`);
  for (const s of due) await enqueue("STYLE_REFINE", { profileId: s.id }, { queue: "text", dedupeKey: `style:${s.id}`, maxAttempts: 2 });
}

// ---- 8j. Planner and series. Daily per active program (and on demand) the LLM reads the program's recent output with
// its performance, its series and the desk's uncovered trending stories, and proposes ideas: topics, next episodes, new
// series, format and timing changes. method_config.autopilot = {topics_per_day: N} accepts the best topic ideas itself.
// Series with auto_generate get their next episode every cadence_days, written with the earlier episodes as context.
async function programStats(niche, days = 30) {
  const posts = await q(`SELECT ci.id, ci.headline, ci.content_type, ci.series_id, a.published_at, c.platform,
      COALESCE((a.last_metrics->>'views')::int, 0) AS views, COALESCE((a.last_metrics->>'likes')::int, 0) AS likes, COALESCE((a.last_metrics->>'comments')::int, 0) AS comments
    FROM content_items ci JOIN content_assets a ON a.content_item_id = ci.id JOIN channels c ON c.id = a.channel_id
    WHERE ci.niche_id = $1 AND a.status = 'PUBLISHED' AND a.published_at > now() - ($2 || ' days')::interval ORDER BY a.published_at DESC LIMIT 300`, [niche.id, String(days)]);
  const group = (key) => Object.values(posts.reduce((acc, p) => { const k = key(p); const g = (acc[k] ||= { key: k, posts: 0, views: 0, likes: 0, comments: 0 }); g.posts++; g.views += p.views; g.likes += p.likes; g.comments += p.comments; return acc; }, {}))
    .map((g) => ({ ...g, avg_views: Math.round(g.views / g.posts), avg_likes: +(g.likes / g.posts).toFixed(1) })).sort((a, b) => b.avg_views - a.avg_views);
  const tz = /bangladesh/i.test(niche.country || "") ? "Asia/Dhaka" : "UTC";
  const hour = (p) => Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: tz }).format(new Date(p.published_at)));
  const score = (p) => p.views + 10 * p.likes + 20 * p.comments;
  return { posts: posts.length, timezone: tz, byType: group((p) => p.content_type), byPlatform: group((p) => p.platform), byHour: group(hour).sort((a, b) => a.key - b.key),
    top: [...posts].sort((a, b) => score(b) - score(a)).slice(0, 8), bottom: [...posts].sort((a, b) => score(a) - score(b)).slice(0, 5) };
}
async function planProgram(nicheId) {
  const niche = await one(`SELECT * FROM niches WHERE id=$1`, [nicheId]); if (!niche) return null;
  const brand = await one(`SELECT * FROM brands WHERE id=$1`, [niche.brand_id]);
  const st = await programStats(niche);
  const series = await q(`SELECT s.id, s.key, s.display_name, s.premise, s.episode_counter, (SELECT json_agg(x) FROM (SELECT headline, episode_number FROM content_items WHERE series_id = s.id ORDER BY created_at DESC LIMIT 5) x) AS recent FROM series s WHERE s.niche_id = $1 AND s.is_active::int = 1`, [nicheId]);
  const trending = DESK_TYPES.has(niche.content_type) ? await q(`SELECT c.title, c.source_count FROM story_clusters c WHERE c.last_seen_at > now() - interval '24 hours' AND NOT EXISTS (SELECT 1 FROM content_items ci WHERE ci.cluster_id = c.id AND ci.niche_id = $1) ORDER BY c.weight_sum DESC LIMIT 15`, [nicheId]) : [];
  const recent = await q(`SELECT COALESCE(headline, topic) AS t FROM content_items WHERE niche_id=$1 AND status NOT IN ('FAILED','REJECTED') ORDER BY created_at DESC LIMIT 40`, [nicheId]);
  const line = (g) => `${g.key}: ${g.posts} posts, avg ${g.avg_views} views / ${g.avg_likes} likes`;
  const r = await llmFor(niche, (llm) => llm.complete({ json: true, maxTokens: 3000,
    system: `You are the content strategist for "${niche.display_name}" (${brand?.name || "brand"}): ${nice(niche.content_type)} in ${niche.language || "en"} for ${niche.country || "a general audience"}. You propose specific, publishable ideas grounded in the data given. Topics are written in ${niche.language || "en"}.`,
    prompt: `PERFORMANCE, last 30 days (${st.posts} published posts)\nBy format:\n${st.byType.map(line).join("\n") || "(no data yet)"}\nBy platform:\n${st.byPlatform.map(line).join("\n") || "(no data yet)"}\nBy hour (${st.timezone}):\n${st.byHour.map(line).join("\n") || "(no data yet)"}\nBest posts:\n${st.top.map((p) => `- ${p.headline} (${p.views} views, ${p.likes} likes)`).join("\n") || "(none)"}\nWeakest posts:\n${st.bottom.map((p) => `- ${p.headline} (${p.views} views)`).join("\n") || "(none)"}\n\nSERIES\n${series.map((s) => `- ${s.key} "${s.display_name}" (${s.episode_counter} episodes). Premise: ${s.premise || "-"}. Latest: ${(s.recent || []).map((x) => x.headline).join(" | ")}`).join("\n") || "(none)"}\n\nTRENDING STORIES NOT YET COVERED\n${trending.map((t) => `- ${t.title} (${t.source_count} outlets)`).join("\n") || "(none)"}\n\nRECENTLY COVERED (do not repeat)\n${recent.map((x) => `- ${x.t}`).join("\n") || "(none)"}\n\nPropose up to 8 ideas. JSON: {"ideas": [{"kind": "TOPIC|SERIES_EPISODE|NEW_SERIES|FORMAT|TIMING", "title": "...", "rationale": "why, citing the data above", "topic": "TOPIC/SERIES_EPISODE: the exact topic to write", "summary": "what the piece should cover", "series_key": "SERIES_EPISODE: existing series key", "series_name": "NEW_SERIES: name", "premise": "NEW_SERIES: premise", "cadence_days": 7, "content_type": "optional format for this piece", "score": 0.0}]}`,
    mock: { ideas: [{ kind: "TOPIC", title: `Explainer for ${niche.display_name}`, rationale: "mock planner idea", topic: `What to know this week: ${niche.display_name}`, summary: "", score: 0.6 }] } }));
  const ideas = (Array.isArray(r.data) ? r.data : r.data?.ideas || []).filter((x) => x && x.title && ["TOPIC", "SERIES_EPISODE", "NEW_SERIES", "FORMAT", "TIMING", "NEW_PROGRAM"].includes(String(x.kind).toUpperCase()));
  const made = [];
  for (const x of ideas.slice(0, 8)) {
    const dup = await one(`SELECT id FROM suggestions WHERE niche_id=$1 AND lower(title)=lower($2) AND created_at > now() - interval '14 days'`, [nicheId, x.title]); if (dup) continue;
    const s = series.find((y) => y.key === x.series_key);
    const id = newId(); await q(`INSERT INTO suggestions (id, brand_id, niche_id, series_id, kind, title, rationale, payload, score) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
      [id, niche.brand_id, nicheId, s?.id || null, String(x.kind).toUpperCase(), String(x.title).slice(0, 300), x.rationale || "", JSON.stringify(x), clamp(Number(x.score) || 0.5, 0, 1)]);
    made.push(id);
  }
  const ap = (P(niche.method_config) || {}).autopilot;
  if (ap?.topics_per_day) {
    const today = await one(`SELECT COUNT(*)::int AS n FROM suggestions WHERE niche_id=$1 AND status='ACCEPTED' AND acted_at >= CURRENT_DATE AND payload->>'autopilot' = 'true'`, [nicheId]);
    const pick = await q(`SELECT id FROM suggestions WHERE niche_id=$1 AND status='NEW' AND kind IN ('TOPIC','SERIES_EPISODE') AND score >= $2 ORDER BY score DESC LIMIT $3`, [nicheId, Number(ap.min_score ?? 0.5), Math.max(0, ap.topics_per_day - today.n)]);
    for (const p of pick) { await q(`UPDATE suggestions SET payload = payload || '{"autopilot": true}'::jsonb WHERE id=$1`, [p.id]); await acceptSuggestion(p.id); }
  }
  return { created: made.length, cost: r.cost || 0 };
}
async function acceptSuggestion(id) {
  const s = await one(`SELECT * FROM suggestions WHERE id=$1`, [id]); if (!s) throw new ApiError(404, null, "Suggestion not found");
  if (s.status === "ACCEPTED") return { suggestion: s };
  const niche = await one(`SELECT * FROM niches WHERE id=$1`, [s.niche_id]); const p = P(s.payload) || {}; const out = {};
  if (s.kind === "TOPIC" || s.kind === "SERIES_EPISODE") {
    const seriesId = s.series_id || (p.series_key ? (await one(`SELECT id FROM series WHERE niche_id=$1 AND key=$2`, [niche.id, p.series_key]))?.id : null) || null;
    const type = p.content_type && CONTENT_TYPE_SET.has(p.content_type) && !VIDEO_TYPES.has(p.content_type) ? p.content_type : null;
    out.itemId = await createQueuedItem(niche, { seriesId, contentType: type, topic: p.topic || s.title, sourceDataRef: { provider: "planner", summary: p.summary || s.rationale || "", suggestionId: s.id } });
    await enqueue("GENERATE_CONTENT", { itemId: out.itemId }, { queue: queueFor(type || niche.content_type), priority: 3, contentItemId: out.itemId });
  } else if (s.kind === "NEW_SERIES") {
    out.seriesId = newId();
    await q(`INSERT INTO series (id, niche_id, key, display_name, premise, cadence_days, auto_generate, next_due_at) VALUES ($1,$2,$3,$4,$5,$6,1,now()) ON CONFLICT (niche_id, key) DO NOTHING`,
      [out.seriesId, niche.id, slugify(p.series_name || s.title).slice(0, 40), p.series_name || s.title, p.premise || s.rationale || "", Number(p.cadence_days) || 7]);
  }
  await q(`UPDATE suggestions SET status='ACCEPTED', acted_at=now(), content_item_id=$2 WHERE id=$1`, [id, out.itemId || null]);
  return { suggestion: await one(`SELECT * FROM suggestions WHERE id=$1`, [id]), ...out };
}
async function sweepPlanner() {
  if (!(await setting("planner.enabled", true))) return;
  const due = await q(`SELECT n.id FROM niches n WHERE n.is_active::int = 1 AND NOT EXISTS (SELECT 1 FROM suggestions s WHERE s.niche_id = n.id AND s.created_at > now() - interval '23 hours')
    AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.type = 'PLAN_PROGRAM' AND j.dedupe_key = 'plan:' || n.id AND j.created_at > now() - interval '23 hours') LIMIT 10`);
  for (const n of due) await enqueue("PLAN_PROGRAM", { nicheId: n.id }, { queue: "text", dedupeKey: `plan:${n.id}`, maxAttempts: 2 });
}
// The series' premise and latest episodes, for every prompt that writes an episode.
async function seriesBlock(item) {
  if (!item.series_id) return "";
  const s = await one(`SELECT * FROM series WHERE id=$1`, [item.series_id]); if (!s) return "";
  const eps = await q(`SELECT episode_number, headline, left(summary, 240) AS summary FROM content_items WHERE series_id=$1 AND id <> $2 AND status NOT IN ('FAILED','REJECTED') ORDER BY created_at DESC LIMIT 6`, [s.id, item.id]);
  return `\nSERIES: this is episode ${item.episode_number || s.episode_counter + 1} of "${s.display_name}".${s.premise ? ` Premise: ${s.premise}.` : ""}${eps.length ? `\nEarlier episodes (newest first):\n${eps.map((e) => `- Ep ${e.episode_number ?? "?"}: ${e.headline} — ${e.summary || ""}`).join("\n")}\nContinue the series: build on earlier episodes where natural and never repeat one.` : ""}`;
}
async function sweepSeries() {
  const due = await q(`SELECT s.id, s.cadence_days FROM series s JOIN niches n ON n.id = s.niche_id WHERE s.auto_generate::int = 1 AND s.is_active::int = 1 AND n.is_active::int = 1 AND (s.next_due_at IS NULL OR s.next_due_at <= now()) LIMIT 10`);
  for (const s of due) {
    await q(`UPDATE series SET next_due_at = now() + ($2 || ' days')::interval WHERE id = $1`, [s.id, String(Number(s.cadence_days) || 7)]);
    await enqueue("SERIES_NEXT", { seriesId: s.id }, { queue: "text", dedupeKey: `series:${s.id}`, maxAttempts: 3 });
  }
}
async function nextEpisode(seriesId) {
  const s = await one(`SELECT * FROM series WHERE id=$1`, [seriesId]); if (!s) return null;
  const niche = await one(`SELECT * FROM niches WHERE id=$1`, [s.niche_id]);
  const eps = await q(`SELECT episode_number, headline, left(summary, 240) AS summary FROM content_items WHERE series_id=$1 AND status NOT IN ('FAILED','REJECTED') ORDER BY created_at DESC LIMIT 8`, [s.id]);
  const r = await llmFor(niche, (llm) => llm.complete({ json: true, maxTokens: 800,
    system: `You plan the episodes of the series "${s.display_name}" for "${niche.display_name}". ${langLine(niche.language)}`,
    prompt: `Premise: ${s.premise || "(none)"}\nEpisodes so far (newest first):\n${eps.map((e) => `- Ep ${e.episode_number ?? "?"}: ${e.headline} — ${e.summary || ""}`).join("\n") || "(none yet: plan the first episode)"}\n\nPropose the next episode. It continues naturally and repeats none of the above. JSON: {"topic": "...", "summary": "what it covers"}`,
    mock: { topic: `${s.display_name}: episode ${s.episode_counter + 1}`, summary: "" } }));
  const d = r.data || {};
  const itemId = await createQueuedItem(niche, { seriesId: s.id, topic: d.topic || `${s.display_name} ${s.episode_counter + 1}`, sourceDataRef: { provider: "series", summary: d.summary || "" } });
  await enqueue("GENERATE_CONTENT", { itemId }, { queue: queueFor(niche.content_type), priority: 2, contentItemId: itemId });
  return { itemId };
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
      const desk = await setting("desk.enabled", true), toCluster = [];
      const maxAgeMs = Number(await setting("ingest.max_age_hours", 72)) * 3600e3;
      for (const it of items) {
        // Stale articles (feeds that never rotate, indexed archive pages) are not taken in at all; old videos still are.
        if ((it.kind || "ARTICLE") === "ARTICLE" && it.published_at && Date.now() - Date.parse(it.published_at) > maxAgeMs) continue;
        const hash = sha(it.url); const id = newId();
        const ins = await q(`INSERT INTO source_items (id, source_id, external_id, url, url_hash, title, summary, published_at, thumbnail_url, kind, raw) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) ON CONFLICT (url_hash) DO NOTHING RETURNING id`,
          [id, sourceId, it.external_id || null, it.url, hash, tidyTitle(it.title).slice(0, 500), it.summary || null, it.published_at || null, it.thumbnail || null, it.kind || "ARTICLE", JSON.stringify({ ...(it.raw || {}), duration: it.duration, views: it.views, platform: it.platform, license: it.license })]);
        if (!ins.length) continue; added++;
        // Articles go to the news desk (clustered, then picked per program); videos are routed to video programs directly.
        if (desk && (it.kind || "ARTICLE") === "ARTICLE") toCluster.push({ ...it, id, source_id: sourceId });
        else routed += await routeSourceItem({ ...it, id, source_id: sourceId });
      }
      if (toCluster.length) { await clusterItems(toCluster, source); deskSoon(); }
      await q(`UPDATE sources SET last_polled_at=now(), last_error=NULL WHERE id=$1`, [sourceId]);
      return { fetched: items.length, added, routed, clustered: toCluster.length };
    } catch (e) { await q(`UPDATE sources SET last_polled_at=now(), last_error=$2 WHERE id=$1`, [sourceId, String(e.message).slice(0, 800)]); throw e; }
  },
  async GENERATE_CONTENT({ itemId }, job) { if (!(await budgetOk())) { await deferJob(job, 60); return { deferred: "budget" }; } return runGeneration(itemId); },
  async REGENERATE({ itemId, part }) { return regenerate(itemId, part); },
  async PROCESS_CANDIDATE({ candidateId }, job) { if (!(await budgetOk())) { await deferJob(job, 60); return { deferred: "budget" }; } return processCandidate(candidateId); },
  async RENDER_CLIP({ itemId, clipId }) { return renderClipItem(itemId, clipId); },
  async PUBLISH_ASSET({ assetId }) { return publishAsset(assetId); },
  async POLL_METRICS({ assetId }) { return pollMetrics(assetId); },
  async STYLE_GENERATE({ brandId, nicheId, samples }) { const s = await generateStyle({ brandId, nicheId, samples }); return { styleProfileId: s.id }; },
  async STYLE_REFINE({ profileId }) { return refineStyle(profileId); },
  async PLAN_PROGRAM({ nicheId }) { return planProgram(nicheId); },
  async SERIES_NEXT({ seriesId }) { return nextEpisode(seriesId); },
};
// Seconds until the next attempt, or null to give up. Transient failures (overloaded model, rate limit, network) back
// off exponentially — 1, 2, 4 … 32 min, about an hour in all — for jobs that are safe to repeat. Publishing keeps its
// own small attempt count so a slow platform cannot cause double posts. Permanent failures stop at once.
const TRANSIENT_MAX_ATTEMPTS = Number(ENV.TRANSIENT_MAX_ATTEMPTS) || 7;
const PATIENT_JOBS = new Set(["INGEST_SOURCE", "GENERATE_CONTENT", "REGENERATE", "PROCESS_CANDIDATE", "RENDER_CLIP", "POLL_METRICS", "STYLE_GENERATE", "STYLE_REFINE", "PLAN_PROGRAM", "SERIES_NEXT"]);
function retryDelay(job, e) {
  if (isPermanent(e)) return null;
  const transient = isTransient(e);
  const max = transient && PATIENT_JOBS.has(job.type) ? Math.max(job.max_attempts || 3, TRANSIENT_MAX_ATTEMPTS) : (job.max_attempts || 3);
  if (job.attempts >= max) return null;
  return transient ? Math.min(60 * 2 ** Math.max(0, job.attempts - 1), 3600) : 30 * job.attempts;
}
async function deferJob(job, minutes) { await q(`UPDATE jobs SET status='PENDING', run_after=now() + ($2 || ' minutes')::interval, attempts=attempts-1, locked_by=NULL WHERE id=$1`, [job.id, String(minutes)]); job._deferred = true; }
// A provider's quota is not this job's fault, so it waits for the reset — the delay the API names, or midnight Pacific
// for a daily limit — without spending an attempt, and the program stops taking new stories until then so the queue
// does not fill with work that cannot run. A news story that would be stale by the time the quota returns is dropped.
const QUOTA_MAX_WAIT_DAYS = Number(ENV.QUOTA_MAX_WAIT_DAYS) || 3;
async function deferForQuota(job, payload, quota, msg) {
  // Waiting has a limit: a job that has been bouncing off a per-minute limit for hours, or off a daily one for days, is
  // not really waiting for a quota — it goes back to the ordinary backoff, and fails and alerts like anything else.
  const cap = quota.kind === "minute" ? 2 * 3600e3 : quota.kind === "busy" ? 8 * 3600e3 : QUOTA_MAX_WAIT_DAYS * 86400e3;
  if (Date.now() - new Date(job.created_at).getTime() > cap) return false;
  const itemId = job.content_item_id || payload.itemId || null;
  const item = itemId ? await one(`SELECT * FROM content_items WHERE id=$1`, [itemId]) : null;
  const niche = item || payload.nicheId ? await one(`SELECT * FROM niches WHERE id=$1`, [item?.niche_id || payload.nicheId]) : null;
  const back = new Date(Date.now() + quota.seconds * 1000);
  if (niche && quota.seconds > 600) await putSetting(`quota.pause.${niche.id}`, { until: back.toISOString(), reason: msg.slice(0, 300) });
  const ageHours = item ? (Date.now() - new Date(item.created_at).getTime()) / 3600e3 + quota.seconds / 3600 : 0;
  if (item?.cluster_id && niche && ageHours > deskCfg(niche).max_age_hours) {
    const note = `Skipped: the writer ${quota.kind === "busy" ? "could not be reached" : "ran out of quota"} and this story would be about ${Math.round(ageHours)} hours old before it comes back.`;
    await q(`UPDATE jobs SET status='CANCELLED', error_message=$2, finished_at=now(), locked_by=NULL WHERE id=$1`, [job.id, note]);
    await q(`UPDATE content_items SET status='REJECTED', rejection_note=$2 WHERE id=$1 AND status NOT IN ('PUBLISHED','PARTIALLY_PUBLISHED')`, [item.id, note]);
    log(`quota: dropped stale story ${item.id} ("${(item.topic || "").slice(0, 60)}")`);
    return true;
  }
  await q(`UPDATE jobs SET status='PENDING', error_message=$2, run_after=$3, attempts=GREATEST(attempts-1,0), locked_by=NULL WHERE id=$1`, [job.id, msg, back.toISOString()]);
  // The item is not being written after all: say it is queued again, so the dashboard doesn't count it as in progress.
  if (item && ["DRAFTING", "FETCHING_DATA", "RENDERING"].includes(item.status)) await q(`UPDATE content_items SET status='QUEUED' WHERE id=$1`, [item.id]);
  log(`quota: ${job.type} ${job.id} waits until ${back.toISOString()} (${quota.kind})`);
  return true;
}
const dhakaTime = (d) => { try { return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Dhaka" }).format(d); } catch { return d.toISOString().slice(0, 16).replace("T", " ") + " UTC"; } };
// Programs whose writer is waiting for a quota to reset, for the dashboard: [{program, until}].
async function quotaPauses() {
  const m = await settings(); const now = Date.now(), out = [];
  for (const [k, v] of Object.entries(m)) {
    if (!k.startsWith("quota.pause.") || !v?.until || new Date(v.until).getTime() <= now) continue;
    const n = await one(`SELECT display_name FROM niches WHERE id=$1`, [k.slice("quota.pause.".length)]);
    if (n) out.push({ program: n.display_name, until: v.until });
  }
  return out;
}
async function notifyQuota(quota, msg) {
  const provider = PROVIDER_HOSTS.find(([h]) => msg.includes(h))?.[1] || "The AI provider";
  // One alert per outage, not one per parked job, and only once it has lasted long enough to be worth knowing about.
  if (quota.kind === "busy") return notify("outage", `${provider} is overloaded`,
    `The model has been answering "high demand" for the past hour, so work is waiting rather than failing. It resumes on its own; stories that would be stale by then are skipped. Nothing to do unless this is still here tomorrow.`,
    { level: "warn", key: `busy:${provider}`, cooldownHours: 6 });
  if (quota.kind !== "day") return;
  const back = dhakaTime(new Date(Date.now() + quota.seconds * 1000));
  await notify("quota", quota.freeTier ? `${provider} free tier: today's requests are used up` : `${provider} daily quota reached`,
    (quota.freeTier
      ? `A free key allows only about 20 requests a day per model${quota.model ? ` — this one ran out on ${quota.model}` : ""}, which is a handful of posts. Enable billing on the key (Google AI Studio → Billing) and the cap goes away; Flash costs a fraction of a cent per post.`
      : `Raise the project's quota with the provider, or add a second key on the API keys page.`)
    + `\n\nWork resumes on its own around ${back} (Dhaka). Until then new stories are not started, and ones that would be stale by then are skipped.`,
    { level: "error", key: `quota:${provider}:${new Date().toISOString().slice(0, 10)}`, cooldownHours: 20 });
}
async function runJob(job) {
  const h = HANDLERS[job.type]; const payload = P(job.payload) || {};
  try {
    if (!h) throw new Error(`no handler for ${job.type}`);
    const result = await h(payload, job);
    if (job._deferred) return;
    await q(`UPDATE jobs SET status='SUCCEEDED', result=$2, finished_at=now(), locked_by=NULL WHERE id=$1`, [job.id, J(result ?? null)?.slice(0, 5000) ?? null]);
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 1500);
    // A provider that has answered "overloaded" for the whole retry hour is not a job that failed, it is a provider
    // that is down — and failing there costs a day of news. Once the ordinary backoff has given up, an outage waits
    // the same way a quota does: no attempt spent, the program paused, stories that would go stale dropped.
    const quota = quotaWait(e) || (isOverloaded(e) && retryDelay(job, e) == null ? { kind: "busy", seconds: 900, model: null } : null);
    if (quota?.seconds && PATIENT_JOBS.has(job.type) && (await deferForQuota(job, payload, quota, msg))) { await notifyQuota(quota, msg).catch((err) => warn("alert", err.message)); return; }
    // A limit no reset will lift (a plan without this model, an empty prepaid balance) is a person's problem, not a retry's.
    const delay = quota && !quota.seconds ? null : retryDelay(job, e);
    warn(`job ${job.type} ${job.id} failed (attempt ${job.attempts}${delay != null ? `, retrying in ${delay}s` : ", giving up"}): ${msg}`);
    if (delay != null) await q(`UPDATE jobs SET status='PENDING', error_message=$2, run_after=now() + ($3 || ' seconds')::interval, locked_by=NULL WHERE id=$1`, [job.id, msg, String(delay)]);
    else {
      await alertOnFailure(job, msg).catch((err) => warn("alert", err.message));
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
// ---- 9b. Alerts. Problems a person has to act on — an AI key rejected or out of credit, a feed that keeps failing, an
// expired publishing token, the budget cap, a stalled pipeline, a growing review queue — are recorded for the dashboard and
// sent to Telegram when a bot token (TELEGRAM_BOT_TOKEN or a "telegram" key) and a chat id (TELEGRAM_CHAT_ID or setting
// alerts.telegram_chat_id) are set. An alert is not repeated within its cooldown. The engine cannot report being asleep:
// an external uptime monitor on /health covers that.
async function telegramTarget() {
  const token = ENV.TELEGRAM_BOT_TOKEN || (await credentialsFor("telegram"))[0]?.secret, chat = ENV.TELEGRAM_CHAT_ID || (await setting("alerts.telegram_chat_id", null));
  return token && chat ? { token, chat: String(chat) } : null;
}
async function notify(kind, title, body = "", { level = "warn", key = null, cooldownHours = 6 } = {}) {
  const dedupe = key || `${kind}:${sha(title).slice(0, 16)}`;
  if (await one(`SELECT id FROM notifications WHERE dedupe_key=$1 AND created_at > now() - ($2 || ' hours')::interval`, [dedupe, String(cooldownHours)])) return false;
  const id = newId();
  await q(`INSERT INTO notifications (id, kind, level, title, body, dedupe_key) VALUES ($1,$2,$3,$4,$5,$6)`, [id, kind, level, String(title).slice(0, 300), String(body || "").slice(0, 3000), dedupe]);
  const tg = await telegramTarget().catch(() => null);
  if (tg) {
    const icon = { error: "🔴", warn: "🟠", info: "🟢" }[level] || "🟠";
    try { await fetchJson(`https://api.telegram.org/bot${tg.token}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: tg.chat, text: `${icon} ${title}${body ? `\n\n${body}` : ""}`.slice(0, 4000), disable_web_page_preview: true }) }); await q(`UPDATE notifications SET delivered=1 WHERE id=$1`, [id]); }
    catch (e) { warn("telegram alert failed:", e.message.slice(0, 160)); }
  }
  return true;
}
// Which provider an error message is about, from the API host it names.
const PROVIDER_HOSTS = [["api.anthropic.com", "Anthropic"], ["generativelanguage.googleapis.com", "Gemini"], ["api.openai.com", "OpenAI"], ["api.elevenlabs.io", "ElevenLabs"], ["graph.facebook.com", "Meta (Facebook/Instagram)"], ["googleapis.com/upload/youtube", "YouTube"], ["oauth2.googleapis.com", "YouTube OAuth"], ["newsapi.org", "NewsAPI"]];
// Called when a job gives up: failures a person must fix (billing, keys, tokens) become alerts.
async function alertOnFailure(job, msg) {
  const provider = PROVIDER_HOSTS.find(([h]) => msg.includes(h))?.[1] || (msg.match(/No API key for "(\w+)"/) || [])[1] || "an API";
  const rule = [
    [/free_tier|FreeTier/i, `${provider} is on a free key and has hit its limit`, "A free key allows about 20 requests a day per model and no pictures. Enable billing on it (Google AI Studio → Billing) — the cost per post is a fraction of a cent."],
    [/credit balance|insufficient_quota|payment/i, `${provider} account is out of credit`, "Top it up, or switch the program to another writer (Programs → Edit → Script / LLM)."],
    [/limit: 0\b/i, `${provider} plan does not include this model`, "Enable billing on the key, or point the program at a model the plan includes (Programs → Edit)."],
    [/exceeded your current quota|RESOURCE_EXHAUSTED/i, `${provider} quota is exhausted`, "Raise the quota with the provider, or add a second key on the API keys page."],
    [/No API key/i, `No key for ${provider}`, "Add it on the API keys page or set the env var on Render."],
    [/API key not valid|invalid[_ ]api[_ ]key|Incorrect API key|\b401\b|PERMISSION_DENIED|Unauthorized/i, `${provider} rejected the key`, "Check the key on the API keys page (Test button)."],
    [/access token|OAuthException|Session has expired|\(#190\)|invalid_grant/i, `${provider} publishing token expired or was revoked`, "Create a new token and update the channel's key."],
  ].find(([re]) => re.test(msg));
  if (rule) await notify("provider", rule[1], `${rule[2]}\n\nLast error (${job.type}): ${msg.slice(0, 400)}`, { level: "error", key: `provider:${rule[1]}`, cooldownHours: 6 });
}
async function sweepHealth() {
  const tz = "Asia/Dhaka", hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: tz }).format(new Date()));
  for (const s of await q(`SELECT s.name, s.last_error FROM sources s WHERE s.is_active::int = 1 AND s.last_error IS NOT NULL AND s.last_polled_at > now() - interval '2 hours'
      AND EXISTS (SELECT 1 FROM niche_sources ns WHERE ns.source_id = s.id) AND NOT EXISTS (SELECT 1 FROM source_items si WHERE si.source_id = s.id AND si.created_at > now() - interval '24 hours')`))
    await notify("source", `Source "${s.name}" keeps failing`, s.last_error.slice(0, 500), { key: `source:${s.name}`, cooldownHours: 24 });
  const cap = Number(await setting("budget.daily_cap_usd", 0));
  if (cap && (await spentTodayUsd()) >= cap) await notify("budget", `Daily budget of $${cap} reached`, "Generation is paused until tomorrow (Settings → Daily spend cap).", { key: `budget:${new Date().toISOString().slice(0, 10)}`, cooldownHours: 24 });
  const gen = await one(`SELECT COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed, COUNT(*)::int AS total, (array_agg(left(error_message, 300) ORDER BY finished_at DESC) FILTER (WHERE status = 'FAILED'))[1] AS last FROM jobs WHERE type IN ('GENERATE_CONTENT','RENDER_CLIP','PROCESS_CANDIDATE') AND finished_at > now() - interval '2 hours'`);
  if (gen.total >= 5 && gen.failed / gen.total > 0.5) await notify("failures", `${gen.failed} of ${gen.total} generation jobs failed in 2 hours`, `Most recent error: ${gen.last || "?"}`, { key: "failures", cooldownHours: 4 });
  const active = await one(`SELECT COUNT(*)::int AS n FROM niches n WHERE n.is_active::int = 1 AND EXISTS (SELECT 1 FROM niche_sources ns WHERE ns.niche_id = n.id)`);
  const recent = await one(`SELECT COUNT(*)::int AS n FROM content_items WHERE created_at > now() - interval '6 hours'`);
  if (active.n && !recent.n && hour >= 9 && hour <= 23 && (await setting("ingest.enabled", true))) await notify("stalled", "No new content in 6 hours", "Sources may be failing, the desk may be off, or every story was filtered out. Check Sources and the News desk.", { key: "stalled", cooldownHours: 12 });
  const backlog = await one(`SELECT COUNT(*)::int AS n FROM content_items WHERE status = 'PENDING_REVIEW' AND created_at < now() - interval '12 hours'`);
  if (backlog.n >= 30) await notify("review", `${backlog.n} drafts have waited over 12 hours in Review`, "Approve them, or let clean drafts publish on their own (Programs → Review: auto-approve after a window).", { key: "review", cooldownHours: 24 });
  // A lane with claimable work that nothing has picked up for an hour has no process behind it: the video lane usually,
  // because rendering runs on a worker service of its own, and a deployment without that worker queues video forever.
  for (const lane of await q(`SELECT queue, COUNT(*)::int AS waiting, min(created_at) AS oldest FROM jobs
      WHERE status = 'PENDING' AND (run_after IS NULL OR run_after <= now()) AND created_at < now() - interval '45 minutes' GROUP BY queue`)) {
    const touched = await one(`SELECT COUNT(*)::int AS n FROM jobs WHERE queue = $1 AND (locked_at > now() - interval '1 hour' OR finished_at > now() - interval '1 hour')`, [lane.queue]);
    if (touched.n) continue;
    const off = (await setting("queues.enabled", {}))[lane.queue] === false;
    await notify("lane", `The "${lane.queue}" lane has ${lane.waiting} job${lane.waiting > 1 ? "s" : ""} and nothing running it`,
      off ? `The lane is paused on the Overview — resume it and the work goes through.`
        : `Nothing has claimed a job in this lane for an hour. ${lane.queue === "video" ? "Video renders run on the worker service (render.yaml: content-engine-video); without it, videos queue forever." : "Check that a process is running this lane (the LANES setting on each service)."}`,
      { key: `lane:${lane.queue}`, cooldownHours: 6 });
  }
  // Daily digest at 21:00 Dhaka time.
  if (hour === 21) {
    const d = await one(`SELECT (SELECT COUNT(*)::int FROM content_assets WHERE status='PUBLISHED' AND published_at > now() - interval '24 hours') AS published,
      (SELECT COUNT(*)::int FROM content_items WHERE created_at > now() - interval '24 hours') AS made, (SELECT COUNT(*)::int FROM content_items WHERE status='FAILED' AND updated_at > now() - interval '24 hours') AS failed,
      (SELECT COUNT(*)::int FROM content_items WHERE status='PENDING_REVIEW') AS waiting`);
    const top = await one(`SELECT ci.headline, (a.last_metrics->>'views')::int AS views FROM content_assets a JOIN content_items ci ON ci.id = a.content_item_id WHERE a.published_at > now() - interval '48 hours' AND a.last_metrics IS NOT NULL ORDER BY (a.last_metrics->>'views')::int DESC NULLS LAST LIMIT 1`);
    await notify("digest", `Today: ${d.published} posts published, ${d.made} made`, `${d.failed} failed · ${d.waiting} waiting in Review · spent $${(await spentTodayUsd()).toFixed(2)}${top ? `\nTop post: ${top.headline} (${top.views} views)` : ""}`, { level: "info", key: `digest:${new Date().toISOString().slice(0, 10)}`, cooldownHours: 20 });
  }
}
// Programs created before the source catalog existed get its sources (and a house style) once.
async function upgradeExistingPrograms() {
  if (await setting("upgrade.catalog_v1", false)) return;
  for (const n of await q(`SELECT * FROM niches WHERE is_active::int = 1`)) {
    const linked = await one(`SELECT 1 AS x FROM niche_sources ns JOIN sources s ON s.id = ns.source_id WHERE ns.niche_id = $1 AND s.catalog_key IS NOT NULL LIMIT 1`, [n.id]);
    const entries = linked ? [] : catalogFor(n);
    if (entries.length) { await installCatalogSources(entries, [n.id]); log(`upgrade: linked ${entries.length} catalog sources to "${n.display_name}"`); }
    if (!n.style_profile_id && n.script_adapter !== "llm_mock") await enqueue("STYLE_GENERATE", { brandId: n.brand_id, nicheId: n.id }, { queue: "text", dedupeKey: `style-gen:${n.id}` });
  }
  await putSetting("upgrade.catalog_v1", true);
}
// Catalog entries get corrected as outlets change — a feed starts refusing datacenter IPs, another is served empty. A
// source that came from the catalog follows the correction instead of failing quietly until someone reads the logs.
// Sources a person added themselves have no catalog_key and are never touched. Bump CATALOG_VERSION to roll out a fix.
const CATALOG_VERSION = 5;
async function syncCatalogSources() {
  if (Number(await setting("upgrade.catalog_sync", 0)) >= CATALOG_VERSION) return;
  for (const e of SOURCE_CATALOG) {
    const row = await one(`SELECT * FROM sources WHERE catalog_key = $1`, [e.key]);
    if (!row || (row.adapter_key === e.adapter && JSON.stringify(P(row.config) || {}) === JSON.stringify(e.config))) continue;
    await q(`UPDATE sources SET adapter_key = $2, config = $3::jsonb, poll_interval_minutes = $4, last_error = NULL WHERE id = $1`, [row.id, e.adapter, JSON.stringify(e.config), e.poll || row.poll_interval_minutes]);
    log(`catalog: "${row.name}" now reads through ${e.adapter}`);
  }
  // An outlet added to the catalog has to reach the programs that already exist, or the catalog only ever describes
  // programs created after it. Only programs that took their sources from the catalog are touched; one whose sources
  // were chosen by hand keeps exactly what was chosen.
  for (const n of await q(`SELECT * FROM niches WHERE is_active::int = 1`)) {
    const have = new Set((await q(`SELECT s.catalog_key FROM niche_sources ns JOIN sources s ON s.id = ns.source_id WHERE ns.niche_id = $1 AND s.catalog_key IS NOT NULL`, [n.id])).map((r) => r.catalog_key));
    if (!have.size) continue;
    const missing = catalogFor(n).filter((e) => !have.has(e.key));
    if (missing.length) { await installCatalogSources(missing, [n.id]); log(`catalog: ${missing.length} new source${missing.length > 1 ? "s" : ""} linked to "${n.display_name}" (${missing.map((e) => e.name).join(", ")})`); }
  }
  await putSetting("upgrade.catalog_sync", CATALOG_VERSION);
}
// A program keeps the adapters it was created with, which go stale: a voice whose provider never got a key would fail the
// first reel the program is asked for, and rendering stays on ffmpeg after the studio arrives. This repairs what cannot
// work on this deployment and takes the studio when it is there. Deliberate choices that do work — including mocks — stay.
const IMPL_PROVIDER = { anthropic: "anthropic", gemini: "gemini", openai: "openai", gemini_image: "gemini", openai_image: "openai", elevenlabs: "elevenlabs", openai_tts: "openai", gemini_tts: "gemini", gemini_embed: "gemini", gemini_transcribe: "gemini", whisper_api: "openai" };
async function adapterUsable(key) {
  const row = await one(`SELECT impl FROM adapter_configs WHERE key=$1 AND enabled::int=1`, [key]);
  if (!row) return false;
  const provider = IMPL_PROVIDER[row.impl];
  return provider ? (await credentialsFor(provider)).length > 0 : true;                    // mocks and local tools need no key
}
// Runs on every boot. A key added today has to reach the programs that already exist — that is the whole point of
// noticing it, and a key is almost always added after the program it is for. Every repair here is conditional on the
// current setting being unusable, so running it again changes nothing once there is nothing to fix. Only the one-off
// migration onto the studio renderer is remembered, because a program deliberately moved back to ffmpeg should stay
// on ffmpeg.
async function upgradeAdapters() {
  const migrate = !(await setting("upgrade.adapters_v3", false));
  const d = await smartAdapterDefaults(), changed = [];
  for (const n of await q(`SELECT * FROM niches WHERE is_active::int = 1`)) {
    const fix = {};
    // A stock-photo key added later should reach programs that already exist: it is what stands between a story and
    // a text card once generated pictures are out of reach.
    const imgFb = P(n.image_adapter_fallbacks) || [];
    if (d.imageAdapterFallbacks.includes("pexels_stock") && !imgFb.includes("pexels_stock") && n.image_adapter !== "pexels_stock" && !/_mock$/.test(n.image_adapter || "")) fix.image_adapter_fallbacks = JSON.stringify([...imgFb, "pexels_stock"]);
    // A second writer that the account already pays for should be behind the first one. Without this a program writes
    // on one provider and stops for the day the moment that provider says no, while a perfectly good key sits unused.
    for (const [col, own, want] of [["script_adapter_fallbacks", n.script_adapter, [d.scriptAdapter, ...d.scriptAdapterFallbacks]],
                                   ["voice_adapter_fallbacks", n.voice_adapter, [d.voiceAdapter, ...(d.voiceAdapterFallbacks || [])]]]) {
      const have = P(n[col]) || [];
      const add = want.filter((k) => k && k !== own && !/_mock$/.test(k) && !have.includes(k));
      if (add.length && !/_mock$/.test(own || "")) fix[col] = JSON.stringify([...have, ...add]);
    }
    for (const [col, want] of [["script_adapter", d.scriptAdapter], ["image_adapter", d.imageAdapter], ["voice_adapter", d.voiceAdapter], ["embed_adapter", d.embedAdapter], ["transcript_adapter", d.transcriptAdapter]])
      if (n[col] && n[col] !== want && !/_mock$/.test(want) && !(await adapterUsable(n[col]))) fix[col] = want;
    if (migrate && n.render_adapter === "ffmpeg" && d.renderAdapter === "remotion") fix.render_adapter = "remotion";
    if (!Object.keys(fix).length) continue;
    await q(`UPDATE niches SET ${Object.keys(fix).map((k, i) => `${k} = $${i + 2}`).join(", ")} WHERE id = $1`, [n.id, ...Object.values(fix)]);
    changed.push(`${n.display_name}: ${Object.entries(fix).map(([k, v]) => `${k.replace("_adapter", "")} → ${v}`).join(", ")}`);
  }
  if (changed.length) {
    log(`upgrade: adapters repaired — ${changed.join(" | ")}`);
    await notify("upgrade", "Programs moved onto the keys and tools this deployment has", `${changed.join("\n")}\n\nChange any of them on the program's Edit screen.`, { level: "info", key: `upgrade:${changed.join("|").slice(0, 80)}`, cooldownHours: 168 }).catch(() => {});
  }
  if (migrate) await putSetting("upgrade.adapters_v3", true);
}

// Keeps the database small enough for Supabase's free tier while polling dozens of feeds around the clock: the ingest
// ledger and story clusters are pruned once nothing refers to them, bulky fields (article text, embeddings) are dropped
// after a few days, and finished jobs are cleared. Content items, media rows and metrics are never pruned.
async function sweepRetention() {
  const days = String(Number(await setting("retention.source_items_days", 14)) || 14);
  const a = await q(`DELETE FROM source_items si WHERE si.created_at < now() - ($1 || ' days')::interval
    AND NOT EXISTS (SELECT 1 FROM content_items ci WHERE ci.source_item_id = si.id) AND NOT EXISTS (SELECT 1 FROM video_candidates vc WHERE vc.source_item_id = si.id) RETURNING id`, [days]);
  await q(`UPDATE source_items SET raw = raw - 'article_text', embedding = NULL WHERE created_at < now() - interval '3 days' AND (embedding IS NOT NULL OR raw ? 'article_text')`);
  const b = await q(`DELETE FROM story_clusters c WHERE c.last_seen_at < now() - interval '7 days' AND NOT EXISTS (SELECT 1 FROM content_items ci WHERE ci.cluster_id = c.id) RETURNING id`);
  await q(`UPDATE story_clusters SET embedding = NULL WHERE last_seen_at < now() - interval '3 days' AND embedding IS NOT NULL`);
  const c = await q(`DELETE FROM jobs WHERE (status IN ('SUCCEEDED','CANCELLED') AND finished_at < now() - interval '7 days') OR (status = 'FAILED' AND finished_at < now() - interval '30 days') RETURNING id`);
  await q(`UPDATE content_items SET topic_embedding = NULL WHERE created_at < now() - interval '60 days' AND topic_embedding IS NOT NULL`);
  if (a.length || b.length || c.length) log(`retention: removed ${a.length} old source items, ${b.length} story clusters, ${c.length} finished jobs`);
}
function startWorkers() {
  if (!LANES.length) { warn("LANES is set but names no known lane — this process serves HTTP only"); return; }
  for (const qn of LANES) workerLoop(qn);
  if (!RUN_SWEEPS) { log(`sweeps disabled on this instance (lanes: ${LANES.join(",")})`); return; }
  const every = (ms, fn) => { const tick = () => fn().catch((e) => warn(fn.name, e.message)); setTimeout(tick, 3000); setInterval(tick, ms); };
  every(60000, sweepDueSources); every(60000, sweepNewsDesk); every(30000, sweepDueAssets); every(60000, sweepReviewDeadlines); every(30 * 60000, sweepMetrics);
  every(6 * 3600000, sweepRetention); every(60 * 60000, sweepPlanner); every(10 * 60000, sweepSeries); every(60 * 60000, sweepStyleRefinement);
  every(15 * 60000, sweepHealth);
  upgradeExistingPrograms().then(upgradeAdapters).then(syncCatalogSources).catch((e) => warn("upgrade", e.message));
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
    const streamed = req.method === "POST" && pathname === "/api/uploads"; // the handler reads the raw body itself
    const body = !streamed && ["POST", "PATCH", "PUT"].includes(req.method) ? await readBody(req) : {};
    const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress;
    await match.handler({ req, res, params, query: url.searchParams, body, ip });
  } catch (e) { const status = e instanceof ApiError ? e.status : 500; if (status >= 500) warn(`${req.method} ${pathname}:`, e.message); send(res, status, { error: String(e.message || e) }); }
});

// ---- routes: meta / health
app.get("/health", async (ctx) => { const db = await one(`SELECT 1 AS ok`).then(() => true).catch(() => false); json(ctx, db ? 200 : 503, { ok: db, worker: WORKER_ID, lanes: LANES, sweeps: RUN_SWEEPS, spentTodayUsd: db ? await spentTodayUsd() : null, storage: (await storageBackend()).name, vault: vaultReady(), studio: studioReady(), memoryMb: memoryLimitMb(), ffmpeg: await exec("ffmpeg", ["-version"]).then(() => true).catch(() => false), ytdlp: await exec("yt-dlp", ["--version"]).then(() => true).catch(() => false) }); });
app.get("/api/adapters", async (ctx) => json(ctx, 200, listAdapterKeys(await instances(true))));
app.get("/api/adapter-impls", (ctx) => json(ctx, 200, Object.fromEntries(Object.entries(IMPLS).map(([stage, m]) => [stage, Object.values(m).map((d) => ({ id: d.id, label: d.label, configSchema: d.configSchema }))]))));
app.get("/api/stats", async (ctx) => {
  const [items, assets, cand, srcs, ideas, alerts] = await Promise.all([q(`SELECT status, COUNT(*)::int AS n FROM content_items GROUP BY status`), q(`SELECT status, COUNT(*)::int AS n FROM content_assets GROUP BY status`), q(`SELECT status, COUNT(*)::int AS n FROM video_candidates GROUP BY status`), one(`SELECT COUNT(*)::int AS n FROM sources WHERE is_active::int=1`), one(`SELECT COUNT(*)::int AS n FROM suggestions WHERE status='NEW'`), one(`SELECT COUNT(*)::int AS n FROM notifications WHERE read_at IS NULL AND level <> 'info'`)]);
  json(ctx, 200, { items: Object.fromEntries(items.map((r) => [r.status, r.n])), assets: Object.fromEntries(assets.map((r) => [r.status, r.n])), candidates: Object.fromEntries(cand.map((r) => [r.status, r.n])), activeSources: srcs?.n ?? 0, ideas: ideas?.n ?? 0, alerts: alerts?.n ?? 0, spentTodayUsd: await spentTodayUsd(), budgetCapUsd: await setting("budget.daily_cap_usd", 0), globalPause: await setting("publishing.global_pause", false), queues: await setting("queues.enabled", {}), quotaPauses: await quotaPauses() });
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
  // A key is worth nothing until the programs are on it, and waiting for the next restart to find that out is a day lost.
  await upgradeAdapters().catch((e) => warn(`adapters after new ${b.provider} key: ${e.message}`));
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
    pexels: () => fetchJson("https://api.pexels.com/v1/search?query=dhaka&per_page=1", { headers: { Authorization: c.secret } }).then((r) => ({ photos: r.total_results })),
    youtube: () => fetchJson(`https://www.googleapis.com/youtube/v3/videos?part=id&chart=mostPopular&maxResults=1&key=${encodeURIComponent(c.secret)}`),
    meta: () => fetchJson(`https://graph.facebook.com/${DEFAULTS.META_API_VERSION}/me?${form({ fields: "id,name", access_token: c.secret })}`),
    youtube_oauth: () => fetchJson("https://oauth2.googleapis.com/token", { method: "POST", body: form({ client_id: c.secret.client_id, client_secret: c.secret.client_secret, refresh_token: c.secret.refresh_token, grant_type: "refresh_token" }) }).then((t) => ({ token_type: t.token_type, expires_in: t.expires_in })),
    telegram: () => fetchJson(`https://api.telegram.org/bot${c.secret}/getMe`).then((r) => ({ bot: r.result?.username })),
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
app.post("/api/adapter-configs/:key/test", async (ctx) => { const row = (await instances(true)).find((r) => r.key === ctx.params.key); if (!row) throw new ApiError(404, null, "Unknown adapter key"); const a = await resolve(row.stage, row.key); let result; if (row.stage === "SCRIPT") result = await a.complete({ prompt: "Reply with the single word OK.", mock: {} }); else if (row.stage === "INGEST") result = { items: (await a.fetchItems({ name: "test", config: ctx.body.config || row.config })).slice(0, 3) }; else if (row.stage === "EMBED") result = { dims: (await a.embed("test"))?.length ?? null };
  // Voice is the one stage whose output has to be heard: it speaks a line and hands back the file, so a program is not
  // committed to a voice nobody has listened to. Bangla by default, since that is where a voice usually disappoints.
  else if (row.stage === "VOICE") { const m = await a.synthesize({ script: ctx.body.script || "আজকের খবর শুনুন। এটি একটি কণ্ঠস্বর পরীক্ষা।", contentItemId: null }); result = { url: m.url, seconds: m.duration_seconds, listen: "open the url to hear it" }; }
  else if (row.stage === "IMAGE") { const m = await a.generate({ prompt: ctx.body.prompt || "a quiet street in Dhaka at dawn", headline: ctx.body.headline || "Voice and picture test", specs: { width: 1080, height: 1080, photo_query: ctx.body.prompt || "dhaka street" }, contentItemId: null }); result = { url: m.url, width: m.width, height: m.height }; }
  else result = { ok: true, note: "resolved; run it through a program to test end-to-end" }; json(ctx, 200, result); });
// ---- brands
app.get("/api/brands", async (ctx) => json(ctx, 200, await q(`SELECT * FROM brands ORDER BY created_at DESC`)));
app.post("/api/brands", async (ctx) => { if (!ctx.body.name) throw new ApiError(400, null, "name is required"); const id = newId(); await q(`INSERT INTO brands (id, name, description, brand_kit) VALUES ($1,$2,$3,$4::jsonb)`, [id, ctx.body.name, ctx.body.description ?? null, JSON.stringify(ctx.body.brandKit || {})]); json(ctx, 201, await one(`SELECT * FROM brands WHERE id=$1`, [id])); });
app.patch("/api/brands/:id", async (ctx) => json(ctx, 200, await patchRow("brands", ctx.params.id, ctx.body, { name: "name", description: "description", brandKit: "brand_kit" })));
// Photocard preview for a brand kit (and optional headline) without generating content: renders a card from a neutral
// gradient so the kit's colours, logo and font can be checked on the Brands page.
app.post("/api/brands/:id/preview-card", async (ctx) => {
  const brand = await one(`SELECT * FROM brands WHERE id=$1`, [ctx.params.id]); if (!brand) throw new ApiError(404, null, "Brand not found");
  const kit = { ...(P(brand.brand_kit) || {}), ...(ctx.body.brandKit || {}) }, lang = ctx.body.language || "bn";
  const bg = tmpPath("jpg"); await exec("ffmpeg", ["-y", "-f", "lavfi", "-i", "gradients=s=1080x720:c0=0x1d2b4f:c1=0x6a7fb5:x0=0:y0=0:x1=1080:y1=720:d=1", "-frames:v", "1", bg]);
  try {
    const out = await composePhotocard(bg, ctx.body.headline || (lang === "bn" ? "সিলেটে বন্যা পরিস্থিতির অবনতি, নদীর পানি বিপৎসীমার ওপরে" : "Flood worsens in Sylhet as rivers cross the danger mark"),
      { width: 1080, height: 1080, kit, card_meta: { date: cardDate(lang), credit: `${lang === "bn" ? "সূত্র" : "Source"}: ${lang === "bn" ? "প্রথম আলো" : "The Daily Star"}` } });
    const url = await storeLocal(out, `previews/${brand.id}.jpg`, "image/jpeg"); await cleanup(out);
    json(ctx, 200, { url: `${url}?t=${Date.now()}` });
  } finally { await cleanup(bg); }
});
// ---- uploads (logos, fonts, music beds, reactor clips): raw body streamed to storage, recorded as an UPLOAD media row.
const UPLOAD_MAX_BYTES = Number(ENV.UPLOAD_MAX_MB || 300) * 1024 * 1024;
app.post("/api/uploads", async (ctx) => {
  const name = String(ctx.query.get("name") || "upload.bin").replace(/[^\w.\-]+/g, "_").slice(-80), purpose = String(ctx.query.get("purpose") || "other");
  const ct = ctx.req.headers["content-type"] || "application/octet-stream", file = tmpPath(extname(name).slice(1) || "bin");
  await new Promise((resolve, reject) => {
    let n = 0; const ws = createWriteStream(file);
    ctx.req.on("data", (c) => { n += c.length; if (n > UPLOAD_MAX_BYTES) { ctx.req.destroy(); ws.destroy(); reject(new ApiError(413, null, `Upload exceeds ${UPLOAD_MAX_BYTES >> 20} MB`)); } });
    ctx.req.pipe(ws); ws.on("finish", resolve); ws.on("error", reject); ctx.req.on("error", reject);
  });
  try {
    const url = await storeLocal(file, `uploads/${purpose}/${newId()}-${name}`, ct);
    const kind = /^video\//.test(ct) ? "VIDEO" : /^audio\//.test(ct) ? "AUDIO" : /^image\//.test(ct) ? "IMAGE" : "FILE";
    json(ctx, 201, await recordMedia({ kind: "UPLOAD", url, mime: ct, duration: kind === "VIDEO" || kind === "AUDIO" ? await ffprobeDuration(file) : null, meta: { name, purpose, media: kind } }));
  } finally { await cleanup(file); }
});
app.get("/api/uploads", async (ctx) => { const p = ctx.query.get("purpose"); json(ctx, 200, await q(`SELECT * FROM media_assets WHERE kind = 'UPLOAD' AND deleted_at IS NULL AND ($1::text IS NULL OR meta->>'purpose' = $1) ORDER BY created_at DESC LIMIT 200`, [p])); });
app.delete("/api/uploads/:id", async (ctx) => { const m = await one(`SELECT * FROM media_assets WHERE id=$1 AND kind='UPLOAD'`, [ctx.params.id]); if (m) { await deleteStored(m.url).catch(() => {}); await q(`UPDATE media_assets SET deleted_at = now() WHERE id=$1`, [m.id]); } json(ctx, 200, { ok: true }); });
app.delete("/api/brands/:id", async (ctx) => { const dep = await one(`SELECT (SELECT COUNT(*) FROM niches WHERE brand_id=$1)::int + (SELECT COUNT(*) FROM channels WHERE brand_id=$1)::int AS n`, [ctx.params.id]); if (dep.n) throw new ApiError(409, null, "Brand still has programs or channels"); await q(`DELETE FROM brands WHERE id=$1`, [ctx.params.id]); json(ctx, 200, { ok: true }); });
// ---- niches (programs)
const NICHE_JSON = ["method_config", "image_specs", "topic_filters", "clip_adapter_fallbacks", "script_adapter_fallbacks", "image_adapter_fallbacks", "voice_adapter_fallbacks"];
const NICHE_MAP = { displayName: "display_name", tone: "tone", visualMode: "visual_mode", topicSourceAdapter: "topic_source_adapter", scriptAdapter: "script_adapter", voiceAdapter: "voice_adapter", renderAdapter: "render_adapter", voiceId: "voice_id", factCheckStrict: "fact_check_strict", dedupThreshold: "dedup_threshold", isActive: "is_active",
  contentType: "content_type", productionMethod: "production_method", methodConfig: "method_config", language: "language", country: "country", approvalMode: "approval_mode", reviewWindowMinutes: "review_window_minutes", styleProfileId: "style_profile_id", publishToPortal: "publish_to_portal", imageAdapter: "image_adapter", imageSpecs: "image_specs", topicFilters: "topic_filters", maxItemsPerDay: "max_items_per_day", priority: "priority",
  downloadAdapter: "download_adapter", transcriptAdapter: "transcript_adapter", clipAdapter: "clip_adapter", clipAdapterFallbacks: "clip_adapter_fallbacks", scriptAdapterFallbacks: "script_adapter_fallbacks", imageAdapterFallbacks: "image_adapter_fallbacks", voiceAdapterFallbacks: "voice_adapter_fallbacks", embedAdapter: "embed_adapter" };
app.get("/api/niches", async (ctx) => { const b = ctx.query.get("brandId"); const rows = b ? await q(`SELECT * FROM niches WHERE brand_id=$1 ORDER BY created_at DESC`, [b]) : await q(`SELECT * FROM niches ORDER BY created_at DESC`); json(ctx, 200, rows.map((r) => rowJson(r, NICHE_JSON))); });
app.get("/api/programs", async (ctx) => { const rows = await q(`SELECT n.*, (SELECT json_agg(json_build_object('id', s.id, 'name', s.name)) FROM sources s JOIN niche_sources ns ON ns.source_id=s.id WHERE ns.niche_id=n.id) AS sources, (SELECT json_agg(json_build_object('id', c.id, 'name', c.display_name, 'platform', c.platform)) FROM channels c JOIN channel_niches cn ON cn.channel_id=c.id WHERE cn.niche_id=n.id) AS channels FROM niches n ORDER BY created_at DESC`); json(ctx, 200, rows.map((r) => rowJson(r, NICHE_JSON))); });
// Adapters a new program starts with when the request doesn't name them: the live ones whose provider has a key (vault or
// env), mocks otherwise — so "create a program" yields real output without visiting the Adapters page.
async function smartAdapterDefaults() {
  const has = async (p) => (await credentialsFor(p)).length > 0;
  const [gem, oai, ant, el] = await Promise.all([has("gemini"), has("openai"), has("anthropic"), has("elevenlabs")]);
  const ffmpeg = await exec("ffmpeg", ["-version"], { timeoutMs: 10000 }).then(() => true).catch(() => false);
  return {
    scriptAdapter: gem ? "gemini_live" : oai ? "openai_live" : ant ? "anthropic_live" : "llm_mock",
    scriptAdapterFallbacks: [gem && "gemini_live", oai && "openai_live", ant && "anthropic_live"].filter(Boolean).slice(1),
    imageAdapter: gem ? "gemini_image" : oai ? "openai_image" : "image_mock",
    // A library photo is the step between a generated picture and a text card: free, and better than no picture at all.
    imageAdapterFallbacks: (await has("pexels")) ? ["pexels_stock"] : [],
    embedAdapter: gem ? "gemini_embed" : "embed_mock",
    voiceAdapter: gem ? "gemini_tts" : el ? "elevenlabs" : oai ? "openai_tts" : "tts_mock",
    voiceAdapterFallbacks: [gem && "gemini_tts", el && "elevenlabs", oai && "openai_tts"].filter(Boolean).slice(1),
    transcriptAdapter: gem ? "gemini_transcribe" : oai ? "whisper_api" : "transcribe_mock",
    // "remotion" falls back to ffmpeg by itself when the rendering instance lacks the memory, so it's safe to pick here.
    renderAdapter: studioInstalled() && ffmpeg ? "remotion" : ffmpeg ? "ffmpeg" : "render_mock",
  };
}
app.post("/api/niches", async (ctx) => {
  const b = { ...(ctx.body.useMocks ? {} : await smartAdapterDefaults()), ...ctx.body }; for (const r of ["brandId", "key", "displayName"]) if (!b[r]) throw new ApiError(400, null, `${r} is required`);
  // A country implies the language its audience reads, and getting that wrong is not a small default: a Bangladeshi
  // news page writing in English is writing for the wrong people. Say `language` explicitly to override it.
  if (!b.language && b.country) b.language = COUNTRY_LANGUAGE[String(b.country).trim().toLowerCase()] || undefined;
  const id = newId(); await q(`INSERT INTO niches (id, brand_id, key, display_name, tone, topic_source_adapter) VALUES ($1,$2,$3,$4,$5,$6)`, [id, b.brandId, b.key, b.displayName, b.tone || "", b.topicSourceAdapter || "newsapi_mock"]);
  const rest = { ...b }; delete rest.brandId; delete rest.key; delete rest.displayName; delete rest.tone; delete rest.topicSourceAdapter;
  const row = Object.keys(rest).some((k) => k in NICHE_MAP) ? await patchRow("niches", id, rest, NICHE_MAP) : await one(`SELECT * FROM niches WHERE id=$1`, [id]);
  if (Array.isArray(b.sourceIds)) for (const s of b.sourceIds) await q(`INSERT INTO niche_sources (id, niche_id, source_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [newId(), id, s]);
  // A Bangladesh program with no sources picked gets the catalog's sources for its language (or the TV channels).
  if (b.autoSources !== false && !(b.sourceIds || []).length) await installCatalogSources(catalogFor(row), [id]);
  // No style picked: the LLM writes one for this brand + program in the background.
  if (b.autoStyle !== false && !b.styleProfileId) await enqueue("STYLE_GENERATE", { brandId: row.brand_id, nicheId: id }, { queue: "text", priority: 8, dedupeKey: `style-gen:${id}` });
  json(ctx, 201, rowJson(row, NICHE_JSON));
});
app.post("/api/programs", async (ctx) => { ctx.req.url = "/api/niches"; const r = app.routes.find((x) => x.method === "POST" && x.re.test("/api/niches")); return r.handler(ctx); });
app.patch("/api/niches/:id", async (ctx) => json(ctx, 200, rowJson(await patchRow("niches", ctx.params.id, ctx.body, NICHE_MAP), NICHE_JSON)));
app.patch("/api/programs/:id", async (ctx) => json(ctx, 200, rowJson(await patchRow("niches", ctx.params.id, ctx.body, NICHE_MAP), NICHE_JSON)));
app.delete("/api/niches/:id", async (ctx) => { const dep = await one(`SELECT COUNT(*)::int AS n FROM content_items WHERE niche_id=$1`, [ctx.params.id]); if (dep.n) throw new ApiError(409, null, `Program has ${dep.n} content items — deactivate it instead (PATCH isActive:false)`); await q(`DELETE FROM series WHERE niche_id=$1`, [ctx.params.id]); await q(`DELETE FROM niches WHERE id=$1`, [ctx.params.id]); json(ctx, 200, { ok: true }); });
app.post("/api/niches/:id/sources/:sourceId", async (ctx) => { await q(`INSERT INTO niche_sources (id, niche_id, source_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [newId(), ctx.params.id, ctx.params.sourceId]); json(ctx, 200, { ok: true }); });
app.delete("/api/niches/:id/sources/:sourceId", async (ctx) => { await q(`DELETE FROM niche_sources WHERE niche_id=$1 AND source_id=$2`, [ctx.params.id, ctx.params.sourceId]); json(ctx, 200, { ok: true }); });
// ---- Meta: one login, every Page. A Page access token is derived from the token of a person who has a role on the
// Page, and /me/accounts hands back one for every Page that person manages. So nobody needs to hunt down a token per
// page: they grant once, the server exchanges the short-lived token for a long-lived one (Page tokens derived from a
// long-lived user token do not expire — derived from a short-lived one they die in an hour, which is the mistake
// everyone makes), stores each Page's token encrypted, and returns only names and ids. Tokens are never sent back.
app.post("/api/meta/pages", async (ctx) => {
  const b = ctx.body, ver = DEFAULTS.META_API_VERSION, graph = await setting("meta.api_base", "https://graph.facebook.com");
  const userToken = String(b.userToken || "").trim();
  if (!userToken) throw new ApiError(400, null, "userToken is required — log in at developers.facebook.com → Graph API Explorer, grant pages_show_list, pages_manage_posts and pages_read_engagement, and paste the token here");
  if (!vaultReady()) throw new ApiError(400, null, "SECRETS_KEY is not set on Render — add a long random string and redeploy before storing Page tokens");
  const appId = b.appId || ENV.META_APP_ID, appSecret = b.appSecret || ENV.META_APP_SECRET;
  let token = userToken, longLived = false;
  if (appId && appSecret) {
    try {
      const ex = await fetchJson(`${graph}/${ver}/oauth/access_token?${form({ grant_type: "fb_exchange_token", client_id: appId, client_secret: appSecret, fb_exchange_token: userToken })}`);
      if (ex.access_token) { token = ex.access_token; longLived = true; }
    } catch (e) { warn(`meta token exchange: ${e.message.slice(0, 160)}`); }
  }
  const me = await fetchJson(`${graph}/${ver}/me/accounts?${form({ access_token: token, fields: "id,name,access_token,tasks,instagram_business_account{id,username}", limit: 100 })}`);
  const pages = [];
  for (const pg of me.data || []) {
    if (!pg.access_token) continue;
    // "CREATE_CONTENT" is the task that actually allows posting; anything less is a Page you can see but not publish to.
    const canPost = !Array.isArray(pg.tasks) || pg.tasks.includes("CREATE_CONTENT") || pg.tasks.includes("MANAGE");
    const label = `Facebook: ${pg.name}`;
    let cred = await one(`SELECT id FROM api_credentials WHERE provider='meta' AND label=$1`, [label]);
    if (cred) await q(`UPDATE api_credentials SET secret_enc=$2, secret_hint=$3 WHERE id=$1`, [cred.id, encryptSecret(pg.access_token), secretHint(pg.access_token)]);
    else { const id = newId(); await q(`INSERT INTO api_credentials (id, provider, label, env_var, priority, secret_enc, secret_hint) VALUES ($1,'meta',$2,'',0,$3,$4)`, [id, label, encryptSecret(pg.access_token), secretHint(pg.access_token)]); cred = { id }; }
    pages.push({ pageId: pg.id, name: pg.name, canPost, credentialId: cred.id, instagram: pg.instagram_business_account ? { id: pg.instagram_business_account.id, username: pg.instagram_business_account.username } : null });
  }
  if (!pages.length) throw new ApiError(400, null, "That login manages no Pages the app can see. Check that pages_show_list was granted and that you have a role on the Page.");
  json(ctx, 200, { longLived, pages,
    note: longLived ? "Page tokens stored. Derived from a long-lived login, so they do not expire."
      : "Page tokens stored, but this login was short-lived, so they expire in about an hour. Add META_APP_ID and META_APP_SECRET (or pass appId/appSecret here) and connect again to make them permanent." });
});
// Turn a connected Page into a channel, so the whole path is: log in, pick a page, done.
app.post("/api/meta/channels", async (ctx) => {
  const b = ctx.body; for (const r of ["brandId", "pageId", "credentialId", "displayName"]) if (!b[r]) throw new ApiError(400, null, `${r} is required`);
  const id = newId(), platform = b.platform === "INSTAGRAM" ? "INSTAGRAM" : "FACEBOOK";
  await q(`INSERT INTO channels (id, brand_id, key, display_name, platform, format, timezone, credential_id, platform_account_id, publisher_adapter) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'meta_graph')`,
    [id, b.brandId, b.key || `fb_${String(b.pageId).slice(-6)}`, b.displayName, platform, b.format || (platform === "INSTAGRAM" ? "REEL_VIDEO" : "STATIC_IMAGE_CAPTION"), b.timezone || "Asia/Dhaka", b.credentialId, String(b.pageId)]);
  for (const n of b.nicheIds || []) await q(`INSERT INTO channel_niches (id, channel_id, niche_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [newId(), id, n]);
  json(ctx, 201, rowJson(await one(`SELECT * FROM channels WHERE id=$1`, [id]), ["platform_config", "posting_windows"]));
});
// ---- channels
const CHANNEL_MAP = { credentialId: "credential_id", displayName: "display_name", platform: "platform", format: "format", credentialRef: "credential_ref", scheduleCron: "schedule_cron", timezone: "timezone", isActive: "is_active", platformAccountId: "platform_account_id", platformConfig: "platform_config", publisherAdapter: "publisher_adapter", maxPostsPerDay: "max_posts_per_day", minGapMinutes: "min_gap_minutes", postingWindows: "posting_windows", captionTemplate: "caption_template" };
app.get("/api/channels", async (ctx) => { const b = ctx.query.get("brandId"); const rows = b ? await q(`SELECT * FROM channels WHERE brand_id=$1 ORDER BY created_at DESC`, [b]) : await q(`SELECT * FROM channels ORDER BY created_at DESC`); const out = []; for (const ch of rows) out.push({ ...rowJson(ch, ["platform_config", "posting_windows"]), niches: await q(`SELECT n.* FROM niches n JOIN channel_niches cn ON cn.niche_id=n.id WHERE cn.channel_id=$1`, [ch.id]) }); json(ctx, 200, out); });
app.post("/api/channels", async (ctx) => { const b = ctx.body; for (const r of ["brandId", "key", "displayName", "platform", "format"]) if (!b[r]) throw new ApiError(400, null, `${r} is required`); const id = newId(); await q(`INSERT INTO channels (id, brand_id, key, display_name, platform, format, timezone) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, b.brandId, b.key, b.displayName, b.platform, b.format, b.timezone || "Asia/Dhaka"]); const rest = { ...b }; for (const k of ["brandId", "key", "displayName", "platform", "format", "timezone"]) delete rest[k]; const row = Object.keys(rest).some((k) => k in CHANNEL_MAP) ? await patchRow("channels", id, rest, CHANNEL_MAP) : await one(`SELECT * FROM channels WHERE id=$1`, [id]); if (Array.isArray(b.nicheIds)) for (const n of b.nicheIds) await q(`INSERT INTO channel_niches (id, channel_id, niche_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [newId(), id, n]); json(ctx, 201, rowJson(row, ["platform_config", "posting_windows"])); });
app.patch("/api/channels/:id", async (ctx) => json(ctx, 200, rowJson(await patchRow("channels", ctx.params.id, ctx.body, CHANNEL_MAP), ["platform_config", "posting_windows"])));
app.delete("/api/channels/:id", async (ctx) => { const dep = await one(`SELECT COUNT(*)::int AS n FROM content_assets WHERE channel_id=$1`, [ctx.params.id]); if (dep.n) throw new ApiError(409, null, "Channel has publish history — deactivate instead"); await q(`DELETE FROM channels WHERE id=$1`, [ctx.params.id]); json(ctx, 200, { ok: true }); });
app.post("/api/channels/:id/niches/:nicheId", async (ctx) => { await q(`INSERT INTO channel_niches (id, channel_id, niche_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [newId(), ctx.params.id, ctx.params.nicheId]); json(ctx, 200, { ok: true }); });
app.delete("/api/channels/:id/niches/:nicheId", async (ctx) => { await q(`DELETE FROM channel_niches WHERE channel_id=$1 AND niche_id=$2`, [ctx.params.id, ctx.params.nicheId]); json(ctx, 200, { ok: true }); });
// Read-only connection check. Publishing to a real account fails for dull reasons — a token for the wrong thing, an id
// from the wrong place — and this says which, before a story is spent finding out.
app.post("/api/channels/:id/check", async (ctx) => {
  const ch = await one(`SELECT * FROM channels WHERE id=$1`, [ctx.params.id]); if (!ch) throw new ApiError(404, null, "Channel not found");
  const pub = await resolve("PUBLISH", ch.publisher_adapter || PLATFORM_DEFAULT_PUBLISHER[ch.platform] || "publish_mock");
  if (!pub.check) return json(ctx, 200, { ok: true, notes: [`${pub.key} publishes nowhere real, so there is nothing to check.`] });
  try { json(ctx, 200, await pub.check({ channel: ch })); }
  catch (e) { json(ctx, 200, { ok: false, error: String(e.message).slice(0, 500) }); }
});
app.post("/api/channels/:id/test-publish", async (ctx) => { const ch = await one(`SELECT * FROM channels WHERE id=$1`, [ctx.params.id]); if (!ch) throw new ApiError(404, null, "Channel not found"); const pub = await resolve("PUBLISH", ch.publisher_adapter || PLATFORM_DEFAULT_PUBLISHER[ch.platform] || "publish_mock"); if (ch.platform !== "FACEBOOK" || pub.impl !== "meta_graph") return json(ctx, 200, { ok: true, note: `resolved publisher ${pub.key}; only Facebook text test-posts are supported here` }); json(ctx, 200, await pub.publish({ channel: ch, mediaKind: "TEXT", caption: ctx.body.message || "Content Engine connection test", title: "test" })); });
// ---- series
app.get("/api/series", async (ctx) => { const n = ctx.query.get("nicheId"); json(ctx, 200, n ? await q(`SELECT * FROM series WHERE niche_id=$1 ORDER BY created_at DESC`, [n]) : await q(`SELECT * FROM series ORDER BY created_at DESC`)); });
const SERIES_MAP = { displayName: "display_name", isActive: "is_active", episodeCounter: "episode_counter", premise: "premise", cadenceDays: "cadence_days", autoGenerate: "auto_generate", nextDueAt: "next_due_at" };
app.post("/api/series", async (ctx) => { const b = ctx.body; if (!b.nicheId || !b.key || !b.displayName) throw new ApiError(400, null, "nicheId, key, displayName are required"); const id = newId(); await q(`INSERT INTO series (id, niche_id, key, display_name) VALUES ($1,$2,$3,$4)`, [id, b.nicheId, b.key, b.displayName]); const rest = { ...b }; for (const k of ["nicheId", "key", "displayName"]) delete rest[k]; json(ctx, 201, Object.keys(rest).some((k) => k in SERIES_MAP) ? await patchRow("series", id, rest, SERIES_MAP) : await one(`SELECT * FROM series WHERE id=$1`, [id])); });
app.patch("/api/series/:id", async (ctx) => json(ctx, 200, await patchRow("series", ctx.params.id, ctx.body, SERIES_MAP)));
app.post("/api/series/:id/next", async (ctx) => json(ctx, 202, await nextEpisode(ctx.params.id)));
// ---- style generation, planner, insights
app.post("/api/style-profiles/generate", async (ctx) => { const b = ctx.body; if (!b.brandId) throw new ApiError(400, null, "brandId is required"); json(ctx, 201, rowJson(await generateStyle({ brandId: b.brandId, nicheId: b.nicheId || null, samples: b.samples || "", name: b.name || null, apply: !!b.apply }), ["banned_terms", "hashtags", "history"])); });
app.post("/api/style-profiles/:id/refine", async (ctx) => json(ctx, 200, (await refineStyle(ctx.params.id)) || { changes: null, note: "Nothing to learn from yet: no edits, rejections or published posts with metrics." }));
app.get("/api/suggestions", async (ctx) => { const n = ctx.query.get("nicheId"), st = ctx.query.get("status") || "NEW"; json(ctx, 200, (await q(`SELECT s.*, n.display_name AS program_name FROM suggestions s LEFT JOIN niches n ON n.id = s.niche_id WHERE ($1::text IS NULL OR s.niche_id=$1) AND ($2 = 'ALL' OR s.status=$2) ORDER BY s.created_at DESC, s.score DESC LIMIT 200`, [n, st])).map((r) => rowJson(r, ["payload"]))); });
app.post("/api/suggestions/:id/accept", async (ctx) => json(ctx, 200, await acceptSuggestion(ctx.params.id)));
app.post("/api/suggestions/:id/dismiss", async (ctx) => json(ctx, 200, await one(`UPDATE suggestions SET status='DISMISSED', acted_at=now() WHERE id=$1 RETURNING *`, [ctx.params.id])));
app.post("/api/programs/:id/plan", async (ctx) => json(ctx, 200, await planProgram(ctx.params.id)));
app.get("/api/insights", async (ctx) => {
  const nicheId = ctx.query.get("nicheId"), days = Math.min(180, Number(ctx.query.get("days")) || 30);
  const niches = nicheId ? [await one(`SELECT * FROM niches WHERE id=$1`, [nicheId])].filter(Boolean) : await q(`SELECT * FROM niches WHERE is_active::int = 1 ORDER BY priority DESC`);
  const programs = []; for (const n of niches) programs.push({ program: { id: n.id, name: n.display_name, type: n.content_type }, ...(await programStats(n, days)) });
  const totals = await one(`SELECT COUNT(*)::int AS published, COALESCE(SUM((last_metrics->>'views')::int), 0)::int AS views, COALESCE(SUM((last_metrics->>'likes')::int), 0)::int AS likes, COALESCE(SUM((last_metrics->>'comments')::int), 0)::int AS comments FROM content_assets WHERE status = 'PUBLISHED' AND published_at > now() - ($1 || ' days')::interval`, [String(days)]);
  const qa = await q(`SELECT qa_status, COUNT(*)::int AS n FROM content_items WHERE created_at > now() - ($1 || ' days')::interval AND qa_status IS NOT NULL GROUP BY qa_status`, [String(days)]);
  json(ctx, 200, { days, totals, qa: Object.fromEntries(qa.map((r) => [r.qa_status, r.n])), programs });
});
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
// ---- schedule: what goes out where and when (next days), and what just went out
app.get("/api/schedule", async (ctx) => json(ctx, 200, {
  upcoming: await q(`SELECT a.id, a.status, a.scheduled_for, c.display_name AS channel, c.platform, ci.id AS item_id, COALESCE(ci.headline, ci.topic) AS headline, ci.content_type, m.url AS hero_url, m.kind AS hero_kind
    FROM content_assets a JOIN channels c ON c.id = a.channel_id JOIN content_items ci ON ci.id = a.content_item_id LEFT JOIN media_assets m ON m.id = ci.hero_media_id
    WHERE a.status IN ('PENDING','RENDERING','RENDERED','PUBLISHING') ORDER BY a.scheduled_for NULLS FIRST LIMIT 200`),
  recent: await q(`SELECT a.id, a.status, a.published_at, a.published_url, a.error_message, c.display_name AS channel, c.platform, ci.id AS item_id, COALESCE(ci.headline, ci.topic) AS headline
    FROM content_assets a JOIN channels c ON c.id = a.channel_id JOIN content_items ci ON ci.id = a.content_item_id
    WHERE a.status IN ('PUBLISHED','FAILED') AND a.updated_at > now() - interval '48 hours' ORDER BY a.updated_at DESC LIMIT 100`),
}));
// ---- setup checklist: what still stands between this install and running on its own
app.get("/api/setup-status", async (ctx) => {
  const has = async (p) => (await credentialsFor(p)).length > 0;
  const [gem, oai, ant, pex] = await Promise.all([has("gemini"), has("openai"), has("anthropic"), has("pexels")]);
  const storage = (await storageBackend()).name;
  const kit = await one(`SELECT COUNT(*)::int AS n FROM brands WHERE brand_kit ? 'logo_url' OR brand_kit ? 'primary_color'`);
  const programs = await one(`SELECT COUNT(*)::int AS n FROM niches WHERE is_active::int = 1`);
  const live = await q(`SELECT c.* FROM channels c WHERE c.is_active::int = 1 AND COALESCE(c.publisher_adapter, '') <> 'publish_mock' AND c.platform <> 'PORTAL'`);
  let liveReady = 0; for (const c of live) { const needs = c.platform === "YOUTUBE" ? "youtube_oauth" : "meta"; if (c.credential_id || (needs === "meta" ? ENV.META_ACCESS_TOKEN : ENV.YOUTUBE_REFRESH_TOKEN)) liveReady++; }
  const freeTier = await one(`SELECT 1 AS x FROM notifications WHERE kind = 'quota' AND title ILIKE '%free tier%' AND created_at > now() - interval '48 hours' LIMIT 1`);
  const items = [
    { key: "ai", ok: gem || oai || ant, title: "An AI key", detail: gem ? "Gemini is set" : oai ? "OpenAI is set" : ant ? "Anthropic is set" : "Add a Gemini key (API keys page, or GEMINI_API_KEY on Render)", link: "#/keys" },
    { key: "password", ok: !!ENV.DASHBOARD_PASSWORD, title: "Dashboard password", detail: ENV.DASHBOARD_PASSWORD ? "Set" : "Set DASHBOARD_PASSWORD on Render — the dashboard is open to anyone", link: null },
    { key: "vault", ok: vaultReady(), title: "Key vault", detail: vaultReady() ? "On" : "Set SECRETS_KEY on Render to store keys from the dashboard", link: null },
    { key: "storage", ok: storage !== "local", title: "Media storage", detail: storage !== "local" ? `Using ${storage}` : "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY on Render (local disk is wiped on deploy and isn't shared with the video worker)", link: "#/settings" },
    { key: "public_url", ok: !!ENV.PUBLIC_BASE_URL, title: "Public URL", detail: ENV.PUBLIC_BASE_URL || "Set PUBLIC_BASE_URL to this service's address (portal links)", link: null },
    { key: "brand", ok: kit.n > 0, title: "A brand kit", detail: kit.n ? "Set" : "Give a brand its logo and colours — every photocard and video uses them", link: "#/brands" },
    { key: "program", ok: programs.n > 0, title: "A program", detail: programs.n ? `${programs.n} active` : "Create one from a preset", link: "#/programs" },
    { key: "channel", ok: liveReady > 0, title: "A real publishing channel", detail: liveReady ? `${liveReady} ready` : live.length ? "A channel has no token yet — add a Meta or YouTube key and pick it on the channel" : "Add a Facebook Page, Instagram or YouTube channel with its token", link: "#/channels" },
    { key: "billing", ok: !freeTier, title: "An AI key with billing", detail: freeTier ? "This key ran out of free-tier requests in the last two days — a free key allows about 20 a day per model and no pictures. Enable billing on it (Google AI Studio → Billing)" : "No free-tier limit hit recently", link: "#/keys" },
    { key: "photos", ok: pex, title: "Photos for posts", detail: pex ? "Stock photos are available when a picture cannot be generated" : "Without generated pictures, posts go out as text cards. A free Pexels key (pexels.com/api) gives them real photos — the writer skips one when it could mislead", link: "#/keys" },
    { key: "budget", ok: Number(await setting("budget.daily_cap_usd", 0)) > 0, title: "A daily spend cap", detail: Number(await setting("budget.daily_cap_usd", 0)) > 0 ? `$${await setting("budget.daily_cap_usd", 0)} a day` : "Set one in Settings so a busy news day cannot run up a bill", link: "#/settings" },
    { key: "alerts", ok: !!(await telegramTarget().catch(() => null)), title: "Alerts on your phone", detail: "Telegram bot token + chat id (Settings → Alerts)", link: "#/settings" },
    { key: "studio", ok: studioInstalled(), title: "Video studio", detail: studioInstalled() ? `Installed. Renders run where the video lane runs and need ${STUDIO_MIN_MEMORY_MB} MB (this instance: ${memoryLimitMb()} MB)` : "Installed by the Docker image (reels and explainers)", link: null },
  ];
  json(ctx, 200, { items, done: items.filter((i) => i.ok).length, total: items.length });
});
// ---- alerts
app.get("/api/notifications", async (ctx) => json(ctx, 200, await q(`SELECT * FROM notifications ORDER BY created_at DESC LIMIT ${Math.min(200, Number(ctx.query.get("limit")) || 50)}`)));
app.post("/api/notifications/read-all", async (ctx) => { await q(`UPDATE notifications SET read_at = now() WHERE read_at IS NULL`); json(ctx, 200, { ok: true }); });
app.post("/api/notifications/test", async (ctx) => { const tg = await telegramTarget(); await notify("test", "Test alert from Content Engine", tg ? "Alerts reach this chat." : "Telegram is not configured: this alert is only in the dashboard.", { level: "info", key: `test:${newId()}` }); json(ctx, 200, { telegram: !!tg }); });
// ---- source catalog + news desk
app.get("/api/source-catalog", async (ctx) => {
  const rows = await q(`SELECT s.catalog_key, s.id, s.is_active, s.last_polled_at, s.last_error, s.read_mode, s.read_note, (SELECT json_agg(n.display_name) FROM niches n JOIN niche_sources ns ON ns.niche_id = n.id WHERE ns.source_id = s.id) AS programs FROM sources s WHERE s.catalog_key IS NOT NULL`);
  const by = Object.fromEntries(rows.map((r) => [r.catalog_key, r]));
  json(ctx, 200, SOURCE_CATALOG.map((e) => ({ ...e, installed: !!by[e.key], sourceId: by[e.key]?.id || null, programs: by[e.key]?.programs || [], lastPolledAt: by[e.key]?.last_polled_at || null, lastError: by[e.key]?.last_error || null, readMode: by[e.key]?.read_mode || null, readNote: by[e.key]?.read_note || null })));
});
app.post("/api/source-catalog/install", async (ctx) => {
  const keys = new Set(ctx.body.keys || []); const entries = SOURCE_CATALOG.filter((e) => keys.has(e.key));
  if (!entries.length) throw new ApiError(400, null, "keys must name catalog entries");
  json(ctx, 200, { sourceIds: await installCatalogSources(entries, ctx.body.nicheIds || []) });
});
app.get("/api/desk", async (ctx) => {
  const hours = String(Math.min(72, Number(ctx.query.get("hours")) || 24));
  json(ctx, 200, await q(`SELECT c.id, c.title, c.outlets, c.source_count, c.item_count, c.published_at, c.first_seen_at, c.last_seen_at,
      LEAST(c.weight_sum, 6) * exp(-extract(epoch FROM now() - c.first_seen_at) / 64800.0) AS score,
      (SELECT json_agg(json_build_object('program', n.display_name, 'itemId', ci.id, 'status', ci.status)) FROM content_items ci JOIN niches n ON n.id = ci.niche_id WHERE ci.cluster_id = c.id) AS coverage
    FROM story_clusters c WHERE c.last_seen_at > now() - ($1 || ' hours')::interval ORDER BY score DESC LIMIT 150`, [hours]));
});
app.post("/api/desk/run", async (ctx) => { await sweepNewsDesk(); json(ctx, 200, { ok: true }); });
// The health checks run every quarter of an hour on their own; this is for asking straight after changing something.
app.post("/api/health/sweep", async (ctx) => { await sweepHealth(); json(ctx, 200, { ok: true, checked: nowIso() }); });
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
// Approving twenty drafts one at a time is the bottleneck that makes an automated newsroom manual again. This approves
// the ones the standards check passed — the same drafts an automatic program would have published by itself — and
// leaves anything it flagged for a person. Each one is scheduled exactly as a single approval would be.
app.post("/api/review/approve-clean", async (ctx) => {
  const rows = await q(`SELECT id FROM content_items WHERE status = 'PENDING_REVIEW' AND qa_status = 'PASS' AND ($1::text IS NULL OR niche_id = $1) ORDER BY created_at ASC LIMIT 100`, [ctx.body.nicheId || null]);
  const approved = [], failed = [];
  for (const r of rows) {
    try { await approveItem(r.id, { auto: false }); approved.push(r.id); }
    catch (e) { failed.push({ id: r.id, error: String(e.message).slice(0, 200) }); }
  }
  log(`review: approved ${approved.length} clean draft(s)${failed.length ? `, ${failed.length} could not be approved` : ""}`);
  json(ctx, 200, { approved: approved.length, failed });
});
app.post("/api/content-items/:id/approve", async (ctx) => { if (rateLimited(`appr:${ctx.ip}`, 30)) throw new ApiError(429, null, "Too many approve requests"); json(ctx, 200, await itemWithMedia(await approveItem(ctx.params.id, { scheduledFor: ctx.body.scheduledFor || null }))); });
app.post("/api/content-items/:id/reject", async (ctx) => json(ctx, 200, await rejectItem(ctx.params.id, ctx.body.note)));
app.post("/api/content-items/:id/regenerate", async (ctx) => { const part = ctx.body.part || "all"; if (!["all", "headline", "image", "captions", "body"].includes(part)) throw new ApiError(400, null, "part must be all|headline|image|captions|body"); const it = await one(`SELECT * FROM content_items WHERE id=$1`, [ctx.params.id]); if (!it) throw new ApiError(404, null, "Not found"); if (VIDEO_TYPES.has(it.content_type) && part === "all") { await enqueue("RENDER_CLIP", { itemId: it.id, clipId: it.clip_id }, { queue: "video", contentItemId: it.id }); } else { await setItem(it.id, { status: part === "all" ? "QUEUED" : "DRAFTING" }); await enqueue(part === "all" ? "GENERATE_CONTENT" : "REGENERATE", { itemId: it.id, part }, { queue: part === "image" ? "image" : queueFor(it.content_type), priority: 5, contentItemId: it.id }); } json(ctx, 202, { ok: true }); });
// Reviewer edits to an AI draft are logged as style feedback, and a changed headline redraws the photocard.
app.patch("/api/content-items/:id", async (ctx) => {
  const b = ctx.body; const map = { script: "script", headline: "headline", summary: "summary", body: "body", captions: "captions", hashtags: "hashtags", imagePrompt: "image_prompt", scheduledFor: "scheduled_for", heroMediaId: "hero_media_id" };
  const before = await one(`SELECT * FROM content_items WHERE id=$1`, [ctx.params.id]); if (!before) throw new ApiError(404, null, "Not found");
  let row = await patchRow("content_items", ctx.params.id, b, map);
  const txt = (v) => (v && typeof v === "object" ? JSON.stringify(v) : String(v ?? ""));
  const changed = ["headline", "summary", "body", "script", "captions"].filter((f) => f in b && txt(P(b[f]) ?? b[f]) !== txt(P(before[f]) ?? before[f]));
  if (changed.length && before.status === "PENDING_REVIEW") await logStyleFeedback(before, "EDIT", changed.map((f) => ({ field: f, old: txt(P(before[f]) ?? before[f]).slice(0, 4000), new: txt(P(b[f]) ?? b[f]).slice(0, 4000) }))).catch((e) => warn("style feedback", e.message));
  if (changed.includes("headline") && !("heroMediaId" in b)) { if (await recomposeCard(row.id).catch((e) => warn(`card recompose: ${e.message}`))) row = await one(`SELECT * FROM content_items WHERE id=$1`, [row.id]); }
  json(ctx, 200, await itemWithMedia(row));
});
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
  let niche = await one(`SELECT * FROM niches WHERE brand_id=$1 AND key=$2`, [brand.id, "bd_news"]); if (!niche) { const id = newId(); await q(`INSERT INTO niches (id, brand_id, key, display_name, tone, topic_source_adapter, content_type, country, language, publish_to_portal, approval_mode) VALUES ($1,$2,'bd_news','Bangladesh News','clear, factual, click-worthy','newsapi_mock','NEWS_STATIC','Bangladesh','en',1,'MANUAL')`, [id, brand.id]);
    await q(`UPDATE niches SET method_config = '{"desk": {"settle_minutes": 0, "min_gap_minutes": 0}}'::jsonb WHERE id = $1`, [id]); niche = await one(`SELECT * FROM niches WHERE id=$1`, [id]); }
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
  server.listen(PORT, async () => {
    const storage = await storageBackend();
    log(`Content Engine listening on http://localhost:${PORT}  (worker ${WORKER_ID}, lanes: ${LANES.join(",") || "none"}, sweeps: ${RUN_SWEEPS}, storage: ${storage.name}, vault: ${vaultReady() ? "on" : "off — set SECRETS_KEY to store secrets from the dashboard"})`);
    // Settle the media bucket at boot rather than at the first upload, so a storage problem shows up in the deploy log.
    if (storage.name === "supabase") ensureSupabaseBucket().catch((e) => warn("supabase storage:", e.message.slice(0, 200)));
    startWorkers();
  });
})().catch((e) => { console.error("boot failed:", e); process.exit(1); });

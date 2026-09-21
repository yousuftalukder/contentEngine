-- =====================================================================
-- Content Engine — single idempotent Postgres/Supabase schema.
-- Safe to run any number of times: every table is CREATE IF NOT EXISTS,
-- every later-added column is ADD COLUMN IF NOT EXISTS, every function is
-- CREATE OR REPLACE, every seed is ON CONFLICT DO NOTHING.
-- server.js runs this file automatically at boot (and `node server.js --migrate`).
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------
-- CONFIG LAYER
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS brands (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Brand kit: logo_url, primary_color, accent_color, text_color, font, fonts_url, handle, website, credit_sources,
-- image_ratio, logo_scale, music_urls, intro_url, outro_url, voice (used by photocards, videos and animations).
ALTER TABLE brands ADD COLUMN IF NOT EXISTS brand_kit JSONB NOT NULL DEFAULT '{}'::jsonb;

-- A "program" in the dashboard = a row in niches.
CREATE TABLE IF NOT EXISTS niches (
  id                   TEXT PRIMARY KEY,
  brand_id             TEXT NOT NULL REFERENCES brands(id),
  key                  TEXT NOT NULL,
  display_name         TEXT NOT NULL,
  tone                 TEXT NOT NULL DEFAULT '',
  visual_mode          TEXT NOT NULL DEFAULT 'STATIC_IMAGE',
  topic_source_adapter TEXT NOT NULL DEFAULT 'newsapi_mock',
  script_adapter       TEXT NOT NULL DEFAULT 'llm_mock',
  voice_adapter        TEXT NOT NULL DEFAULT 'tts_mock',
  render_adapter       TEXT NOT NULL DEFAULT 'render_mock',
  voice_id             TEXT,
  fact_check_strict    INTEGER NOT NULL DEFAULT 1,
  dedup_threshold      REAL NOT NULL DEFAULT 0.82,
  is_active            INTEGER NOT NULL DEFAULT 1,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(brand_id, key)
);
ALTER TABLE niches ADD COLUMN IF NOT EXISTS content_type            TEXT NOT NULL DEFAULT 'NICHE_STATIC';
ALTER TABLE niches ADD COLUMN IF NOT EXISTS production_method       TEXT;
ALTER TABLE niches ADD COLUMN IF NOT EXISTS method_config           JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE niches ADD COLUMN IF NOT EXISTS language                TEXT NOT NULL DEFAULT 'en';
ALTER TABLE niches ADD COLUMN IF NOT EXISTS country                 TEXT;
ALTER TABLE niches ADD COLUMN IF NOT EXISTS approval_mode           TEXT NOT NULL DEFAULT 'MANUAL';
ALTER TABLE niches ADD COLUMN IF NOT EXISTS review_window_minutes   INTEGER NOT NULL DEFAULT 60;
ALTER TABLE niches ADD COLUMN IF NOT EXISTS style_profile_id        TEXT;
ALTER TABLE niches ADD COLUMN IF NOT EXISTS publish_to_portal       INTEGER NOT NULL DEFAULT 0;
ALTER TABLE niches ADD COLUMN IF NOT EXISTS image_adapter           TEXT NOT NULL DEFAULT 'image_mock';
ALTER TABLE niches ADD COLUMN IF NOT EXISTS image_specs             JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE niches ADD COLUMN IF NOT EXISTS topic_filters           JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE niches ADD COLUMN IF NOT EXISTS max_items_per_day       INTEGER NOT NULL DEFAULT 0;
ALTER TABLE niches ADD COLUMN IF NOT EXISTS priority                INTEGER NOT NULL DEFAULT 0;
ALTER TABLE niches ADD COLUMN IF NOT EXISTS download_adapter        TEXT NOT NULL DEFAULT 'ytdlp';
ALTER TABLE niches ADD COLUMN IF NOT EXISTS transcript_adapter      TEXT NOT NULL DEFAULT 'transcribe_mock';
ALTER TABLE niches ADD COLUMN IF NOT EXISTS clip_adapter            TEXT NOT NULL DEFAULT 'llm_clipper';
ALTER TABLE niches ADD COLUMN IF NOT EXISTS clip_adapter_fallbacks  JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE niches ADD COLUMN IF NOT EXISTS script_adapter_fallbacks JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE niches ADD COLUMN IF NOT EXISTS image_adapter_fallbacks JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE niches ADD COLUMN IF NOT EXISTS embed_adapter           TEXT NOT NULL DEFAULT 'embed_mock';
-- The writer and the pictures have always had somewhere to fall back to; the voice did not, so one provider saying no
-- stopped every video the program makes for the rest of the day.
ALTER TABLE niches ADD COLUMN IF NOT EXISTS voice_adapter_fallbacks JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE niches ADD COLUMN IF NOT EXISTS transcript_adapter_fallbacks JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS channels (
  id             TEXT PRIMARY KEY,
  brand_id       TEXT NOT NULL REFERENCES brands(id),
  key            TEXT NOT NULL,
  display_name   TEXT NOT NULL,
  platform       TEXT NOT NULL,
  format         TEXT NOT NULL,
  credential_ref TEXT,
  schedule_cron  TEXT,
  timezone       TEXT NOT NULL DEFAULT 'Asia/Dhaka',
  is_active      INTEGER NOT NULL DEFAULT 1,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(brand_id, key)
);
ALTER TABLE channels ADD COLUMN IF NOT EXISTS platform_account_id TEXT;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS platform_config     JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS publisher_adapter   TEXT;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS max_posts_per_day   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS min_gap_minutes     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS posting_windows     JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS caption_template    TEXT;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS last_published_at   TIMESTAMPTZ;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS credential_id       TEXT;  -- api_credentials.id (meta / youtube_oauth) used to publish on this channel

CREATE TABLE IF NOT EXISTS channel_niches (
  id         TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  niche_id   TEXT NOT NULL REFERENCES niches(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(channel_id, niche_id)
);

CREATE TABLE IF NOT EXISTS series (
  id              TEXT PRIMARY KEY,
  niche_id        TEXT NOT NULL REFERENCES niches(id),
  key             TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  episode_counter INTEGER NOT NULL DEFAULT 0,
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(niche_id, key)
);

CREATE TABLE IF NOT EXISTS style_profiles (
  id           TEXT PRIMARY KEY,
  brand_id     TEXT REFERENCES brands(id),
  name         TEXT NOT NULL,
  language     TEXT NOT NULL DEFAULT 'en',
  tone         TEXT NOT NULL DEFAULT '',
  rules        TEXT NOT NULL DEFAULT '',
  examples     TEXT NOT NULL DEFAULT '',
  banned_terms JSONB NOT NULL DEFAULT '[]'::jsonb,
  cta          TEXT NOT NULL DEFAULT '',
  hashtags     JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Where raw material comes from (RSS feed, NewsAPI query, YouTube channel, Twitch VODs, FB page...).
CREATE TABLE IF NOT EXISTS sources (
  id                    TEXT PRIMARY KEY,
  brand_id              TEXT REFERENCES brands(id),
  name                  TEXT NOT NULL,
  kind                  TEXT NOT NULL DEFAULT 'RSS',
  adapter_key           TEXT NOT NULL DEFAULT 'rss',
  config                JSONB NOT NULL DEFAULT '{}'::jsonb,
  poll_interval_minutes INTEGER NOT NULL DEFAULT 30,
  last_polled_at        TIMESTAMPTZ,
  last_error            TEXT,
  license_policy        TEXT NOT NULL DEFAULT 'ANY',
  is_active             INTEGER NOT NULL DEFAULT 1,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE sources ADD COLUMN IF NOT EXISTS adapter_key TEXT NOT NULL DEFAULT 'rss';
ALTER TABLE sources ADD COLUMN IF NOT EXISTS last_error  TEXT;

CREATE TABLE IF NOT EXISTS niche_sources (
  id         TEXT PRIMARY KEY,
  niche_id   TEXT NOT NULL REFERENCES niches(id) ON DELETE CASCADE,
  source_id  TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(niche_id, source_id)
);

-- Ingest-once ledger. url_hash guarantees a story/video is only ever taken in once.
CREATE TABLE IF NOT EXISTS source_items (
  id            TEXT PRIMARY KEY,
  source_id     TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  external_id   TEXT,
  url           TEXT NOT NULL,
  url_hash      TEXT NOT NULL UNIQUE,
  title         TEXT NOT NULL,
  summary       TEXT,
  published_at  TIMESTAMPTZ,
  thumbnail_url TEXT,
  kind          TEXT NOT NULL DEFAULT 'ARTICLE',
  raw           JSONB,
  status        TEXT NOT NULL DEFAULT 'NEW',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_source_items_status ON source_items(status, created_at);
ALTER TABLE sources ADD COLUMN IF NOT EXISTS weight      REAL NOT NULL DEFAULT 1;   -- outlet importance in news-desk ranking
ALTER TABLE sources ADD COLUMN IF NOT EXISTS language    TEXT;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS catalog_key TEXT;                      -- set when created from the built-in catalog
-- How the outlet is actually being read. A feed that quietly drops to Google News still polls, still returns items and
-- still looks healthy — while losing every summary and every photograph the outlet publishes. That is not an error, so
-- it cannot live in last_error (a successful poll clears it, and the health sweep would alert on it daily); it is a
-- degraded mode, and it gets its own column so the dashboard can say so.
ALTER TABLE sources ADD COLUMN IF NOT EXISTS read_mode   TEXT;                      -- NULL/'direct' | 'google_news'
ALTER TABLE sources ADD COLUMN IF NOT EXISTS read_note   TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sources_catalog_key ON sources(catalog_key) WHERE catalog_key IS NOT NULL;

-- NEWS DESK: one row per real-world story, grouping every outlet that reports it (server.js section 7c).
CREATE TABLE IF NOT EXISTS story_clusters (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  embedding     TEXT,                                -- running mean of members' trimmed embeddings (JSON array)
  outlets       JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{name, weight}]
  weight_sum    REAL NOT NULL DEFAULT 0,
  item_count    INTEGER NOT NULL DEFAULT 0,
  source_count  INTEGER NOT NULL DEFAULT 0,
  published_at  TIMESTAMPTZ,                         -- earliest publication time among members
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_story_clusters_seen ON story_clusters(last_seen_at DESC);
ALTER TABLE source_items ADD COLUMN IF NOT EXISTS cluster_id TEXT;
ALTER TABLE source_items ADD COLUMN IF NOT EXISTS embedding  TEXT;
CREATE INDEX IF NOT EXISTS idx_source_items_cluster ON source_items(cluster_id);

-- ---------------------------------------------------------------------
-- STATE / HISTORY LAYER
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS content_items (
  id                     TEXT PRIMARY KEY,
  niche_id               TEXT NOT NULL REFERENCES niches(id),
  series_id              TEXT REFERENCES series(id),
  derived_from_id        TEXT REFERENCES content_items(id),
  episode_number         INTEGER,
  topic                  TEXT NOT NULL DEFAULT '',
  topic_embedding        TEXT,
  source_data_ref        TEXT,
  script                 TEXT,
  script_meta            TEXT,
  voice_asset_url        TEXT,
  status                 TEXT NOT NULL DEFAULT 'QUEUED',
  rejection_note         TEXT,
  niche_profile_version  TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS content_type        TEXT;
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS source_item_id      TEXT REFERENCES source_items(id);
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS video_candidate_id  TEXT;
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS clip_id             TEXT;
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS headline            TEXT;
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS summary             TEXT;
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS body                TEXT;
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS captions            JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS hashtags            JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS image_prompt        TEXT;
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS hero_media_id       TEXT;
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS portal_article_id   TEXT;
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS auto_approved       INTEGER NOT NULL DEFAULT 0;
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS review_deadline_at  TIMESTAMPTZ;
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS scheduled_for       TIMESTAMPTZ;
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS generation_cost_usd REAL NOT NULL DEFAULT 0;
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS cluster_id          TEXT;   -- news-desk story this item covers
CREATE INDEX IF NOT EXISTS idx_content_items_cluster ON content_items(cluster_id, niche_id);
-- Quality gate (server.js 8h): PASS | REVIEW | REJECT, 0-1 score, the full report.
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS qa_status           TEXT;
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS qa_score            REAL;
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS qa_report           JSONB;

-- Style learning (server.js 8i): reviewer edits, rejection notes and top posts feed periodic style refinement.
ALTER TABLE style_profiles ADD COLUMN IF NOT EXISTS niche_id   TEXT;
ALTER TABLE style_profiles ADD COLUMN IF NOT EXISTS generated  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE style_profiles ADD COLUMN IF NOT EXISTS history    JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE style_profiles ADD COLUMN IF NOT EXISTS refined_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS style_feedback (
  id               TEXT PRIMARY KEY,
  style_profile_id TEXT,
  niche_id         TEXT,
  content_item_id  TEXT,
  kind             TEXT NOT NULL,        -- EDIT | REJECT
  field            TEXT,
  old_text         TEXT,
  new_text         TEXT,
  note             TEXT,
  used_at          TIMESTAMPTZ,          -- set once a refinement has consumed it
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_style_feedback_profile ON style_feedback(style_profile_id, used_at);

-- Planner (server.js 8j): ideas from past performance, trending stories and series history.
CREATE TABLE IF NOT EXISTS suggestions (
  id              TEXT PRIMARY KEY,
  brand_id        TEXT,
  niche_id        TEXT,
  series_id       TEXT,
  kind            TEXT NOT NULL,         -- TOPIC | SERIES_EPISODE | NEW_SERIES | FORMAT | TIMING | NEW_PROGRAM
  title           TEXT NOT NULL,
  rationale       TEXT,
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  score           REAL NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'NEW',   -- NEW | ACCEPTED | DISMISSED
  content_item_id TEXT,
  acted_at        TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_suggestions_niche ON suggestions(niche_id, status, created_at DESC);

-- Alerts (server.js 9b): problems a person must act on, shown in the dashboard and sent to Telegram when configured.
CREATE TABLE IF NOT EXISTS notifications (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  level      TEXT NOT NULL DEFAULT 'warn',   -- info | warn | error
  title      TEXT NOT NULL,
  body       TEXT,
  dedupe_key TEXT,
  delivered  INTEGER NOT NULL DEFAULT 0,
  read_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_dedupe ON notifications(dedupe_key, created_at DESC);
ALTER TABLE series ADD COLUMN IF NOT EXISTS premise       TEXT;
ALTER TABLE series ADD COLUMN IF NOT EXISTS cadence_days  REAL;
ALTER TABLE series ADD COLUMN IF NOT EXISTS next_due_at   TIMESTAMPTZ;
ALTER TABLE series ADD COLUMN IF NOT EXISTS auto_generate INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_content_items_niche_series_status ON content_items(niche_id, series_id, status);
CREATE INDEX IF NOT EXISTS idx_content_items_status ON content_items(status, created_at);

CREATE TABLE IF NOT EXISTS content_assets (
  id               TEXT PRIMARY KEY,
  content_item_id  TEXT NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
  channel_id       TEXT NOT NULL REFERENCES channels(id),
  status           TEXT NOT NULL DEFAULT 'PENDING',
  render_url       TEXT,
  published_url    TEXT,
  external_id      TEXT,
  error_message    TEXT,
  retry_count      INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(content_item_id, channel_id)
);
ALTER TABLE content_assets ADD COLUMN IF NOT EXISTS caption        TEXT;
ALTER TABLE content_assets ADD COLUMN IF NOT EXISTS media_asset_id TEXT;
ALTER TABLE content_assets ADD COLUMN IF NOT EXISTS scheduled_for  TIMESTAMPTZ;
ALTER TABLE content_assets ADD COLUMN IF NOT EXISTS published_at   TIMESTAMPTZ;
ALTER TABLE content_assets ADD COLUMN IF NOT EXISTS last_metrics   JSONB;
ALTER TABLE content_assets ADD COLUMN IF NOT EXISTS comment_text   TEXT;   -- the first comment (the source link), as sent
ALTER TABLE content_assets ADD COLUMN IF NOT EXISTS comment_id     TEXT;   -- the platform's id for it; null = not (yet) posted
CREATE INDEX IF NOT EXISTS idx_content_assets_sched ON content_assets(status, scheduled_for);

CREATE TABLE IF NOT EXISTS media_assets (
  id               TEXT PRIMARY KEY,
  content_item_id  TEXT REFERENCES content_items(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL,             -- IMAGE | AUDIO | VIDEO | THUMBNAIL
  url              TEXT NOT NULL,
  mime             TEXT,
  width            INTEGER,
  height           INTEGER,
  duration_seconds REAL,
  storage_path     TEXT,
  meta             JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;  -- set by storage cleanup once the file is removed from R2/Supabase
CREATE INDEX IF NOT EXISTS idx_media_assets_item ON media_assets(content_item_id);

CREATE TABLE IF NOT EXISTS portal_articles (
  id              TEXT PRIMARY KEY,
  content_item_id TEXT REFERENCES content_items(id) ON DELETE SET NULL,
  brand_id        TEXT REFERENCES brands(id),
  slug            TEXT NOT NULL UNIQUE,
  title           TEXT NOT NULL,
  summary         TEXT,
  body_html       TEXT NOT NULL DEFAULT '',
  hero_image_url  TEXT,
  source_url      TEXT,
  language        TEXT NOT NULL DEFAULT 'en',
  country         TEXT,
  status          TEXT NOT NULL DEFAULT 'DRAFT',
  published_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_portal_articles_pub ON portal_articles(status, published_at DESC);

CREATE TABLE IF NOT EXISTS research_notes (
  id              TEXT PRIMARY KEY,
  niche_id        TEXT REFERENCES niches(id) ON DELETE SET NULL,
  content_item_id TEXT REFERENCES content_items(id) ON DELETE SET NULL,
  topic           TEXT NOT NULL,
  notes           JSONB NOT NULL DEFAULT '[]'::jsonb,
  citations       JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS video_candidates (
  id               TEXT PRIMARY KEY,
  source_id        TEXT REFERENCES sources(id) ON DELETE SET NULL,
  source_item_id   TEXT REFERENCES source_items(id) ON DELETE SET NULL,
  niche_id         TEXT REFERENCES niches(id) ON DELETE SET NULL,
  platform         TEXT,
  external_id      TEXT,
  source_url       TEXT NOT NULL,
  title            TEXT NOT NULL,
  duration_seconds REAL,
  view_count       BIGINT,
  published_at     TIMESTAMPTZ,
  thumbnail_url    TEXT,
  license          TEXT NOT NULL DEFAULT 'UNKNOWN',
  score            REAL NOT NULL DEFAULT 0,
  score_reason     TEXT,
  status           TEXT NOT NULL DEFAULT 'NEW',
  local_path       TEXT,
  transcript       JSONB,
  error_message    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE video_candidates ADD COLUMN IF NOT EXISTS source_url TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_video_candidates_status ON video_candidates(status, score DESC);

CREATE TABLE IF NOT EXISTS clips (
  id                 TEXT PRIMARY KEY,
  video_candidate_id TEXT NOT NULL REFERENCES video_candidates(id) ON DELETE CASCADE,
  niche_id           TEXT REFERENCES niches(id) ON DELETE SET NULL,
  content_item_id    TEXT REFERENCES content_items(id) ON DELETE SET NULL,
  start_seconds      REAL NOT NULL,
  end_seconds        REAL NOT NULL,
  title              TEXT,
  hook               TEXT,
  score              REAL NOT NULL DEFAULT 0,
  reason             TEXT,
  transcript_text    TEXT,
  render_url         TEXT,
  status             TEXT NOT NULL DEFAULT 'SELECTED',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS performance_metrics (
  id               TEXT PRIMARY KEY,
  asset_id         TEXT NOT NULL REFERENCES content_assets(id) ON DELETE CASCADE,
  views            INTEGER NOT NULL DEFAULT 0,
  avg_view_percent REAL,
  ctr              REAL,
  likes            INTEGER DEFAULT 0,
  comments         INTEGER DEFAULT 0,
  captured_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_perf_asset_time ON performance_metrics(asset_id, captured_at);
ALTER TABLE performance_metrics ADD COLUMN IF NOT EXISTS shares INTEGER DEFAULT 0;

-- ---------------------------------------------------------------------
-- JOB QUEUE (DB-backed, one lane per queue, claimed with SKIP LOCKED)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS jobs (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'PENDING',
  payload         TEXT NOT NULL DEFAULT '{}',
  result          TEXT,
  error_message   TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  content_item_id TEXT REFERENCES content_items(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ
);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS queue        TEXT NOT NULL DEFAULT 'text';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS priority     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS run_after    TIMESTAMPTZ;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS locked_by    TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS locked_at    TIMESTAMPTZ;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS max_attempts INTEGER NOT NULL DEFAULT 3;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS dedupe_key   TEXT;
CREATE INDEX IF NOT EXISTS idx_jobs_status_type ON jobs(status, type);
CREATE INDEX IF NOT EXISTS idx_jobs_claim ON jobs(queue, status, run_after, priority DESC, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_dedupe ON jobs(dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE OR REPLACE FUNCTION claim_job(p_queue TEXT, p_worker TEXT)
RETURNS SETOF jobs AS $$
  UPDATE jobs
     SET status = 'RUNNING', locked_by = p_worker, locked_at = now(),
         started_at = COALESCE(started_at, now()), attempts = attempts + 1, updated_at = now()
   WHERE id = (
     SELECT id FROM jobs
      WHERE status = 'PENDING' AND queue = p_queue
        AND (run_after IS NULL OR run_after <= now())
      ORDER BY priority DESC, created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED)
  RETURNING *;
$$ LANGUAGE sql SET search_path = public;

-- ---------------------------------------------------------------------
-- CREDENTIALS / USAGE / SETTINGS / ADAPTER INSTANCES
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS api_credentials (
  id             TEXT PRIMARY KEY,
  provider       TEXT NOT NULL,       -- anthropic | gemini | newsapi | elevenlabs | youtube | meta | ...
  label          TEXT NOT NULL,
  env_var        TEXT NOT NULL,       -- name of the env var on Render holding the secret. Never the secret.
  priority       INTEGER NOT NULL DEFAULT 0,
  daily_quota    INTEGER,
  enabled        INTEGER NOT NULL DEFAULT 1,
  cooldown_until TIMESTAMPTZ,
  last_error     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Vault: secret pasted in the dashboard, AES-256-GCM under SECRETS_KEY. env_var may be '' when a vault secret is used.
ALTER TABLE api_credentials ADD COLUMN IF NOT EXISTS secret_enc  TEXT;
ALTER TABLE api_credentials ADD COLUMN IF NOT EXISTS secret_hint TEXT;
ALTER TABLE api_credentials ALTER COLUMN env_var SET DEFAULT '';

CREATE TABLE IF NOT EXISTS api_usage_daily (
  id            TEXT PRIMARY KEY,
  credential_id TEXT NOT NULL,       -- api_credentials.id or 'env:<provider>' for the plain env-var fallback
  provider      TEXT NOT NULL,
  day           DATE NOT NULL DEFAULT CURRENT_DATE,
  units         INTEGER NOT NULL DEFAULT 0,
  cost_usd      REAL NOT NULL DEFAULT 0,
  UNIQUE(credential_id, provider, day)
);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Named adapter instances. Programs/channels/sources reference these by key.
CREATE TABLE IF NOT EXISTS adapter_configs (
  id            TEXT PRIMARY KEY,
  key           TEXT NOT NULL UNIQUE,
  stage         TEXT NOT NULL,   -- TOPIC INGEST DOWNLOAD TRANSCRIBE CLIP SCRIPT IMAGE VOICE RENDER PUBLISH EMBED
  impl          TEXT NOT NULL,   -- code id registered in server.js
  label         TEXT NOT NULL,
  config        JSONB NOT NULL DEFAULT '{}'::jsonb,
  credential_id TEXT,
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- updated_at trigger on every table that has the column
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql SET search_path = public;

DO $$
DECLARE t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY['brands','niches','channels','series','style_profiles','sources',
                               'content_items','content_assets','portal_articles','video_candidates',
                               'jobs','api_credentials','settings','adapter_configs','story_clusters','suggestions']) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_' || t || '_updated_at') THEN
      EXECUTE format('CREATE TRIGGER trg_%I_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- RLS on every table: Supabase's REST API exposes the public schema to the anon and
-- authenticated roles, and with RLS on and no policy they get no rows.
-- The backend connects as the table owner, which bypasses RLS.
-- The public portal's read policies (published articles + media) follow.
-- ---------------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND NOT rowsecurity LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='portal_articles' AND policyname='portal_public_read') THEN
    CREATE POLICY portal_public_read ON portal_articles FOR SELECT USING (status = 'PUBLISHED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='media_assets' AND policyname='media_public_read') THEN
    CREATE POLICY media_public_read ON media_assets FOR SELECT USING (true);
  END IF;
END $$;

-- Supabase Storage bucket "media" (skipped silently on plain Postgres).
DO $$
BEGIN
  INSERT INTO storage.buckets (id, name, public) VALUES ('media', 'media', true) ON CONFLICT (id) DO NOTHING;
EXCEPTION WHEN undefined_table OR insufficient_privilege OR invalid_schema_name THEN NULL;
END $$;

-- ---------------------------------------------------------------------
-- SEEDS (idempotent)
-- ---------------------------------------------------------------------
INSERT INTO settings (key, value) VALUES
  ('queues.enabled', '{"ingest":true,"text":true,"image":true,"video":true,"publish":true,"metrics":true}'::jsonb),
  ('publishing.global_pause', 'false'::jsonb),
  ('budget.daily_cap_usd', '5'::jsonb),
  ('ingest.enabled', 'true'::jsonb),
  ('repurpose.view_threshold', '500'::jsonb)
ON CONFLICT (key) DO NOTHING;

INSERT INTO adapter_configs (id, key, stage, impl, label, config) VALUES
  (gen_random_uuid()::text, 'newsapi_mock',     'TOPIC',      'newsapi_mock',     'Mock tech headlines',            '{}'),
  (gen_random_uuid()::text, 'tmdb_mock',        'TOPIC',      'tmdb_mock',        'Mock movie topics',              '{}'),
  (gen_random_uuid()::text, 'sportmonks_mock',  'TOPIC',      'sportmonks_mock',  'Mock sports topics',             '{}'),
  (gen_random_uuid()::text, 'newsapi_live',     'TOPIC',      'newsapi_topic',    'NewsAPI top headline (live)',    '{"country":"us","category":"technology"}'),
  (gen_random_uuid()::text, 'ingest_mock',      'INGEST',     'ingest_mock',      'Mock feed',                      '{}'),
  (gen_random_uuid()::text, 'rss',              'INGEST',     'rss',              'RSS / Atom feed',                '{}'),
  (gen_random_uuid()::text, 'newsapi',          'INGEST',     'newsapi',          'NewsAPI (dev-only tier)',        '{}'),
  (gen_random_uuid()::text, 'youtube_api',      'INGEST',     'youtube_api',      'YouTube Data API search',        '{}'),
  (gen_random_uuid()::text, 'ytdlp_list',       'INGEST',     'ytdlp_list',       'yt-dlp listing (YouTube/Twitch/FB/any)', '{}'),
  (gen_random_uuid()::text, 'google_news',      'INGEST',     'google_news',      'Google News search / edition (no key)', '{}'),
  (gen_random_uuid()::text, 'youtube_rss',      'INGEST',     'youtube_rss',      'YouTube channel feed (no key)',  '{}'),
  (gen_random_uuid()::text, 'sitemap',          'INGEST',     'sitemap',          'News sitemap',                   '{}'),
  (gen_random_uuid()::text, 'ytdlp',            'DOWNLOAD',   'ytdlp',            'yt-dlp downloader',              '{}'),
  (gen_random_uuid()::text, 'download_mock',    'DOWNLOAD',   'download_mock',    'Mock downloader',                '{}'),
  (gen_random_uuid()::text, 'direct',           'DOWNLOAD',   'direct',           'Direct link / uploaded file',    '{}'),
  (gen_random_uuid()::text, 'transcribe_mock',  'TRANSCRIBE', 'transcribe_mock',  'Mock transcript',                '{}'),
  (gen_random_uuid()::text, 'gemini_transcribe','TRANSCRIBE', 'gemini_transcribe','Gemini audio transcription',     '{}'),
  (gen_random_uuid()::text, 'whisper_local',    'TRANSCRIBE', 'whisper_local',    'Whisper CLI (local, heavy)',     '{}'),
  (gen_random_uuid()::text, 'clip_mock',        'CLIP',       'clip_mock',        'Mock clipper',                   '{}'),
  (gen_random_uuid()::text, 'llm_clipper',      'CLIP',       'llm_clipper',      'LLM reads transcript, picks clips', '{}'),
  (gen_random_uuid()::text, 'llm_mock',         'SCRIPT',     'llm_mock',         'Mock LLM',                       '{}'),
  (gen_random_uuid()::text, 'anthropic_live',   'SCRIPT',     'anthropic',        'Anthropic Claude',               '{}'),
  (gen_random_uuid()::text, 'gemini_live',      'SCRIPT',     'gemini',           'Google Gemini',                  '{}'),
  (gen_random_uuid()::text, 'openai_live',      'SCRIPT',     'openai',           'OpenAI GPT',                     '{}'),
  (gen_random_uuid()::text, 'whisper_api',      'TRANSCRIBE', 'whisper_api',      'OpenAI Whisper API',             '{}'),
  (gen_random_uuid()::text, 'openai_image',     'IMAGE',      'openai_image',     'OpenAI image generation',        '{}'),
  (gen_random_uuid()::text, 'openai_tts',       'VOICE',      'openai_tts',       'OpenAI TTS',                     '{}'),
  (gen_random_uuid()::text, 'image_mock',       'IMAGE',      'image_mock',       'Mock image (SVG card)',          '{}'),
  (gen_random_uuid()::text, 'gemini_image',     'IMAGE',      'gemini_image',     'Gemini image generation',        '{}'),
  (gen_random_uuid()::text, 'pexels_stock',     'IMAGE',      'pexels_stock',     'Stock photo (Pexels)',           '{}'),
  (gen_random_uuid()::text, 'tts_mock',         'VOICE',      'tts_mock',         'Mock TTS (silent audio)',        '{}'),
  (gen_random_uuid()::text, 'elevenlabs',       'VOICE',      'elevenlabs',       'ElevenLabs TTS',                 '{}'),
  (gen_random_uuid()::text, 'gemini_tts',       'VOICE',      'gemini_tts',       'Gemini TTS (Bangla + English)',  '{}'),
  (gen_random_uuid()::text, 'render_mock',      'RENDER',     'render_mock',      'Mock renderer',                  '{}'),
  (gen_random_uuid()::text, 'ffmpeg',           'RENDER',     'ffmpeg',           'ffmpeg renderer',                '{}'),
  (gen_random_uuid()::text, 'remotion',         'RENDER',     'remotion',         'Studio (Remotion) + ffmpeg',     '{}'),
  (gen_random_uuid()::text, 'publish_mock',     'PUBLISH',    'publish_mock',     'Mock publisher',                 '{}'),
  (gen_random_uuid()::text, 'meta_graph',       'PUBLISH',    'meta_graph',       'Facebook Page + Instagram (Graph API)', '{}'),
  (gen_random_uuid()::text, 'youtube_upload',   'PUBLISH',    'youtube_upload',   'YouTube Data API upload',        '{}'),
  (gen_random_uuid()::text, 'embed_mock',       'EMBED',      'embed_mock',       'No embeddings (Jaccard fallback)', '{}'),
  (gen_random_uuid()::text, 'gemini_embed',     'EMBED',      'gemini_embed',     'Gemini embeddings',              '{}')
ON CONFLICT (key) DO NOTHING;

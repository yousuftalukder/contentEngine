# Content Engine

An automated newsroom and content studio. It watches Bangladeshi news outlets and TV channels, groups the same story across
outlets, writes it in each brand's house style, checks it against its sources, turns it into photocards, reels, explainers
and reaction videos, and publishes on a schedule to Facebook, Instagram, YouTube and a news portal — then learns from what
performed. You create brands and programs; the engine does the rest and alerts you when something needs a person.

```
 sources ─► news desk ─► writer ─► quality gate ─► review / auto ─► schedule ─► publish ─► metrics ─► planner
 (RSS, Google News,  (one story,   (house style,  (facts vs sources,               (per channel                  (ideas, series,
  TV channels)        many outlets) Bangla/English) safety, language)              windows, gaps)                 style learning)
                                     │
                                     ├─ photocard (brand kit)            ├─ news reel (studio)        ├─ animated explainer (studio)
                                     └─ reuse clip / voice-over reel     └─ long-form reaction video
```

## What it does

**Sources, no keys needed.** A built-in catalog verified live, for two audiences. **United States**: CBS Sports and Yahoo Sports direct, ESPN, Bleacher Report and Sports Illustrated through Google News (their feeds refuse datacenter IPs), Variety, Deadline, The Hollywood Reporter, Billboard and Rolling Stone for entertainment, The Verge and TechCrunch for technology, NPR and ABC News for general. A program says which desk it is about (`method_config.topics`) and takes only that one. **Bangladesh**: outlet RSS feeds (Prothom Alo, The
Daily Star, Dhaka Tribune, TBS, BBC Bangla, Bangla Tribune, Dhaka Post, DW Bangla, Risingbd), outlets reached through Google
News where their own feeds are blocked (bdnews24, Kaler Kantho, Samakal, Jugantor, Ittefaq, Jagonews24, Kalbela, Bangladesh
Pratidin, Financial Express, New Age, UNB, BSS), and the YouTube feeds of ten TV news channels (Somoy, Jamuna, Channel 24,
Ekattor, Independent, ATN, NTV, Channel i, DBC, Rtv). A new Bangladesh program is linked to the sources for its language
automatically. RSS, Atom, Google News searches, news sitemaps, YouTube channels and yt-dlp listings can be added by hand.

**News desk.** Articles are grouped into stories across outlets and languages (Gemini embeddings, word overlap as fallback).
Each program gets its best uncovered stories, ranked by how many outlets carry them, their weight and freshness, and the
writer receives every outlet's version — one story, written once, from several sources. Per-program pacing: outlets required,
settle time, story age, stories per pass, minutes between stories.

**Writing and accuracy.** Gemini by default (Anthropic, OpenAI as alternatives or backups), with fallback models and retries
that match the failure (rate limit and overload back off; bad requests fail fast). Every draft passes the **quality gate**:
claims not in the sources, an overstated headline, defamation, incitement, graphic detail, minors, and language are checked;
automatic programs publish only clean drafts, a flagged draft is revised once and rechecked, anything else waits in Review
with the report.

**House style.** Written by the LLM for each brand and program (optionally from sample posts), then refined from reviewers'
edits, rejection notes and the best-performing posts, with history.

**Formats.**
- *Photocard* — the standard Bangladeshi news post: picture, brand-colour panel with the headline, logo, Bangla date, source
  credit. Bangla is shaped correctly (libass with complex shaping).
- *News reel* (`NEWS_REEL`) — a story as a 35-60 s vertical video: narrated section by section (Gemini TTS speaks Bangla),
  one illustration per section with Ken Burns, headline strip, karaoke captions, brand outro. Rendered by the **studio**
  (Remotion). `IMAGE_SLIDESHOW` and `LONG_FORM_VIDEO` use the same path.
- *Animated explainer* (`ANIMATED_EXPLAINER`) — the animation blueprint: grounded research, a scene plan in six layouts
  (TitleCard, BulletReveal, IconGrid, Comparison, DataChart, FullQuote), narration per scene driving the animation, subtitles,
  chapters and a YouTube thumbnail.
- *Clips from video* (`PODCAST_CLIP`, `VOICEOVER_CLIP`, `REACTION_CLIP`, `MOVIE_RECAP`) — download, transcribe, pick moments,
  cut vertical reels (crop or blur-pad that keeps TV chyrons), captions, voice-overs in the channel's own words over ducked
  original sound, and **long-form reactions** (`REACTION_LONG`): the source plays in segments with a reactor picture-in-picture,
  pausing for commentary (at least ~30%), with chapters. Every footage video gets the brand logo and -14 LUFS loudness.
- *Long post* and *news article* for the portal, with research notes.

**Planner and series.** Daily, per program: ideas from performance by format, platform and hour, the best and weakest posts,
series history and trending stories not yet covered. Accept an idea and it is written; programs on autopilot accept their
best ideas themselves. Series keep a premise and get their next episode on a cadence, written with earlier episodes as context.

**Publishing.** Facebook Pages (photo, video, text), Instagram (image, Reels), YouTube (Shorts, long videos with thumbnail and
chapters), and the built-in portal. Per-channel posting windows, minimum gaps and daily limits.

**Alerts.** An AI account out of credit, a rejected key, an expired publishing token, a failing source, the budget cap, a
stalled pipeline, a growing review queue — on the dashboard and on Telegram, plus a 21:00 daily digest.

**When a provider says no.** Quotas are handled as waiting, not failing. A per-model limit falls through to the next model
(quotas count per model, so the fallback list multiplies what a free key can do); a per-minute limit waits the delay the API
names; a daily one parks the job until the reset — without spending a retry — and the program stops taking new stories until
then, so the queue can't fill with work that cannot run. News that would be stale by the reset is dropped rather than posted
late, and one alert says what to do. If no picture can be generated (no image key, a plan with no image quota), the engine falls back to a **stock photo**
(Pexels, free key) — and the writer withholds the search phrase when a generic photo could mislead, for a specific
incident, a named person, or a claim a reader would take the photo as evidence for. Every stock photo is marked
illustrative and credits the photographer. With no photo either, the post
still goes out as a **text card**: the brand's colours, logo, label, headline, date and source credit, redrawn if the
headline is edited. A free Gemini key allows roughly 20 requests a day per model and no pictures — enable billing on it for
the engine to run at full speed.

## Run it locally

```bash
npm install
cp .env.example .env        # set DATABASE_URL at least; everything else can run on mock adapters
node --env-file=.env server.js
```

Open http://localhost:4000. With no provider keys the engine runs on mock adapters end to end. ffmpeg (with libass) is needed
for photocards and video; the studio needs `npm install` in `studio/` (it downloads Chrome Headless Shell on first render).

```bash
npm test                    # boots the real server against an in-process Postgres (PGlite) and drives every pipeline
npm run rehearse            # a full cycle against today's live Bangladeshi feeds, no keys, publishing nowhere real
cd studio && npm run studio # Remotion Studio: preview and tweak the reel and explainer designs
```

`npm run rehearse` is how to tell whether the outlets are still serving their feeds and whether stories from different
outlets still land in one cluster — the things a test suite cannot answer. It prints what each source returned, the
clusters with the outlets behind them, and the draft the desk chose to write.

## Deploy on Render

`render.yaml` is a Render Blueprint: a **web service** (dashboard, API, ingest/text/image/publish/metrics lanes, all sweeps) and
a **background worker** (the video lane: downloads, ffmpeg and the studio). Both use the Dockerfile, which installs ffmpeg,
yt-dlp, Bangla fonts, the studio and headless Chrome, and pre-builds the studio bundle. The schema migrates itself at boot.

- The free web plan sleeps after 15 minutes without visitors and then stops polling and publishing: use **Starter** or above.
- The worker needs **Standard** (2 GB) for 1080p video and the studio.
- The two services don't share a disk: set **Supabase Storage** (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`; the `media`
  bucket is created automatically) or R2.
- Point an uptime monitor at `/health`: the engine can alert on everything except being down.

## Environment

| Variable | Needed | What for |
|---|---|---|
| `DATABASE_URL` | yes | Supabase → Connect → Session pooler (port 5432) |
| `DASHBOARD_PASSWORD` | yes | protects the dashboard and API (user `DASHBOARD_USERNAME`, default `admin`) |
| `SECRETS_KEY` | yes | encrypts keys pasted on the API keys page (`openssl rand -hex 32`); never change it |
| `PUBLIC_BASE_URL` | yes | the web service's URL (portal links) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | yes (split deploy) | media storage in the `media` bucket |
| `GEMINI_API_KEY` | yes | writing, images, embeddings, Bangla TTS, transcription (or add it on the API keys page) |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | recommended | alerts and the daily digest |
| `PEXELS_API_KEY` | recommended | free stock photos when a picture cannot be generated (otherwise posts are text cards) |
| `META_ACCESS_TOKEN` | to publish | Facebook Page / Instagram (or per-channel keys in the dashboard) |
| `YOUTUBE_CLIENT_ID`, `_SECRET`, `_REFRESH_TOKEN` | to publish | YouTube uploads (or per-channel keys) |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY` | optional | alternative or backup writers and voices |
| `R2_*` | optional | Cloudflare R2 instead of Supabase Storage |

Everything else — model names, voices, lanes, retries, fonts — has defaults; see `.env.example`.

## How it's built

- `server.js` — the whole backend in one file, in numbered sections (search for `// ===`): config, database, keys and vault,
  storage, adapter registry and implementations (LLM, ingest, download, transcribe, clip, image, voice, embeddings, render,
  studio, publish), news desk and catalog, orchestrator per content type, quality gate, house style, planner and series, job
  lanes with retries, alerts, HTTP API.
- `schema.sql` — one idempotent schema, applied at every boot; row-level security on every table (the server connects as the
  owner; Supabase's public API sees nothing).
- `studio/` — Remotion compositions (NewsReel, Explainer) rendered by `studio/render.mjs` in a child process.
- `frontend/` — the dashboard (vanilla JS).
- `test/` — end-to-end tests on PGlite; CI runs them on every pull request.

Adapters are swappable per program (Adapters page): every stage has named instances, mocks for running without keys, and
fallback lists.

## Notes

- **Remotion licence:** free for individuals and companies with up to three employees; larger companies need a Remotion
  company licence.
- **Reusing video:** TV footage is copyrighted. Voice-overs and long-form reactions add original commentary, but platforms and
  rights holders decide what is fair; the `license_policy` of a source can restrict it to Creative Commons or your own material.
- **News pictures** default to clearly-illustrated images rather than photo-realistic scenes of real events.

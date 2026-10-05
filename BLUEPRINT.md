# Content Engine — the blueprint

What this system is for, every kind of thing it makes, and where each piece of the work happens. Agreed
2026-09-21. This is the document to argue with before writing code; the code follows it, not the other way round.

## The shape of it

The engine is the outer loop and it does not make videos. It finds or receives sources, keeps a queue, stores
what comes back, shows it for review, and publishes it. The *middle* — turning a source into a finished piece —
is a swappable adapter, and which adapter runs is a per-programme choice.

| stage | what happens | where |
|---|---|---|
| Source | feeds for news; pasted links for video; uploads | engine |
| Queue | one lane per stage, retries, fallback chains | engine |
| **Production** | **the adapter for that content type** | **server, your PC, or a rented API** |
| Library | every output stored, a review item created | engine |
| Review | play it, fix the caption, approve or reject | dashboard |
| Publish | Facebook + Instagram (source link as first comment), YouTube | engine |

Three places the work can happen, and the difference matters:

- **Server** — free Render instance, 512 MB, a tenth of a CPU, always on. Good for text, cards, light renders,
  publishing. Slow at video. YouTube refuses it (datacenter IP).
- **Your PC** — fast, free, unlimited, and **YouTube works**. Available a few hours a day. Jobs queue and wait
  when it is off; the dashboard says so.
- **Rented** — an API that does the expensive middle. Costs money, always available. **Optional everywhere:** every
  variant has a free route, and a rented one only switches on when its key is added (agreed 2026-10-04: no billing).

**Each step runs where it can (2026-10-05).** The server holds the AI keys and the free voice; the PC has YouTube, the
studio and your footage, but usually no key. So a job is split at the step that needs the other machine, never failed:

| step | where | how it crosses |
|---|---|---|
| fetch a YouTube video, transcribe English, cut and render clips | PC | — |
| choose the moments (LLM picker) | server, if the PC has no writer | `PICK_CLIPS` with the PC's transcript and soundtrack signals |
| transcribe Bangla (local whisper cannot) | server (Gemini) | the PC uploads a 16 kHz copy of the audio |
| any other writing on the PC (captions, recap and reaction scripts, 7a scripts) | server | `LLM_RELAY`: the request goes as a job, the answer comes back |
| write an explainer (research, plan, pictures, narration) | server | the plan is stored on the item |
| render an explainer (Remotion) | PC | `STUDIO_RENDER` with the stored plan |

The free allowance is protected for the work that matters: a hand-reviewed programme stops drafting at 30 waiting
(news wrote 222 unread drafts a day and spent it all), and a clip waits for the LLM picker's reset rather than being cut
by the weaker heuristic.

---

## 1 — Clip / trimmed reel

Long video in, the moment that matters out. The main product.

| # | variant | input | production | runs | writer | voice | cost |
|---|---|---|---|---|---|---|---|
| 1a | Laptop clip | your link | whisper → `clip_meaning` → cut that section only → 9:16 + captions | **your PC** | — | — | **free** |
| 1b | Rented clip | your link | service transcribes, scores moments, cuts, captions | server → API | — | — | per minute |
| 1c | Claude-picked | your link | whisper → an LLM reads the transcript and chooses → cut → render | your PC | picker only | — | pennies |
| 1d | Server clip | non-YouTube link | as 1a, on the server at 720p | server | — | — | free |

1a is primary; 1b covers the hours your PC is off. No script and no hook are written for a trimmed clip — the
speaker wrote them. The "hook" is *where the cut starts*, which is what the picker scores.

## 2 — News card *(live today)*

| # | variant | input | production | runs | writer | voice |
|---|---|---|---|---|---|---|
| 2a | Photo card | engine feeds | cluster → headline + caption → the outlet's own photo, branded | server | yes | — |
| 2b | Text card | feeds, no photo | same, typographic card | server | yes | — |
| 2c | Stock card | feeds, no photo | same, Pexels image | server | yes | — |

## 3 — News reel

| # | variant | input | production | runs | writer | voice |
|---|---|---|---|---|---|---|
| 3a | Photo reel | feeds | story photos → narration → burned captions | server | yes | yes |
| 3b | Telecast clip | telecast link | **identical to 1a/1b** — nothing written, nothing narrated | PC / rented | — | — |
| 3c | Telecast + intro | telecast link | 3b with a narrated headline card in front | PC | yes | yes |

## 4 — Reaction

| # | variant | input | production | runs | writer | voice |
|---|---|---|---|---|---|---|
| 4a | Silent reaction | link + reactor clip | clip → keep the original audio, ~1.1× → persona picture-in-picture | PC | — | — |
| 4b | Summary voiceover | link + reactor | 4a plus two or three sentences of summary under ducked audio | PC | yes | yes |
| 4c | Long-form | full video + reactor | a plan of play/comment beats → segments with commentary between | PC only | yes | yes |

The persona overlay is in-house only. No clipping service puts *your* face on *their* cut.

## 5 — Recap

A long video becomes a shorter video that tells its story, cut from its own footage.

| # | variant | input | production | runs | writer | voice |
|---|---|---|---|---|---|---|
| 5a | Scene recap | long video | **Gemini watches the video** → timestamped scenes → script → cut those ranges → narrate, source audio ducked | PC | yes (video tokens — the cost) | yes |
| 5b | Transcript recap | dialogue-led video | transcript → script → cut by timestamp → narrate | PC | yes | yes |
| 5c | Twelve Labs | long video | purpose-built moment retrieval, same assembly | PC + API | yes | yes |

5b is much cheaper; 5a is better where the story is visual. Copyright exposure is highest here of anything in
this document.

## 6 — Animation *(Remotion, on your PC)*

| # | variant | input | production | runs | writer | voice |
|---|---|---|---|---|---|---|
| 6a | Explainer | topic | script → motion graphics, type, transitions | **PC** | yes | yes |
| 6b | Data / research | data + topic | animated charts and diagrams | PC | yes | yes |
| 6c | Illustrated series | script + characters | AI character images composited and moved in code | PC | yes | yes |
| 6d | Blender 3D | scene files | CPU render, hours, hand-authored | PC | — | yes |

On an i3 with Intel UHD graphics, 6a–6c render a minute of 1080p in roughly two to eight minutes. 6d is honest
but impractical: the render is slow and, more to the point, nothing automates *authoring* a 3D scene well.

## 7 — Script → video

| # | variant | input | production | runs | writer | voice |
|---|---|---|---|---|---|---|
| 7a | Own footage | topic | script → your local footage library matched per sentence → narrate | **PC** | yes | yes |
| 7b | Stock footage | topic | same, drawing on Pexels | PC / server | yes | yes |
| 7c | Photo sequence | topic | stills with motion, narrated *(exists today)* | server | yes | yes |

7a is the one that does not look like everyone else's: commercial script-to-video tools all draw from the same
stock pool, and a library of your own footage is the difference.

---

## What each variant needs

| need | variants |
|---|---|
| nothing — free, no key | 1a, 1d, 3b, 4a |
| a writer key — any free one: Gemini, Groq, Mistral, Cerebras, OpenRouter's free models, or Grok | 1c, 2a–c, 3a, 3c, 4b, 4c, 5a–c, 6a–c, 7a–c |
| a voice (edge-tts, free) | 3a, 3c, 4b, 4c, 5a–c, 6a–d, 7a–c |
| a clipping subscription *(optional, the only paid item)* | 1b only |
| your PC switched on | 1a, 1c, 4a–c, 5a–c, 6a–d, 7a |
| a persona from you | 4a–c |
| Gemini video input (free tier) | 5a |
| a Twelve Labs key *(optional)* | 5c |
| your footage folder | 7a |

## Adapters

| stage | already built | to build |
|---|---|---|
| Source | rss, google_news, ytdlp, direct, uploads | — |
| Transcribe | whisper.cpp (English), gemini_transcribe | — |
| Clip | clip_meaning, clip_signal, llm_clipper, vizard (rented, optional) | — |
| Video understanding | gemini_video (scenes: what is seen and said, free tier), twelve_labs (optional) | — |
| Script | gemini_live, anthropic_live, openai_live, and the free writers groq_live, mistral_live, cerebras_live, openrouter_live, grok_live — one chain, each taking over when the one before has spent its allowance | — |
| Image | gemini_image, openai_image, pexels_stock, source_photo, pollinations (free, no key) | — |
| Footage | Pexels (country-filtered), your own folder (7a) | — |
| Voice | tts_edge (free; bn-BD verified), tts_piper (English), tts_command | — |
| Render | ffmpeg, remotion | — |
| Publish | meta_graph (FB/IG + first comment), youtube_upload | — |

## Measured, so nobody re-derives it

- Laptop, link to finished reel: **6 minutes**. whisper base on 18 minutes of audio: **136 s**.
- The same job on the free server with the tiny model: over **50 minutes**, unfinished.
- **YouTube refuses the server** ("Sign in to confirm you're not a bot") and serves your PC without complaint.
- **Local whisper cannot do Bangla.** A clean Bangla sentence came back in Urdu script from `base`; `tiny`
  produced nothing. Bangla speech needs hosted ASR. Re-checked 2026-10-04 with `large-v3-turbo` (q5, 550 MB) on a
  75-second Jamuna TV report: Bengali script and the first sentence right, then repetition loops ("পারে পারে পারে…"),
  one segment per 30 s, and 200 s to transcribe 75 s on the PC (beam search and no-context changed nothing; 10-second
  chunks stopped the loops but came back mostly empty and took 527 s). Still hosted ASR.
- **edge-tts speaks Bangladeshi Bangla, free, no key** — `bn-BD-NabanitaNeural`, `bn-BD-PradeepNeural`.
- Remotion renders on this laptop. The 512 MB server cannot run it at all (Chromium needs ~2 GB).
- Free-server video renders must be 720p. At 1080p the process is killed with no error recorded.
- **The server runs ffmpeg 5.1, the PC 6.1.** Two filter graphs that worked on the PC failed only on the server: a
  stack of a 30 fps and a 24 fps picture never finished, and the brand pass (logo + loudness) was refused on every
  video. Any new filter graph is checked on 5.1 before it ships.
- **Several outlets refuse the server's address** as YouTube does: Ittefaq, Desh Rupantor, Bangla Tribune and Dhaka
  Tribune article pages fail from Render every time and open from the PC. Their full-size photos are recovered from
  the feed thumbnail's address; their article text is not.
- **Stock footage is American unless told otherwise.** "government inspection" put a US flag in a Bangladesh reel;
  clips are now taken only when Pexels' own description names the programme's country.
- Split-screen reaction on the free server, 21 s at 720p: **about 4–5 minutes** once both fixes above were in.

## Clipping services, checked 2026-10-04 *(1b)*

From the providers' own documentation; nothing bought or called yet.

| service | API access | price | YouTube links | Bangla | notes |
|---|---|---|---|---|---|
| Vizard | Creator plan and up, no sales call | ~$14.50/month (annual), 600 upload minutes; 3 requests/min, 20/hour | yes — it fetches them itself | **no** (37 languages) | `POST …/open-api/v1/project/create` (header `VIZARDAI_API_KEY`, `videoType` 2 = YouTube, `preferLength`, `ratioOfClip`, `maxClipNumber`), poll `GET …/project/query/{id}`. Docs do not say whether clip start/end in the source are returned — decides whether we can re-render in our own style |
| Klap | public, usage-based | $0.44 per video in + $0.32 per short + $0.48 per export ≈ **$2.84 for three clips** | — | — | `https://api.klap.app/v2` `/tasks`, `/projects`, `/exports`; endpoint detail not public |
| OpusClip | Business / enterprise only | sales | — | — | not self-serve |
| Submagic | Business+API tier | $69/month, 100 min, then $0.10–0.15/min | — | — | |

Vizard is the fit for 1b: a flat monthly price, and it fetches YouTube itself, which is exactly the gap when the PC
is off. Its first test before building: one video through the API, to see whether the clip times come back.

## Still to verify before its own build

- Gemini video input on a long file *(5a)*: built as 360p, one-frame-a-second proxies read at low media resolution
  (about 100 tokens a second), forty minutes per request; a longer video goes in pieces. Not yet run on a real film.
- Pollinations, the free picture service *(6c)*, measured 2026-10-04: about 4 s a picture; without a token it turns
  away many requests with an empty 402 (every other one when quiet, six in a row when busy) and serves a later one, so
  the engine asks again for up to two minutes; it caps pictures at about 768 px and puts a small logo in a corner.
- An illustrated scene rendered end to end on the PC (Pollinations → cut-out → studio, edge-tts voice): 16 s of 1080p in
  about 6 minutes. The character is cut out of its background cleanly, white clothes kept; the pale disc the model tends
  to draw behind a character stays (removing it by colour leaked into the figure), and two drawings of the same
  character from the same description and seed look alike but not identical.

## Built, not yet proven on real material (2026-10-04)

5c (Twelve Labs, optional), 6b (data explainer), 6c (illustrated series), 7a (own footage) and 1b
(Vizard, optional) — each passes its tests against stand-ins for the services, and none has yet been made from real
material in production. 6d (Blender) stays unbuilt, for the reason given under 6.

## Proven working

**5a, 2026-10-05:** a scene recap made by the server from *Duck and Cover* (1951, archive.org): Gemini's free tier
watched a 360p, one-frame-a-second proxy, the recap script narrates what is on screen (the turtle, the dynamite, the
classroom drill) and each cut matches its line, over the film's own sound. 55 s, 720×1280.

1a, 1d, 2a–c, 7c, 6a, edge-tts voice, and the whole of 2 live in production. 3a (Bangla news reel on edge-tts,
the outlet's own photo, local footage) and 4a (split-screen and picture-in-picture, rendered by the server from a
real speech, with a stock stand-in for the host until there is a real persona clip) since 2026-10-04. Also proven on
2026-10-04, made by the server: 1c (the LLM picker — first place for the famous line in 9 of 14 speeches, against 4
for the free heuristic), 3b (an English TV report clipped on the PC), 4b (summary voice-over), 5b (transcript recap)
7b (a Bangla explainer on Bangladesh-only stock footage) and 4c (a three-minute long-form reaction: five segments, seven
commentary breaks, a stand-in host) and 3c (a Bangla narrated headline card, built today, in front of an English
report).

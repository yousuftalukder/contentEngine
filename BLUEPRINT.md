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
- **Rented** — an API that does the expensive middle. Costs money, always available.

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
| a writer key | 1c, 2a–c, 3a, 3c, 4b, 4c, 5a–c, 6a–c, 7a–c |
| a voice (edge-tts, free) | 3a, 3c, 4b, 4c, 5a–c, 6a–d, 7a–c |
| a clipping subscription | 1b only |
| your PC switched on | 1a, 1c, 4a–c, 5a–c, 6a–d, 7a |
| a persona from you | 4a–c |
| Gemini video input | 5a |

## Adapters

| stage | already built | to build |
|---|---|---|
| Source | rss, google_news, ytdlp, direct, uploads | — |
| Transcribe | whisper.cpp (English), gemini_transcribe | — |
| Clip | clip_meaning, clip_signal, llm_clipper | **clip_service** (rented) |
| Video understanding | — | **gemini_video** (scenes for 5a) |
| Script | gemini_live, anthropic_live (Claude) | — |
| Voice | tts_piper (English), tts_command | **tts_edge** (free; bn-BD verified) |
| Render | ffmpeg, remotion | — |
| Publish | meta_graph (FB/IG + first comment), youtube_upload | — |

## Measured, so nobody re-derives it

- Laptop, link to finished reel: **6 minutes**. whisper base on 18 minutes of audio: **136 s**.
- The same job on the free server with the tiny model: over **50 minutes**, unfinished.
- **YouTube refuses the server** ("Sign in to confirm you're not a bot") and serves your PC without complaint.
- **Local whisper cannot do Bangla.** A clean Bangla sentence came back in Urdu script from `base`; `tiny`
  produced nothing. Bangla speech needs hosted ASR.
- **edge-tts speaks Bangladeshi Bangla, free, no key** — `bn-BD-NabanitaNeural`, `bn-BD-PradeepNeural`.
- Remotion renders on this laptop. The 512 MB server cannot run it at all (Chromium needs ~2 GB).
- Free-server video renders must be 720p. At 1080p the process is killed with no error recorded.

## Still to verify before its own build

- The clipping service API: shape, polling, price *(1b)*.
- Gemini video input on a long file: chunking and cost *(5a)*.
- The persona overlay on real footage — it passes tests, it has never run on a real video *(4a)*.

## Proven working

1a, 1d, 2a–c, 7c, 6a, edge-tts voice, and the whole of 2 live in production.

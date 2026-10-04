# Running the Content Engine — the owner's guide

What you do day to day, and what each thing you can add unlocks. For how it is built, see README.md; for what it makes,
see BLUEPRINT.md and the dashboard's **What it makes** page.

## The three places work happens

| | what it does | always on? |
|---|---|---|
| **The server** (Render) | reads the news, writes cards and reels, makes light videos, publishes | yes |
| **Your PC** (the worker) | anything from YouTube (Render is blocked there), heavy video, animated explainers | only while it runs |
| **The dashboard** | where you review, approve and set things up | — |

A programme set to **"Video work runs on: My PC"** waits for your PC. Nothing is lost while it is off; the dashboard
shows the PC as off and the work as waiting.

## Every day

1. Open **Review**. Everything waits there for you: approve, fix the caption, or reject with a reason (the reason
   teaches the next draft).
2. Two notes you may see on a draft:
   - **"Written from headlines only"** — none of the outlets' articles could be read (Ittefaq, Desh Rupantor, Bangla
     Tribune and Dhaka Tribune block servers). Check every fact against the source before approving. These drafts are
     never published automatically.
   - **"Caption not written — the writer refused"** — the AI was out of its free allowance; the clip's own words stand
     in. Rewrite the caption before posting.
3. **Overview** shows alerts (a key out of credit, a feed failing) and whether the AI allowance is waiting to reset.
4. News you have not reviewed within **24 hours** is set aside as "Expired unreviewed" — day-old news is not worth
   publishing, and it buried the fresh stories (2,400 day-old drafts had piled up). Change the window, or turn it off
   with 0, in **Settings → review.news_expiry_hours**. Clips and other videos never expire.

**Nothing is published yet.** The one channel, `fb_main`, uses the mock publisher — "published" there means nowhere.
Connect your real Page under **Channels → Connect Facebook** (it lists the Pages your login manages and stores each
Page's token encrypted), attach it to your programmes, and approved posts go out with the source link as the first
comment.

## Making clips from a long video

1. **Video candidates → paste the link**, pick the clips programme (`yt_clips` runs on your PC; YouTube links need it).
2. The engine transcribes it, an AI reads the transcript and picks the moments (on fourteen famous speeches it put the
   line anyone would clip first in nine), cuts each to a captioned vertical reel, adds the logo and levels the sound.
3. The clips land in **Review**.

Reaction videos, voice-overs, recaps and "telecast with intro" are the same flow with a different
**Production method** on the programme (Programs → Edit → Video).

## The PC worker

- **Start:** `powershell -ExecutionPolicy Bypass -File pc\start.ps1` (a window opens; minimise it).
- **Stop:** close that window. Running jobs go back to the queue.
- **Start it at every sign-in:** `powershell -ExecutionPolicy Bypass -File pc\autostart.ps1` (undo with `-Remove`).
- First time on a new PC: `pc\setup.ps1`, then fill in `.env.pc` from Render's Environment tab.

## What adding each thing unlocks

| you add | where | unlocks |
|---|---|---|
| your **Facebook Page** | dashboard → **Channels → Connect Facebook** | real publishing (today the channel is a mock) |
| your **Gemini key** in the vault | dashboard → **API keys** (paste it there, not only on Render) | the AI picker and writer on your PC; animated explainers (6a, 6b) end to end |
| **Gemini billing** | Google AI Studio → Billing | no more daily allowance stops; scene recap (5a); illustrated series (6c, needs image generation); Bangla speech transcription for TV clips |
| a **reactor clip** of yourself | dashboard → Brands → Media library (purpose: reactor) | reaction videos you can publish (4a, 4c — proven with a stand-in) |
| a **Vizard** subscription (~$14.50/month) | vizard.ai, then its key on API keys | clipping while your PC is off (1b) |
| a **Twelve Labs** key | API keys | the Twelve Labs recap (5c) |
| a folder of **your own footage** | tell me where | script-to-video on your footage (7a) |

## Test programmes left from the proofs

Made on 2026-10-04 to prove variants on the real server, all under the demo brand, none publishing anywhere:
`reaction_test`, `voiceover_test`, `recap_test`, `reaction_long_test`, `telecast_intro_test`, `stockvideo_test`
(inactive), `eval_llm_picker` (inactive, the selection evaluation). Deactivate or delete them from **Programs** when
you no longer want them; keep `eval_llm_picker` if the selection evaluation should be re-run.

## Security housekeeping

Secrets pasted into chat should be rotated: the Supabase service-role key first, then the database password, then
`SECRETS_KEY` (rotating that one means re-entering keys stored in the dashboard vault).

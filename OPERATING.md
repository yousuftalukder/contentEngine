# Running the Content Engine — the owner's guide

What you do day to day, and what each thing you can add unlocks. For how it is built, see README.md; for what it makes,
see BLUEPRINT.md and the dashboard's **What it makes** page.

## The three places work happens

| | what it does | always on? |
|---|---|---|
| **The server** (Render) | reads the news, writes cards and reels, makes light videos, publishes | yes |
| **Your PC** (the worker) | anything from YouTube (Render is blocked there), heavy video, rendering animations (the server writes them) | only while it runs |
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
   - **"Caption not written — the writer refused"** — the AI was out of its free allowance when this video was
     finished; the clip's own words stand in. Rewrite the caption before posting. (Rare now: a clip's caption is
     written when its moment is chosen, and your PC borrows the server's writer.)
3. **Overview** shows alerts (a key out of credit, a feed failing) and whether the AI allowance is waiting to reset.
4. News you have not reviewed within **24 hours** is set aside as "Expired unreviewed" — day-old news is not worth
   publishing, and it buried the fresh stories (2,400 day-old drafts had piled up). Change the window, or turn it off
   with 0, in **Settings → review.news_expiry_hours**. Clips and other videos never expire.
5. A programme you review by hand stops drafting while **30** of its drafts are already waiting for you, and starts
   again as you review them (or they expire). Drafting faster than anyone reads spent the whole free Gemini allowance
   on news nobody saw — 222 drafts in one day — and left the clips without the AI that picks their best moments.
   Change it in **Settings → review.max_waiting** (0 = never stop), or per programme under Automation.

**Pausing news.** *Pause news* on the Overview (or the News desk page) stops all drafting from the news feeds in one
click; the feeds are still read, so *Resume news* starts on today's stories. Each news programme also has its own
pause / resume beside it.

**Nothing is published yet.** The one channel, `fb_main`, uses the mock publisher — "published" there means nowhere.
Connect your real Page under **Channels → Connect Facebook** (it lists the Pages your login manages and stores each
Page's token encrypted), attach it to your programmes, and approved posts go out with the source link as the first
comment.

## Making clips from a long video

1. **Videos to clip → paste the link**, pick the clips programme (`yt_clips` runs on your PC; YouTube links need it).
2. The engine transcribes it (on your PC for YouTube links), an AI reads the transcript and picks the moments (on
   fourteen famous speeches it put the line anyone would clip first in nine), cuts each to a captioned vertical reel,
   adds the logo and levels the sound. If your PC has no AI key of its own, the server does the picking from your
   PC's transcript and hands the clips back to the PC to cut.
   Bangla speech is never given to the PC's local transcriber (it cannot hear Bangla): it goes to Gemini — on the
   server, from the PC's soundtrack, when the PC has no key.
3. The clips land in **Review**, each with the caption the AI wrote when it chose the moment. A trimmed clip under
   hand review skips the automated quality check (you are the check); a clips programme that publishes by itself
   keeps it. A video costs about one AI request, not seven to thirteen as it did.
4. When the AI that picks the moments has used up today's free allowance, the video **waits** for the reset (midnight
   Pacific) rather than being cut by the weaker free picker. If you would rather have clips sooner, set the programme's
   *When the AI picker is out of allowance* to *Use the free picker now* (Programmes → Edit → Video).

Reaction videos, voice-overs, recaps and "telecast with intro" are the same flow with a different
**Production method** on the programme (Programmes → Edit → Video).

## Starting a new kind of programme

**What it makes** lists every variant in the blueprint with what each needs and whether that is in place now. Press
**Make a programme** on any built variant: the form opens set up for it (content type, method, picker, where it runs),
and everything stays editable. On the **Programmes** page each programme shows which variant it is, who writes for it
and who stands in when that writer's allowance runs out (*Engine choices* in the form edits those chains).

## The PC worker

Your PC does not need an AI key of its own. Anything it has to write — a clip's caption, a recap script, the script
for a video on your own footage — it asks the server's writer for, and the server answers. (Adding a key to the
dashboard's API keys page lets the PC write directly, which is a little faster.)

- **Start:** `powershell -ExecutionPolicy Bypass -File pc\start.ps1` (a window opens; minimise it).
- **Stop:** close that window. Running jobs go back to the queue.
- **Start it at every sign-in:** `powershell -ExecutionPolicy Bypass -File pc\autostart.ps1` (undo with `-Remove`).
- First time on a new PC: `pc\setup.ps1`, then fill in `.env.pc` from Render's Environment tab.
- **Run `pc\setup.ps1` once more** (added 2026-10-05): it now installs deno, which yt-dlp needs to keep reading YouTube
  (it warns that YouTube without it is deprecated). Everything already installed is left alone.

## What adding each thing unlocks

Nothing here needs a card. Every variant in the blueprint runs on free allowances; the two paid services are optional
extras, never requirements.

| you add | where | unlocks |
|---|---|---|
| your **Facebook Page** | dashboard → **Channels → Connect Facebook** | real publishing (today the channel is a mock) |
| a free **Gemini key** | on Render (it is there now), or dashboard → **API keys** | the best free writer for Bangla; scene recaps (5a: Gemini watches the video); Bangla transcription; what Gemini sees in your own footage (7a). Your PC borrows the server's, so it needs none of its own |
| a free **Groq** or **Mistral** key (or OpenRouter, Cerebras, xAI Grok) | API keys | more writers in the chain: when Gemini's ~20 requests a day per model run out, the next one writes. Groq: console.groq.com, no card |
| a **Pollinations** token (optional) | API keys | removes the small corner logo from free generated pictures (illustrated series, 6c). Pictures work without it |
| a **reactor clip** of yourself | dashboard → Brands → Media library (purpose: reactor) | reaction videos you can publish (4a, 4c — proven with a stand-in) |
| a **footage folder** on your PC | the programme → Video → *Your footage folder* | script videos on your own footage (7a), with stock behind it unless you tick *own footage only* |
| a **Vizard** key *(optional, paid ~$14.50/month)* | API keys, then a clips programme with clipper `vizard` | clipping while your PC is off (1b). Everything else clips for free on your PC or the server |
| a **Twelve Labs** key *(optional)* | API keys, then a recap programme with transcriber `twelve_labs` | the Twelve Labs recap (5c); 5a does the same free on Gemini |

## Test programmes left from the proofs

Made on 2026-10-04 and 10-05 to prove variants on the real server, all under the demo brand, none publishing anywhere:
`reaction_test`, `voiceover_test`, `recap_test`, `reaction_long_test`, `telecast_intro_test`, `scene_recap_test`,
`bn_clip_test`, `data_explainer_test`, `illustrated_test`, `stockvideo_test` (inactive), `eval_llm_picker` (inactive,
the selection evaluation). Deactivate or delete them from **Programmes** when you no longer want them; keep
`eval_llm_picker` if the selection evaluation should be re-run (`eval/boundaries.mjs` re-scores its stored runs for free).

## Security housekeeping

Secrets pasted into chat should be rotated: the Supabase service-role key first, then the database password, then
`SECRETS_KEY` (rotating that one means re-entering keys stored in the dashboard vault).

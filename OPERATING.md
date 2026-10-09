# Running the Content Engine — the owner's guide

What you do day to day, and what each thing you can add unlocks. For how it is built, see README.md; for what it makes,
see BLUEPRINT.md and the dashboard's **What it makes** page.

## The three places work happens

| | what it does | always on? |
|---|---|---|
| **The server** (Render) | reads the news feeds and groups the stories, answers your PC's writing requests with its AI keys, picks clip moments, transcribes Bangla, plans ideas, schedules posts | yes |
| **Your PC** (the worker) | keeps every picture and video, and makes them: news cards and reels, clips (YouTube only works here), explainers and animations; sends the posts | only while it runs |
| **The dashboard** | where you review, approve and set things up | — |

Your PC is where the files are kept (since 2026-10-07; see *Storage* below), so **everything that makes or shows a
picture or a video waits for it** — not only programmes set to "Video work runs on: My PC". Nothing is lost while it is
off; the work waits, and the Overview says the PC is off.

## Every day

1. **Make sure the PC worker is running** (`pc\start.ps1`, or set it to start at sign-in — see *The PC worker*). The
   Overview's *Files are kept on your PC* panel says **reachable** when it is up and **PC off** when it is not.
2. Open **Review**. Everything waits there for you: approve, fix the caption, or reject with a reason (the reason
   teaches the next draft; Enter in the reason box rejects). After each decision the next draft comes up by itself;
   `j` / `k` or the arrow keys move along the queue, `/` jumps to the box that narrows it, and drafts that arrive while
   you work are offered with a button rather than loaded under what you are editing. Videos and pictures in Review
   only play while the PC is on.
3. Notes you may see on a draft:
   - **"Written from headlines only"** — none of the outlets' articles could be read (Ittefaq, Desh Rupantor, Bangla
     Tribune and Dhaka Tribune block servers). Check every fact against the source before approving. These drafts are
     never published automatically.
   - **"Researched without web search"** — explainers and long posts research their topic with Google's web search
     first; when search itself was refused (not part of the free plan for that model, or its own allowance spent),
     the research was done from the writer's memory and the source article. Check figures, dates and names.
   - **"Check before approving"** — anything the engine wants you to know about this draft, for example *Caption not
     written — the writer refused*: the AI was out of its free allowance when the video was finished, and the clip's
     own words stand in. Rewrite the caption before posting.
   - **Research notes** (explainers and long posts) — the facts the draft was written from, each with its source
     link, so a figure can be checked against where it came from.
   - **Scenes used** (recaps) — the scenes the recap was cut from, each narrated line with its time in the film and a
     link to that moment in the source, so a cut can be checked the way a clip's moment can.
   - On a video, editing the headline or caption changes the post's text, not the video. **Re-render** draws the same
     video again (a clip, or an explainer from its stored plan); **Regenerate everything** writes it afresh.
4. **Overview**, top to bottom: what is waiting for review and what is being made; whether the AI allowance is
   waiting to reset; **Automatic production** on or off, with its button; while it is on, the news controls (*Pause
   news*, each news programme); whether your PC's files are reachable; the AI requests made today; programmes that
   stopped drafting because too much is waiting for you; alerts (a key out of credit, a feed failing); the worker
   lanes; and the variants with what each still needs.
5. News you have not reviewed within **24 hours** is set aside as "Expired unreviewed" — day-old news is not worth
   publishing, and it buried the fresh stories (2,400 day-old drafts had piled up). Change the window, or turn it off
   with 0, in **Settings → review.news_expiry_hours**. Clips and other videos never expire.
6. A programme you review by hand stops drafting while **30** of its drafts are already waiting for you, and starts
   again as you review them (or they expire). Drafting faster than anyone reads spent the whole free Gemini allowance
   on news nobody saw — 222 drafts in one day — and left the clips without the AI that picks their best moments.
   Change it in **Settings → review.max_waiting** (0 = never stop), or per programme under Automation.

**Automatic production is off unless you turn it on** (Overview → *Turn on*; *Turn off* stops it again). Off, nothing
is made by itself: the feeds are not read, no news is drafted, no ideas are planned, series wait. *Generate* and pasting
a video link always work. On, the engine runs on its own within each programme's limits, and *Pause news* below
pauses only the news within it. It was on by default until 2026-10-07, drafting round the clock, and that is what
filled the free storage.

**Pausing news.** While automatic production is on, *Pause news* on the Overview (or the News desk page) stops all
drafting from the news feeds in one click; the feeds are still read, so *Resume news* starts on today's stories. Each
news programme also has its own pause / resume beside it.

**When something keeps failing.** A job whose worker stops in the middle of it (the server running out of memory, your
PC switched off mid-render) goes back to the queue on its own — but the third time it happens to the same job it stops
and says so, rather than looping. **Retry** on the job starts it completely afresh. A post that was interrupted while
it was being sent is never sent again on its own: it is marked *check the channel first*, because it may already be up.

**Storage: files are kept on your PC** (Settings → Review and news → *Files are kept on your PC*; on in production).
The server stores nothing; every step that makes a picture or a video — news cards too — runs on your PC and writes it
there (`data\media` in the project folder), and posts are sent from the PC as well. While the PC worker runs, it opens
a free Cloudflare tunnel so the dashboard on your phone can play the videos and the publishers can fetch them. The
tunnel's address changes every time the PC starts, but links always go through the server, so they keep working after
a restart. When the PC is off, pictures and videos can't be shown or posted, and the work that makes them waits. An
upload (a logo, a reactor clip) made while the PC is off waits on the server until the PC writes it; an upload over
150 MB has to be copied into `data\media` by hand. The PC deletes its own files on the same rules as cloud storage: an
item's media 48 hours after every channel has published it (Settings → Media storage), and — only if you set a number
of days — the pictures and videos of rejected and failed drafts (Settings → Review and news). Keep an eye on the PC's
free disk space. The folder can be any folder on the PC (**Settings → Media storage → Your PC → Folder on the PC**, a
full path like `D:\ContentEngine\media`): the worker picks it up within a minute, finishes the jobs under way, moves
the existing files there itself and carries on; a folder it cannot use is reported under Alerts. The same panel switches to the cloud instead — **Cloudflare R2** (free 10 GB) or Supabase — for
days the PC is off: then news cards, text, pictures and server-made video need no PC at all, and only YouTube and the
heavy video work still go to it, when a programme says so. Files already stored stay where they are and keep their
links.

**Delete the old files in Supabase yourself.** Supabase's free 1 GB filled on 2026-10-07 and its storage was
restricted; the engine no longer uses it (the database is still Supabase). To clear it: Supabase dashboard → your
project → **Storage → the `media` bucket → select all → Delete** (repeat until the bucket is empty). If the dashboard
is restricted too, contact Supabase support and ask them to empty the bucket or lift the restriction. Drafts made
before the switch still point at those files and will show no picture or video; regenerate any you still want.

**Nothing is published yet.** The one channel, `fb_main`, uses the mock publisher — "published" there means nowhere.
Connect your real Page under **Channels → Connect with Facebook**: Facebook opens its own login, you allow the Pages
you want, and you come back with each one ready to add — the engine fetches and stores a permanent token for every
Page itself. One-time setup first: in your Facebook app (developers.facebook.com) add the **Facebook Login** product
and put the callback address the dialog shows under its *Valid OAuth Redirect URIs*, then add the app's App ID and App
Secret under **API keys** as the provider *Facebook app*. Without that setup, **Paste a Facebook token** does the same
from a token copied out of Graph API Explorer. **Connect with YouTube** works the same way with a Google Cloud OAuth
client (YouTube Data API enabled, a Web application client whose authorised redirect URI is the callback address the
dialog shows, its id and secret under **API keys** as *Google app*); publish the Google app, or its tokens expire after
seven days. Attach each channel to your programmes, and approved posts go out with the source link as the first
comment — while your PC is on, since the posts are sent from it.

## Making clips from a long video

1. **Videos to clip → paste the link**, pick the clips programme (`yt_clips` runs on your PC; YouTube links need it).
2. The engine transcribes it (on your PC — for YouTube links always, and for every link while the files are kept
   there), an AI reads the transcript and picks the moments (on fourteen famous speeches it put the line anyone would
   clip first in nine), cuts each to a captioned vertical reel,
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
**Production method** on the programme (Programmes → Edit → Video). How many clips a video gives, and how long each
may be, are on the same tab. A **summary voice-over** (4b) says two or three sentences over the opening of the clip, the
clip's own sound dipping under the voice and coming back after it, with your reactor clip in the corner if you set one.
A **scene recap** (5a) needs Gemini to watch the film: when your PC has no key, it sends the server a small copy (360p,
a frame a second) and the server watches it.

## Starting a new kind of programme

**What it makes** lists every variant in the blueprint with what each needs and whether that is in place now. (It
lists *your PC on* only for the variants that always run there; while the files are kept on the PC, every variant
needs it.) Press **Make a programme** on any built variant: the form opens set up for it (content type, method, picker, where it runs),
and everything stays editable. On the **Programmes** page each programme shows which variant it is, who writes for it
and who stands in when that writer's allowance runs out (*Engine choices* in the form edits those chains).

## The PC worker

Your PC does not need an AI key of its own. Anything it has to write — a news draft, a clip's caption, a recap script,
an explainer, the script for a video on your own footage — it asks the server's writer for, and the server answers.
(Adding a key to the dashboard's API keys page lets the PC write directly, which is a little faster.) Other keys are
different: the PC sees keys stored on the **API keys** page, not ones set only in Render's Environment tab. Now that the
PC makes the news cards and script videos, a Pexels key that exists only on Render does not reach it — add it on API
keys as well.

While it runs, the worker also keeps your files: it writes them to `data\media` in the project folder and opens a free
Cloudflare tunnel (cloudflared, no account) so the dashboard and the publishers can fetch them. Its window logs the
tunnel's address when it opens; if cloudflared is missing it says so — run `pc\setup.ps1`.

- **Start:** `powershell -ExecutionPolicy Bypass -File pc\start.ps1` (a window opens; minimise it).
- **Stop:** close that window. Running jobs go back to the queue, and pictures and videos can't be shown until it
  starts again.
- **Start it at every sign-in:** `powershell -ExecutionPolicy Bypass -File pc\autostart.ps1` (undo with `-Remove`).
  With the files kept on the PC, this is the setting that keeps the engine usable.
- First time on a new PC: `pc\setup.ps1`, then fill in `.env.pc` from Render's Environment tab. A new PC starts with an
  empty `data\media`: copy that folder across from the old one, or every existing picture and video is missing.
- **Pause just your PC:** Overview → Worker lanes → *your PC*. Its work waits — with the files kept on the PC, that
  is everything that makes a picture or a video (news drafts included), and posting. Reading feeds and picking
  moments carry on on the server.
- **Run `pc\setup.ps1` once more** whenever it gains a tool; everything already installed is left alone. 2026-10-05
  added deno, which yt-dlp needs to keep reading YouTube; 2026-10-07 added cloudflared, the tunnel that serves the
  PC's files.

## Setting up a PC, or moving to a new one

You run everything from the dashboard; no Claude or programming tool is needed. The PC only has to run the worker.

**From the dashboard (the easy way)** — Windows:
1. On the PC, install **Node.js** (LTS, from nodejs.org) and **Python** (python.org, tick *Add python.exe to PATH*).
   Git is not needed.
2. On the dashboard, open **Set up → Set up a PC**, tick what you want (Blender for 3D explainers, start at every
   sign-in, *this PC replaces my old one*) and press **Make a setup command**. Copy the command.
3. On the PC, open PowerShell, paste it, press Enter. It downloads the engine into `ContentEngine` in your user folder,
   writes `.env.pc` itself, installs the tools and starts the worker in a minimised window. The dashboard page shows
   the PC come online.

The command works **once, for 30 minutes**; don't share it or paste it into a chat — until it is used, whoever runs it
gets your database connection. If Node.js or Python is missing it says so before using anything up: install it and
paste the same command again. Each use leaves a notice on the dashboard (and on Telegram, if alerts go there). Running
a new command on a PC that is already set up updates it and keeps its files and `.env.pc`.

**By hand** (the same thing, step by step):
1. Install **Node.js** (LTS, from nodejs.org), **Python** (python.org, tick *Add python.exe to PATH*) and **Git**.
2. Get the project: `git clone https://github.com/yousuftalukder/contentEngine` and open the folder.
3. Run `powershell -ExecutionPolicy Bypass -File pc\setup.ps1` (add `-Blender` for 3D explainers). It installs
   everything else into the project folder and says when it is ready.
4. Copy `.env.pc` from your old PC (or fill it in from Render's Environment tab). It holds the database password and
   the vault key: keep it private.
5. Start it: `powershell -ExecutionPolicy Bypass -File pc\start.ps1` — or `pc\autostart.ps1` once, to start it at
   every sign-in.

**Only one PC is the worker at a time.** Each PC keeps the files it made, in `data\media`. A second PC started while the
first is running refuses to start and says so. To move for good: stop the worker on the old PC, copy its `data\media`
folder into the new PC's project folder, and start the new one once with `PC_TAKEOVER=1` set
(`$env:PC_TAKEOVER = "1"; pc\start.ps1`) — the dashboard's *this PC replaces my old one* does that for you. Files left
behind on the old PC stop playing in Review.

**Updating** after a change is merged: make a new setup command and run it on the PC (or `git pull` in the project
folder), then restart the worker.

## What adding each thing unlocks

Nothing here needs a card. Every variant in the blueprint runs on free allowances; the two paid services are optional
extras, never requirements.

| you add | where | unlocks |
|---|---|---|
| your **Facebook Page** | dashboard → **Channels → Connect with Facebook** (the app's id and secret under API keys first, or *Paste a token*) | real publishing (today the channel is a mock) |
| a free **Gemini key** | on Render (it is there now), or dashboard → **API keys** | the best free writer for Bangla; scene recaps (5a: Gemini watches the video); Bangla transcription; what Gemini sees in your own footage (7a). Your PC borrows the server's, so it needs none of its own |
| a free **Groq** or **Mistral** key (or OpenRouter, Cerebras, xAI Grok) | API keys | more writers in the chain: when Gemini's ~20 requests a day per model run out, the next one writes. Groq: console.groq.com, no card |
| a free **Pexels** key | API keys (it is on Render now, which your PC cannot see — and the PC makes the cards and videos while it keeps the files) | stock photos on news cards (2c) and stock footage in script videos (7b); without it those become text cards and photo sequences |
| a **Pollinations** token (optional) | API keys | removes the small corner logo from free generated pictures (illustrated series, 6c). Pictures work without it |
| a **reactor clip** of yourself | dashboard → Brands → Media library (purpose: reactor) | reaction videos you can publish (4a, 4c — proven with a stand-in) |
| a **footage folder** on your PC | the programme → Video → *Your footage folder* | script videos on your own footage (7a), with stock behind it unless you tick *own footage only* (a 7a programme cannot be saved without a folder) |
| a **Vizard** key *(optional, paid ~$14.50/month)* | API keys, then a clips programme with clipper `vizard` | clipping while your PC is off (1b) — not while the files are kept on the PC, since every job that makes a file then runs on the PC. Everything else clips for free on your PC or the server |
| a **Twelve Labs** key *(optional)* | API keys, then a recap programme with transcriber `twelve_labs` | the Twelve Labs recap (5c); 5a does the same free on Gemini |

## Test programmes left from the proofs

Made between 2026-10-04 and 10-06 to prove variants on the real server, all under the demo brand, none publishing anywhere:
`reaction_test`, `voiceover_test`, `recap_test`, `reaction_long_test`, `telecast_intro_test`, `scene_recap_test`,
`bn_clip_test`, `data_explainer_test`, `illustrated_test`, `blender_test`, `own_footage_test`, `stockvideo_test` (inactive), `eval_llm_picker` (inactive,
the selection evaluation). Deactivate or delete them from **Programmes** when you no longer want them; keep
`eval_llm_picker` if the selection evaluation should be re-run (`eval/boundaries.mjs` re-scores its stored runs for free).

## Security housekeeping

Secrets pasted into chat should be rotated: the Supabase service-role key first, then the database password, then
`SECRETS_KEY` (rotating that one means re-entering keys stored in the dashboard vault).

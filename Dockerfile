# Content Engine — image for both Render services (web + video worker; LANES picks the role at runtime).
# Needs ffmpeg (render, JPEG conversion, headline overlay via libass) + yt-dlp (video sourcing) + fonts:
#   fonts-noto-core  → Noto Sans / Noto Sans Bengali: headline overlays and burned captions in Bangla and English
#   fonts-dejavu-core → fallback Latin font
#   fontconfig       → lets libass find fonts by name ("Noto Sans Bengali"); OVERLAY_FONT env var overrides the name
# The video studio (studio/, Remotion) renders news reels and animated explainers in headless Chrome; the libraries
# below are what Chrome Headless Shell needs on Debian. Its bundle is built here so the first render starts at once.
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 curl ca-certificates fontconfig fonts-dejavu-core fonts-noto-core \
      libnss3 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 libgbm1 libasound2 libxrandr2 libxkbcommon0 libxfixes3 libxcomposite1 \
      libxdamage1 libpango-1.0-0 libcairo2 libcups2 libdrm2 libxshmfence1 \
 && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp \
 && fc-cache -f \
 && rm -rf /var/lib/apt/lists/*
# Piper: a speech engine that runs here, costs nothing and never runs out. A hosted voice is better, but a hosted voice
# on a free tier is twenty narrations a day and a hosted voice unpaid is none at all — so the last fallback is one that
# cannot refuse. bn_BD is the reason it is worth the 150 MB: almost nothing free speaks Bangladeshi Bangla.
ENV PIPER_DIR=/opt/piper
# Written out one command at a time on purpose. A loop with shell parameter expansion in here silently produced an
# install with the binary present and no voices, and a trailing `|| true` meant the build still passed — so the first
# time it was needed it said "voice not installed" in production instead of during the build.
RUN set -eux; \
    curl -fsSL https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz | tar -xz -C /opt; \
    ln -sf /opt/piper/piper /usr/local/bin/piper; \
    mkdir -p /opt/piper/voices; \
    curl -fsSL -o /opt/piper/voices/bn_BD-google-medium.onnx      https://huggingface.co/rhasspy/piper-voices/resolve/main/bn/bn_BD/google/medium/bn_BD-google-medium.onnx; \
    curl -fsSL -o /opt/piper/voices/bn_BD-google-medium.onnx.json https://huggingface.co/rhasspy/piper-voices/resolve/main/bn/bn_BD/google/medium/bn_BD-google-medium.onnx.json; \
    curl -fsSL -o /opt/piper/voices/en_US-lessac-medium.onnx      https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx; \
    curl -fsSL -o /opt/piper/voices/en_US-lessac-medium.onnx.json https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json; \
    test -s /opt/piper/voices/bn_BD-google-medium.onnx; \
    test -s /opt/piper/voices/en_US-lessac-medium.onnx; \
    echo "the engine is installed" | piper --model /opt/piper/voices/en_US-lessac-medium.onnx --output_file /tmp/piper-check.wav; \
    test -s /tmp/piper-check.wav; rm -f /tmp/piper-check.wav
# The Bangla voice is downloaded but silent with this piper build: its phoneme map contains a two-codepoint symbol and
# piper 2023.11.14 rejects anything that is not one ("aɪ" is not a single codepoint). The file is correct and a newer
# piper will read it, so it stays; the engine falls back to another installed voice rather than failing a video over
# it. Bangla narration is not on the critical path — a clip cut from a long video keeps the source's own audio.
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY studio/package.json studio/package-lock.json ./studio/
RUN cd studio && npm ci && npx remotion browser ensure
COPY studio ./studio
RUN cd studio && node render.mjs --bundle-only
COPY server.js schema.sql ./
COPY frontend ./frontend
ENV NODE_ENV=production PORT=4000 WORK_DIR=/tmp
EXPOSE 4000
HEALTHCHECK --interval=60s --timeout=10s CMD curl -fsS http://localhost:4000/health || exit 1
CMD ["node", "server.js"]

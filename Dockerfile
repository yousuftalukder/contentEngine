# Content Engine — image for both Render services (web + video worker; LANES picks the role at runtime).
# Needs ffmpeg (render, JPEG conversion, headline overlay via libass) + yt-dlp (video sourcing) + fonts:
#   fonts-noto-core  → Noto Sans / Noto Sans Bengali: headline overlays and burned captions in Bangla and English
#   fonts-dejavu-core → fallback Latin font
#   fontconfig       → lets libass find fonts by name ("Noto Sans Bengali"); OVERLAY_FONT env var overrides the name
# The video studio (studio/, Remotion) renders news reels and animated explainers in headless Chrome; the libraries
# below are what Chrome Headless Shell needs on Debian. Its bundle is built here so the first render starts at once.

# whisper.cpp, compiled in a stage of its own so the compiler and its headers do not ship. Transcription is what turns
# a long video into a list of moments worth clipping, and it is the one step with no free hosted option that survives
# a day's use — so it runs here, on the worker, unlimited and costing nothing. Built static: one binary to copy out.
#
# GGML_NATIVE=OFF, and every instruction-set extension off with it, is not a detail. ggml defaults to -march=native,
# which compiles for whatever machine built the image; the machine that runs it is a different one, and production
# died with SIGILL on its first real transcription — an instruction the host does not have. Nothing catches this in
# a build: the smoke test below runs on the builder's own CPU, and so does CI's, so both pass and production still
# falls over. So neither guess is made here: both are built, a baseline one that runs on any x86-64 and one using
# AVX2/FMA/F16C, and server.js reads what the host's own /proc/cpuinfo reports and runs the fitting one. Render's
# current host has avx2, fma and f16c and no avx512, which is worth a few times the speed on a shared vCPU — but
# the host can change, and a binary that is merely probably safe is what put SIGILL in production in the first place.
FROM debian:bookworm-slim AS whisper
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends build-essential cmake curl ca-certificates; \
    curl -fsSL https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v1.9.4.tar.gz | tar -xz -C /tmp; \
    for v in base avx2; do \
      if [ "$v" = avx2 ]; then EXT="-DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON"; else EXT="-DGGML_AVX=OFF -DGGML_AVX2=OFF -DGGML_FMA=OFF -DGGML_F16C=OFF"; fi; \
      cmake -S /tmp/whisper.cpp-1.9.4 -B "/tmp/b-$v" -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF \
        -DGGML_NATIVE=OFF -DGGML_BMI2=OFF $EXT; \
      cmake --build "/tmp/b-$v" --config Release -j "$(nproc)" --target whisper-cli; \
      install -Dm755 "$(find "/tmp/b-$v" -name whisper-cli -type f | head -1)" "/out/whisper-cli-$v"; \
    done; \
    cp /out/whisper-cli-base /out/whisper-cli; \
    /out/whisper-cli --help >/dev/null 2>&1 || true

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
ENV WHISPER_DIR=/opt/whisper
COPY --from=whisper /out/whisper-cli /out/whisper-cli-base /out/whisper-cli-avx2 /usr/local/bin/
# The multilingual models rather than the .en ones: the clips come from English video, but a Bangladeshi programme has
# Bangla sources too, and one model that handles both beats a better English one that handles nothing else. Both sizes
# ship because the machine decides: base is 141 MB and needs a few hundred more to run in, which a 512 MB instance
# does not have — it was killed part-way through loading the first time production tried. tiny is 74 MB, hears less
# well, and runs. server.js picks by the memory it finds; a bigger worker gets base without being told.
RUN set -eux; \
    mkdir -p $WHISPER_DIR; \
    curl -fsSL -o $WHISPER_DIR/ggml-base.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin; \
    curl -fsSL -o $WHISPER_DIR/ggml-tiny.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin; \
    test -s $WHISPER_DIR/ggml-base.bin; \
    test -s $WHISPER_DIR/ggml-tiny.bin; \
    ffmpeg -hide_banner -loglevel error -y -f lavfi -i "sine=frequency=400:duration=2" -ar 16000 -ac 1 /tmp/w.wav; \
    for m in tiny base; do whisper-cli -m $WHISPER_DIR/ggml-$m.bin -f /tmp/w.wav -oj -of /tmp/w >/dev/null; test -s /tmp/w.json; rm -f /tmp/w.json; done; \
    rm -f /tmp/w.wav
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
COPY fonts ./fonts
ENV NODE_ENV=production PORT=4000 WORK_DIR=/tmp
EXPOSE 4000
HEALTHCHECK --interval=60s --timeout=10s CMD curl -fsS http://localhost:4000/health || exit 1
CMD ["node", "server.js"]

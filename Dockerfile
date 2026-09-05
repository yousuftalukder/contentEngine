# Content Engine — image for both Render services (web + video worker; LANES picks the role at runtime).
# Needs ffmpeg (render, JPEG conversion, headline overlay via libass) + yt-dlp (video sourcing) + fonts:
#   fonts-noto-core  → Noto Sans / Noto Sans Bengali: headline overlays and burned captions in Bangla and English
#   fonts-dejavu-core → fallback Latin font
#   fontconfig       → lets libass find fonts by name ("Noto Sans Bengali"); OVERLAY_FONT env var overrides the name
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 curl ca-certificates fontconfig fonts-dejavu-core fonts-noto-core \
 && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp \
 && fc-cache -f \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js schema.sql ./
COPY frontend ./frontend
ENV NODE_ENV=production PORT=4000 WORK_DIR=/tmp
EXPOSE 4000
HEALTHCHECK --interval=60s --timeout=10s CMD curl -fsS http://localhost:4000/health || exit 1
CMD ["node", "server.js"]

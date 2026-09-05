# Content Engine — Render web service image.
# Needs ffmpeg (render) + yt-dlp (video sourcing/download) + fonts (burned captions).
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 curl ca-certificates fonts-dejavu-core \
 && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp \
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

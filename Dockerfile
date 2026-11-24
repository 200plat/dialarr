FROM node:20-alpine

# ffmpeg + ffprobe: transcode mkv/avi to cached browser-playable mp4 (server.js tcWork)
# The fonts are for the subtitle burn: libass draws the cues with whatever
# fontconfig can find, and with no fonts at all it draws nothing but a warning
# ("failed to find any fallback with glyph 0x0") — the subtitles are simply
# missing from the picture.
RUN apk add --no-cache ffmpeg font-dejavu font-noto

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 3005
VOLUME ["/app/media", "/app/data"]

CMD ["node", "server.js"]

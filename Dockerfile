FROM node:20-alpine

# ffmpeg is optional but recommended: it converts unsupported formats on the fly
# and reads subtitles embedded in mkv files.
RUN apk add --no-cache ffmpeg

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .

ENV NODE_ENV=production PORT=3000
EXPOSE 3000
CMD ["node", "src/server.js"]

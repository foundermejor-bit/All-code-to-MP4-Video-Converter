FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg chromium tini fonts-noto-core fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production PUPPETEER_SKIP_DOWNLOAD=true PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium PORT=10000
WORKDIR /app
COPY --chown=node:node package.json ./
RUN npm install --omit=dev && npm cache clean --force && chown -R node:node /app
COPY --chown=node:node . .
USER node
EXPOSE 10000
ENTRYPOINT ["tini","--"]
CMD ["node","server.js"]

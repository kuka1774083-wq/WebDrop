FROM node:22-slim AS base
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

FROM base AS deps
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

FROM base
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY config ./config
COPY src ./src
COPY public ./public
COPY scripts ./scripts

RUN mkdir -p /app/data/files /app/data/staging /app/data/thumbs /app/data/previews
ENV NODE_ENV=production
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]

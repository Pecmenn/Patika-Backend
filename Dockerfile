FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY migrations ./migrations
COPY public ./public
COPY scripts ./scripts

# Fotoğraflar kalıcı alanda durur, sunucu yönetici yetkisi olmadan çalışır.
RUN mkdir -p /data/photos && chown -R node:node /data
USER node

EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:4000/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--no-warnings", "src/server.ts"]

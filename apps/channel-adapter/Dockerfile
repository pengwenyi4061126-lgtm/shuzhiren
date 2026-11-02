FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/channel-adapter/package.json apps/channel-adapter/package.json
RUN npm ci --omit=dev --workspace @shuzhiren/channel-adapter
COPY apps/channel-adapter apps/channel-adapter
WORKDIR /app/apps/channel-adapter
USER node
CMD ["node", "index.mjs"]

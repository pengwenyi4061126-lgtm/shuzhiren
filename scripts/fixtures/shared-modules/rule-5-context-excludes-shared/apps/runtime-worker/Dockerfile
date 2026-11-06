FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --workspace @shuzhiren/runtime-worker
COPY --chown=node:node apps/console/lib/shared apps/console/lib/shared
COPY --chown=node:node apps/runtime-worker apps/runtime-worker
CMD ["node", "index.mjs"]

FROM node:20-alpine

WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/alert-notifier/package.json apps/alert-notifier/package.json
COPY apps/channel-adapter/package.json apps/channel-adapter/package.json
COPY apps/console/package.json apps/console/package.json
COPY apps/output-probe/package.json apps/output-probe/package.json
COPY apps/runtime-observer/package.json apps/runtime-observer/package.json
COPY apps/runtime-worker/package.json apps/runtime-worker/package.json
RUN npm ci --omit=dev --workspace @shuzhiren/runtime-worker
COPY --chown=node:node apps/runtime-worker apps/runtime-worker

WORKDIR /app/apps/runtime-worker
USER node
CMD ["node", "index.mjs"]

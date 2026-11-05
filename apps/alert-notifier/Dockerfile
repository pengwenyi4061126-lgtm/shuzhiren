FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/alert-notifier/package.json apps/alert-notifier/package.json
COPY apps/channel-adapter/package.json apps/channel-adapter/package.json
COPY apps/console/package.json apps/console/package.json
COPY apps/output-probe/package.json apps/output-probe/package.json
COPY apps/runtime-observer/package.json apps/runtime-observer/package.json
COPY apps/runtime-worker/package.json apps/runtime-worker/package.json
RUN npm ci --omit=dev --workspace @shuzhiren/alert-notifier
COPY apps/alert-notifier apps/alert-notifier
WORKDIR /app/apps/alert-notifier
USER node
CMD ["node", "index.mjs"]

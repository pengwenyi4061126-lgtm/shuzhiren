FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node apps/runtime-worker apps/runtime-worker
COPY --chown=node:node apps/console/lib/shared apps/console/lib/shared
CMD ["node", "index.mjs"]

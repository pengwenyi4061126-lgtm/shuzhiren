FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node apps/runtime-worker apps/runtime-worker
CMD ["node", "index.mjs"]

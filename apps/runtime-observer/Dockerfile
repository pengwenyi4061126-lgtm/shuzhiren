FROM node:24-alpine

WORKDIR /app
COPY --chown=node:node apps/runtime-observer/package.json ./package.json
COPY --chown=node:node apps/runtime-observer/index.mjs ./index.mjs
COPY --chown=node:node apps/runtime-observer/targets.mjs ./targets.mjs

USER node
CMD ["node", "index.mjs"]

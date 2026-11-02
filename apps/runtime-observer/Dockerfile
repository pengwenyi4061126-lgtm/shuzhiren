FROM node:20-alpine

WORKDIR /app
COPY apps/runtime-observer/package.json ./package.json
COPY apps/runtime-observer/index.mjs ./index.mjs
COPY apps/runtime-observer/targets.mjs ./targets.mjs

CMD ["node", "index.mjs"]

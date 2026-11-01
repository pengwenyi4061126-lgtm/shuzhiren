FROM node:20-alpine

WORKDIR /app
COPY apps/runtime-worker/package.json ./package.json
RUN npm install --omit=dev
COPY apps/runtime-worker/index.mjs ./index.mjs

CMD ["node", "index.mjs"]

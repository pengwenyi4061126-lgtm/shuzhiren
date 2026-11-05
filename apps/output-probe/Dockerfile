FROM node:24-bookworm-slim@sha256:6042915a8b58012e6699f998ed96bca43ec9d8582447bdb68bc2445d0fafeb79

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --chown=node:node apps/output-probe/package.json ./package.json
COPY --chown=node:node apps/output-probe/index.mjs ./index.mjs
COPY --chown=node:node apps/output-probe/handler.mjs ./handler.mjs
COPY --chown=node:node apps/output-probe/lib.mjs ./lib.mjs

EXPOSE 8081
USER node
CMD ["node", "index.mjs"]

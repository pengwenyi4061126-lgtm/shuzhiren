FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY apps/output-probe/package.json ./package.json
COPY apps/output-probe/index.mjs ./index.mjs
COPY apps/output-probe/lib.mjs ./lib.mjs

EXPOSE 8081
CMD ["node", "index.mjs"]

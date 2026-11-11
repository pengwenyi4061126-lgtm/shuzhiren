FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS dependencies

WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/alert-notifier/package.json apps/alert-notifier/package.json
COPY apps/channel-adapter/package.json apps/channel-adapter/package.json
COPY apps/console/package.json apps/console/package.json
COPY apps/douyin-adapter/package.json apps/douyin-adapter/package.json
COPY apps/output-probe/package.json apps/output-probe/package.json
COPY apps/runtime-observer/package.json apps/runtime-observer/package.json
COPY apps/runtime-worker/package.json apps/runtime-worker/package.json
RUN npm ci

FROM dependencies AS build

COPY apps/console apps/console
COPY infra/postgres/migrations infra/postgres/migrations
RUN npm run build --workspace @shuzhiren/console

# This target exists only for a loopback-bound P0 verification server.  A
# Next standalone production server unconditionally assigns
# NODE_ENV=production, so it cannot exercise the explicitly development-only
# request-header identity guard.  Keep source plus dev dependencies available
# and invoke the repository's loopback-enforcing dev launcher instead.
FROM dependencies AS development

COPY --chown=node:node apps/console apps/console
COPY --chown=node:node infra/postgres/migrations infra/postgres/migrations
WORKDIR /app/apps/console
ENV NODE_ENV=development
ENV PORT=3000
ENV HOSTNAME=127.0.0.1
# The development server writes Turbopack state under .next.  The COPY
# instruction does not make the destination directory itself writable for the
# non-root runtime user, so provision that cache root explicitly.
RUN mkdir -p .next && chown node:node .next
USER node
EXPOSE 3000
CMD ["node", "scripts/dev.mjs"]

FROM dependencies AS migrator

COPY apps/console/scripts/migrate.mjs apps/console/scripts/migration-integrity.mjs ./apps/console/scripts/
COPY infra/postgres/migrations ./infra/postgres/migrations
WORKDIR /app/apps/console
USER node
CMD ["node", "scripts/migrate.mjs"]

FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
RUN addgroup --system --gid 1001 shuzhiren && adduser --system --uid 1001 console
COPY --from=build --chown=console:shuzhiren /app/apps/console/.next/standalone ./
COPY --from=build --chown=console:shuzhiren /app/apps/console/.next/static ./apps/console/.next/static

WORKDIR /app/apps/console
USER console
EXPOSE 3000
CMD ["node", "server.js"]

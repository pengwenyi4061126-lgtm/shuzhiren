FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85
USER root
RUN apk add --no-cache ffmpeg
RUN ffprobe -version >/dev/null
WORKDIR /app
COPY --chown=node:node server.mjs dev-init.mjs recording-quality.mjs ./
USER node
EXPOSE 8089
CMD ["node", "server.mjs"]

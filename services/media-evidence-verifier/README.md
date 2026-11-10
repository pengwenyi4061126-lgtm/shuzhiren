# Media Evidence Verifier

This private Node service implements the upload-grant, object-verification, and download-grant endpoints in [`docs/MEDIA_UPLOAD_CONTRACT.md`](../../docs/MEDIA_UPLOAD_CONTRACT.md). It uses Node built-ins for the S3-compatible protocol and an isolated `ffprobe` process for photo-narration archive quality checks. The control plane receives signed URLs and evidence metadata, never object-storage credentials.

## Configuration

Set these variables in the service environment:

| Variable | Purpose |
| --- | --- |
| `MEDIA_EVIDENCE_VERIFIER_TOKEN` | Dedicated bearer token; at least 48 characters. |
| `MEDIA_EVIDENCE_S3_BUCKET` | Private, versioned bucket name. |
| `MEDIA_EVIDENCE_S3_REGION` | S3 signing region. |
| `MEDIA_EVIDENCE_S3_ACCESS_KEY` | Dedicated least-privilege object-store key. |
| `MEDIA_EVIDENCE_S3_SECRET_KEY` | Secret for that key. |
| `MEDIA_EVIDENCE_S3_INTERNAL_ENDPOINT` | Endpoint used by this service for signed object reads. |
| `MEDIA_EVIDENCE_S3_PUBLIC_ENDPOINT` | Browser-reachable endpoint used in presigned URLs. |
| `PORT` | Optional listener port; defaults to `8089`. |

Production endpoints must use HTTPS. Local HTTP endpoints are accepted only for loopback testing. The bucket must have versioning enabled before verification or cross-device downloads will be rejected. Keep public bucket access blocked; permit browser PUT only from the console origin with the `content-type` and `x-amz-checksum-sha256` headers. Do not expose bucket listing or delete operations to this service credential.

The internal and public endpoint may differ when a reverse proxy exposes the object store to browsers. The public endpoint hostname and path are part of the SigV4 signature and must route to the same bucket service. Place this service behind TLS termination, allow only the control plane to call its API, and keep its bearer token and storage credentials in a secret manager.

## Local development stack

The development-only Compose file starts MinIO on loopback, creates the `shuzhiren-media` bucket, enables versioning, applies the restricted browser PUT CORS policy, then starts this verifier on `127.0.0.1:8089`. The local verifier uses the MinIO development root key; never reuse it outside this isolated development stack. The verifier accepts its container-network HTTP endpoint only when both `NODE_ENV=development` and `MEDIA_EVIDENCE_ALLOW_INSECURE_INTERNAL_ENDPOINT=true` are set. The public S3 URL remains loopback-only, and the console adds that loopback origin to `connect-src` only in development.

1. Copy `config/dev-compose.example.env` to `infra/compose/.env` and replace all password/token placeholders with unique random values.
2. Start the local object store and verifier with `docker compose --env-file infra/compose/.env -f infra/compose/docker-compose.yml up -d --build media-evidence-verifier`.
3. Copy `MEDIA_EVIDENCE_VERIFIER_URL`, `MEDIA_EVIDENCE_VERIFIER_TOKEN`, and `MEDIA_UPLOAD_ALLOWED_ORIGINS` from `infra/compose/.env` into `apps/console/.env.local`, then restart the console dev server.
4. In the console, upload and approve a photo asset, select it in a reviewed project, render a photo narration, and save it. The browser PUT goes to MinIO and the resulting immutable object version is archived through the verifier.

MinIO publishes only loopback ports. This Compose stack is for development and local integration testing, not production deployment.

## Behavior

- Upload grants are bound to tenant UUID, supported kind/MIME, SHA-256 hex and base64 digests, and a maximum 100 MiB file. Keys use an opaque UUID under the tenant prefix. Grants last 15 minutes and sign only the host, content type, and SHA-256 checksum header.
- Verification reads the stored bytes, enforces the size limit, calculates SHA-256, detects supported JPEG, PNG, MP4, WebM, WAV, MP3, or Ogg content, and requires a non-null immutable S3 version ID.
- Project photo-narration verification additionally probes the stored WebM and requires a 720x1280 video stream, an audio stream, and a finite duration from 1 to 300 seconds. At most two ffprobe processes run concurrently; overload and probe failures fail closed. The version-bound report is stored with the immutable project recording.
- Download grants re-read and hash the exact requested version, include that version in the signed GET, set an attachment filename, and last five minutes.
- API errors do not return storage endpoint credentials, object bytes, or signed URLs beyond the grant response that was requested. `/healthz` is the only unauthenticated route.

## Run and test

```sh
node services/media-evidence-verifier/server.mjs
npm run media:evidence:service:test
```

The tests use a local fake S3 endpoint and injected ffprobe results; the container image build separately installs ffmpeg and checks that `ffprobe` is executable. A production deployment still needs a versioned private bucket, dedicated credentials, HTTPS routing, and an end-to-end browser upload/download check.

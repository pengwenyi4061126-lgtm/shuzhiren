# Media Upload Contract

The asset workspace uploads files directly to private object storage through a short-lived grant issued by the private media evidence service. The control plane never receives storage credentials. Production upload is available only after the repository service is deployed and configured with a versioned private bucket; demo mode creates a clearly labeled demo asset and does not transfer file bytes.

The development Compose stack provisions a versioned MinIO bucket and starts the verifier locally; see the local development instructions in the verifier README. The browser CSP permits the MinIO loopback upload origin only in development. Production must list each exact TLS object-storage origin in `MEDIA_UPLOAD_ALLOWED_ORIGINS`; the console rejects upload grants whose URL origin is absent from that list.

## Grant request

`POST /v1/media-evidence/upload-grant` with the existing verifier bearer token and JSON body:

```json
{
  "tenantId": "<tenant-id>",
  "kind": "portrait_photo",
  "checksum": "sha256:<64 lowercase hex characters>",
  "checksumBase64": "<base64 SHA-256 bytes>",
  "contentType": "image/jpeg",
  "bytes": 12345
}
```

The service returns `objectKey`, `uploadUrl`, `headers`, and `expiresAt`. It must bind the grant to all request fields, use an opaque tenant-prefixed object key, enforce the 100 MiB limit, reject unsupported media types, and expire the grant within 15 minutes. The URL must use HTTPS (HTTP loopback is allowed only for local development). The only permitted signed headers are `content-type` and `x-amz-checksum-sha256`, with values matching the request. The bucket remains private, versioned, and tenant-isolated. Configure bucket CORS to allow PUT from the console origin and expose no bucket listing or read operations.

## Download grant

The console issues `POST /v1/media-evidence/download-grant` only after loading the recording row by authenticated tenant, project, and recording ID. The verifier request includes `tenantId`, the stored `objectKey`, immutable `objectVersion`, stored `expectedChecksum`, validated `fileName`, and an optional disposition restricted to `attachment` or `inline` (default `attachment`). The verifier must confirm that the exact immutable object version still matches the checksum and issue a read-only HTTPS `downloadUrl` that expires within five minutes. Attachment grants use a safe filename; inline grants set only `Content-Disposition: inline` and are used by the authenticated project recording preview route. Neither grant permits list, write, or delete access. The console validates the URL scheme and expiry, sends the URL only to the requesting authorized browser, and marks grant responses `no-store`. Page CSP permits media playback only from configured media upload/object-store origins. Demo mode does not issue download grants.

## Verification

Project photo-narration archives add `qualityProfile: "photo-narration-webm"` to object verification. The verifier independently inspects the stored object with `ffprobe`, requires a 720x1280 video stream, at least one audio stream, and a finite 1-300 second container duration, then returns a `recordingQuality` report. The control plane validates and stores that report in the immutable project recording row. At most two probes run concurrently; missing `ffprobe`, malformed media, overload, or a failing probe rejects the archive. Demo verification cannot claim this profile. This technical report does not verify that product facts were spoken or visibly correct, and does not replace human content review.

After the browser PUT succeeds, it registers the returned key and hex checksum through `POST /api/v1/assets`. The existing `POST /v1/media-evidence/verify` service endpoint must read the actual stored object and return the exact object key, SHA-256 checksum, immutable object version, byte count, detected content type, opaque evidence reference, and verification timestamp. Registration and human approval continue to persist that version-bound evidence. A failed upload or verification does not create an approved asset.

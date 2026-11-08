# Media Upload Contract

The asset workspace uploads files directly to private object storage through a short-lived grant issued by the private media evidence service. The control plane never receives storage credentials. Production upload is available only after the repository service is deployed and configured with a versioned private bucket; demo mode creates a clearly labeled demo asset and does not transfer file bytes.

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

The console issues `POST /v1/media-evidence/download-grant` only after loading the recording row by authenticated tenant, project, and recording ID. The verifier request includes `tenantId`, the stored `objectKey`, immutable `objectVersion`, stored `expectedChecksum`, and validated `fileName`. The verifier must confirm that the exact immutable object version still matches the checksum and issue a read-only HTTPS `downloadUrl` that expires within five minutes. The response contains only `downloadUrl` and `expiresAt`; it must set a safe attachment filename from the validated name and must not grant list, write, or delete access. The console validates the URL scheme and expiry, sends the URL only to the requesting authorized browser, and marks the response `no-store`. Demo mode does not issue download grants.

## Verification

After the browser PUT succeeds, it registers the returned key and hex checksum through `POST /api/v1/assets`. The existing `POST /v1/media-evidence/verify` service endpoint must read the actual stored object and return the exact object key, SHA-256 checksum, immutable object version, byte count, detected content type, opaque evidence reference, and verification timestamp. Registration and human approval continue to persist that version-bound evidence. A failed upload or verification does not create an approved asset.

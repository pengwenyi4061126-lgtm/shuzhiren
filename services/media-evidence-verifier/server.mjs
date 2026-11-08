import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_BYTES = 100 * 1024 * 1024;
const MAX_CONCURRENT_OBJECT_READS = 2;
let concurrentObjectReads = 0;
const GRANT_PATHS = new Set(["/v1/media-evidence/upload-grant", "/v1/media-evidence/verify", "/v1/media-evidence/download-grant"]);
const MIME_BY_KIND = {
  portrait: new Set(["video/mp4", "video/webm"]),
  portrait_photo: new Set(["image/jpeg", "image/png"]),
  product_clip: new Set(["video/mp4", "video/webm"]),
  voice: new Set(["audio/wav", "audio/mpeg", "audio/ogg"]),
  music: new Set(["audio/wav", "audio/mpeg", "audio/ogg"]),
  overlay_background: new Set(["image/jpeg", "image/png"])
};

export function createMediaEvidenceServer(config, fetchImpl = fetch) {
  const settings = validateConfig(config);
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/healthz") return json(response, 200, { status: "ok" });
    if (!GRANT_PATHS.has(url.pathname) || request.method !== "POST") return json(response, 404, { error: "not_found" });
    if (!authorized(request.headers.authorization, settings.token)) return json(response, 401, { error: "unauthorized" });
    try {
      const input = await readJson(request);
      if (url.pathname.endsWith("/upload-grant")) return json(response, 200, await uploadGrant(settings, input));
      if (url.pathname.endsWith("/verify")) return json(response, 200, await verifyObject(settings, input, fetchImpl));
      return json(response, 200, await downloadGrant(settings, input, fetchImpl));
    } catch (error) {
      const status = error?.status ?? 500;
      return json(response, status, { error: error?.code ?? "internal_error" });
    }
  });
  return server;
}

export function configFromEnv(env = process.env) {
  return {
    token: env.MEDIA_EVIDENCE_VERIFIER_TOKEN,
    bucket: env.MEDIA_EVIDENCE_S3_BUCKET,
    region: env.MEDIA_EVIDENCE_S3_REGION,
    accessKey: env.MEDIA_EVIDENCE_S3_ACCESS_KEY,
    secretKey: env.MEDIA_EVIDENCE_S3_SECRET_KEY,
    internalEndpoint: env.MEDIA_EVIDENCE_S3_INTERNAL_ENDPOINT,
    publicEndpoint: env.MEDIA_EVIDENCE_S3_PUBLIC_ENDPOINT
  };
}

async function uploadGrant(config, input) {
  const tenantId = requireTenant(input.tenantId);
  const checksum = requireChecksum(input.checksum);
  if (!/^[A-Za-z0-9+/]{43}=$/.test(input.checksumBase64) || Buffer.from(input.checksumBase64, "base64").toString("base64") !== input.checksumBase64
    || Buffer.from(input.checksumBase64, "base64").toString("hex") !== checksum.slice(7)) throw fault(400, "invalid_checksum");
  const contentType = requireContentType(input.kind, input.contentType);
  if (!Number.isSafeInteger(input.bytes) || input.bytes < 1 || input.bytes > MAX_BYTES) throw fault(400, "invalid_size");
  const extension = ({ "image/jpeg": "jpg", "image/png": "png", "video/mp4": "mp4", "video/webm": "webm", "audio/wav": "wav", "audio/mpeg": "mp3", "audio/ogg": "ogg" })[contentType];
  const objectKey = `${tenantId}/${randomUUID()}.${extension}`;
  const expiresAt = new Date(Date.now() + 15 * 60_000);
  const headers = { "content-type": contentType, "x-amz-checksum-sha256": input.checksumBase64 };
  return { objectKey, uploadUrl: presignedUrl(config, "PUT", objectKey, 900, headers), headers, expiresAt: expiresAt.toISOString() };
}

async function verifyObject(config, input, fetchImpl) {
  const tenantId = requireTenant(input.tenantId);
  const objectKey = requireObjectKey(input.objectKey, tenantId);
  const expectedChecksum = requireChecksum(input.expectedChecksum);
  const object = await readObject(config, objectKey, undefined, fetchImpl);
  if (object.checksum !== expectedChecksum) throw fault(409, "checksum_mismatch");
  const contentType = detectContentType(object.bytes);
  if (!contentType || !MIME_BY_KIND[input.kind]?.has(contentType)) throw fault(415, "unsupported_content");
  return { objectKey, checksum: object.checksum, objectVersion: object.version, bytes: object.bytes.length, contentType, evidenceRef: `urn:media-evidence:${randomUUID()}`, verifiedAt: new Date().toISOString() };
}

async function downloadGrant(config, input, fetchImpl) {
  const tenantId = requireTenant(input.tenantId);
  const objectKey = requireObjectKey(input.objectKey, tenantId);
  const version = requireVersion(input.objectVersion);
  const expectedChecksum = requireChecksum(input.expectedChecksum);
  const fileName = requireFileName(input.fileName);
  const object = await readObject(config, objectKey, version, fetchImpl);
  if (object.checksum !== expectedChecksum || object.version !== version) throw fault(409, "object_version_mismatch");
  const disposition = `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`;
  const expiresAt = new Date(Date.now() + 5 * 60_000);
  return { downloadUrl: presignedUrl(config, "GET", objectKey, 300, {}, { versionId: version, "response-content-disposition": disposition, "response-content-type": object.contentType }), expiresAt: expiresAt.toISOString() };
}

async function readObject(config, objectKey, version, fetchImpl) {
  if (concurrentObjectReads >= MAX_CONCURRENT_OBJECT_READS) throw fault(503, "object_verification_busy");
  concurrentObjectReads++;
  try {
    const query = version ? { versionId: version } : {};
    const response = await s3Request(config, "GET", objectKey, query, undefined, fetchImpl);
    if (response.status === 404) throw fault(404, "object_not_found");
    if (!response.ok) throw fault(502, "object_store_unavailable");
    const lengthHeader = response.headers.get("content-length");
    const declaredLength = lengthHeader === null ? Number.NaN : Number(lengthHeader);
    if (Number.isFinite(declaredLength) && (declaredLength < 1 || declaredLength > MAX_BYTES)) throw fault(413, "object_size_invalid");
    const bytes = await readCappedBody(response);
    if (bytes.length < 1) throw fault(413, "object_size_invalid");
    const checksum = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const actualVersion = response.headers.get("x-amz-version-id");
    if (!actualVersion || actualVersion === "null" || !/^[A-Za-z0-9._:-]{1,200}$/.test(actualVersion)) throw fault(503, "versioned_bucket_required");
    return { bytes, checksum, version: actualVersion, contentType: detectContentType(bytes) };
  } finally {
    concurrentObjectReads--;
  }
}

async function s3Request(config, method, key, query = {}, headers = {}, fetchImpl = fetch) {
  const url = objectUrl(config.internalEndpoint, config.bucket, key, query);
  const body = headers.body;
  const requestHeaders = { ...headers };
  delete requestHeaders.body;
  const date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = date.slice(0, 8);
  const payloadHash = body ? createHash("sha256").update(body).digest("hex") : "UNSIGNED-PAYLOAD";
  requestHeaders.host = url.host;
  requestHeaders["x-amz-date"] = date;
  requestHeaders["x-amz-content-sha256"] = payloadHash;
  const signedNames = Object.keys(requestHeaders).map((name) => name.toLowerCase()).sort();
  const canonicalHeaders = signedNames.map((name) => `${name}:${String(requestHeaders[name]).trim().replace(/\s+/g, " ")}\n`).join("");
  const canonicalRequest = [method, url.pathname, canonicalQuery(url.searchParams), canonicalHeaders, signedNames.join(";"), payloadHash].join("\n");
  const scope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", date, scope, sha256(canonicalRequest)].join("\n");
  const signature = sign(config.secretKey, dateStamp, config.region, stringToSign);
  requestHeaders.authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKey}/${scope}, SignedHeaders=${signedNames.join(";")}, Signature=${signature}`;
  delete requestHeaders.host;
  try { return await fetchImpl(url, { method, headers: requestHeaders, ...(body ? { body } : {}), signal: AbortSignal.timeout(30_000) }); }
  catch { throw fault(502, "object_store_unavailable"); }
}

async function readCappedBody(response) {
  const reader = response.body?.getReader();
  if (!reader) throw fault(502, "object_body_missing");
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw fault(413, "object_size_invalid");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, size);
}

function presignedUrl(config, method, key, expires, headers = {}, extraQuery = {}) {
  const url = objectUrl(config.publicEndpoint, config.bucket, key);
  const now = new Date();
  const date = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = date.slice(0, 8);
  const names = ["host", ...Object.keys(headers).map((name) => name.toLowerCase())].sort();
  const scope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const params = new URLSearchParams({
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${config.accessKey}/${scope}`,
    "X-Amz-Date": date,
    "X-Amz-Expires": String(expires),
    "X-Amz-SignedHeaders": names.join(";"),
    ...extraQuery
  });
  const canonicalHeaders = names.map((name) => `${name}:${name === "host" ? url.host : String(headers[name] ?? headers[Object.keys(headers).find((header) => header.toLowerCase() === name)]).trim().replace(/\s+/g, " ")}\n`).join("");
  const canonicalRequest = [method, url.pathname, canonicalQuery(params), canonicalHeaders, names.join(";"), "UNSIGNED-PAYLOAD"].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", date, scope, sha256(canonicalRequest)].join("\n");
  params.set("X-Amz-Signature", sign(config.secretKey, dateStamp, config.region, stringToSign));
  url.search = canonicalQuery(params);
  return url.toString();
}

function objectUrl(endpoint, bucket, key, query = {}) {
  const url = new URL(endpoint);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/${awsEncode(bucket)}/${key.split("/").map(awsEncode).join("/")}`;
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  return url;
}

function canonicalQuery(params) {
  return [...params.entries()].map(([key, value]) => [awsEncode(key), awsEncode(value)]).sort(([aKey, aValue], [bKey, bValue]) => aKey.localeCompare(bKey) || aValue.localeCompare(bValue)).map(([key, value]) => `${key}=${value}`).join("&");
}

function awsEncode(value) { return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function hmac(key, value, encoding) { return createHmac("sha256", key).update(value).digest(encoding); }
function sign(secret, date, region, value) { const dateKey = hmac(`AWS4${secret}`, date); const regionKey = hmac(dateKey, region); const serviceKey = hmac(regionKey, "s3"); return hmac(hmac(serviceKey, "aws4_request"), value, "hex"); }

function detectContentType(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.length >= 12 && bytes.toString("ascii", 4, 8) === "ftyp") return "video/mp4";
  if (bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return "video/webm";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WAVE") return "audio/wav";
  if ((bytes.length >= 3 && bytes.toString("ascii", 0, 3) === "ID3") || (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return "audio/mpeg";
  if (bytes.length >= 4 && bytes.toString("ascii", 0, 4) === "OggS") return "audio/ogg";
  return null;
}

function validateConfig(config) {
  if (!config || typeof config.token !== "string" || config.token.length < 48 || typeof config.bucket !== "string" || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket)
    || typeof config.region !== "string" || !/^[a-z0-9-]{1,32}$/.test(config.region) || typeof config.accessKey !== "string" || config.accessKey.length < 8
    || typeof config.secretKey !== "string" || config.secretKey.length < 32) throw new Error("invalid_media_evidence_configuration");
  for (const endpoint of [config.internalEndpoint, config.publicEndpoint]) {
    const url = new URL(endpoint);
    const loopbackHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
    if ((url.protocol !== "https:" && !loopbackHttp) || url.username || url.password || url.search || url.hash) throw new Error("invalid_media_evidence_endpoint");
  }
  return config;
}

function authorized(header, token) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function readJson(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers["content-type"] ?? "")) throw fault(415, "json_required");
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16 * 1024) throw fault(413, "request_too_large");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw fault(400, "invalid_json"); }
}

function requireTenant(value) { if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw fault(400, "invalid_tenant"); return value.toLowerCase(); }
function requireChecksum(value) { if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/i.test(value)) throw fault(400, "invalid_checksum"); return value.toLowerCase(); }
function requireContentType(kind, value) { const type = typeof value === "string" ? value.toLowerCase().split(";", 1)[0].trim() : ""; if (!MIME_BY_KIND[kind]?.has(type)) throw fault(415, "unsupported_content_type"); return type; }
function requireObjectKey(value, tenantId) { if (typeof value !== "string" || value.length > 240 || value.includes("..") || value.includes("\\") || !value.startsWith(`${tenantId}/`) || !/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(?:jpg|png|mp4|webm|wav|mp3|ogg)$/.test(value)) throw fault(400, "invalid_object_key"); return value; }
function requireVersion(value) { if (typeof value !== "string" || value === "null" || !/^[A-Za-z0-9._:-]{1,200}$/.test(value)) throw fault(400, "invalid_object_version"); return value; }
function requireFileName(value) { if (typeof value !== "string" || value.length < 1 || value.length > 160 || /[\\/:*?"<>|\x00-\x1f\x7f]/.test(value)) throw fault(400, "invalid_file_name"); return value; }
function fault(status, code) { return Object.assign(new Error(code), { status, code }); }
function json(response, status, value) { response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }); response.end(JSON.stringify(value)); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const server = createMediaEvidenceServer(configFromEnv());
  server.listen(Number(process.env.PORT ?? 8089), "0.0.0.0");
}

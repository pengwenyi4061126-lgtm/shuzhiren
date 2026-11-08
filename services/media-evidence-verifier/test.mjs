import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { after, before, test } from "node:test";
import { createMediaEvidenceServer } from "./server.mjs";

const token = "media-evidence-test-token-0123456789-abcdefghijklmnopqrstuvwxyz";
const tenantId = "7e5d2e8d-0d40-4e46-8f2d-90cb0a5f7cc1";
const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const checksum = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
let stored;
let media;
let s3;
let mediaBase;
let uploadedObjectKey;

before(async () => {
  s3 = createHttpServer(async (request, response) => {
    if (request.method === "PUT") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      stored = { bytes: Buffer.concat(chunks), contentType: request.headers["content-type"], objectKey: request.url.split("?")[0].split("/").slice(2).join("/") };
      response.writeHead(200, { "x-amz-version-id": "version-001" }).end();
      return;
    }
    const key = request.url.split("?")[0].split("/").slice(2).join("/");
    const version = new URL(request.url, "http://localhost").searchParams.get("versionId");
    if (request.method === "GET" && stored && key === stored.objectKey && (!version || version === "version-001")) return response.writeHead(200, { "content-length": String(stored.bytes.length), "content-type": stored.contentType, "x-amz-version-id": "version-001" }).end(stored.bytes);
    response.writeHead(404).end();
  });
  await new Promise((resolve) => s3.listen(0, "127.0.0.1", resolve));
  const s3Address = s3.address();
  const endpoint = `http://127.0.0.1:${s3Address.port}`;
  media = createMediaEvidenceServer({ token, bucket: "test-media-bucket", region: "us-east-1", accessKey: "access-key-123", secretKey: "s".repeat(40), internalEndpoint: endpoint, publicEndpoint: endpoint });
  await new Promise((resolve) => media.listen(0, "127.0.0.1", resolve));
  mediaBase = `http://127.0.0.1:${media.address().port}`;
});

after(() => { media?.close(); s3?.close(); });

async function post(path, body, auth = token) {
  return fetch(`${mediaBase}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify(body) });
}

test("private media service signs a tenant-bound upload and verifies stored bytes and version", async () => {
  const checksumBase64 = Buffer.from(checksum.slice(7), "hex").toString("base64");
  const grantResponse = await post("/v1/media-evidence/upload-grant", { tenantId, kind: "portrait_photo", checksum, checksumBase64, contentType: "image/jpeg", bytes: bytes.length });
  assert.equal(grantResponse.status, 200);
  const grant = await grantResponse.json();
  uploadedObjectKey = grant.objectKey;
  assert.match(grant.objectKey, new RegExp(`^${tenantId}/[0-9a-f-]{36}\\.jpg$`));
  assert.deepEqual(Object.keys(grant.headers).sort(), ["content-type", "x-amz-checksum-sha256"]);
  assert.equal(grant.headers["content-type"], "image/jpeg");
  assertValidPresignedSignature(grant.uploadUrl, "PUT", grant.headers);
  const put = await fetch(grant.uploadUrl, { method: "PUT", headers: grant.headers, body: bytes });
  assert.equal(put.status, 200);
  assert.match(new URL(grant.uploadUrl).searchParams.get("X-Amz-Signature"), /^[a-f0-9]{64}$/);

  const verifiedResponse = await post("/v1/media-evidence/verify", { tenantId, kind: "portrait_photo", objectKey: grant.objectKey, expectedChecksum: checksum });
  assert.equal(verifiedResponse.status, 200);
  const proof = await verifiedResponse.json();
  assert.deepEqual({ objectKey: proof.objectKey, checksum: proof.checksum, objectVersion: proof.objectVersion, bytes: proof.bytes, contentType: proof.contentType }, { objectKey: grant.objectKey, checksum, objectVersion: "version-001", bytes: bytes.length, contentType: "image/jpeg" });
  assert.match(proof.evidenceRef, /^urn:media-evidence:/);
  const mismatchedChecksum = await post("/v1/media-evidence/verify", { tenantId, kind: "portrait_photo", objectKey: grant.objectKey, expectedChecksum: `sha256:${"0".repeat(64)}` });
  assert.equal(mismatchedChecksum.status, 409, "stored bytes must match requested checksum");
  const wrongKind = await post("/v1/media-evidence/verify", { tenantId, kind: "portrait", objectKey: grant.objectKey, expectedChecksum: checksum });
  assert.equal(wrongKind.status, 415, "detected content must match the declared media kind");
});

test("download grants bind the exact version, checksum and attachment name", async () => {
  const response = await post("/v1/media-evidence/download-grant", { tenantId, objectKey: uploadedObjectKey, objectVersion: "version-001", expectedChecksum: checksum, fileName: "项目成片.webm" });
  assert.equal(response.status, 200);
  const grant = await response.json();
  const download = new URL(grant.downloadUrl);
  assert.equal(download.searchParams.get("versionId"), "version-001");
  assert.match(download.searchParams.get("response-content-disposition"), /filename\*=UTF-8''/);
  assert.match(download.searchParams.get("X-Amz-Signature"), /^[a-f0-9]{64}$/);
  assertValidPresignedSignature(grant.downloadUrl, "GET", {});
  assert.equal((await post("/v1/media-evidence/download-grant", { tenantId, objectKey: "other-tenant/forged.jpg", objectVersion: "version-001", expectedChecksum: checksum, fileName: "clip.webm" })).status, 400);
});

function assertValidPresignedSignature(rawUrl, method, extraHeaders) {
  const url = new URL(rawUrl);
  const params = new URLSearchParams(url.search);
  const suppliedSignature = params.get("X-Amz-Signature");
  params.delete("X-Amz-Signature");
  const signedNames = params.get("X-Amz-SignedHeaders").split(";");
  const canonicalHeaders = signedNames.map((name) => `${name}:${name === "host" ? url.host : extraHeaders[name]}\n`).join("");
  const canonicalQuery = [...params.entries()].map(([key, value]) => [encodeAws(key), encodeAws(value)]).sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv)).map(([key, value]) => `${key}=${value}`).join("&");
  const canonicalRequest = [method, url.pathname, canonicalQuery, canonicalHeaders, signedNames.join(";"), "UNSIGNED-PAYLOAD"].join("\n");
  const date = params.get("X-Amz-Date");
  const dateStamp = date.slice(0, 8);
  const scope = params.get("X-Amz-Credential").split("/").slice(1).join("/");
  const stringToSign = ["AWS4-HMAC-SHA256", date, scope, createHash("sha256").update(canonicalRequest).digest("hex")].join("\n");
  const hmac = (key, value, encoding) => createHmac("sha256", key).update(value).digest(encoding);
  const dateKey = hmac(`AWS4${"s".repeat(40)}`, dateStamp);
  const regionKey = hmac(dateKey, "us-east-1");
  const serviceKey = hmac(regionKey, "s3");
  const signingKey = hmac(serviceKey, "aws4_request");
  assert.equal(suppliedSignature, hmac(signingKey, stringToSign, "hex"));
}

function encodeAws(value) { return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`); }

test("invalid credentials, MIME and oversized uploads fail closed", async () => {
  const badAuth = await post("/v1/media-evidence/upload-grant", {}, "wrong-token");
  assert.equal(badAuth.status, 401);
  const payload = { tenantId, kind: "portrait_photo", checksum, checksumBase64: Buffer.from(checksum.slice(7), "hex").toString("base64"), contentType: "video/mp4", bytes: bytes.length };
  assert.equal((await post("/v1/media-evidence/upload-grant", payload)).status, 415);
  assert.equal((await post("/v1/media-evidence/upload-grant", { ...payload, contentType: "image/jpeg", bytes: 100 * 1024 * 1024 + 1 })).status, 400);
});

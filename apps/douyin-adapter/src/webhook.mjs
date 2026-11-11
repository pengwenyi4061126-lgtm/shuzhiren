import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { getPath } from "./value-map.mjs";

export class WebhookValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WebhookValidationError";
    this.code = code;
  }
}

function requiredText(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(name + " must be a non-empty string");
  return value;
}

function getHeader(headers, name) {
  if (!headers || typeof name !== "string") return undefined;
  if (typeof headers.get === "function") {
    const value = headers.get(name);
    if (value !== null && value !== undefined) return String(value);
  }
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target) continue;
    if (Array.isArray(value)) return value.length ? String(value[0]) : undefined;
    return value === undefined || value === null ? undefined : String(value);
  }
  return undefined;
}

function asRawBody(rawBody) {
  if (Buffer.isBuffer(rawBody)) return rawBody.toString("utf8");
  if (typeof rawBody !== "string") throw new TypeError("rawBody must be a string or Buffer");
  return rawBody;
}

function signatureInput({ rawBody, timestamp, input }) {
  if (typeof input === "function") return String(input({ rawBody, timestamp }));
  if (input === "raw_body") return rawBody;
  if (input === "timestamp.raw_body") return String(timestamp) + "." + rawBody;
  if (input === "timestamp+raw_body") return String(timestamp) + rawBody;
  throw new TypeError("Unsupported signature input mode");
}

function signatureConfig(config) {
  if (!config || typeof config !== "object") throw new TypeError("signature config is required");
  requiredText(config.header, "signature.header");
  requiredText(config.secret, "signature.secret");
  if (config.input === undefined) throw new TypeError("signature.input must be configured explicitly");
  const algorithm = config.algorithm ?? "sha256";
  const encoding = config.encoding ?? "hex";
  const prefix = config.prefix ?? "";
  if (!["hex", "base64", "base64url"].includes(encoding)) throw new TypeError("signature.encoding must be hex, base64, or base64url");
  if (config.timestampHeader !== undefined) requiredText(config.timestampHeader, "signature.timestampHeader");
  if (config.maxAgeMs !== undefined && (!Number.isFinite(config.maxAgeMs) || config.maxAgeMs < 0)) throw new TypeError("signature.maxAgeMs must be non-negative");
  return { ...config, algorithm, encoding, prefix };
}

function timestampMs(value, format = "unix_seconds") {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  if (format === "raw") return Number(value);
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return undefined;
  if (format === "unix_milliseconds") return numeric;
  if (format === "unix_seconds") return numeric * 1000;
  throw new TypeError("Unsupported timestamp format");
}

function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createWebhookSignature({ rawBody, secret, timestamp, input = "raw_body", algorithm = "sha256", encoding = "hex", prefix = "" }) {
  const body = asRawBody(rawBody);
  requiredText(secret, "secret");
  const inputValue = signatureInput({ rawBody: body, timestamp, input });
  return prefix + createHmac(algorithm, secret).update(inputValue).digest(encoding);
}

export function verifyWebhookSignature({ rawBody, headers, signature: config, now = Date.now } = {}) {
  const body = asRawBody(rawBody);
  const settings = signatureConfig(config);
  const supplied = getHeader(headers, settings.header);
  if (!supplied) return false;
  const timestamp = settings.timestampHeader ? getHeader(headers, settings.timestampHeader) : undefined;
  if (settings.timestampHeader && !timestamp) return false;
  if (timestamp !== undefined && settings.maxAgeMs !== undefined) {
    const parsedTimestamp = timestampMs(timestamp, settings.timestampFormat);
    const current = typeof now === "function" ? now() : now;
    if (!Number.isFinite(parsedTimestamp) || !Number.isFinite(current) || Math.abs(Number(current) - parsedTimestamp) > settings.maxAgeMs) return false;
  }
  const expected = createWebhookSignature({ rawBody: body, secret: settings.secret, timestamp, input: settings.input, algorithm: settings.algorithm, encoding: settings.encoding, prefix: settings.prefix });
  return constantTimeEqual(supplied, expected);
}

export function createMemoryIdempotencyStore({ now = Date.now, ttlMs = 24 * 60 * 60 * 1000, maxEntries = 10000 } = {}) {
  if (!Number.isInteger(ttlMs) || ttlMs <= 0) throw new TypeError("ttlMs must be a positive integer");
  if (!Number.isInteger(maxEntries) || maxEntries <= 0) throw new TypeError("maxEntries must be a positive integer");
  const entries = new Map();
  const currentMs = () => {
    const value = typeof now === "function" ? now() : now;
    if (!Number.isFinite(value)) throw new TypeError("now must resolve to a finite millisecond timestamp");
    return Number(value);
  };
  const purge = (at) => {
    for (const [messageId, entry] of entries) if (entry.expiresAt <= at) entries.delete(messageId);
  };
  return {
    check(messageId, fingerprint, at = currentMs()) {
      requiredText(messageId, "messageId");
      requiredText(fingerprint, "fingerprint");
      purge(at);
      const existing = entries.get(messageId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new WebhookValidationError("message_id_conflict", "Msg-Id was reused with a different payload");
        return { duplicate: true };
      }
      if (entries.size >= maxEntries) throw new WebhookValidationError("idempotency_store_full", "Webhook idempotency store is full");
      entries.set(messageId, { fingerprint, expiresAt: Number(at) + ttlMs });
      return { duplicate: false };
    },
    get size() {
      purge(currentMs());
      return entries.size;
    },
    clear() {
      entries.clear();
    }
  };
}

export function validateWebhookConfig(config) {
  if (!config || typeof config !== "object") throw new TypeError("webhook config is required");
  requiredText(config.challengeField, "challengeField");
  requiredText(config.challengeResponseField, "challengeResponseField");
  if (config.msgIdHeader === undefined && config.msgIdBodyPath === undefined) throw new TypeError("msgIdHeader or msgIdBodyPath must be configured");
  if (config.msgIdHeader !== undefined) requiredText(config.msgIdHeader, "msgIdHeader");
  signatureConfig(config.signature);
  return { allowChallengeWithoutMsgId: true, ...config, signature: signatureConfig(config.signature) };
}

export async function parseWebhookRequest({
  rawBody,
  headers = {},
  config,
  idempotencyStore,
  now = Date.now
} = {}) {
  const settings = validateWebhookConfig(config);
  const body = asRawBody(rawBody);
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new WebhookValidationError("invalid_json", "Webhook body is not valid JSON");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new WebhookValidationError("invalid_payload", "Webhook body must be a JSON object");
  }

  const challenge = getPath(payload, settings.challengeField);
  const skipChallengeSignature = challenge !== undefined && settings.signature.verifySignature === false;
  if (!skipChallengeSignature && !verifyWebhookSignature({ rawBody: body, headers, signature: settings.signature, now })) {
    throw new WebhookValidationError("invalid_signature", "Webhook signature verification failed");
  }
  if (challenge !== undefined) {
    if (!["string", "number"].includes(typeof challenge) || String(challenge) === "") throw new WebhookValidationError("invalid_challenge", "Webhook challenge must be a non-empty scalar");
    const challengeValue = String(challenge);
    const challengeMessageId = resolveMessageId(payload, headers, settings);
    if (!challengeMessageId && !settings.allowChallengeWithoutMsgId) throw new WebhookValidationError("missing_message_id", "Msg-Id is required");
    return {
      kind: "challenge",
      challenge: challengeValue,
      response: { [settings.challengeResponseField]: challengeValue },
      messageId: challengeMessageId,
      payload,
      duplicate: false
    };
  }

  const messageId = resolveMessageId(payload, headers, settings);
  if (!messageId) throw new WebhookValidationError("missing_message_id", "Msg-Id is required");
  const fingerprint = createHash("sha256").update(body).digest("hex");
  const dedupe = idempotencyStore ? await idempotencyStore.check(messageId, fingerprint) : { duplicate: false };
  return { kind: "event", messageId, payload, fingerprint, duplicate: Boolean(dedupe.duplicate) };
}

export function createWebhookParser(config, { idempotencyStore, now = Date.now } = {}) {
  const settings = validateWebhookConfig(config);
  return {
    parse(request) {
      return parseWebhookRequest({ ...request, config: settings, idempotencyStore, now: request?.now ?? now });
    }
  };
}

function resolveMessageId(payload, headers, config) {
  const headerValue = config.msgIdHeader ? getHeader(headers, config.msgIdHeader) : undefined;
  const bodyValue = config.msgIdBodyPath === undefined ? undefined : getPath(payload, config.msgIdBodyPath);
  const value = headerValue ?? bodyValue;
  if (value === undefined || value === null || value === "") return undefined;
  const normalized = String(value).trim();
  if (!normalized || normalized.length > 200) throw new WebhookValidationError("invalid_message_id", "Msg-Id must be 1-200 characters");
  return normalized;
}

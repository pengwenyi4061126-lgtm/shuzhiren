import { createHash, timingSafeEqual } from "node:crypto";
import { createDouyinApiClient } from "./api.mjs";
import {
  buildAuthorizationUrl,
  consumeOAuthCallback,
  createOAuthStateStore,
  createOAuthTransaction
} from "./oauth.mjs";
import { createTokenClient } from "./token.mjs";
import {
  normalizeBillingResponse,
  normalizeProductResponse,
  ResponseNormalizationError
} from "./normalize.mjs";
import {
  createMemoryIdempotencyStore,
  createWebhookParser,
  parseWebhookRequest,
  WebhookValidationError
} from "./webhook.mjs";
import { getPath, readMappedValue } from "./value-map.mjs";

const DEFAULT_DOUYIN_CHALLENGE_PATH = ["content", "challenge"];
const DEFAULT_DOUYIN_SIGNATURE_HEADER = "X-Douyin-Signature";
const DEFAULT_DOUYIN_MESSAGE_ID_HEADER = "Msg-Id";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asQuery(value) {
  if (typeof value === "string" || value instanceof URL) {
    return new URL(value, "https://adapter.invalid").searchParams;
  }
  return value;
}

function normalizeScope(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) return value.trim().split(/\s+/);
  return [];
}

function normalizeOAuthOptions(options) {
  const oauth = options.oauth ?? {};
  const nestedToken = oauth.token ?? {};
  const token = { ...nestedToken, ...(options.token ?? {}) };
  const clientId = oauth.clientId ?? token.clientId;
  const redirectUri = oauth.redirectUri ?? token.redirectUri;
  const tokenEndpoint = token.tokenEndpoint ?? oauth.tokenEndpoint;
  const authorizationParameterNames = {
    ...(oauth.authorization?.parameterNames ?? {})
  };
  if (oauth.authorization?.clientIdParam) authorizationParameterNames.clientId = oauth.authorization.clientIdParam;
  if (oauth.authorization?.redirectUriParam) authorizationParameterNames.redirectUri = oauth.authorization.redirectUriParam;
  if (oauth.authorization?.scopeParam) authorizationParameterNames.scope = oauth.authorization.scopeParam;
  if (oauth.authorization?.stateParam) authorizationParameterNames.state = oauth.authorization.stateParam;
  if (oauth.authorization?.nonceParam) authorizationParameterNames.nonce = oauth.authorization.nonceParam;

  const requestFieldNames = {
    ...(token.requestFieldNames ?? {})
  };
  if (token.clientIdParam) requestFieldNames.clientId = token.clientIdParam;
  if (token.clientSecretParam) requestFieldNames.clientSecret = token.clientSecretParam;
  if (token.grantTypeParam) requestFieldNames.grantType = token.grantTypeParam;
  if (token.codeParam) requestFieldNames.code = token.codeParam;
  if (token.refreshTokenParam) requestFieldNames.refreshToken = token.refreshTokenParam;
  if (token.redirectUriParam) requestFieldNames.redirectUri = token.redirectUriParam;
  if (token.scopeParam) requestFieldNames.scope = token.scopeParam;

  return {
    oauth,
    token: {
      ...token,
      clientId,
      redirectUri,
      tokenEndpoint,
      requestFieldNames,
      requestEncoding: token.requestEncoding === "multipart/form-data" ? "form" : (token.requestEncoding ?? "form")
    },
    authorizationEndpoint: oauth.authorizationEndpoint,
    clientId,
    redirectUri,
    scope: normalizeScope(oauth.scope ?? oauth.scopes),
    parameterNames: authorizationParameterNames
  };
}

function legacyTokenShape(token) {
  if (!token || typeof token.expiresAt !== "number") return token;
  return { ...token, expiresAt: new Date(token.expiresAt).toISOString() };
}

function parseCsv(text) {
  if (typeof text !== "string") throw new TypeError("CSV input must be a string");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field.length === 0) {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (quoted) throw new Error("CSV contains an unterminated quoted field");
  if (field.length || row.length) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  if (!rows.length) return [];
  const headers = rows.shift();
  return rows
    .filter((values) => values.some((value) => value !== ""))
    .map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

function normalizeLegacyCsv(csv, config) {
  if (!config || !isObject(config.fields)) throw new TypeError("billing.fields mapping must be configured explicitly");
  const rows = parseCsv(csv);
  const items = rows.map((raw, index) => {
    const item = {};
    for (const [field, mapping] of Object.entries(config.fields)) {
      const value = readMappedValue(raw, mapping, { fieldName: `billing.${field}`, required: field === "id" });
      if (value !== undefined) item[field] = value;
    }
    if (item.id === undefined || item.id === null || String(item.id).trim() === "") {
      throw new ResponseNormalizationError("missing_id", `billing item at index ${index} has no id`);
    }
    return { ...item, raw };
  });
  return { items };
}

function normalizeLegacyResponse(payload, config, normalizer, key, type) {
  const normalized = normalizer(payload, config);
  const sourceItems = getPath(payload, config.itemsPath);
  const items = normalized[key].map((item, index) => ({ ...item, raw: sourceItems[index] }));
  return { items, ...(normalized.pagination ? { pagination: normalized.pagination } : {}) };
}

function normalizeSignatureConfig(webhook) {
  const source = webhook.signature ?? {};
  const signature = {
    ...source,
    header: source.header ?? source.signatureHeader,
    secret: source.secret ?? webhook.secret,
    input: source.input ?? source.signingInput ?? "raw_body",
    timestampFormat: source.timestampFormat ?? (source.timestampHeader ? "unix_milliseconds" : undefined),
    verifySignature: source.verifySignature ?? webhook.challenge?.verifySignature
  };
  delete signature.signatureHeader;
  delete signature.signingInput;
  return signature;
}

function normalizeWebhookConfig(webhook) {
  const challenge = webhook.challenge ?? {};
  return {
    challengeField: webhook.challengeField ?? challenge.requestField,
    challengeResponseField: webhook.challengeResponseField ?? challenge.responseField,
    msgIdHeader: webhook.msgIdHeader ?? DEFAULT_DOUYIN_MESSAGE_ID_HEADER,
    msgIdBodyPath: webhook.msgIdBodyPath,
    allowChallengeWithoutMsgId: webhook.allowChallengeWithoutMsgId ?? true,
    signature: normalizeSignatureConfig(webhook)
  };
}

function safeDigestEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function asBody(rawBody) {
  if (Buffer.isBuffer(rawBody)) return rawBody.toString("utf8");
  if (typeof rawBody !== "string") throw new TypeError("rawBody must be a string or Buffer");
  return rawBody;
}

async function parseDefaultDouyinWebhook({ rawBody, headers = {}, secret, idempotencyStore }) {
  const body = asBody(rawBody);
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new WebhookValidationError("invalid_json", "Webhook body is not valid JSON");
  }
  if (!isObject(payload)) throw new WebhookValidationError("invalid_payload", "Webhook body must be a JSON object");
  const challenge = getPath(payload, DEFAULT_DOUYIN_CHALLENGE_PATH);
  if (challenge !== undefined) {
    if (!["string", "number"].includes(typeof challenge) || String(challenge) === "") {
      throw new WebhookValidationError("invalid_challenge", "Webhook challenge must be a non-empty scalar");
    }
    const value = String(challenge);
    return { kind: "challenge", challenge: value, response: { challenge: value }, payload, duplicate: false };
  }
  if (typeof secret !== "string" || !secret) throw new TypeError("webhook.secret must be configured");
  const supplied = Object.entries(headers).find(([key]) => key.toLowerCase() === DEFAULT_DOUYIN_SIGNATURE_HEADER.toLowerCase())?.[1]
    ?? headers.get?.(DEFAULT_DOUYIN_SIGNATURE_HEADER);
  const expected = createHash("sha1").update(secret + body).digest("hex");
  if (!supplied || !safeDigestEqual(supplied, expected)) {
    throw new WebhookValidationError("invalid_signature", "Webhook signature verification failed");
  }
  const messageId = Object.entries(headers).find(([key]) => key.toLowerCase() === DEFAULT_DOUYIN_MESSAGE_ID_HEADER.toLowerCase())?.[1]
    ?? headers.get?.(DEFAULT_DOUYIN_MESSAGE_ID_HEADER);
  if (!messageId) throw new WebhookValidationError("missing_message_id", "Msg-Id is required");
  const fingerprint = createHash("sha256").update(body).digest("hex");
  const dedupe = idempotencyStore ? idempotencyStore.check(String(messageId), fingerprint) : { duplicate: false };
  return { kind: "event", messageId: String(messageId), payload, fingerprint, duplicate: Boolean(dedupe.duplicate) };
}

export function createDouyinAdapter(options = {}) {
  const normalized = normalizeOAuthOptions(options);
  const now = options.now ?? Date.now;
  const stateStore = createOAuthStateStore({ now, maxEntries: options.oauth?.maxStateEntries ?? 1000 });
  const legacyNormalization = options.normalization !== undefined;
  const legacyContract = legacyNormalization
    || options.oauth?.scopes !== undefined
    || options.oauth?.authorization?.clientIdParam !== undefined
    || options.oauth?.token !== undefined;
  if (legacyNormalization) {
    if (!isObject(options.normalization.product) || !Object.keys(options.normalization.product).length) {
      throw new TypeError("product.normalization profile is required");
    }
    if (options.normalization.product.itemsPath === undefined) {
      throw new TypeError("product.itemsPath must be configured explicitly");
    }
    if (!isObject(options.normalization.billing) || !Object.keys(options.normalization.billing).length) {
      throw new TypeError("billing.normalization profile is required");
    }
    if (options.normalization.billing.itemsPath === undefined) {
      throw new TypeError("billing.itemsPath must be configured explicitly");
    }
  }
  const defaultProductConfig = legacyNormalization ? options.normalization.product : options.productResponse;
  const defaultBillingConfig = legacyNormalization ? options.normalization.billing : options.billingResponse;
  const fetchImpl = options.fetchImpl ?? fetch;
  const tokenConfig = normalized.token;
  const webhookOptions = options.webhook;
  const defaultDouyinWebhook = Boolean(webhookOptions?.secret)
    && !webhookOptions.challengeField
    && !webhookOptions.challenge
    && !webhookOptions.signature?.header
    && !webhookOptions.signature?.signatureHeader;
  const idempotencyStore = createMemoryIdempotencyStore({ now, ttlMs: webhookOptions?.idempotencyTtlMs ?? 24 * 60 * 60 * 1000 });
  const webhookConfig = webhookOptions && !defaultDouyinWebhook ? normalizeWebhookConfig(webhookOptions) : undefined;
  const webhookParser = webhookConfig ? createWebhookParser(webhookConfig, { idempotencyStore, now }) : undefined;

  function startOAuth() {
    const transaction = createOAuthTransaction({
      now,
      ttlMs: normalized.oauth.stateTtlMs ?? normalized.oauth.ttlMs,
      stateBytes: normalized.oauth.stateBytes ?? 32,
      nonceBytes: normalized.oauth.nonceBytes ?? 32
    });
    stateStore.put(transaction);
    const authorizationUrl = buildAuthorizationUrl({
      authorizationEndpoint: normalized.authorizationEndpoint,
      clientId: normalized.clientId,
      redirectUri: normalized.redirectUri,
      transaction,
      scope: normalized.scope,
      parameterNames: normalized.parameterNames
    });
    return { authorizationUrl, transaction, state: transaction.state, nonce: transaction.nonce };
  }

  function validateOAuthCallback(query, { requireNonce = false, actualNonce, now: callbackNow } = {}) {
    return consumeOAuthCallback({
      store: stateStore,
      query: asQuery(query),
      now: callbackNow ?? now,
      requireNonce,
      actualNonce
    });
  }

  function getTokenClient(clientSecretOverride) {
    const effectiveSecret = clientSecretOverride ?? tokenConfig.clientSecret;
    return createTokenClient({
      ...tokenConfig,
      clientSecret: effectiveSecret,
      clientAuthentication: tokenConfig.clientAuthentication ?? (effectiveSecret ? "client_secret_post" : "none"),
      fetchImpl,
      now,
      requestEncoding: tokenConfig.requestEncoding === "multipart/form-data" ? "form" : tokenConfig.requestEncoding
    });
  }

  async function exchangeCodeForToken({ code, redirectUri, scope, clientSecret, extraParams } = {}) {
    const token = await getTokenClient(clientSecret).exchangeCodeForToken({ code, redirectUri, scope, extraParams });
    return legacyContract ? legacyTokenShape(token) : token;
  }

  async function refreshAccessToken({ refreshToken, scope, clientSecret, extraParams } = {}) {
    const token = await getTokenClient(clientSecret).refreshAccessToken({ refreshToken, scope, extraParams });
    return legacyContract ? legacyTokenShape(token) : token;
  }

  async function completeOAuth({ callback, nonce, clientSecret } = {}) {
    const query = asQuery(callback);
    const validated = validateOAuthCallback(query, { requireNonce: nonce !== undefined, actualNonce: nonce });
    return exchangeCodeForToken({ code: validated.code, clientSecret });
  }

  async function parseWebhook(request = {}) {
    if (defaultDouyinWebhook) {
      return parseDefaultDouyinWebhook({ ...request, secret: webhookOptions.secret, idempotencyStore });
    }
    return webhookParser.parse(request);
  }

  async function handleWebhook(request = {}) {
    try {
      const parsed = await parseWebhook(request);
      if (parsed.kind === "challenge") return { status: 200, body: parsed.response, kind: "challenge", msgId: parsed.messageId };
      if (parsed.duplicate) return { status: 200, kind: "duplicate", msgId: parsed.messageId };
      return { status: 202, kind: "event", msgId: parsed.messageId, payload: parsed.payload };
    } catch (error) {
      const status = error?.code === "invalid_json" ? 400 : 401;
      return { status, error: error?.code ?? "webhook_error", message: error?.message ?? String(error) };
    }
  }

  function normalizeProducts(payload, overrideConfig) {
    const config = arguments.length >= 2 ? overrideConfig : defaultProductConfig;
    if (legacyNormalization && arguments.length < 2) return normalizeLegacyResponse(payload, config, normalizeProductResponse, "products", "products");
    return normalizeProductResponse(payload, config);
  }

  function normalizeBilling(payload, overrideConfig) {
    const config = arguments.length >= 2 ? overrideConfig : defaultBillingConfig;
    if (legacyNormalization && arguments.length < 2) return normalizeLegacyResponse(payload, config, normalizeBillingResponse, "records", "billing");
    return normalizeBillingResponse(payload, config);
  }

  function normalizeBillingCsv(csv, overrideConfig) {
    const config = arguments.length >= 2 ? overrideConfig : defaultBillingConfig;
    return normalizeLegacyCsv(csv, config);
  }

  return {
    api: (apiOptions = {}) => createDouyinApiClient({ ...apiOptions, fetchImpl }),
    startOAuth,
    completeOAuth,
    validateOAuthCallback,
    exchangeCodeForToken,
    refreshAccessToken,
    refreshToken: refreshAccessToken,
    parseWebhook,
    handleWebhook,
    normalizeProducts,
    normalizeBilling,
    normalizeBillingCsv,
    get stateCount() { return stateStore.size; },
    get idempotencyCount() { return idempotencyStore.size; }
  };
}


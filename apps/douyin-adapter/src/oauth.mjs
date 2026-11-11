import { randomBytes, timingSafeEqual } from "node:crypto";

export const DEFAULT_OAUTH_TTL_MS = 10 * 60 * 1000;

export class OAuthCallbackError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OAuthCallbackError";
    this.code = code;
  }
}

function nowMs(value) {
  const result = typeof value === "function" ? value() : value;
  if (!Number.isFinite(result)) throw new TypeError("now must resolve to a finite millisecond timestamp");
  return Number(result);
}

function requiredText(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(name + " must be a non-empty string");
  return value;
}

function httpUrl(value, name) {
  let url;
  try {
    url = new URL(requiredText(value, name));
  } catch {
    throw new TypeError(name + " must be an HTTP(S) URL");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new TypeError(name + " must be an HTTP(S) URL");
  if (url.username || url.password) throw new TypeError(name + " must not contain embedded credentials");
  return url;
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function queryValue(query, name) {
  if (query instanceof URLSearchParams) return query.get(name) ?? undefined;
  if (query && typeof query.get === "function") {
    const value = query.get(name);
    return value === null ? undefined : value;
  }
  const value = query?.[name];
  return Array.isArray(value) ? value[0] : value;
}

export function createOAuthTransaction({
  now = Date.now,
  ttlMs = DEFAULT_OAUTH_TTL_MS,
  stateBytes = 32,
  nonceBytes = 32,
  randomBytesImpl = randomBytes,
  metadata = {}
} = {}) {
  if (!Number.isInteger(ttlMs) || ttlMs <= 0) throw new TypeError("ttlMs must be a positive integer");
  if (!Number.isInteger(stateBytes) || stateBytes < 16) throw new TypeError("stateBytes must be at least 16");
  if (!Number.isInteger(nonceBytes) || nonceBytes < 16) throw new TypeError("nonceBytes must be at least 16");
  if (typeof randomBytesImpl !== "function") throw new TypeError("randomBytesImpl must be a function");
  const createdAt = nowMs(now);
  const state = randomBytesImpl(stateBytes).toString("base64url");
  const nonce = randomBytesImpl(nonceBytes).toString("base64url");
  if (!state || !nonce) throw new Error("randomBytesImpl returned an empty value");
  return Object.freeze({ state, nonce, createdAt, expiresAt: createdAt + ttlMs, ...metadata });
}

export function createOAuthStateStore({ now = Date.now, maxEntries = 1000 } = {}) {
  if (!Number.isInteger(maxEntries) || maxEntries <= 0) throw new TypeError("maxEntries must be a positive integer");
  const entries = new Map();

  function purge() {
    const current = nowMs(now);
    for (const [state, transaction] of entries) {
      if (transaction.expiresAt <= current) entries.delete(state);
    }
  }

  return {
    put(transaction) {
      if (!transaction || typeof transaction.state !== "string" || typeof transaction.nonce !== "string" || !Number.isFinite(transaction.expiresAt)) {
        throw new TypeError("transaction must contain state, nonce, and expiresAt");
      }
      purge();
      if (entries.size >= maxEntries && !entries.has(transaction.state)) throw new Error("oauth_state_store_full");
      entries.set(transaction.state, transaction);
      return transaction;
    },
    peek(state) {
      purge();
      const transaction = entries.get(state);
      return transaction ? { ...transaction } : undefined;
    },
    take(state) {
      purge();
      const transaction = entries.get(state);
      if (transaction) entries.delete(state);
      return transaction;
    },
    get size() {
      purge();
      return entries.size;
    }
  };
}

export function buildAuthorizationUrl({
  authorizationEndpoint,
  clientId,
  redirectUri,
  transaction,
  scope = [],
  responseType = "code",
  parameterNames = {},
  extraParams = {}
}) {
  const endpoint = httpUrl(authorizationEndpoint, "authorizationEndpoint");
  requiredText(clientId, "clientId");
  requiredText(redirectUri, "redirectUri");
  if (!transaction || typeof transaction.state !== "string" || typeof transaction.nonce !== "string") throw new TypeError("transaction must contain state and nonce");
  const names = {
    responseType: "response_type",
    clientId: "client_id",
    redirectUri: "redirect_uri",
    scope: "scope",
    state: "state",
    nonce: "nonce",
    ...parameterNames
  };
  const params = new URLSearchParams();
  params.set(names.responseType, responseType);
  params.set(names.clientId, clientId);
  params.set(names.redirectUri, redirectUri);
  params.set(names.state, transaction.state);
  params.set(names.nonce, transaction.nonce);
  if (Array.isArray(scope) && scope.length) params.set(names.scope, scope.join(" "));
  else if (typeof scope === "string" && scope.trim()) params.set(names.scope, scope.trim());
  for (const [key, value] of Object.entries(extraParams)) {
    if (value === undefined || value === null) continue;
    if ([names.responseType, names.clientId, names.redirectUri, names.scope, names.state, names.nonce].includes(key)) {
      throw new Error("extraParams cannot override OAuth core parameter: " + key);
    }
    params.set(key, String(value));
  }
  endpoint.search = endpoint.search ? endpoint.search + "&" + params.toString() : "?" + params.toString();
  return endpoint.toString();
}

export function createAuthorizationRequest(options = {}) {
  const transaction = createOAuthTransaction(options);
  const authorizationUrl = buildAuthorizationUrl({ ...options, transaction });
  return { transaction, authorizationUrl };
}

export function validateOAuthCallback({
  query,
  transaction,
  now = Date.now,
  stateParam = "state",
  codeParam = "code",
  errorParam = "error",
  nonceParam = "nonce",
  requireNonce = false,
  actualNonce
}) {
  if (!transaction || typeof transaction.state !== "string" || typeof transaction.nonce !== "string") {
    throw new OAuthCallbackError("missing_transaction", "OAuth transaction is missing");
  }
  const providerError = queryValue(query, errorParam);
  if (providerError) throw new OAuthCallbackError("provider_error", "OAuth provider returned error: " + providerError);
  const state = queryValue(query, stateParam);
  if (!state || !safeEqual(state, transaction.state)) throw new OAuthCallbackError("invalid_state", "OAuth state mismatch");
  if (nowMs(now) > transaction.expiresAt) throw new OAuthCallbackError("expired_state", "OAuth state has expired");
  const code = queryValue(query, codeParam);
  if (!code || typeof code !== "string") throw new OAuthCallbackError("missing_code", "OAuth callback code is missing");
  const returnedNonce = actualNonce ?? queryValue(query, nonceParam);
  if (requireNonce && !returnedNonce) throw new OAuthCallbackError("missing_nonce", "OAuth callback nonce is missing");
  if (returnedNonce !== undefined && (!returnedNonce || !safeEqual(returnedNonce, transaction.nonce))) {
    throw new OAuthCallbackError("invalid_nonce", "OAuth nonce mismatch");
  }
  return { code, state, nonce: transaction.nonce, transaction: { ...transaction } };
}

export function consumeOAuthCallback({ store, query, now = Date.now, ...options }) {
  if (!store || typeof store.take !== "function") throw new TypeError("store with take(state) is required");
  const state = queryValue(query, options.stateParam ?? "state");
  const transaction = state ? store.take(state) : undefined;
  if (!transaction) throw new OAuthCallbackError("state_not_found", "OAuth state is unknown or expired, or was already consumed");
  return validateOAuthCallback({ query, transaction, now, ...options });
}

import { Buffer } from "node:buffer";
import { getPath, readMappedValue } from "./value-map.mjs";

export class TokenEndpointError extends Error {
  constructor(message, { status, payload } = {}) {
    super(message);
    this.name = "TokenEndpointError";
    this.status = status;
    this.payload = payload;
  }
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
  return url.toString();
}

function numericExpiresIn(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error("expires_in must be a non-negative safe integer");
  return number;
}

function parseJsonBody(text) {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("token response must be a JSON object");
    return parsed;
  } catch (error) {
    if (error instanceof SyntaxError) throw new TokenEndpointError("Token endpoint returned invalid JSON", { payload: text });
    throw error;
  }
}

export function normalizeTokenResponse(payload, {
  fieldMap = {},
  existingRefreshToken,
  now = Date.now,
  includeRaw = false
} = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new TypeError("token response must be an object");
  const explicitEnvelope = fieldMap.envelope === undefined ? undefined : getPath(payload, fieldMap.envelope);
  const legacyEnvelope = explicitEnvelope !== undefined || (!fieldMap.accessToken && !fieldMap.refreshToken && payload.data && typeof payload.data === "object" && !Array.isArray(payload.data) && Object.hasOwn(payload.data, "access_token"));
  const source = explicitEnvelope ?? (legacyEnvelope ? payload.data : payload);
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new TypeError("configured token envelope must resolve to an object");
  const accessToken = readMappedValue(source, fieldMap.accessToken ?? "access_token", { fieldName: "accessToken", required: true });
  if (typeof accessToken !== "string" || !accessToken) throw new Error("accessToken must be a non-empty string");
  const tokenTypeValue = readMappedValue(source, fieldMap.tokenType ?? "token_type", { fieldName: "tokenType" });
  const refreshTokenValue = readMappedValue(source, fieldMap.refreshToken ?? "refresh_token", { fieldName: "refreshToken" });
  const scopeValue = readMappedValue(source, fieldMap.scope ?? "scope", { fieldName: "scope" });
  const expiresInValue = readMappedValue(source, fieldMap.expiresIn ?? "expires_in", { fieldName: "expiresIn" });
  const expiresIn = numericExpiresIn(expiresInValue);
  const expiresAtValue = readMappedValue(source, fieldMap.expiresAt, { fieldName: "expiresAt" });
  const refreshExpiresInValue = readMappedValue(source, fieldMap.refreshExpiresIn ?? "refresh_expires_in", { fieldName: "refreshExpiresIn" });
  const refreshExpiresIn = numericExpiresIn(refreshExpiresInValue);
  const openIdValue = readMappedValue(source, fieldMap.openId ?? "open_id", { fieldName: "openId" });
  const issuedAt = typeof now === "function" ? now() : now;
  if (!Number.isFinite(issuedAt)) throw new TypeError("now must resolve to a finite millisecond timestamp");
  const expiresAt = expiresAtValue === undefined ? (expiresIn === undefined ? undefined : Number(issuedAt) + expiresIn * 1000) : expiresAtValue;
  const refreshToken = refreshTokenValue ?? existingRefreshToken;
  const normalized = {
    accessToken,
    tokenType: tokenTypeValue === undefined ? "Bearer" : String(tokenTypeValue)
  };
  if (refreshToken !== undefined) normalized.refreshToken = String(refreshToken);
  if (scopeValue !== undefined) {
    normalized.scope = legacyEnvelope
      ? (Array.isArray(scopeValue) ? scopeValue : String(scopeValue).split(/\s+/).filter(Boolean))
      : (typeof scopeValue === "string" ? scopeValue : String(scopeValue));
  }
  if (expiresIn !== undefined) normalized.expiresIn = expiresIn;
  if (expiresAt !== undefined) normalized.expiresAt = expiresAt;
  if (refreshExpiresIn !== undefined) normalized.refreshExpiresIn = refreshExpiresIn;
  if (openIdValue !== undefined) normalized.openId = String(openIdValue);
  if (includeRaw) normalized.raw = payload;
  return normalized;
}

function addFormValue(values, name, value) {
  if (value !== undefined && value !== null) values.set(name, String(value));
}

export function createTokenClient({
  tokenEndpoint,
  clientId,
  clientSecret,
  redirectUri,
  fetchImpl = fetch,
  clientAuthentication = "client_secret_post",
  requestEncoding = "form",
  requestFieldNames = {},
  tokenFieldMap = {},
  tokenResponseIncludeRaw = false,
  now = Date.now,
  defaultHeaders = {}
}) {
  const endpoint = httpUrl(tokenEndpoint, "tokenEndpoint");
  requiredText(clientId, "clientId");
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  if (!["client_secret_post", "client_secret_basic", "none"].includes(clientAuthentication)) throw new TypeError("Unsupported clientAuthentication");
  if (!["form", "json", "multipart/form-data"].includes(requestEncoding)) throw new TypeError("requestEncoding must be form, json, or multipart/form-data");
  if (clientAuthentication !== "none") requiredText(clientSecret, "clientSecret");
  const names = {
    grantType: "grant_type",
    code: "code",
    refreshToken: "refresh_token",
    clientId: "client_id",
    clientSecret: "client_secret",
    redirectUri: "redirect_uri",
    scope: "scope",
    ...requestFieldNames
  };

  async function requestToken(values, existingRefreshToken) {
    const headers = { accept: "application/json", ...defaultHeaders };
    const payload = Object.fromEntries(values);
    if (clientAuthentication === "client_secret_post") {
      payload[names.clientId] = clientId;
      payload[names.clientSecret] = clientSecret;
    } else if (clientAuthentication === "client_secret_basic") {
      payload[names.clientId] = clientId;
      headers.authorization = "Basic " + Buffer.from(clientId + ":" + clientSecret).toString("base64");
    } else {
      payload[names.clientId] = clientId;
    }
    let body;
    if (requestEncoding === "json") {
      headers["content-type"] = "application/json";
      body = JSON.stringify(payload);
    } else {
      headers["content-type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(payload).toString();
    }
    let response;
    try {
      response = await fetchImpl(endpoint, { method: "POST", headers, body });
    } catch (error) {
      throw new TokenEndpointError("Token endpoint request failed", { payload: error });
    }
    let parsed;
    if (typeof response.text === "function") {
      parsed = parseJsonBody(await response.text());
    } else if (typeof response.json === "function") {
      try {
        parsed = await response.json();
      } catch (error) {
        throw new TokenEndpointError("Token endpoint returned invalid JSON", { payload: error });
      }
    } else {
      parsed = {};
    }
    if (!response.ok) throw new TokenEndpointError("Token endpoint rejected request", { status: response.status, payload: parsed });
    return normalizeTokenResponse(parsed, { fieldMap: tokenFieldMap, existingRefreshToken, now, includeRaw: tokenResponseIncludeRaw });
  }

  return {
    exchangeCodeForToken({ code, redirectUri: overrideRedirectUri, scope, extraParams = {} } = {}) {
      requiredText(code, "code");
      const values = new Map();
      values.set(names.grantType, "authorization_code");
      values.set(names.code, code);
      addFormValue(values, names.redirectUri, overrideRedirectUri ?? redirectUri);
      addFormValue(values, names.scope, scope);
      for (const [key, value] of Object.entries(extraParams)) addFormValue(values, key, value);
      return requestToken(values);
    },
    refreshAccessToken({ refreshToken, scope, extraParams = {} } = {}) {
      requiredText(refreshToken, "refreshToken");
      const values = new Map();
      values.set(names.grantType, "refresh_token");
      values.set(names.refreshToken, refreshToken);
      addFormValue(values, names.scope, scope);
      for (const [key, value] of Object.entries(extraParams)) addFormValue(values, key, value);
      return requestToken(values, refreshToken);
    }
  };
}

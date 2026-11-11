import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  OAuthCallbackError,
  ResponseNormalizationError,
  TokenEndpointError,
  WebhookValidationError,
  createDouyinAdapter,
  createOAuthTransaction,
  normalizeTokenResponse
} from "../src/index.mjs";
import { createMockFetch, jsonResponse } from "./fixture/mock-fetch.mjs";

const baseTime = 1_800_000_000_000;

function webhookSignature(rawBody, timestamp, secret) {
  return "sha256=" + createHmac("sha256", secret).update(timestamp + "." + rawBody).digest("hex");
}

function createAdapter(fetchImpl, now = () => baseTime) {
  return createDouyinAdapter({
    now,
    fetchImpl,
    oauth: {
      authorizationEndpoint: "https://provider.invalid/oauth/authorize",
      clientId: "client-demo",
      redirectUri: "https://app.invalid/oauth/callback",
      scope: ["user.info", "commerce.read"],
      stateTtlMs: 5 * 60 * 1000,
      stateBytes: 16,
      nonceBytes: 16
    },
    token: {
      tokenEndpoint: "https://provider.invalid/oauth/token",
      clientId: "client-demo",
      clientSecret: "secret-demo",
      redirectUri: "https://app.invalid/oauth/callback"
    },
    webhook: {
      challengeField: "challenge",
      challengeResponseField: "challenge",
      msgIdHeader: "Msg-Id",
      signature: {
        header: "X-Configured-Signature",
        timestampHeader: "X-Configured-Timestamp",
        timestampFormat: "unix_seconds",
        maxAgeMs: 5 * 60 * 1000,
        secret: "webhook-secret-demo",
        input: "timestamp.raw_body",
        prefix: "sha256=",
        algorithm: "sha256",
        encoding: "hex"
      }
    },
    productResponse: {
      itemsPath: ["result", "items"],
      fields: {
        id: "sku",
        name: "title",
        priceCents: { path: "price_cents", transform: "integer" },
        currency: "currency"
      },
      pagination: { nextCursor: ["result", "next_cursor"] }
    },
    billingResponse: {
      itemsPath: ["payload", "records"],
      fields: {
        id: "record_id",
        orderId: "order_reference",
        amountCents: { path: "amount_cents", transform: "integer" },
        status: "status",
        occurredAt: { path: "occurred_at", transform: "iso-date" }
      }
    }
  });
}

test("OAuth start and callback consume state once and validate nonce", () => {
  const adapter = createAdapter(async () => {
    throw new Error("token fetch should not run in this test");
  });
  const started = adapter.startOAuth();
  const authorizationUrl = new URL(started.authorizationUrl);
  assert.equal(authorizationUrl.origin, "https://provider.invalid");
  assert.equal(authorizationUrl.searchParams.get("response_type"), "code");
  assert.equal(authorizationUrl.searchParams.get("client_id"), "client-demo");
  assert.equal(authorizationUrl.searchParams.get("state"), started.transaction.state);
  assert.equal(authorizationUrl.searchParams.get("nonce"), started.transaction.nonce);
  assert.equal(authorizationUrl.searchParams.get("scope"), "user.info commerce.read");
  assert.equal(adapter.stateCount, 1);

  const callback = adapter.validateOAuthCallback({
    code: "authorization-code",
    state: started.transaction.state,
    nonce: started.transaction.nonce
  }, { requireNonce: true });
  assert.equal(callback.code, "authorization-code");
  assert.equal(callback.nonce, started.transaction.nonce);
  assert.equal(adapter.stateCount, 0);
  assert.throws(
    () => adapter.validateOAuthCallback({ code: "authorization-code", state: started.transaction.state }),
    (error) => error instanceof OAuthCallbackError && error.code === "state_not_found"
  );

  const expired = createOAuthTransaction({ now: baseTime - 10_000, ttlMs: 1000 });
  assert.throws(
    () => {
      adapter.validateOAuthCallback({ code: "code", state: expired.state }, { now: baseTime });
    },
    (error) => error instanceof OAuthCallbackError
  );
});

test("token exchange and refresh use mock fetch and normalize standard or configured fields", async () => {
  const mock = createMockFetch(async ({ url, init }, callNumber) => {
    assert.equal(url, "https://provider.invalid/oauth/token");
    assert.equal(init.method, "POST");
    assert.equal(init.headers["content-type"], "application/x-www-form-urlencoded");
    const form = new URLSearchParams(init.body);
    assert.equal(form.get("client_id"), "client-demo");
    assert.equal(form.get("client_secret"), "secret-demo");
    if (callNumber === 1) {
      assert.equal(form.get("grant_type"), "authorization_code");
      assert.equal(form.get("code"), "authorization-code");
      return jsonResponse({ access_token: "access-1", refresh_token: "refresh-1", token_type: "Bearer", expires_in: "3600", scope: "user.info" });
    }
    assert.equal(form.get("grant_type"), "refresh_token");
    assert.equal(form.get("refresh_token"), "refresh-1");
    return jsonResponse({ access_token: "access-2", expires_in: 120 });
  });
  const adapter = createAdapter(mock.fetchImpl);
  const exchanged = await adapter.exchangeCodeForToken({ code: "authorization-code" });
  assert.deepEqual(exchanged, {
    accessToken: "access-1",
    tokenType: "Bearer",
    refreshToken: "refresh-1",
    scope: "user.info",
    expiresIn: 3600,
    expiresAt: baseTime + 3_600_000
  });
  const refreshed = await adapter.refreshAccessToken({ refreshToken: exchanged.refreshToken });
  assert.deepEqual(refreshed, {
    accessToken: "access-2",
    tokenType: "Bearer",
    refreshToken: "refresh-1",
    expiresIn: 120,
    expiresAt: baseTime + 120_000
  });
  assert.equal(mock.calls.length, 2);

  assert.deepEqual(
    normalizeTokenResponse({ accessToken: "configured-access", expiresIn: 10 }, {
      fieldMap: { accessToken: "accessToken", expiresIn: "expiresIn" },
      now: baseTime
    }),
    { accessToken: "configured-access", tokenType: "Bearer", expiresIn: 10, expiresAt: baseTime + 10_000 }
  );

  const failing = createAdapter(async () => jsonResponse({ error: "invalid_grant" }, { status: 400 }));
  await assert.rejects(
    () => failing.exchangeCodeForToken({ code: "bad-code" }),
    (error) => error instanceof TokenEndpointError && error.status === 400
  );
});

test("webhook challenge, signature, Msg-Id and idempotency are configuration-driven", async () => {
  const mock = createMockFetch(async () => jsonResponse({}));
  const adapter = createAdapter(mock.fetchImpl);
  const timestamp = String(Math.floor(baseTime / 1000));
  const challengeBody = JSON.stringify({ challenge: "challenge-1" });
  const challenge = await adapter.parseWebhook({
    rawBody: challengeBody,
    headers: {
      "X-Configured-Timestamp": timestamp,
      "X-Configured-Signature": webhookSignature(challengeBody, timestamp, "webhook-secret-demo")
    }
  });
  assert.deepEqual(challenge.response, { challenge: "challenge-1" });
  assert.equal(challenge.kind, "challenge");

  const eventBody = JSON.stringify({ event_type: "configured_event", data: { id: "event-1" } });
  const headers = {
    "Msg-Id": "msg-1",
    "X-Configured-Timestamp": timestamp,
    "X-Configured-Signature": webhookSignature(eventBody, timestamp, "webhook-secret-demo")
  };
  const first = await adapter.parseWebhook({ rawBody: eventBody, headers });
  assert.equal(first.kind, "event");
  assert.equal(first.messageId, "msg-1");
  assert.equal(first.duplicate, false);
  assert.equal(adapter.idempotencyCount, 1);
  const duplicate = await adapter.parseWebhook({ rawBody: eventBody, headers });
  assert.equal(duplicate.duplicate, true);
  const conflictingBody = JSON.stringify({ event_type: "different_event" });
  await assert.rejects(
    () => adapter.parseWebhook({
      rawBody: conflictingBody,
      headers: { ...headers, "X-Configured-Signature": webhookSignature(conflictingBody, timestamp, "webhook-secret-demo") }
    }),
    (error) => error instanceof WebhookValidationError && error.code === "message_id_conflict"
  );
  await assert.rejects(
    () => adapter.parseWebhook({
      rawBody: eventBody,
      headers: { ...headers, "X-Configured-Signature": "sha256=" + "0".repeat(64) }
    }),
    (error) => error instanceof WebhookValidationError && error.code === "invalid_signature"
  );
});

test("product and billing responses normalize only through explicit field maps", () => {
  const adapter = createAdapter(async () => jsonResponse({}));
  assert.deepEqual(
    adapter.normalizeProducts({
      result: {
        items: [{ sku: "sku-1", title: "商品 A", price_cents: "1299", currency: "CNY" }],
        next_cursor: "cursor-2"
      }
    }),
    {
      products: [{ id: "sku-1", name: "商品 A", priceCents: 1299, currency: "CNY" }],
      pagination: { nextCursor: "cursor-2" }
    }
  );
  assert.deepEqual(
    adapter.normalizeBilling({
      payload: {
        records: [{ record_id: "bill-1", order_reference: "order-1", amount_cents: 1299, status: "paid", occurred_at: "2026-11-11T00:00:00Z" }]
      }
    }),
    {
      records: [{ id: "bill-1", orderId: "order-1", amountCents: 1299, status: "paid", occurredAt: "2026-11-11T00:00:00.000Z" }]
    }
  );
  assert.throws(
    () => adapter.normalizeProducts({ result: { items: [] } }, {}),
    /itemsPath/
  );
  assert.throws(
    () => adapter.normalizeProducts({ result: { items: [{ title: "missing-id" }] } }),
    (error) => error instanceof Error && /Missing required mapped field|no id/.test(error.message)
  );
  assert.ok(ResponseNormalizationError);
});

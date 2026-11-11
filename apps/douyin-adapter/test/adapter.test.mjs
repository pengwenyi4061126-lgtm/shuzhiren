import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import { createDouyinAdapter, createDouyinApiClient, normalizeTokenResponse } from "../src/index.mjs";
import { billingPayload, normalizationConfig, oauthConfig, productPayload } from "./fixture/provider-profile.mjs";

const NOW = 1_800_000_000_000;

test("OAuth start, state/nonce callback validation, code exchange, and one-time state", async () => {
  const calls = [];
  const fetchImpl = mockFetch(calls, { access_token: "access-1", refresh_token: "refresh-1", token_type: "Bearer", expires_in: 3600, scope: "live.read commerce.read" });
  const adapter = createDouyinAdapter({ oauth: oauthConfig, fetchImpl, now: () => NOW });
  const started = adapter.startOAuth();
  const authorization = new URL(started.authorizationUrl);
  assert.equal(authorization.searchParams.get("state"), started.state);
  assert.equal(authorization.searchParams.get("nonce"), started.nonce);
  assert.equal(authorization.searchParams.get("scope"), "live.read commerce.read");

  const token = await adapter.completeOAuth({ callback: `https://app.invalid/callback?code=code-1&state=${encodeURIComponent(started.state)}`, nonce: started.nonce, clientSecret: "secret" });
  assert.equal(token.accessToken, "access-1");
  assert.equal(token.expiresAt, new Date(NOW + 3600_000).toISOString());
  assert.equal(calls[0].url, oauthConfig.tokenEndpoint);
  assert.equal(new URLSearchParams(calls[0].init.body).get("grant_type"), "authorization_code");
  assert.equal(new URLSearchParams(calls[0].init.body).get("client_key"), "client-id");
  assert.equal(new URLSearchParams(calls[0].init.body).get("client_secret"), "secret");
  await assert.rejects(() => adapter.completeOAuth({ callback: `https://app.invalid/callback?code=code-1&state=${encodeURIComponent(started.state)}`, nonce: started.nonce }), /unknown or expired/);
});

test("OAuth rejects state and nonce mismatch before token fetch", async () => {
  const calls = [];
  const adapter = createDouyinAdapter({ oauth: oauthConfig, fetchImpl: mockFetch(calls, { access_token: "unused" }), now: () => NOW });
  const started = adapter.startOAuth();
  await assert.rejects(() => adapter.completeOAuth({ callback: "https://app.invalid/callback?code=code-1&state=wrong", nonce: started.nonce }), /unknown or expired/);
  const second = adapter.startOAuth();
  await assert.rejects(() => adapter.completeOAuth({ callback: `https://app.invalid/callback?code=code-1&state=${encodeURIComponent(second.state)}`, nonce: "wrong" }), /nonce mismatch/);
  assert.equal(calls.length, 0);
});

test("refresh token uses mocked fetch and normalizes the response", async () => {
  const calls = [];
  const adapter = createDouyinAdapter({ oauth: oauthConfig, fetchImpl: mockFetch(calls, { access_token: "access-2", expires_in: 90 }), now: () => NOW });
  const token = await adapter.refreshToken({ refreshToken: "refresh-1" });
  assert.deepEqual(token.scope, undefined);
  assert.equal(token.tokenType, "Bearer");
  assert.equal(token.expiresIn, 90);
  assert.equal(new URLSearchParams(calls[0].init.body).get("grant_type"), "refresh_token");
  assert.equal(new URLSearchParams(calls[0].init.body).get("refresh_token"), "refresh-1");
});

test("official token response data envelope is normalized without losing open_id", () => {
  const token = normalizeTokenResponse({ data: { access_token: "access-3", refresh_token: "refresh-3", expires_in: 120, refresh_expires_in: 2_592_000, open_id: "open-1", scope: "video.create" } }, { now: () => NOW });
  assert.equal(token.accessToken, "access-3");
  assert.equal(token.openId, "open-1");
  assert.equal(token.refreshExpiresIn, 2_592_000);
  assert.deepEqual(token.scope, ["video.create"]);
});

test("webhook challenge, signature verification, and Msg-Id idempotency", async () => {
  const secret = "synthetic-webhook-secret";
  const adapter = createDouyinAdapter({
    oauth: oauthConfig,
    now: () => NOW,
    webhook: {
      secret,
      signature: { signatureHeader: "x-provider-signature", timestampHeader: "x-provider-timestamp", algorithm: "sha256", mode: "hmac", prefix: "sha256=", maxAgeMs: 5 * 60_000, signingInput: ({ timestamp, rawBody }) => `${timestamp}.${rawBody}` },
      challenge: { requestField: "challenge_code", responseField: "challenge_code", verifySignature: false }
    }
  });
  const challenge = await adapter.handleWebhook({ headers: {}, rawBody: JSON.stringify({ challenge_code: "challenge-1" }) });
  assert.equal(challenge.status, 200);
  assert.deepEqual(challenge.body, { challenge_code: "challenge-1" });

  const rawBody = JSON.stringify({ event: "synthetic.order", value: 1 });
  const timestamp = String(NOW);
  const signature = `sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
  const headers = { "x-provider-timestamp": timestamp, "x-provider-signature": signature, "msg-id": "msg-1" };
  const first = await adapter.handleWebhook({ headers, rawBody });
  assert.equal(first.status, 202);
  assert.equal(first.kind, "event");
  assert.equal(first.msgId, "msg-1");
  const duplicate = await adapter.handleWebhook({ headers, rawBody });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.kind, "duplicate");
  const invalid = await adapter.handleWebhook({ headers: { ...headers, "x-provider-signature": "sha256=bad" }, rawBody });
  assert.equal(invalid.status, 401);
});

test("Douyin defaults verify nested content.challenge and SHA1(client_secret + raw body)", async () => {
  const secret = "douyin-client-secret";
  const adapter = createDouyinAdapter({ oauth: oauthConfig, webhook: { secret }, now: () => NOW });
  const challenge = await adapter.handleWebhook({ rawBody: JSON.stringify({ event: "verify_webhook", content: { challenge: 12345 } }) });
  assert.equal(challenge.status, 200);
  assert.deepEqual(challenge.body, { challenge: "12345" });
  const rawBody = JSON.stringify({ event: "authorize", content: { scopes: ["video.create"] } });
  const signature = createHash("sha1").update(`${secret}${rawBody}`).digest("hex");
  const message = await adapter.handleWebhook({ headers: { "X-Douyin-Signature": signature, "Msg-Id": "douyin-msg-1" }, rawBody });
  assert.equal(message.status, 202);
  assert.equal(message.msgId, "douyin-msg-1");
});

test("product and billing responses use explicit configurable mappings", () => {
  const adapter = createDouyinAdapter({ oauth: oauthConfig, normalization: normalizationConfig });
  assert.deepEqual(adapter.normalizeProducts(productPayload).items[0], {
    id: "item-1", title: "Synthetic mug", priceMinor: 1299, stock: 7, raw: productPayload.payload.entries[0]
  });
  assert.deepEqual(adapter.normalizeBilling(billingPayload).items[0], {
    id: "bill-1", status: "settled", amountMinor: 1299, currency: "CNY", occurredAt: "2026-11-11T00:00:00.000Z", raw: billingPayload.payload.records[0]
  });
  assert.throws(() => createDouyinAdapter({ oauth: oauthConfig, normalization: { product: {}, billing: normalizationConfig.billing } }), /product\.(normalization profile is required|itemsPath)/);
});

test("billing CSV downloads can be mapped with explicit columns", () => {
  const adapter = createDouyinAdapter({
    oauth: oauthConfig,
    normalization: {
      product: normalizationConfig.product,
      billing: {
        itemsPath: "unused-for-csv",
        fields: {
          id: "订单号",
          status: "状态",
          amountMinor: { path: "金额(分)", transform: (value) => Number(value) },
          currency: "币种"
        }
      }
    }
  });
  assert.deepEqual(adapter.normalizeBillingCsv("订单号,状态,金额(分),币种\norder-1,支付成功,1299,CNY\n" ).items[0], {
    id: "order-1", status: "支付成功", amountMinor: 1299, currency: "CNY", raw: { "订单号": "order-1", "状态": "支付成功", "金额(分)": "1299", "币种": "CNY" }
  });
});

test("official product, bill, fund-bill, and settlement clients use documented paths without guessing bodies", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return { ok: true, status: 200, async json() { return { data: { error_code: "0" } }; } };
  };
  const client = createDouyinApiClient({ accessToken: "access-token", appId: "app-1", apiBaseUrl: "https://open.douyin.invalid", ecpayBaseUrl: "https://developer.toutiao.invalid", fetchImpl });
  await client.getProductTemplate({ categoryId: "100", productType: "1", accountId: "merchant-root" });
  await client.saveProduct({ accountId: "merchant-root", body: { product: { out_id: "p-1" } } });
  await client.getTransactionBill({ billDate: "20261111", billType: "payment" });
  await client.getFundBill({ billDate: "202611", merchantId: "merchant-1", accountType: "ALL", paymentType: "ALL", tradeType: "ALL" });
  await client.queryOrder({ outOrderNo: "order-1", sign: "sign-1" });
  await client.settle({ body: { app_id: "app-1", out_settle_no: "settle-1", out_order_no: "order-1", settle_desc: "test", sign: "sign-1" } });
  assert.equal(new URL(calls[0].url).pathname, "/goodlife/v1/goods/template/get/");
  assert.equal(new URL(calls[0].url).searchParams.get("category_id"), "100");
  assert.equal(calls[0].init.headers["Rpc-Transit-Life-Account"], "merchant-root");
  assert.equal(new URL(calls[2].url).pathname, "/api/apps/v3/bills/");
  assert.deepEqual(JSON.parse(calls[2].init.body), { app_id: "app-1", bill_date: "20261111", bill_type: "payment" });
  assert.equal(new URL(calls[3].url).pathname, "/api/apps/v3/fund/bills/");
  assert.equal(new URL(calls[4].url).pathname, "/api/apps/ecpay/v1/query_order");
  assert.equal(new URL(calls[5].url).pathname, "/api/apps/ecpay/v1/settle");
});

function mockFetch(calls, body, { status = 200 } = {}) {
  return async (url, init) => {
    calls.push({ url: String(url), init });
    return { ok: status >= 200 && status < 300, status, async json() { return body; } };
  };
}

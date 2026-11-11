const DEFAULT_API_BASE_URL = "https://open.douyin.com";
const DEFAULT_ECPAY_BASE_URL = "https://developer.toutiao.com";
const BILL_TYPES = new Set(["payment", "settle", "refund", "return", "withdraw", "rebate", "annual_rebate"]);
const ACCOUNT_TYPES = new Set(["FEE", "REFUND_DEPOSIT", "PAY_TO_CHANGE", "WX", "ALIPAY", "DOUYIN", "YZT", "ALL"]);
const PAYMENT_TYPES = new Set(["INCOME", "EXPENDITURE", "ALL"]);
const TRADE_TYPES = new Set(["RECHARGE", "PAY", "REFUND", "DEAL", "WITHDRAW", "ROLLBACK", "ADJUST_IN", "ADJUST_OUT", "PENALTY", "SETTLE", "RETURN_SETTLE_IN", "RETURN_SETTLE_OUT", "ALL"]);

/**
 * Thin, secret-safe HTTP client for the official endpoints that are currently
 * documented. It deliberately accepts provider bodies unchanged: the
 * platform's product templates and bill CSV schemas are dynamic and should not
 * be replaced by guessed fields in this project.
 */
export function createDouyinApiClient({ accessToken, appId, apiBaseUrl = DEFAULT_API_BASE_URL, ecpayBaseUrl = DEFAULT_ECPAY_BASE_URL, fetchImpl = fetch } = {}) {
  const apiBase = requireBaseUrl(apiBaseUrl, "apiBaseUrl");
  const ecpayBase = requireBaseUrl(ecpayBaseUrl, "ecpayBaseUrl");

  return {
    getProductTemplate({ categoryId, productType, openBizType, productSubType, accountId } = {}) {
      requireString(categoryId, "categoryId");
      requireString(productType, "productType");
      return requestJson({ base: apiBase, path: "/goodlife/v1/goods/template/get/", method: "GET", accessToken, accountId, query: { category_id: categoryId, product_type: productType, open_biz_type: openBizType, product_sub_type: productSubType }, fetchImpl });
    },

    saveProduct({ body, accountId } = {}) {
      requireObject(body, "body");
      requireString(accountId, "accountId");
      return requestJson({ base: apiBase, path: "/goodlife/v1/goods/product/save/", method: "POST", accessToken, accountId, body, fetchImpl });
    },

    operateProduct({ body, accountId } = {}) {
      requireObject(body, "body");
      requireString(accountId, "accountId");
      return requestJson({ base: apiBase, path: "/goodlife/v1/goods/product/operate/", method: "POST", accessToken, accountId, body, fetchImpl });
    },

    syncStock({ body, accountId } = {}) {
      requireObject(body, "body");
      requireString(accountId, "accountId");
      return requestJson({ base: apiBase, path: "/goodlife/v1/goods/stock/sync/", method: "POST", accessToken, accountId, body, fetchImpl });
    },

    syncSkus({ body, accountId } = {}) {
      requireObject(body, "body");
      requireString(accountId, "accountId");
      return requestJson({ base: apiBase, path: "/goodlife/v1/goods/sku/batch_save/", method: "POST", accessToken, accountId, body, fetchImpl });
    },

    getTransactionBill({ billDate, billType, merchantId } = {}) {
      validateBillDate(billDate);
      requireEnum(billType, BILL_TYPES, "billType");
      requireString(appId, "appId");
      return requestJson({ base: apiBase, path: "/api/apps/v3/bills/", method: "POST", accessToken, body: omitUndefined({ app_id: appId, bill_date: billDate, bill_type: billType, merchant_id: merchantId }), fetchImpl });
    },

    getFundBill({ billDate, merchantId, accountType, paymentType, tradeType } = {}) {
      validateBillDate(billDate);
      requireEnum(accountType, ACCOUNT_TYPES, "accountType");
      requireEnum(paymentType, PAYMENT_TYPES, "paymentType");
      requireEnum(tradeType, TRADE_TYPES, "tradeType");
      requireString(appId, "appId");
      requireString(merchantId, "merchantId");
      return requestJson({ base: apiBase, path: "/api/apps/v3/fund/bills/", method: "POST", accessToken, body: { account_type: accountType, app_id: appId, bill_date: billDate, merchant_id: merchantId, payment_type: paymentType, trade_type: tradeType }, fetchImpl });
    },

    queryOrder({ outOrderNo, sign, thirdpartyId } = {}) {
      requireString(outOrderNo, "outOrderNo");
      requireString(sign, "sign");
      requireString(appId, "appId");
      return requestJson({ base: ecpayBase, path: "/api/apps/ecpay/v1/query_order", method: "POST", body: omitUndefined({ app_id: appId, out_order_no: outOrderNo, sign, thirdparty_id: thirdpartyId }), fetchImpl });
    },

    settle({ body } = {}) {
      requireObject(body, "body");
      return requestJson({ base: ecpayBase, path: "/api/apps/ecpay/v1/settle", method: "POST", body, fetchImpl });
    },

    querySettle({ body } = {}) {
      requireObject(body, "body");
      return requestJson({ base: ecpayBase, path: "/api/apps/ecpay/v1/query_settle", method: "POST", body, fetchImpl });
    },

    async downloadBill({ url } = {}) {
      const billUrl = requireDownloadUrl(url);
      const response = await fetchImpl(billUrl, { method: "GET", headers: { accept: "text/csv, text/plain, application/octet-stream" } });
      if (!response.ok) throw new Error(`Douyin bill download failed with status ${response.status}`);
      return { url: billUrl.toString(), contentType: response.headers?.get?.("content-type") ?? undefined, text: await response.text() };
    }
  };
}

export async function requestJson({ base, path, method = "POST", accessToken, accountId, query, body, fetchImpl = fetch } = {}) {
  const url = new URL(path, requireBaseUrl(base, "base"));
  for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (accessToken !== undefined) headers["access-token"] = requireString(accessToken, "accessToken");
  if (accountId !== undefined) headers["Rpc-Transit-Life-Account"] = requireString(accountId, "accountId");
  const response = await fetchImpl(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Douyin API request failed with status ${response.status}`);
  const platformError = payload?.data?.error_code ?? payload?.err_no;
  if (platformError !== undefined && String(platformError) !== "0") throw new Error(`Douyin API rejected request with error ${platformError}`);
  return payload;
}

function requireBaseUrl(value, name) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name} must be an HTTP(S) URL`); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error(`${name} must be an HTTP(S) URL without credentials`);
  return url;
}
function requireDownloadUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("bill URL must be an HTTPS URL"); }
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("bill URL must be an HTTPS URL without credentials");
  return url;
}
function requireString(value, name) { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`); return value; }
function requireObject(value, name) { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`); return value; }
function requireEnum(value, allowed, name) { requireString(value, name); if (!allowed.has(value)) throw new Error(`${name} is unsupported`); return value; }
function validateBillDate(value) { requireString(value, "billDate"); if (!/^\d{6}(?:\d{2})?$/.test(value)) throw new Error("billDate must be yyyyMM or yyyyMMdd"); }
function omitUndefined(value) { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null)); }

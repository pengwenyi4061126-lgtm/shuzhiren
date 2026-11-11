// Synthetic fixture only. These names are intentionally not presented as official platform fields.
export const oauthConfig = {
  authorizationEndpoint: "https://provider.invalid/oauth/authorize",
  tokenEndpoint: "https://provider.invalid/oauth/token",
  clientId: "client-id",
  redirectUri: "https://app.invalid/oauth/douyin/callback",
  scopes: ["live.read", "commerce.read"],
  authorization: { clientIdParam: "client_key" },
  token: { clientIdParam: "client_key", requestEncoding: "multipart/form-data" }
};

export const normalizationConfig = {
  product: {
    itemsPath: "payload.entries",
    fields: {
      id: "providerItemKey",
      title: "providerTitle",
      priceMinor: { path: "providerPriceMinor", transform: (value) => Number(value), required: false },
      stock: { path: "providerStock", transform: (value) => Number(value), required: false }
    }
  },
  billing: {
    itemsPath: "payload.records",
    fields: {
      id: "providerBillKey",
      status: "providerStatus",
      amountMinor: { path: "providerAmountMinor", transform: (value) => Number(value) },
      currency: "providerCurrency",
      occurredAt: { path: "providerOccurredAt", required: false }
    }
  }
};

export const productPayload = {
  payload: { entries: [{ providerItemKey: "item-1", providerTitle: "Synthetic mug", providerPriceMinor: "1299", providerStock: "7" }] }
};

export const billingPayload = {
  payload: { records: [{ providerBillKey: "bill-1", providerStatus: "settled", providerAmountMinor: "1299", providerCurrency: "CNY", providerOccurredAt: "2026-11-11T00:00:00.000Z" }] }
};

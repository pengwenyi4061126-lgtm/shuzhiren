# Douyin Adapter 最小可运行闭环

这个目录提供一个零依赖、ESM、Node 原生的适配器核心，不直接请求真实平台。网络调用只存在于 createTokenClient，并通过 fetchImpl 注入；测试全部使用 test/fixture/mock-fetch.mjs。

## 能力

- OAuth：生成高熵 state/nonce，带过期时间的一次性 state store，授权 URL 构造，回调的 error/state/nonce/code 校验。
- Token：授权码交换、refresh token，form 或 JSON 请求，标准 OAuth 字段规范化；客户端字段名和 token 响应字段可通过 mapping 配置。
- Webhook：签名校验、challenge 响应、Msg-Id（header 或 body 路径）解析、内存幂等和同 ID 不同 payload 冲突检测。
- 商品/账单：只按调用方提供的 itemsPath、fields、pagination 映射标准化，不内置未经确认的 Douyin 端点字段。

## 运行测试

在本目录执行：

    npm test

或直接执行：

    node --test test/*.test.mjs
    npm run check

## 使用骨架

    import { createDouyinAdapter } from "./src/index.mjs";

    const adapter = createDouyinAdapter({
      oauth: {
        authorizationEndpoint: process.env.OAUTH_AUTHORIZATION_ENDPOINT,
        clientId: process.env.OAUTH_CLIENT_ID,
        redirectUri: process.env.OAUTH_REDIRECT_URI,
        scope: ["user.info"],
        stateTtlMs: 10 * 60 * 1000
      },
      token: {
        tokenEndpoint: process.env.OAUTH_TOKEN_ENDPOINT,
        clientId: process.env.OAUTH_CLIENT_ID,
        clientSecret: process.env.OAUTH_CLIENT_SECRET,
        redirectUri: process.env.OAUTH_REDIRECT_URI,
        tokenFieldMap: {
          accessToken: "access_token",
          refreshToken: "refresh_token",
          expiresIn: "expires_in"
        }
      },
      webhook: {
        challengeField: "YOUR_CHALLENGE_FIELD",
        challengeResponseField: "YOUR_CHALLENGE_RESPONSE_FIELD",
        msgIdHeader: "Msg-Id",
        signature: {
          header: "YOUR_SIGNATURE_HEADER",
          timestampHeader: "YOUR_TIMESTAMP_HEADER",
          timestampFormat: "unix_seconds",
          secret: process.env.WEBHOOK_SECRET,
          input: "timestamp.raw_body",
          prefix: "sha256=",
          algorithm: "sha256",
          encoding: "hex"
        }
      },
      productResponse: {
        itemsPath: ["YOUR", "PRODUCT", "LIST", "PATH"],
        fields: {
          id: { path: "YOUR_ID_FIELD", transform: "string" },
          name: { path: "YOUR_NAME_FIELD", transform: "trimmed-string" },
          priceCents: { path: "YOUR_PRICE_CENTS_FIELD", transform: "integer" }
        }
      },
      billingResponse: {
        itemsPath: ["YOUR", "BILLING", "LIST", "PATH"],
        fields: {
          id: "YOUR_BILLING_ID_FIELD",
          amountCents: { path: "YOUR_AMOUNT_CENTS_FIELD", transform: "integer" }
        }
      }
    });

    const { authorizationUrl, transaction } = adapter.startOAuth();
    // 将 authorizationUrl 返回给前端；回调收到 query 后调用 adapter.validateOAuthCallback(query)。
    // token 交换：await adapter.exchangeCodeForToken({ code });
    // refresh：await adapter.refreshAccessToken({ refreshToken });
    // webhook：await adapter.parseWebhook({ rawBody, headers });

上面的 YOUR_* 是故意保留的配置边界：拿到已确认的接口文档或实际 fixture 后，再替换为对应字段，不在 adapter 内猜测官方字段。

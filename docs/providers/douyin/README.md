# 抖音 Adapter 规格

- 目标平台：抖音
- D1 决策日期：2026-11-05
- 实现目录：`apps/douyin-adapter/`
- 控制台能力注册：`apps/console/lib/channel-adapters.ts` 的 `douyin`
- 当前代码验证：`npm run douyin-adapter:test`（mock fetch，不访问真实平台）
- 官方资料核验：[`OFFICIAL_API_RESEARCH.md`](./OFFICIAL_API_RESEARCH.md)

## 接入边界

### OAuth

- 服务端保管 `client_secret`、access token 和 refresh token。
- 授权码登录使用一次性 `state`，回调状态消费一次；`nonce` 由调用方校验后传入。
- 默认端点为抖音官方 OAuth 路径，参数名使用 `client_key`；端点和参数可配置，方便处理官方文档代际差异。
- token 响应支持官方 `data` 包装，并保留 `open_id`、`refresh_expires_in` 和原始响应。

### 原生 Webhook

- challenge 从 `content.challenge` 读取，响应体返回 `{"challenge":"..."}`。
- 原始消息体必须在 JSON 解析前保留；默认按 `SHA1(client_secret + raw_body)` 校验 `X-Douyin-Signature`。
- 使用 `Msg-Id` 做幂等；官方重试与 5 秒响应要求由上层 HTTP 入口和持久化去重存储承接。

### 商品

- 已实现官方生活服务商品端点客户端：模板查询、商品保存、上下架、库存、多 SKU；商品 body 由调用方根据官方动态模板传入。
- 抖店全品类电商商品创建/更新/库存字段在当前官方资料中未确认，不使用生活服务接口冒充抖店商品同步。
- JSON 商品结果支持显式字段映射，禁止隐式猜测平台字段。

### 账单与结算

- 已实现交易账单、资金账单、订单查询、结算和结算查询请求客户端；账单下载 URL 由客户端下载后交给显式 CSV 字段映射。
- CSV 映射支持订单号、状态、金额、币种等项目内标准字段；佣金、服务费、运费、优惠、税费、保证金、退款和打款周期必须按实际 `bill_type`/CSV 表头配置，缺字段时测试失败，不补默认值。
- 旧 GET 账单接口与新 v3 POST 接口并存时，必须在租户配置中明确接口代际，不能混用签名 Query 与 access-token JSON 认证。

## 发布前未满足条件

代码和 mock 契约测试不等于真实平台可用。仍需抖音开发者/服务商账号、应用审核、scope、主播授权、Webhook 配置、正式 RTMP/Stream Secret、目标平台规则确认和真实账单样本。对应 Readiness 的 EP-02、EP-15、EP-17、EP-19 仍按外部前置条件处理。

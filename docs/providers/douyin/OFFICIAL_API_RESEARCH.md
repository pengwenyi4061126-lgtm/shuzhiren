# 抖音官方 API 资料核验

- 核验日期：2026-11-11
- 项目：E:\shuzizhibo
- 资料范围：抖音官方旧开放平台 open.douyin.com 文档，以及 open.douyin.com/platform/doc 当前重定向到的官方开发者文档 developer.open-douyin.com。
- 产物范围：仅维护本文件；未修改现有代码或其它文件，未提交 Git。

## 结论先行

1. OAuth 授权码、换取 access token、刷新 access token、刷新 refresh token 均有官方文档；当前接口详情页写的是 POST。旧版 Web 接入说明的接口表仍显示 GET，存在官方文档代际冲突，接入时应以当前接口详情页为准并在控制台/沙盒复核。
2. Webhooks 的 challenge、X-Douyin-Signature 和 Msg-Id 去重规则可以由官方文档确认：回调为 POST application/json；challenge 位于 content.challenge；响应体返回 JSON 文本；签名为 SHA1(client_secret + 原始消息体)；Msg-Id 用于去重。
3. 官方当前文档确认了生活服务商品同步接口：查询商品模板、创建/更新商品、上下架商品、同步库存，以及多 SKU 接口。它们属于 goodlife/生活服务商品能力，不等同于抖店全品类商品 API；本报告把商品文档页 URL 与实际 `open.douyin.com` API URL 分开记录。
4. 对“抖店电商商品同步”：官方能力概述只确认“电商插件小程序商品、订单查询”需前往抖店开放平台申请服务端接口；在 open.douyin.com 文档中未核实到可直接用于抖店商品创建/更新/同步的端点。不要把生活服务 goodlife 接口当成抖店商品同步接口。
5. 订单、结算/分账、交易账单、资金账单均有官方接口。当前生活服务详细页给出 `goodlife` 订单查询和 `/api/apps/trade/v2/settle/*` 分账接口；新账单文档给出 `/api/apps/v3/bills/` 与 `/api/apps/v3/fund/bills/` 两个 POST 对账接口。另有电商支付 `ecpay` 代际页面使用 `developer.toutiao.com` 正式域名和 `open-sandbox.douyin.com` 沙盒域名，不能与生活服务接口混用。

## 1. OAuth 授权码、换 token、刷新

官方文档：

- [抖音授权码](https://open.douyin.com/platform/resource/docs/openapi/account-permission/douyin-get-permission-code/)
- [WEB 授权接入说明](https://open.douyin.com/platform/resource/docs/develop/permission/web/permission)
- [抖音帐号 OAuth 2.0 授权](https://open.douyin.com/platform/resource/docs/develop/permission/web/oauth2)

### 1.1 获取授权码

| 项目 | 官方确认 |
|---|---|
| 方法 | GET |
| 路径 | /platform/oauth/connect/ |
| 用途 | 展示授权页并获取授权码 `code` |
| 实际端点 | `https://open.douyin.com/platform/oauth/connect/` |
| 查询字段 | `client_key`、`response_type=code`、`scope`、`redirect_uri` |
| 可选字段 | `optionalScope`、`state` |
| 回调确认字段 | 用户授权完成后回调中附带 `code` |
| 未确认项 | 不同应用类型的 scope 清单及控制台生成链接的差异未在本报告展开；不额外推导字段。 |

### 1.2 授权码换 access token

官方接口详情：[获取 access](https://open.douyin.com/platform/resource/docs/openapi/account-permission/get-access-token/)

| 项目 | 官方确认 |
|---|---|
| 正式 URL | https://open.douyin.com/oauth/access_token/ |
| 当前接口详情页方法 | POST |
| Content-Type | application/x-www-form-urlencoded |
| Body 必填 | client_secret、code、grant_type=authorization_code、client_key |
| 响应 data 中已确认 | access_token、expires_in、open_id、refresh_expires_in、refresh_token、scope、error_code、description |
| 重要行为 | code 只能使用一次；拿到 access token 后不要重复授权刷新同一个 code。 |

注意：旧版 [WEB 授权接入说明](https://open.douyin.com/platform/resource/docs/develop/permission/web/permission) 的接口明细表仍写成 GET /oauth/access_token/，与当前接口详情页的 POST 冲突。本文按当前接口详情页记录为 POST，不把旧表的 GET 当作当前实现依据。页面文案还出现 access token 15 天、refresh token 30 天，而示例响应的 `expires_in` 为 `86400`；实现应读取响应中的 `expires_in`/`refresh_expires_in`，不要硬编码 TTL。

### 1.3 刷新 access token / 续期

官方接口详情：[刷新 access](https://open.douyin.com/platform/resource/docs/openapi/account-permission/refresh-access-token)

| 项目 | 官方确认 |
|---|---|
| 正式 URL | https://open.douyin.com/oauth/refresh_token/ |
| 方法 | POST |
| Content-Type | multipart/form-data |
| Body 必填 | client_key、grant_type=refresh_token、refresh_token |
| 响应 data 中已确认 | access_token、expires_in、open_id、refresh_expires_in、refresh_token、scope、error_code、description |
| 有效期说明 | 官方文档写明 access token 约 15 天、refresh token 约 30 天；刷新 access token 不改变 refresh token 有效期。 |
| 错误码 | access token 过期/无效：10008 或 2190008；refresh token 过期/无效：10010。 |

### 1.4 刷新 refresh token

官方接口详情：[刷新 refresh_token](https://open.douyin.com/platform/resource/docs/openapi/account-permission/refresh-token)

| 项目 | 官方确认 |
|---|---|
| 正式 URL | https://open.douyin.com/oauth/renew_refresh_token/ |
| 方法 | POST |
| Content-Type | multipart/form-data |
| Body 必填 | client_key、refresh_token |
| 响应 data 中已确认 | refresh_token、expires_in、error_code、description |
| 前置权限 | client_key 需要具备 renew_refresh_token 权限 |
| 轮换行为 | 旧 refresh token 失效，新 token 有 30 天有效期；最多刷新 5 次，之后需重新授权。 |

### 1.5 client access token

官方接口详情：[生成 client_token](https://open.douyin.com/platform/resource/docs/openapi/account-permission/client-token)

| 项目 | 官方确认 |
|---|---|
| 正式 URL | https://open.douyin.com/oauth/client_token/ |
| 方法 | POST |
| Content-Type | multipart/form-data |
| Body 必填 | client_key、client_secret、grant_type=client_credential |
| 响应 data 中已确认 | access_token、expires_in、error_code、description |
| 有效期 | 官方文档写明约 2 小时；重复获取会使旧 token 失效，但有 5 分钟缓冲。 |

## 2. Webhook：challenge、签名、Msg-Id 去重

官方文档：

- [Webhooks 概述](https://open.douyin.com/platform/resource/docs/develop/webhooks/summarize/)
- [Webhooks 事件列表](https://open.douyin.com/platform/resource/docs/develop/webhooks/event-list/)
- [Webhook 签名 FAQ](https://open.douyin.com/platform/resource/docs/common-question/faq/)
- [迁移后的消息推送配置文档](https://developer.open-douyin.com/docs/resource/zh-CN/local-life/develop/preparation/message-push-configuration-access)

### 2.1 回调地址校验 challenge

| 项目 | 官方确认 |
|---|---|
| 平台请求方法 | POST |
| Content-Type | application/json |
| 验证请求体 | {"event":"verify_webhook","client_key":"","content":{"challenge":12345}} |
| 应答要求 | 从 content.challenge 取值，立即返回 Response Body 中的 JSON 文本 {"challenge":12345} |
| 注意 | 不能把 challenge 直接作为非 JSON 响应返回。 |

### 2.2 消息来源签名

官方确认：

    X-Douyin-Signature = SHA1(client_secret + 原始消息体)

- Header 名称：X-Douyin-Signature
- 拼接顺序：应用 client_secret 在前，收到的消息体在后。
- 参与哈希的数据：收到的消息体原文/原始字节，不应先解析 JSON 再重新序列化。
- FAQ 额外说明：JSON 序列化使用 json-iterator，末尾可能带换行；验签不一致时必须保留流中原始消息体，包括可能存在的换行。
- 已无法从官方概述确认的项：签名编码大小写、是否有额外前缀、是否支持密钥轮换。本文不作推断。

### 2.3 Msg-Id 去重与重试

- Header：Msg-Id
- 官方用途：用于消息去重。
- 官方重试行为：回调连接超过 5 秒会断开，共重试 3 次。
- 建议落地字段：只把 Msg-Id 当作平台消息唯一键进行幂等处理；官方概述未给出去重保留时长、字符长度、大小写规则和缺失时的替代键，这些项目前无法确认。

## 3. 商品 / 生活服务商品同步接口

当前官方能力页明确将商品同步分为旧接口和新接口；下面列的是当前新平台文档可核实的 goodlife 接口。

总览：[商品发布和查询能力](https://developer.open-douyin.com/docs/resource/zh-CN/local-life/develop/capability/basic/goods-introduce)

### 3.1 查询商品模板

官方接口：[查询商品模板接口](https://developer.open-douyin.com/docs/resource/zh-CN/local-life/develop/OpenAPI/general-capabilities/product-query/template.get)

| 项目 | 官方确认 |
|---|---|
| URL | https://open.douyin.com/goodlife/v1/goods/template/get/ |
| 方法 | GET |
| Scope | life.capacity.goods.query |
| Header | access-token 必填；content-type: application/json；Rpc-Transit-Life-Account 为来客商户根账户 ID |
| Query 必填 | category_id、product_type |
| Query 条件/可选 | open_biz_type、product_sub_type |
| 响应模板字段 | product_attrs、sku_attrs、spu_attrs、calendar_attrs；属性项官方展示了 key、is_required、is_multi、value_type、value_demo、desc |
| 关键规则 | 商品/ SKU 的 attr_key_value_map 应依据该模板生成；官方明确说明模板是实时动态计算结果。 |

### 3.2 创建/更新商品

官方接口：[创建/更新商品接口](https://developer.open-douyin.com/docs/resource/zh-CN/local-life/develop/OpenAPI/general-capabilities/goods/save)

| 项目 | 官方确认 |
|---|---|
| URL | https://open.douyin.com/goodlife/v1/goods/product/save/ |
| 方法 | POST |
| Scope | life.capacity.goods.found |
| Header | access-token 必填；content-type: application/json；Rpc-Transit-Life-Account 为来客商户根账户 ID |
| Body 顶层已确认 | product（必填 Struct）、ability、account_id、sku、skus |
| sku/skus 规则 | 单 SKU 商品传 sku；预约商品可用 skus；多 SKU 商品另有批量 SKU 接口 |
| 商品标识规则 | 同一服务商相同 out_id 重复创建会覆盖，等同更新；页面示例还展示 product_id 等字段，但具体业务类型字段必须以模板/对应商品文档为准。 |
| 属性规则 | attr_key_value_map 的 key/value 类型必须按商品模板返回的 is_required、is_multi、value_type 处理。 |
| 响应已确认 | data.product_id、data.sku_ids、data.extra_map、data.error_code、data.description。 |

### 3.3 在线商品查询

官方接口：[在线商品查询](https://developer.open-douyin.com/docs/resource/zh-CN/local-life/develop/OpenAPI/general-capabilities/product-query/online.get)

| 项目 | 官方确认 |
|---|---|
| URL | https://open.douyin.com/goodlife/v1/goods/product/online/get/ |
| 方法 | GET |
| Query | `account_id`，以及 `out_ids` / `product_ids` 二选一 |

本次只记录官方页面明确的查询字段；没有把商品详情响应中的未核验内部字段扩展进来。

### 3.4 上下架/删除商品

官方接口：[上下架商品](https://developer.open-douyin.com/docs/resource/zh-CN/local-life/develop/OpenAPI/general-capabilities/goods/operate)

| 项目 | 官方确认 |
|---|---|
| URL | https://open.douyin.com/goodlife/v1/goods/product/operate/ |
| 方法 | POST |
| Scope | life.capacity.goods.found |
| Header | access-token 必填；content-type: application/json |
| Body 已确认 | op_type、account_id、out_id 或 product_id |
| op_type 枚举 | 1 上线、2 下线、3 删除；删除后无法恢复，需要创建新商品。 |
| 约束 | 已封禁商品不支持上下架操作。 |

### 3.5 同步库存

官方接口：[同步库存](https://developer.open-douyin.com/docs/resource/zh-CN/local-life/develop/OpenAPI/general-capabilities/goods/batch.save)

| 项目 | 官方确认 |
|---|---|
| URL | https://open.douyin.com/goodlife/v1/goods/stock/sync/ |
| 方法 | POST |
| Scope | life.capacity.goods.found |
| Header | access-token 必填；content-type: application/json |
| Body 已确认 | stock（必填 Struct）、account_id、out_id 或 product_id |
| 未确认项 | 当前官方页面对 stock Struct 的内部字段未展开；不能据此写 stock_qty、avail_qty 等字段为必填或固定字段。 |

### 3.6 多 SKU

官方 SDK 总览：[生活服务商家应用 OpenAPI SDK 总览](https://developer.open-douyin.com/docs/resource/zh-CN/local-life/develop/sdk-overview)

| 项目 | 官方确认 |
|---|---|
| URL | https://open.douyin.com/goodlife/v1/goods/sku/batch_save/ |
| 方法 | POST |
| Scope | life.capacity.goods.found |
| 说明 | 用于创建/更新多 SKU 商品的 SKU 列表；具体 Body 字段需以对应接口详情页为准，本次不补猜。 |

### 3.7 抖店电商商品同步：当前无法确认

官方能力概述：[能力概述](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/introduction/capabilities)

官方当前只明确：

- “电商插件小程序商品、订单查询”：开发者可前往抖店开放平台申请服务端开放接口，实现商品和订单信息查询。
- “生活服务行业商品同步”：在抖音开放平台文档中提供商品创建/查询/修改等接口，且新旧两套接口并存，新增商家使用新接口。

截至本次核验，未在 open.douyin.com/当前官方开发者文档中确认到一个明确属于抖店全品类电商、可用于商品创建/更新/库存同步的公开 URL + HTTP 方法 + 完整字段定义。因此：

- 不把 goodlife/v1/goods/* 标记为抖店电商商品 API；
- 不把第三方 SDK、非官方镜像或抖店后台页面接口当成官方 OpenAPI；
- 若项目目标是抖店商品同步，仍缺：抖店开放平台对应平台/角色、正式接口文档 URL、接口版本、权限/授权模型、请求签名和完整 Body 字段。

## 4. 订单、结算、交易账单、资金明细

### 4.1 当前生活服务订单查询

官方接口：[生活服务订单查询](https://developer.open-douyin.com/docs/resource/zh-CN/local-life/develop/OpenAPI/general-capabilities/order.query/query)

| 项目 | 官方确认 |
|---|---|
| URL | https://open.douyin.com/goodlife/v1/trade/order/query/ |
| 方法 | GET |
| Scope | `life.capacity.order.query` |
| 必填 Query | `account_id`、`page_num`、`page_size` |
| 可选/条件 Query | `create_order_start_time`、`create_order_end_time`、`update_order_start_time`、`update_order_end_time`、`cursor`、`ext_order_id`、`open_id`、`order_id`、`order_status` |
| 已废弃字段 | `get_secret_number` 已废弃，接口忽略 |
| 文档示例状态码 | `0` 初始化、`100` 待支付、`101` 支付取消、`200` 已支付、`201` 待使用、`1` 已完成、`150` 部分支付 |

这是生活服务 `goodlife` 订单接口；下方的 `ecpay` 页面是另一代小程序支付订单接口，不能按同一字段模型接入。

### 4.2 电商支付订单查询（ecpay 代际页面）

官方接口：[支付结果查询](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/develop/server/payment/ecpay/pay-list/query)

| 项目 | 官方确认 |
|---|---|
| 正式 URL | https://developer.toutiao.com/api/apps/ecpay/v1/query_order |
| 沙盒 URL | https://open-sandbox.douyin.com/api/apps/ecpay/v1/query_order |
| 方法 | POST |
| Header | Content-Type: application/json |
| Body 已确认 | app_id、out_order_no、sign；服务商模式条件传 thirdparty_id |
| 响应已确认 | err_no、err_tips、out_order_no、order_id；官方页面还列出 cps_info 等业务字段，但不在此扩写未核对的完整响应结构。 |

### 4.3 当前生活服务/自营交易分账

#### 4.3.1 创建分账

官方接口：[初始化分账](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/develop/server/locallife/general-ability/self-operated-trading/settlement/init-settle)

| 项目 | 官方确认 |
|---|---|
| URL | https://open.douyin.com/api/apps/trade/v2/settle/create_settle |
| 方法 | POST |
| Scope | `industry_open.trade.settle` |
| 必填 Body | `out_order_no`、`out_settle_no`、`settle_desc` |
| 可选 Body | `item_order_id`、`settle_params`、`cp_extra`、`notify_url` |
| `settle_params` | `merchant_uid`、`amount`；金额单位为分 |
| 响应 | `settle_id`、`inner_settle_id` |

#### 4.3.2 查询分账

官方接口：[查询分账](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/develop/server/locallife/general-ability/self-operated-trading/settlement/query-settle)

| 项目 | 官方确认 |
|---|---|
| URL | https://open.douyin.com/api/apps/trade/v2/settle/query_settle |
| 方法 | POST |
| 查询条件 | `settle_id`、`order_id`、`out_settle_no`、`out_order_no` 四选一；官方给出的优先顺序为 `settle_id` > `order_id` > `out_settle_no` > `out_order_no` |
| 响应字段 | `out_order_no`、`out_settle_no`、`order_id`、`settle_id`、`item_order_id`、`settle_amount`、`settle_status`、`settle_detail`、`settle_time`、`rake`、`commission`、`cp_extra`、`inner_settle_id` |
| 金额单位 | `settle_amount` 单位为分 |

### 4.4 电商支付发起结算及分账（ecpay 代际页面）

官方接口：[发起结算及分账](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/develop/server/payment/ecpay/settlements/settlement)

| 项目 | 官方确认 |
|---|---|
| 正式 URL | https://developer.toutiao.com/api/apps/ecpay/v1/settle |
| 沙盒 URL | https://open-sandbox.douyin.com/api/apps/ecpay/v1/settle |
| 方法 | POST |
| Body 已确认 | app_id、out_settle_no、out_order_no、settle_desc、sign |
| 条件/可选字段 | settle_params、cp_extra、notify_url、thirdparty_id、finish |
| settle_params | JSON 字符串；每项官方字段为 merchant_uid、amount，金额单位为分 |
| finish | 官方特别说明类型是 string 而不是 bool；true 为默认完结分账，false 表示可继续分账 |
| 响应 | err_no、err_tips、成功时 settle_no |
| 账期 | 到店服务类订单默认核销后 3 天；其它订单默认支付成功后 7 天，具体以行业规则为准。 |

### 4.5 电商支付查询结算/分账结果（ecpay 代际页面）

官方接口：[结算及分账结果查询](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/develop/server/payment/ecpay/settlements/query)

| 项目 | 官方确认 |
|---|---|
| 正式 URL | https://developer.toutiao.com/api/apps/ecpay/v1/query_settle |
| 沙盒 URL | https://open-sandbox.douyin.com/api/apps/ecpay/v1/query_settle |
| 方法 | POST |
| Body 已确认 | app_id、sign；out_settle_no 为可选查询条件 |
| 未确认项 | 本次官方搜索结果没有完整展开该接口的全部响应字段，不补猜。 |

### 4.6 生活服务预计分账单

官方接口：[商户查询预计分账单](https://developer.open-douyin.com/docs/resource/zh-CN/local-life/develop/OpenAPI/general-capabilities/life.capacity.billing/merchantquery)

| 项目 | 官方确认 |
|---|---|
| URL | https://open.douyin.com/goodlife/v1/settle/ledger/query/ |
| 方法 | GET |
| Scope | `life.capacity.billing` |
| 生成时间 | 核销后约 1 小时生成预计分账单 |
| Query/响应明细 | 当前核验未从官方页面完整确认，未自行补写字段 |

### 4.7 获取交易账单

当前新接口：[获取交易账单](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/develop/server/trade-system/general/GetBills/)

| 项目 | 官方确认 |
|---|---|
| URL | https://open.douyin.com/api/apps/v3/bills/ |
| 方法 | POST |
| Scope | trade_basic.developer.trade_bill |
| Header | access-token；content-type: application/json |
| Body 必填 | app_id、bill_date、bill_type |
| Body 条件字段 | merchant_id；官方说明支付/退款类型在该字段为空时有特殊返回范围 |
| bill_date | 日账单 yyyyMMdd，月账单 yyyyMM |
| bill_type | payment 支付、settle 分账、refund 退款、return 退分账、withdraw 提现、rebate 返佣、annual_rebate 年框返佣 |
| 响应 | err_no、err_msg、log_id、data.bill_list；bill_list 为账单文件下载 URL，官方说明下载链接有效期 6 小时 |
| 账单数据 | 官方页面按账单类型提供 CSV 示例及字段；例如支付/分账账单含订单号、平台订单号、渠道订单号、金额、支付方式、状态等，具体以所选 bill_type 的官方 CSV/页面定义为准。 |

### 4.8 获取资金账单

当前新接口：[获取资金账单](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/develop/server/trade-system/general/GetBills/fund_bills)

| 项目 | 官方确认 |
|---|---|
| URL | https://open.douyin.com/api/apps/v3/fund/bills/ |
| 方法 | POST |
| Scope | trade_basic.developer.trade_bill |
| Header | access-token；content-type: application/json |
| Body 必填 | account_type、app_id、bill_date、merchant_id、payment_type、trade_type |
| account_type | FEE 手续费、REFUND_DEPOSIT 退款备用金、PAY_TO_CHANGE 打款到零钱、WX 微信、ALIPAY 支付宝、DOUYIN 抖音支付、YZT 聚合账户、ALL 全部 |
| payment_type | INCOME 收入、EXPENDITURE 支出、ALL 全部 |
| trade_type | RECHARGE 充值、PAY 打款、REFUND 退款、DEAL 交易、WITHDRAW 提现、ROLLBACK 退回、ADJUST_IN 调账入、ADJUST_OUT 调账出、PENALTY 扣罚、SETTLE 分账、RETURN_SETTLE_IN 退分账入、RETURN_SETTLE_OUT 退分账出、ALL 全部 |
| bill_date | 日账单 yyyyMMdd，月账单 yyyyMM |
| 响应 | err_no、err_msg、log_id、data.fund_bill_list；账单文件下载 URL 有效期 6 小时 |
| 资金明细字段 | 官方页面确认资金账单金额单位为元，并展示：商户号、交易单号、关联订单号、账户类型、交易类型、收支金额、账户金额、动账时间、说明。 |

### 4.9 旧代际账单接口（仅作兼容核对）

官方仍可检索到旧接口文档：

- [旧交易账单文档](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/develop/server/ecpay/bills/bill/)
  - URL：https://developer.toutiao.com/api/apps/bills
  - 方法：GET
  - Query：bill_date、merchant_id、bill_type、app_id、thirdparty_id、sign
- [旧资金账单文档](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/develop/server/ecpay/bills/fundbill)
  - URL：https://developer.toutiao.com/api/apps/fund/bills
  - 方法：GET
  - Query：app_id、merchant_id、account_type、payment_type、trade_type、bill_date、thirdparty_id、sign

当前新文档已经提供 /api/apps/v3/bills/ 和 /api/apps/v3/fund/bills/ 的 POST 版本。项目接入前应确认目标账号/能力实际开通的是哪一代接口，不要混用 access-token JSON 版本与旧的 sign Query 版本。

## 5. 官方平台迁移影响

官方迁移说明：[抖音开放平台升级（迁移）指引](https://open.douyin.com/platform/resource/docs/transfer)

已确认：

- open.douyin.com/platform/doc 当前重定向到新开发者平台文档。
- 旧抖音开放平台的“自研开发者”数据迁移到 developer.open-douyin.com。
- 旧平台“系统服务商”涉及应用的数据迁移到 developer.open-douyin.com，涉及服务的数据迁移到 partner.open-douyin.com。
- 旧文档仍可访问，但新旧接口、平台角色、权限和域名存在代际差异。本文保留官方 URL 和冲突点，不用猜测字段填平差异。

## 6. 仍无法确认的项

- 授权码展示 URL 的完整 query 参数表及不同应用类型的 scope 清单。
- OAuth 当前 POST 接口的服务端是否严格要求 multipart/form-data 边界格式，或对 application/x-www-form-urlencoded 的兼容范围；当前详情页分别给出了 Content-Type，但未提供可执行请求样例。
- Webhook Msg-Id 的长度、字符集、保留时长，以及缺少该 Header 时的平台行为。
- Webhook 签名的编码大小写、是否有额外前缀、密钥轮换/双密钥过渡规则。
- goodlife/v1/goods/stock/sync/ 的 stock 内部字段；官方当前页面未展开。
- 抖店全品类电商商品创建/更新/库存同步的官方 OpenAPI URL、方法、权限和完整字段；当前 open.douyin.com 资料只确认电商插件商品/订单查询能力指向抖店开放平台。
- 生活服务订单查询的普通事件响应完整结构，以及 `order_status` 等筛选字段的全部枚举含义；本报告只记录页面明确的请求字段和示例状态码。
- 生活服务预计分账单 `goodlife/v1/settle/ledger/query/` 的完整 Query 参数和响应明细字段。
- 当前生活服务分账接口与 `ecpay` 代际结算接口的账号/应用适用范围差异；两组 URL、Scope/签名模型和字段不可混用。
- /api/apps/v3/bills/ 和 /api/apps/v3/fund/bills/ 下载文件的完整 CSV schema，应按实际 bill_type 和官方 demo 文件逐类确认。
- 结算查询接口的完整响应字段及部分行业的特殊结算周期。

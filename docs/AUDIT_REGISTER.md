# 审计问题登记（Audit_Register）

本文件逐条登记审计问题的编号、状态、证据与修复（Requirement 7）。审计基线是 2026-11-04 的《shuzizhibo 全面审查报告》，文件名 `f9d9e2ed-88ca-4736-978b-9c1242d28819.md`。报告不在仓库内，本文件不复制报告全文，只按"审计报告 §<章节> <编号>"引用；登记时读取的报告文件的 SHA-256 记在 [VERIFICATION_LOG.md#v-20261105-05](VERIFICATION_LOG.md#v-20261105-05)。`npm run docs:governance:check`（`scripts/check-governance-docs.mjs`，规则在 `scripts/lib/audit-register.mjs`）在 Local_Verification 与 CI 的 `static-gates` 中校验本文件；行为测试为 `npm run docs:governance:test`。

## 登记范围

- 来自审计报告的记录共 54 条：严重 C1–C4（报告 §2）、高 H1–H7（§3）、中 M1–M25（§4）共 36 个问题，加上 §5"低"中的 18 个问题 L1–L18（Requirement 7.1）。
- **低级问题的拆分规则**：§5 中每个一级列表项算一个问题，按报告中的顺序编号为 L1、L2……。`原始描述` 逐字取该项的加粗短语，与 `scripts/lib/audit-register.mjs` 中冻结的 `REPORT_LOW_ITEMS` 相同（Requirement 7.2）。一级项下的二级子项属于同一个问题，照录在同一记录的 `报告子项` 中（L9 有 4 个子项，L18 有 3 个）。
- 报告 §6（仓库与本机环境状态）与 §8（未覆盖或需在真实环境确认的项）不是 C、H、M、L 问题，不登记。§8 的"RTMP 模式会话 ID"由 Requirement 32 在 Readiness_Matrix 中跟踪。
- **新缺陷**：本规格执行期间发现、报告没有列出的缺陷，从 N1 起顺序编号，不复用、不跳号，在其修复提交之前或同一提交中登记（Requirement 7.14）。

## 记录格式

每条记录由一个三级标题 `### <编号> <标题>` 和紧跟其后的一个 yaml 代码块组成（中间只允许空行）。YAML 用 js-yaml 的 `FAILSAFE_SCHEMA` 解析，所有值都按字符串读取。本文件只有记录使用 yaml 代码块，下面的示例用 text 代码块。

```text
编号: C1                       # 与标题中的编号相同
标题: <与标题中的文字相同>
来源: 审计报告 §2 C1            # 报告中的问题固定写作"审计报告 §<章节> <编号>"；新缺陷写发现出处
来源标记: 已核实                # 已核实 | 待复核 | 需环境验证 | 未标注 | 新发现
原始描述: <L 项必填>            # 与 REPORT_LOW_ITEMS 逐字一致；其他记录不写
报告子项: [<可选>]              # 低级问题的二级子项
优先级: P0                      # P0 | P1 | P2
位置:                           # 至少一项；仓库相对路径（可用 *），有行号时写在冒号之后
  - "infra/postgres/migrations/059_channel_connection_verification_governance.sql:21,25,62-64"
状态: 已确认                    # 待复核 | 已确认 | 已否定 | 需环境验证 | 已修复，必须等于推导结果
对应需求: ["8", "10", "36"]      # 本规格中处理该问题的需求编号；没有时写 ["无：<理由>"]
证据:                           # 至少一项；核实或修复前写审计报告中的对应章节
  - "审计报告 §2 C1"
核实:                           # 可选；每次核实追加一项，不改写已有项
  - 提交: <7 至 40 位小写十六进制 SHA>
    方法: 代码阅读              # 代码阅读 | 本机测试 | CI_Pipeline 运行 | 外部环境测试
    结论: 已确认                # 已确认 | 已否定 | 需环境验证
    证据:                       # 一个映射，或多个映射的列表；字段按方法选择
      文件: <仓库相对路径>       # 代码阅读：文件、行号范围、推理
      行号范围: "64-72"
      推理: <从代码得出结论的理由>
    # 本机测试：{ 测试名称, 命令, 记录: <可选，V-YYYYMMDD-NN> }
    # CI_Pipeline 运行：{ run id, 步骤: [<与结论相关的实际执行步骤名称>], 记录: <可选> }
    # 外部环境测试：{ 环境, 日期: YYYY-MM-DD, 记录: <VERIFICATION_LOG 中的 V-YYYYMMDD-NN> }
修复:                           # 可选；四项都齐全时状态才是已修复
  提交: <修复提交 SHA>
  回归测试: [<至少一个回归测试名称>]
  修复前失败: { 命令: <命令>, 提交: <不含修复的父提交 SHA> }   # 或 { run id: <id> }
  修复后通过: { run id: <id> }                               # 或 { 命令: <命令>, 提交: <修复提交 SHA> }
无需修复: []                     # 最后一次核实的结论为已否定时必填，元素形如 "25.4"
说明: <可选：补充事实与待办>
```

字段规则：

- `位置` 按 dc2916e 中的实际路径填写。报告的路径或行号与 dc2916e 不符时，`位置` 写实际值，并在 `证据` 中以"位置说明"注明报告原文。`vendor/` 下的行号按 dc2916e 锁定的子模块提交。报告只写目录、通配或"各 Dockerfile"时，展开为 dc2916e 中的具体文件；报告没有给出行号的问题不补写行号。
- `对应需求` 写需求编号（"1" 至 "40"），或者只写一项"无：<理由>"。
- `优先级`：报告中的问题取其对应需求在需求总览中的最高优先级，门禁按 `REQUIREMENT_PRIORITIES` 复核；新缺陷按需求文档的"优先级定义"指定（Requirement 7.15），门禁只检查取值。
- 其他键（如 `说明`）可以按需添加，门禁不解释其内容。

## 状态推导规则

每条记录在任一时刻只有一个状态（Requirement 7.4）。`状态` 由人填写，门禁用 `deriveStatus` 按以下顺序重新推导，两者不同时报错：

1. `修复` 同时含有提交 SHA（7 至 40 位）、至少一个回归测试、修复前失败证据和修复后通过证据时，状态为已修复（Requirement 7.11、7.12）。
2. 否则，`核实` 非空时，状态为最后一次核实的 `结论`。
3. 否则按 `来源标记` 取初始状态（Requirement 7.5）：已核实 → 已确认；需环境验证 → 需环境验证；待复核、未标注、新发现 → 待复核。

修复记录缺少任何一项（包括回归测试只能在 Linux 或 4090 上运行、尚未运行的情况）时，状态保持修复前的值，不得写为已修复（Requirement 7.13）。可以先写入已有的部分（例如只写 `提交` 与 `回归测试`），证据齐全后再补齐。

报告中的问题，`来源标记` 必须与报告相同：C、H 两组与 M1–M9 为已核实，M18、M19 为需环境验证，其余 M 项为待复核，L 项在报告中没有标记，写未标注。C3 的原文是"已核实代码；PostgreSQL 报错行为未在本机执行"，H5 的原文是"已核实，并在本机 Node 中复现了 URL 解析异常"，两者按已核实登记，尚未执行的部分写在证据中。新缺陷写新发现。

## 核实、否定与修复的规则

- **核实**（Requirement 7.6、7.7）：每次核实记录所基于的提交、方法与结论，证据按方法填写：代码阅读写文件、行号范围与推理；本机测试写测试名称与执行命令；CI_Pipeline 运行写 run id 与相关的实际执行步骤名称；外部环境测试写环境、日期和 VERIFICATION_LOG 中对应条目的编号。
- **先核实，后修复**（Requirement 7.8）：来源标记为待复核、未标注或新发现的问题，只要写了 `修复`，`核实` 中就必须已有结论为已确认的一项（与修复写在同一提交中也可以）。
- **已否定**（Requirement 7.9、7.10）：最后一次核实的结论为已否定时，必须给出否定依据，即代码阅读的文件、行号范围与推理，或一个在核实提交上通过的 Behavioral_Test 及其执行证据（本机测试的命令或 CI 的 run id）。测试的标签以 `LOCAL_CHECKS` 与 `CI_ONLY_STEPS` 为准；不在这两份清单中的测试，须在证据的 `记录` 中引用判定为行为验证的 VERIFICATION_LOG 条目。只有 Static_Gate 通过不构成否定依据。同时必须写 `无需修复`，列出对应需求中仅为修复该问题而设的验收标准（形如 "25.4"，只能属于本记录的对应需求），没有时写 `[]`；同时服务于其他问题的验收标准不列入。
- **修复**（Requirement 7.11、7.12）：记录修复提交与至少一个回归测试，以及该回归测试的两项执行证据：在不含修复的代码上失败（本机命令加父提交 SHA，或 CI run id），在修复提交上通过。

## 门禁错误码

| 错误码 | 含义 | 需求 |
| --- | --- | --- |
| `AR-SET` | C1–C4、H1–H7、M1–M25、L1–L18 有缺失或重复，出现其他编号，或 N 编号不是从 N1 起连续 | 7.1、7.14 |
| `AR-LOW-TEXT` | L 项的原始描述与 `REPORT_LOW_ITEMS` 不符 | 7.2 |
| `AR-FIELD` | 标题与 YAML 块不配对、YAML 解析失败；编号、位置、状态、证据、对应需求缺失或格式错误；对应需求为"无"时缺少理由；来源或来源标记与报告不符 | 7.3、7.5 |
| `AR-STATUS` | 状态不在五个取值内，或不等于推导结果 | 7.4、7.5 |
| `AR-VERIFY` | 核实缺少提交、方法或结论，或证据字段不符合所选方法 | 7.6、7.7 |
| `AR-ORDER` | 待复核的问题有修复记录，但没有结论为已确认的核实 | 7.8 |
| `AR-NEGATE` | 已否定缺少依据、依据只有 static 检查、缺少 `无需修复` 键或其格式错误 | 7.9、7.10 |
| `AR-FIX` | 修复记录不完整却标为已修复，或修复字段格式错误 | 7.11 至 7.13 |
| `AR-PRIORITY` | 新缺陷缺少优先级；优先级取值错误；报告中问题的优先级不等于对应需求的最高优先级 | 7.15 |
| `SECRET` | 某行命中与 VERIFICATION_LOG 相同的 `SECRET_PATTERNS`；只报模式名，不回显内容 | 6.8 |

YAML 块解析失败的记录报出标题所在行并跳过其余规则，但仍计入 `AR-SET` 的集合统计。全部错误一次报告，门禁以 1 退出。

## 严重（审计报告 §2）

### C1 所有 channel_connections 的 INSERT 都会失败

```yaml
编号: C1
标题: 所有 channel_connections 的 INSERT 都会失败
来源: 审计报告 §2 C1
来源标记: 已核实
优先级: P0
位置:
  - "infra/postgres/migrations/059_channel_connection_verification_governance.sql:21,25,62-64"
  - "infra/postgres/migrations/061_channel_verification_remediation.sql:10,14"
状态: 已确认
对应需求: ["8", "10", "36"]
证据:
  - "审计报告 §2 C1"
  - "位置说明：审计报告与设计第 1 部分 §7.3 把触发器定义写作 059:62-65；dc2916e 中 059 共 64 行，create trigger 语句在第 62 至 64 行"
```

### C2 结算批次和差异的不可变治理完全失效

```yaml
编号: C2
标题: 结算批次和差异的不可变治理完全失效
来源: 审计报告 §2 C2
来源标记: 已核实
优先级: P0
位置:
  - "infra/postgres/migrations/062_settlement_reconciliation.sql:100-101,126-127"
状态: 已确认
对应需求: ["9", "10", "36"]
证据:
  - "审计报告 §2 C2"
```

### C3 alert-notifier 永远发不出任何告警

```yaml
编号: C3
标题: alert-notifier 永远发不出任何告警
来源: 审计报告 §2 C3
来源标记: 已核实
优先级: P0
位置:
  - "apps/alert-notifier/index.mjs:65-69"
状态: 已确认
对应需求: ["11", "36"]
证据:
  - "审计报告 §2 C3"
  - "来源标记说明：报告原文为[已核实代码；PostgreSQL 报错行为未在本机执行]，按设计第 1 部分 §7.1 取已核实；42P18 报错行为尚未在 PostgreSQL 上实际执行，由 Requirement 11.10 的测试最终证明"
  - "位置说明：审计报告与设计第 1 部分 §7.3 写作 index.mjs:64-68；dc2916e 中第 64 行是 set_config，enqueue 的 insert 语句与三个参数在第 65 至 69 行（与设计第 2 部分 §0.1 一致）"
```

### C4 runtime worker 缺少 live_interactions 的 SELECT 权限，渠道回复会被重复发送

```yaml
编号: C4
标题: runtime worker 缺少 live_interactions 的 SELECT 权限，渠道回复会被重复发送
来源: 审计报告 §2 C4
来源标记: 已核实
优先级: P0
位置:
  - "infra/postgres/service-principals.sql:44"
  - "apps/runtime-worker/index.mjs:273"
状态: 已确认
对应需求: ["12", "36"]
证据:
  - "审计报告 §2 C4"
```

## 高（审计报告 §3）

### H1 release.yml 存在脚本注入和凭据外泄

```yaml
编号: H1
标题: release.yml 存在脚本注入和凭据外泄
来源: 审计报告 §3 H1
来源标记: 已核实
优先级: P0
位置:
  - ".github/workflows/release.yml:113,123-124,187-189"
状态: 已确认
对应需求: ["13"]
证据:
  - "审计报告 §3 H1"
```

### H2 RTMP 推流密钥多处泄露

```yaml
编号: H2
标题: RTMP 推流密钥多处泄露
来源: 审计报告 §3 H2
来源标记: 已核实
优先级: P0
位置:
  - "infra/compose/docker-compose.runtime.yml:170"
  - "vendor/LiveTalking/app.py:141"
  - "vendor/LiveTalking/server/routes.py:195-196"
状态: 已确认
对应需求: ["14"]
证据:
  - "审计报告 §3 H2"
  - "位置说明：vendor/LiveTalking 的行号按 dc2916e 锁定的子模块提交 c7269433a2b6ecebcd9342445d2ecc882c98b0da"
```

### H3 节目脚本实际由微软 Edge 在线 TTS 合成，而不是授权的 CosyVoice 声线

```yaml
编号: H3
标题: 节目脚本实际由微软 Edge 在线 TTS 合成，而不是授权的 CosyVoice 声线
来源: 审计报告 §3 H3
来源标记: 已核实
优先级: P0
位置:
  - "vendor/LiveTalking/config.py:74-76"
  - "infra/compose/docker-compose.runtime.yml:169-170"
  - "runtime/gateway/app.py:497,548,556"
状态: 已确认
对应需求: ["15"]
证据:
  - "审计报告 §3 H3"
  - "位置说明：vendor/LiveTalking 的行号按 dc2916e 锁定的子模块提交 c7269433a2b6ecebcd9342445d2ecc882c98b0da"
```

### H4 发布清单的"冻结快照校验"永远显示失败

```yaml
编号: H4
标题: 发布清单的"冻结快照校验"永远显示失败
来源: 审计报告 §3 H4
来源标记: 已核实
优先级: P0
位置:
  - "apps/console/lib/release-manifest.ts:62,103"
状态: 已确认
对应需求: ["16"]
证据:
  - "审计报告 §3 H4"
```

### H5 output-probe 一个无鉴权请求就能让进程崩溃

```yaml
编号: H5
标题: output-probe 一个无鉴权请求就能让进程崩溃
来源: 审计报告 §3 H5
来源标记: 已核实
优先级: P0
位置:
  - "apps/output-probe/index.mjs:47,51"
状态: 已确认
对应需求: ["17"]
证据:
  - "审计报告 §3 H5"
  - "来源标记说明：报告原文为[已核实，并在本机 Node 中复现了 URL 解析异常]，取已核实"
  - "位置说明：审计报告与设计第 1 部分 §7.3 写作 index.mjs:46,50；dc2916e 中第 46 行是 http.createServer 的 async 监听函数，new URL 在第 47 行，decodeURIComponent 在第 51 行"
```

### H6 channel-adapter 转发失败时不释放租约，平台重试会被误判为成功

```yaml
编号: H6
标题: channel-adapter 转发失败时不释放租约，平台重试会被误判为成功
来源: 审计报告 §3 H6
来源标记: 已核实
优先级: P0
位置:
  - "apps/channel-adapter/index.mjs:37-51"
状态: 已确认
对应需求: ["18"]
证据:
  - "审计报告 §3 H6"
```

### H7 Gateway 命令日志会被"毒化"

```yaml
编号: H7
标题: Gateway 命令日志会被"毒化"
来源: 审计报告 §3 H7
来源标记: 已核实
优先级: P0
位置:
  - "runtime/gateway/app.py:257-263,487-491"
  - "infra/compose/docker-compose.runtime.yml:10"
状态: 已确认
对应需求: ["19"]
证据:
  - "审计报告 §3 H7"
```

## 中（审计报告 §4）

### M1 401/403 变成 500

```yaml
编号: M1
标题: 401/403 变成 500
来源: 审计报告 §4 M1
来源标记: 已核实
优先级: P1
位置:
  - "apps/console/lib/control-plane/auth-context.ts"
  - "apps/console/app/api/v1/products/[productId]/versions/route.ts:8"
状态: 已确认
对应需求: ["20"]
证据:
  - "审计报告 §4 M1"
```

### M2 事务内嵌套占用连接池

```yaml
编号: M2
标题: 事务内嵌套占用连接池
来源: 审计报告 §4 M2
来源标记: 已核实
优先级: P1
位置:
  - "apps/console/lib/control-plane/store.ts:190,254-258,318,327"
  - "apps/console/lib/database.ts:12"
状态: 已确认
对应需求: ["21"]
证据:
  - "审计报告 §4 M2"
```

### M3 所有 Node 服务的 pg.Pool 都没有注册 error 监听

```yaml
编号: M3
标题: 所有 Node 服务的 pg.Pool 都没有注册 error 监听
来源: 审计报告 §4 M3
来源标记: 已核实
优先级: P1
位置:
  - "apps/alert-notifier/index.mjs"
  - "apps/channel-adapter/index.mjs"
  - "apps/console/lib/database.ts"
  - "apps/runtime-worker/index.mjs"
状态: 已确认
对应需求: ["22"]
证据:
  - "审计报告 §4 M3"
  - "位置说明：审计报告写作 apps/**（全仓库搜索无匹配）；dc2916e 中创建 pg.Pool 的是这 4 个文件，git grep 在 apps 下没有 pool.on 的匹配"
```

### M4 迁移 checksum 受换行符影响

```yaml
编号: M4
标题: 迁移 checksum 受换行符影响
来源: 审计报告 §4 M4
来源标记: 已核实
优先级: P1
位置:
  - "apps/console/scripts/migration-integrity.mjs:10,16"
状态: 已确认
对应需求: ["23"]
证据:
  - "审计报告 §4 M4"
```

### M5 schema 校验漏检两张表

```yaml
编号: M5
标题: schema 校验漏检两张表
来源: 审计报告 §4 M5
来源标记: 已核实
优先级: P1
位置:
  - "scripts/verify-postgres-schema.mjs:34"
状态: 已确认
对应需求: ["24"]
证据:
  - "审计报告 §4 M5"
```

### M6 非生产模式信任请求头身份

```yaml
编号: M6
标题: 非生产模式信任请求头身份
来源: 审计报告 §4 M6
来源标记: 已核实
优先级: P1
位置:
  - "apps/console/lib/control-plane/auth-context.ts:27-38"
  - "apps/console/proxy.ts:7"
  - "config/control-plane.example.env:2"
状态: 已确认
对应需求: ["25"]
证据:
  - "审计报告 §4 M6"
  - "位置说明：审计报告与设计第 1 部分 §7.3 写作 auth-context.ts:26-37；dc2916e 中 requestContextFrom 的请求头分支在第 27 至 38 行"
```

### M7 compose 硬编码与部署预检脱节

```yaml
编号: M7
标题: compose 硬编码与部署预检脱节
来源: 审计报告 §4 M7
来源标记: 已核实
优先级: P1
位置:
  - "infra/compose/docker-compose.runtime.yml:55"
状态: 已确认
对应需求: ["26"]
证据:
  - "审计报告 §4 M7"
```

### M8 静态门禁只做子串匹配

```yaml
编号: M8
标题: 静态门禁只做子串匹配
来源: 审计报告 §4 M8
来源标记: 已核实
优先级: P1
位置:
  - "scripts/check-*.mjs"
  - "scripts/check-runtime-outbox-alerting.mjs"
状态: 已确认
对应需求: ["36"]
证据:
  - "审计报告 §4 M8"
  - "来源标记说明：报告状态列为 已核实（以运行结果为证）"
```

### M9 Node 20 已于 2026-04-30 停止维护

```yaml
编号: M9
标题: Node 20 已于 2026-04-30 停止维护
来源: 审计报告 §4 M9
来源标记: 已核实
优先级: P1
位置:
  - "package.json"
  - "apps/alert-notifier/Dockerfile"
  - "apps/channel-adapter/Dockerfile"
  - "apps/console/Dockerfile"
  - "apps/output-probe/Dockerfile"
  - "apps/runtime-observer/Dockerfile"
  - "apps/runtime-worker/Dockerfile"
状态: 已确认
对应需求: ["27"]
证据:
  - "审计报告 §4 M9"
  - "位置说明：审计报告写作 根 package.json、各 Dockerfile；dc2916e 中 package.json 的 engines.node 为 >=20.9.0，以 node:20 为基础镜像的是这 6 个 Dockerfile"
```

### M10 runtime-worker 的重试语义

```yaml
编号: M10
标题: runtime-worker 的重试语义
来源: 审计报告 §4 M10
来源标记: 待复核
优先级: P1
位置:
  - "apps/runtime-worker/index.mjs:72-74,179-186,462-470"
状态: 待复核
对应需求: ["28"]
证据:
  - "审计报告 §4 M10"
```

### M11 手工投递可能重复下发

```yaml
编号: M11
标题: 手工投递可能重复下发
来源: 审计报告 §4 M11
来源标记: 待复核
优先级: P1
位置:
  - "apps/console/lib/control-plane/outbox.ts:125-134"
状态: 待复核
对应需求: ["28"]
证据:
  - "审计报告 §4 M11"
```

### M12 数据修复迁移可能空跑

```yaml
编号: M12
标题: 数据修复迁移可能空跑
来源: 审计报告 §4 M12
来源标记: 待复核
优先级: P1
位置:
  - "infra/postgres/migrations/048_runtime_alert_open_uniqueness.sql"
  - "infra/postgres/migrations/061_channel_verification_remediation.sql:69-78"
状态: 待复核
对应需求: ["30"]
证据:
  - "审计报告 §4 M12"
  - "来源标记说明：报告状态列为 待复核，取决于迁移角色"
```

### M13 审批触发器只挂在 UPDATE 和 DELETE 上

```yaml
编号: M13
标题: 审批触发器只挂在 UPDATE 和 DELETE 上
来源: 审计报告 §4 M13
来源标记: 待复核
优先级: P1
位置:
  - "infra/postgres/migrations/051_governed_evidence_immutability.sql"
  - "infra/postgres/migrations/052_editable_draft_show_programs.sql"
  - "infra/postgres/migrations/058_media_asset_content_verification.sql"
  - "infra/postgres/migrations/064_governed_runtime_program_scripts.sql"
状态: 待复核
对应需求: ["29"]
证据:
  - "审计报告 §4 M13"
```

### M14 "最后一个管理员"保护存在写偏斜竞态

```yaml
编号: M14
标题: '"最后一个管理员"保护存在写偏斜竞态'
来源: 审计报告 §4 M14
来源标记: 待复核
优先级: P1
位置:
  - "infra/postgres/migrations/054_governed_membership_authorization.sql:24-52"
状态: 待复核
对应需求: ["29"]
证据:
  - "审计报告 §4 M14"
```

### M15 外键不校验同租户

```yaml
编号: M15
标题: 外键不校验同租户
来源: 审计报告 §4 M15
来源标记: 待复核
优先级: P1
位置:
  - "infra/postgres/migrations/*.sql"
状态: 待复核
对应需求: ["30"]
证据:
  - "审计报告 §4 M15"
  - "来源标记说明：报告状态列为 待复核，可利用性取决于应用层校验"
  - "位置说明：审计报告写作 多个迁移"
```

### M16 JWT 校验缺少加固选项

```yaml
编号: M16
标题: JWT 校验缺少加固选项
来源: 审计报告 §4 M16
来源标记: 待复核
优先级: P1
位置:
  - "apps/console/lib/control-plane/auth-context.ts:51"
  - "apps/console/proxy.ts:17"
状态: 待复核
对应需求: ["25"]
证据:
  - "审计报告 §4 M16"
```

### M17 运行时网络没有隔离

```yaml
编号: M17
标题: 运行时网络没有隔离
来源: 审计报告 §4 M17
来源标记: 待复核
优先级: P1
位置:
  - "infra/compose/docker-compose.runtime.yml"
  - "vendor/LiveTalking"
  - "vendor/CosyVoice"
状态: 待复核
对应需求: ["31"]
证据:
  - "审计报告 §4 M17"
```

### M18 CosyVoice 链路很可能不可用

```yaml
编号: M18
标题: CosyVoice 链路很可能不可用
来源: 审计报告 §4 M18
来源标记: 需环境验证
优先级: P0
位置:
  - "runtime/gateway/app.py:387"
  - "infra/compose/docker-compose.runtime.yml:184-196"
  - "vendor/CosyVoice/cosyvoice/cli/frontend.py:164"
状态: 需环境验证
对应需求: ["15", "32"]
证据:
  - "审计报告 §4 M18"
  - "位置说明：vendor/CosyVoice 的行号按 dc2916e 锁定的子模块提交 074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc"
```

### M19 Gateway journal 备份可能大多失败

```yaml
编号: M19
标题: Gateway journal 备份可能大多失败
来源: 审计报告 §4 M19
来源标记: 需环境验证
优先级: P1
位置:
  - "scripts/backup-runtime-gateway-state.sh:41"
状态: 需环境验证
对应需求: ["32"]
证据:
  - "审计报告 §4 M19"
```

### M20 CI 有缺口

```yaml
编号: M20
标题: CI 有缺口
来源: 审计报告 §4 M20
来源标记: 待复核
优先级: P0
位置:
  - ".github/workflows/ci.yml"
  - ".github/workflows/release.yml"
  - "scripts/check-release-workflow.mjs:11"
状态: 已确认
对应需求: ["2", "3"]
证据:
  - "审计报告 §4 M20"
  - "位置说明：审计报告写作 .github/workflows/*；dc2916e 中有 ci.yml 与 release.yml 两个工作流"
核实:
  - 提交: dc2916eef45f2aebacde24598723468f23ee61a6
    方法: 代码阅读
    结论: 已确认
    证据:
      - 文件: .github/workflows/ci.yml
        行号范围: "1-9"
        推理: "顶层只有 name、on 与 jobs，全文 135 行中没有 permissions 键，GITHUB_TOKEN 使用仓库的默认权限"
      - 文件: .github/workflows/ci.yml
        行号范围: "64-72"
        推理: "九个 docker build 步骤依次构建控制台（含 migrator target）、五个 Node 服务、Gateway 与 LiveTalking，没有构建 runtime/cosyvoice/Dockerfile；cosyvoice 只作为第 63 行 compose 渲染的 profile 出现"
      - 文件: scripts/verify-local.mjs
        行号范围: "26-27"
        推理: "Local_Verification 运行 membership:scopes:check 与 governance:tenant-scope:check，ci.yml 中没有运行这两个检查的步骤"
      - 文件: .github/workflows/ci.yml
        行号范围: "27,30"
        推理: "actions/checkout 与 actions/setup-node 按 tag v4 引用；release.yml 第 106、110、111、129、150、165、169、192 行的 action 同样按 tag 引用"
      - 文件: scripts/check-release-workflow.mjs
        行号范围: "11"
        推理: "门禁要求 release.yml 含有 docker/login-action@v3、docker/setup-buildx-action@v3、docker/build-push-action@v6、actions/upload-artifact@v4、actions/download-artifact@v4 等带 tag 的子串，把 action 改为按 SHA 引用会使该门禁失败，因此它阻止了按 SHA 固定"
```

### M21 发布证据不可信

```yaml
编号: M21
标题: 发布证据不可信
来源: 审计报告 §4 M21
来源标记: 待复核
优先级: P1
位置:
  - "scripts/write-release-image-result.mjs:28"
  - "scripts/verify-deployment-images.mjs"
状态: 待复核
对应需求: ["34"]
证据:
  - "审计报告 §4 M21"
```

### M22 开发 compose 对外暴露数据服务

```yaml
编号: M22
标题: 开发 compose 对外暴露数据服务
来源: 审计报告 §4 M22
来源标记: 待复核
优先级: P1
位置:
  - "infra/compose/docker-compose.yml"
状态: 待复核
对应需求: ["33"]
证据:
  - "审计报告 §4 M22"
```

### M23 LiveTalking 镜像会带入敏感内容

```yaml
编号: M23
标题: LiveTalking 镜像会带入敏感内容
来源: 审计报告 §4 M23
来源标记: 待复核
优先级: P1
位置:
  - "runtime/livetalking/Dockerfile.dockerignore"
状态: 待复核
对应需求: ["33"]
证据:
  - "审计报告 §4 M23"
```

### M24 供应链未锁定

```yaml
编号: M24
标题: 供应链未锁定
来源: 审计报告 §4 M24
来源标记: 待复核
优先级: P2
位置:
  - "apps/alert-notifier/Dockerfile"
  - "apps/channel-adapter/Dockerfile"
  - "apps/console/Dockerfile"
  - "apps/output-probe/Dockerfile"
  - "apps/runtime-observer/Dockerfile"
  - "apps/runtime-worker/Dockerfile"
  - "runtime/gateway/Dockerfile"
  - "runtime/livetalking/Dockerfile"
  - "runtime/cosyvoice/Dockerfile"
  - "runtime/gateway/requirements.txt"
状态: 待复核
对应需求: ["35"]
证据:
  - "审计报告 §4 M24"
  - "位置说明：审计报告写作 各 Dockerfile、requirements；dc2916e 中共有这 9 个 Dockerfile"
```

### M25 异步处理器中有阻塞调用

```yaml
编号: M25
标题: 异步处理器中有阻塞调用
来源: 审计报告 §4 M25
来源标记: 待复核
优先级: P2
位置:
  - "runtime/gateway/app.py:146-165,368-382"
状态: 待复核
对应需求: ["38"]
证据:
  - "审计报告 §4 M25"
```

## 低（审计报告 §5）

### L1 token 比较不是常量时间

```yaml
编号: L1
标题: token 比较不是常量时间
来源: 审计报告 §5 L1
来源标记: 未标注
原始描述: token 比较不是常量时间
优先级: P0
位置:
  - "apps/console/lib/runtime-service-auth.ts:24"
  - "apps/output-probe/index.mjs:36"
状态: 待复核
对应需求: ["17", "37"]
证据:
  - "审计报告 §5 L1"
  - "位置说明：审计报告写作 apps/console/lib/control-plane/runtime-service-auth.ts:24 与 apps/output-probe/index.mjs:35；dc2916e 中前者位于 apps/console/lib/runtime-service-auth.ts（第 24 行），output-probe 的比较在第 36 行"
```

### L2 租户 token 配置错误不会报错

```yaml
编号: L2
标题: 租户 token 配置错误不会报错
来源: 审计报告 §5 L2
来源标记: 未标注
原始描述: 租户 token 配置错误不会报错
优先级: P2
位置:
  - "apps/console/lib/runtime-service-auth.ts"
状态: 待复核
对应需求: ["37"]
证据:
  - "审计报告 §5 L2"
```

### L3 安全头偏弱

```yaml
编号: L3
标题: 安全头偏弱
来源: 审计报告 §5 L3
来源标记: 未标注
原始描述: 安全头偏弱
优先级: P2
位置:
  - "apps/console/next.config.ts:4"
状态: 待复核
对应需求: ["37"]
证据:
  - "审计报告 §5 L3"
```

### L4 错误信息外泄

```yaml
编号: L4
标题: 错误信息外泄
来源: 审计报告 §5 L4
来源标记: 未标注
原始描述: 错误信息外泄
优先级: P2
位置:
  - "apps/console/app/api/v1/runtime/health/route.ts"
状态: 待复核
对应需求: ["37"]
证据:
  - "审计报告 §5 L4"
```

### L5 canonicalJson 依赖 locale

```yaml
编号: L5
标题: canonicalJson 依赖 locale
来源: 审计报告 §5 L5
来源标记: 未标注
原始描述: canonicalJson 依赖 locale
优先级: P1
位置:
  - "apps/console/lib/release-manifest.ts"
  - "scripts/create-deployment-release-manifest.mjs"
  - "scripts/check-deployment-config.mjs"
状态: 待复核
对应需求: ["34"]
证据:
  - "审计报告 §5 L5"
```

### L6 发布清单有效期不一致

```yaml
编号: L6
标题: 发布清单有效期不一致
来源: 审计报告 §5 L6
来源标记: 未标注
原始描述: 发布清单有效期不一致
优先级: P1
位置:
  - "scripts/create-deployment-release-manifest.mjs"
  - "scripts/check-deployment-config.mjs"
状态: 待复核
对应需求: ["34"]
证据:
  - "审计报告 §5 L6"
  - "位置说明：审计报告没有写文件；dc2916e 中生成端的 30 天上限在 create-deployment-release-manifest.mjs，校验端的 31 天上限与写作 30 天的报错文案在 check-deployment-config.mjs"
```

### L7 两个服务不处理 SIGTERM

```yaml
编号: L7
标题: 两个服务不处理 SIGTERM
来源: 审计报告 §5 L7
来源标记: 未标注
原始描述: 两个服务不处理 SIGTERM
优先级: P2
位置:
  - "apps/channel-adapter/index.mjs"
  - "apps/output-probe/index.mjs"
  - "infra/compose/docker-compose.runtime.yml"
状态: 待复核
对应需求: ["38"]
证据:
  - "审计报告 §5 L7"
```

### L8 跨租户改名

```yaml
编号: L8
标题: 跨租户改名
来源: 审计报告 §5 L8
来源标记: 未标注
原始描述: 跨租户改名
优先级: P1
位置:
  - "apps/console/lib/memberships.ts:57-61"
状态: 待复核
对应需求: ["29"]
证据:
  - "审计报告 §5 L8"
```

### L9 Gateway 的小问题

```yaml
编号: L9
标题: Gateway 的小问题
来源: 审计报告 §5 L9
来源标记: 未标注
原始描述: Gateway 的小问题
报告子项:
  - "`/docs` 和 `/openapi.json` 无需鉴权即可访问"
  - "非 ASCII 的 Authorization 头会导致 500"
  - "`NVIDIA_VISIBLE_DEVICES` 不为 0 时 GPU 编号映射错误"
  - "上游 JSON 解析不在 try 中"
优先级: P2
位置:
  - "runtime/gateway/app.py"
状态: 待复核
对应需求: ["37"]
证据:
  - "审计报告 §5 L9"
```

### L10 compose 端口配置不一致

```yaml
编号: L10
标题: compose 端口配置不一致
来源: 审计报告 §5 L10
来源标记: 未标注
原始描述: compose 端口配置不一致
优先级: P1
位置:
  - "infra/compose/docker-compose.runtime.yml"
状态: 待复核
对应需求: ["26"]
证据:
  - "审计报告 §5 L10"
```

### L11 两份 runtime env 模板变量不一致

```yaml
编号: L11
标题: 两份 runtime env 模板变量不一致
来源: 审计报告 §5 L11
来源标记: 未标注
原始描述: 两份 runtime env 模板变量不一致
优先级: P1
位置:
  - "config/runtime.example.env"
  - "config/runtime-gateway.example.env"
状态: 待复核
对应需求: ["26"]
证据:
  - "审计报告 §5 L11"
```

### L12 systemd 单元不完善

```yaml
编号: L12
标题: systemd 单元不完善
来源: 审计报告 §5 L12
来源标记: 未标注
原始描述: systemd 单元不完善
优先级: P2
位置:
  - "infra/systemd/shuzhiren-postgres-backup.service"
  - "infra/systemd/shuzhiren-runtime-gateway-backup.service"
状态: 待复核
对应需求: ["38"]
证据:
  - "审计报告 §5 L12"
  - "位置说明：审计报告没有写文件；dc2916e 中两个备份单元是这两个 .service 文件"
```

### L13 Prometheus 示例目标错误

```yaml
编号: L13
标题: Prometheus 示例目标错误
来源: 审计报告 §5 L13
来源标记: 未标注
原始描述: Prometheus 示例目标错误
优先级: P2
位置:
  - "infra/observability/prometheus.example.yml"
状态: 待复核
对应需求: ["38"]
证据:
  - "审计报告 §5 L13"
```

### L14 备份脚本暴露口令

```yaml
编号: L14
标题: 备份脚本暴露口令
来源: 审计报告 §5 L14
来源标记: 未标注
原始描述: 备份脚本暴露口令
优先级: P2
位置:
  - "scripts/backup-postgres.sh"
  - "scripts/restore-postgres-drill.sh"
状态: 待复核
对应需求: ["38"]
证据:
  - "审计报告 §5 L14"
```

### L15 迁移器缺少保护

```yaml
编号: L15
标题: 迁移器缺少保护
来源: 审计报告 §5 L15
来源标记: 未标注
原始描述: 迁移器缺少保护
优先级: P2
位置:
  - "apps/console/scripts/migrate.mjs"
状态: 待复核
对应需求: ["38"]
证据:
  - "审计报告 §5 L15"
```

### L16 审计哈希链可被改写

```yaml
编号: L16
标题: 审计哈希链可被改写
来源: 审计报告 §5 L16
来源标记: 未标注
原始描述: 审计哈希链可被改写
优先级: P1
位置:
  - "infra/postgres/migrations/030_audit_hash_chain.sql"
  - "infra/postgres/service-principals.sql"
状态: 待复核
对应需求: ["30"]
证据:
  - "审计报告 §5 L16"
```

### L17 锁文件与实际部署不符

```yaml
编号: L17
标题: 锁文件与实际部署不符
来源: 审计报告 §5 L17
来源标记: 未标注
原始描述: 锁文件与实际部署不符
优先级: P2
位置:
  - "runtime/open-source.lock.json"
  - "config/runtime.example.env"
状态: 待复核
对应需求: ["39"]
证据:
  - "审计报告 §5 L17"
```

### L18 许可证事项

```yaml
编号: L18
标题: 许可证事项
来源: 审计报告 §5 L18
来源标记: 未标注
原始描述: 许可证事项
报告子项:
  - "模型权重的许可证与代码许可证是分开的，需要单独审查"
  - "修改后的 LiveTalking 按 Apache-2.0 需要附带修改声明并保留 NOTICE"
  - "edge-tts 的服务条款需要评估"
优先级: P2
位置:
  - "vendor/LiveTalking"
  - "infra/compose/docker-compose.runtime.yml"
状态: 待复核
对应需求: ["39"]
证据:
  - "审计报告 §5 L18"
  - "位置说明：模型权重不在仓库中，由 docker-compose.runtime.yml 以 MODEL_VOLUME_PATH 与 COSYVOICE_MODEL_PATH 挂载进容器"
```

## 新缺陷（本规格执行期间发现）

新缺陷的初始状态为待复核（Requirement 7.5）。N1–N4 的代码阅读核实由阶段 3 的任务 10.1 写入，先于各自的修复提交（Requirement 7.8）。N5 不属于 Requirement 1 至 40 的验收标准，本计划不包含它的修复任务，是否在本规格内修复由用户决定。

### N1 Runtime_Worker 缺少 outbox_events 的 INSERT 权限

```yaml
编号: N1
标题: Runtime_Worker 缺少 outbox_events 的 INSERT 权限
来源: 本规格执行期间新发现（设计文档跨部分裁决 15；第 6 部分 Requirement 28 §28.1 第 7 条）
来源标记: 新发现
优先级: P0
位置:
  - "infra/postgres/service-principals.sql:34"
  - "apps/runtime-worker/index.mjs:158,231"
状态: 待复核
对应需求: ["12", "28"]
证据:
  - "设计文档跨部分裁决 15"
  - "设计文档第 6 部分 Requirement 28 §28.1 第 7 条"
说明: >-
  service-principals.sql 第 34 行只授予 shuzhiren_runtime_worker 对 outbox_events 的 select、update；
  scheduleDueRun（第 95 行起，INSERT 在第 158 行）与 degradeStaleLiveRun（第 193 行起，INSERT 在第 231 行）
  都在租户事务中向 outbox_events 插入 media.dispatch 事件。以 worker 主体运行时这两条路径报 permission denied
  并整体回滚：到期的 ARMED 场次收不到 start_program，遥测过期的 LIVE 场次不会降级。优先级定为 P0，理由是在部署的
  服务主体下定时开播与看门狗降级都无法执行，属于需求文档优先级定义中的部署阻断项。修复与 C4 在 service-principals.sql
  中一起完成（任务 13.1），对应 Requirement 12 的授权改动与 Requirement 28.14 以 worker 主体运行的测试。
```

### N2 渠道连接创建与 channel_connection.created 审计分属两个事务

```yaml
编号: N2
标题: 渠道连接创建与 channel_connection.created 审计分属两个事务
来源: 本规格执行期间新发现（设计文档跨部分裁决 18；第 2 部分 §0.1）
来源标记: 新发现
优先级: P1
位置:
  - "apps/console/app/api/v1/channels/connections/route.ts:22-23"
  - "apps/console/lib/channels.ts:101-107"
状态: 待复核
对应需求: ["8"]
证据:
  - "设计文档跨部分裁决 18"
  - "设计文档第 2 部分 §0.1（route 第 23 行）"
说明: >-
  route.ts 第 22 行的 createChannelConnection 在自己的 withTenantTransaction（channels.ts 第 101 至 107 行）中插入并提交；
  第 23 行再由 recordAuditEvent 另开事务写 channel_connection.created。审计写入失败时连接已经存在，接口却返回 500，
  审计链中也缺少这条创建记录。修复见 Requirement 8.8、8.9（任务 10.3）。
```

### N3 Alert_Notifier 的 /healthz 连通性查询总时长可达 2 × DATABASE_QUERY_TIMEOUT_MS

```yaml
编号: N3
标题: Alert_Notifier 的 /healthz 连通性查询总时长可达 2 × DATABASE_QUERY_TIMEOUT_MS
来源: 本规格执行期间新发现（设计文档跨部分裁决 18；第 2 部分 §4.1 第 4 点）
来源标记: 新发现
优先级: P2
位置:
  - "apps/alert-notifier/index.mjs:13-14,22"
状态: 待复核
对应需求: ["11"]
证据:
  - "设计文档跨部分裁决 18"
  - "设计文档第 2 部分 §4.1 第 4 点"
说明: >-
  index.mjs 第 14 行的连接池把 connectionTimeoutMillis 与 query_timeout 都设为 DATABASE_QUERY_TIMEOUT_MS（第 13 行）；
  /healthz 的 select 1（第 22 行）先等待取得连接、再执行查询，两段分别计时，总时长最长约为 2 × DATABASE_QUERY_TIMEOUT_MS。
  修复为用 withDeadline 限定总时长（任务 12.1）。
```

### N4 Alert_Notifier 在最后一次尝试后崩溃的投递记录永久停在 delivering

```yaml
编号: N4
标题: Alert_Notifier 在最后一次尝试后崩溃的投递记录永久停在 delivering
来源: 本规格执行期间新发现（设计文档跨部分裁决 18；第 2 部分 §4.1 第 6 点）
来源标记: 新发现
优先级: P2
位置:
  - "apps/alert-notifier/index.mjs:83-84,91"
状态: 待复核
对应需求: ["11"]
证据:
  - "设计文档跨部分裁决 18"
  - "设计文档第 2 部分 §4.1 第 6 点"
说明: >-
  claimDelivery 只领取 attempts 小于 ALERT_NOTIFIER_MAX_ATTEMPTS 的记录（第 83 至 84 行），领取时把 attempts 加 1
  并置为 delivering（第 91 行）。最后一次尝试领取之后进程崩溃时，retry 没有执行，记录的 attempts 等于上限、状态为
  delivering，此后既不会再被领取，也不会被标为 failed。修复为 claim 事务中的清扫（任务 12.1）。
```

### N5 commands 路由在 issueCommand 提交之后才用独立事务写审计事件

```yaml
编号: N5
标题: commands 路由在 issueCommand 提交之后才用独立事务写审计事件
来源: 本规格执行期间新发现（设计文档跨部分裁决 18；第 5 部分 Requirement 21 §21.2）
来源标记: 新发现
优先级: P1
位置:
  - "apps/console/app/api/v1/live-runs/[runId]/commands/route.ts:22-25"
状态: 待复核
对应需求: ["无：不属于 Requirement 1 至 40 的验收标准"]
证据:
  - "设计文档跨部分裁决 18"
  - "设计文档第 5 部分 Requirement 21 §21.2"
说明: >-
  commands 路由第 22 行的 issueCommand 在自己的事务中写入命令与 outbox 事件并提交；第 24、25 行再分别调用
  recordAuditEvent 写 live_command.accepted 与 media_command.enqueued，各自是独立的事务。审计写入失败时命令已经入队，
  接口却返回 500，审计链中也缺少这两条记录。第 5 部分发现，第 6 部分未处理；本计划不包含 N5 的修复任务。
```

### N6 CI checkout 中 LiveTalking 镜像构建因悬空的 /app/.git 文件在 git apply 处失败

```yaml
编号: N6
标题: CI checkout 中 LiveTalking 镜像构建因悬空的 /app/.git 文件在 git apply 处失败
来源: 本规格执行期间新发现（CI 第 492 次运行，run 41965741382，docker-build 第 14 步；设计文档“风险”一节“git apply 与 gitlink”）
来源标记: 新发现
优先级: P0
位置:
  - "runtime/livetalking/Dockerfile.dockerignore:1,23-25"
  - "runtime/livetalking/Dockerfile:5,11,13"
状态: 已确认
对应需求: ["1", "2", "33"]
证据:
  - "CI #492（run 41965741382，提交 8226fa38502dbcfa068fa8940fb1850805962734）docker-build 第 14 步 Run docker build --load --file runtime/livetalking/Dockerfile --tag shuzhiren/livetalking:ci . 的结论为 failure，其后的 CosyVoice 构建为 skipped"
  - "设计文档“风险”一节“git apply 与 gitlink”；设计文档第 7 部分 Requirement 33 §1.1"
核实:
  - 提交: 8226fa38502dbcfa068fa8940fb1850805962734
    方法: CI_Pipeline 运行
    结论: 已确认
    证据:
      run id: "41965741382"
      步骤: ["Run docker build --load --file runtime/livetalking/Dockerfile --tag shuzhiren/livetalking:ci ."]
  - 提交: 8226fa38502dbcfa068fa8940fb1850805962734
    方法: 代码阅读
    结论: 已确认
    证据:
      文件: runtime/livetalking/Dockerfile.dockerignore
      行号范围: "1,23-25"
      推理: >-
        第 1 行的 .git 只匹配构建上下文根目录的 .git。第 23 至 25 行先排除 vendor/*，再用 !vendor/LiveTalking/**
        把子模块目录的全部内容重新纳入，其中包括 vendor/LiveTalking/.git。actions/checkout 以 submodules: recursive
        检出时，子模块的 .git 是一个内容为 gitdir: ../../.git/modules/vendor/LiveTalking 的文件；Dockerfile 第 11 行
        COPY vendor/LiveTalking/ ./ 把它复制为 /app/.git，而镜像中没有它指向的目录。第 13 行在 WORKDIR /app（第 5 行）中
        执行 git apply，git 在仓库发现阶段读到这个 .git 文件，以 fatal 错误退出，退出码 128。补丁不能应用时
        git apply --check 的退出码是 1，chown 失败的退出码也是 1，所以 128 指向 git 的 fatal 错误。本机工作区中
        vendor/LiveTalking/.git 是目录，本机的 deploy:check 又在子模块仓库中执行同一补丁的 git apply --check，因此本机看不到这个问题。
修复:
  回归测试: ["docker build --load --file runtime/livetalking/Dockerfile --tag shuzhiren/livetalking:ci ."]
  修复前失败: { run id: "41965741382" }
说明: >-
  失败输出由用户 2026-11-05 登录 GitHub 后从 job 127042212017 的第 14 步日志抄录（公开 API 不提供 job 日志）：
  ERROR: failed to build: failed to solve: process "/bin/sh -c git apply --check --recount /tmp/livetalking-observability.patch
  && git apply --recount /tmp/livetalking-observability.patch && chown -R livetalking:livetalking /app" did not complete
  successfully: exit code: 128。公开 API 的注解只有 Process completed with exit code 1.。2026-11-05 在本机（Windows，
  git 2.56.0.windows.3）的临时目录中复现了机制：目录中放一个内容为 gitdir: ../../.git/modules/vendor/LiveTalking 的 .git 文件时，
  git apply --check --recount 输出 fatal: gitfile does not point to a valid repository 并以 128 退出；删除该文件后同一命令以 0 退出。
  CI 的 Ubuntu 24.04 镜像中 git 版本不同，错误文字可能不同。修复在 !vendor/LiveTalking/** 之后加入 vendor/LiveTalking/.git 与
  vendor/LiveTalking/.git/**（dockerignore 中后出现的规则优先），构建上下文不再包含子模块的 .git，/app 中没有 .git 时
  git apply 以非仓库模式对工作目录应用补丁。优先级定为 P0：它使 CI_Pipeline 的 docker-build 验证组失败，违反 Requirement 1.9
  （LiveTalking 镜像构建以退出码 0 结束），并使 Requirement 2.5 的 CosyVoice 构建被跳过，属于需求文档优先级定义中的 CI 恢复。
  这一修复同时使镜像 /app 下不再有子模块根目录的 .git（Requirement 33.1 的一部分）；M23 的其余内容、按设计第 7 部分 §1.1
  改写整个 dockerignore 与镜像路径检查仍由 Requirement 33 的任务完成，M23 的状态不因本修复改变。修复提交的 SHA 与修复后通过的
  run id 在新的 CI 运行结束后补入；补齐之前状态保持已确认（Requirement 7.13）。
```

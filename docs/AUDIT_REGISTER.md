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
状态: 已修复
对应需求: ["8", "10", "36"]
证据:
  - "审计报告 §2 C1"
  - "位置说明：审计报告与设计第 1 部分 §7.3 把触发器定义写作 059:62-65；dc2916e 中 059 共 64 行，create trigger 语句在第 62 至 64 行"
  - "CI #493（run 41972571602，提交 1657254）postgres-integration 第 10 步 db:verify 的 job 日志错误行为 ERROR channel connection configuration is immutable"
核实:
  - 提交: 16572549bb72d718ad898248fc27e7b74e284e35
    方法: CI_Pipeline 运行
    结论: 已确认
    证据:
      run id: "41972571602"
      步骤: ["Run npm run db:verify -- --allow-privileged"]
修复:
  提交: f35eb3053ee468adfcd79a151ec2e5fc887b572d
  回归测试: ["npm run db:verify -- --allow-privileged"]
  修复前失败: { run id: "41972571602" }
  修复后通过: { run id: "41978941738" }
说明: >-
  修复提交 f35eb30 新增迁移 069，以大写字面量比较 TG_OP，并为 DELETE 给出单独的报错；059 与 061 不变。提交没有新增测试，回归测试是已有的
  db:verify，它在 channel_connections 中插入行：在 #492（run 41965741382）与 #493（run 41972571602，提交 1657254，即 f35eb30 的父提交）中，
  job 日志都报 ERROR channel connection configuration is immutable，步骤以 1 退出（V-20261105-09、V-20261105-10）；在含修复的 #494
  （run 41978941738，提交 734ee8e）中第 10 步为 success（V-20261105-12），此后各次运行都为 success。
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
修复:
  提交: 416df392aa1c574b7f4a04a640752a1c297dce61
  回归测试: ["npm run db:verify -- --allow-privileged"]
  修复后通过: { run id: "41978941738" }
说明: >-
  修复提交 416df39 新增迁移 070，重定义 govern_settlement_batch、govern_settlement_line 与 govern_settlement_exception：只用大写字面量比较 TG_OP，
  未知操作直接报错，批次状态转换改为显式允许列表；062 不变，提交没有新增测试。回归测试是 db:verify 中已有的结算不可变断言
  （scripts/verify-postgres-schema.mjs 第 252 至 259 行，按 416df39）。修复后通过：db:verify 在含修复的 CI 运行（#494，run 41978941738，提交 734ee8e，V-20261105-12）中实际执行并为 success。#492、#493 中 db:verify 在更早的
  channel_connections 插入处因 C1 失败，结算断言没有执行，因此不能作为修复前失败的证据。缺修复前失败：CI 中没有该回归测试在不含修复的代码上失败的运行，提交说明也没有记录在父提交 f35eb30 上运行它的命令与结果，所以只写已有的部分，状态保持已确认（Requirement 7.13）。
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
修复:
  提交: 39ebbc000f1604be0748ac038516d6e560dca575
  回归测试: ["npm run alert-notifier:test"]
  修复后通过: { run id: "41978941738" }
说明: >-
  修复提交 39ebbc0 让 enqueue 语句以 a.tenant_id = $1::uuid 引用租户参数，并为 notifier 的每个参数写明类型。回归测试 scripts/test-alert-notifier.mjs
  由本提交修改：fake pg 对未引用的参数报 42P18，并要求一个轮询周期后 /healthz 为 200。修复后通过：node-unit 的 alert-notifier:test 在含修复的 CI 运行（#494，run 41978941738，提交 734ee8e，V-20261105-12）中实际执行并为 success。
  230e4c7 之后 control-plane:integration 让 notifier 连接真实 PostgreSQL，该步骤在 run 41993338992 中为 success。缺修复前失败：CI 中没有该回归测试在不含修复的代码上失败的运行，提交说明也没有记录在父提交 2e010f0 上运行它的命令与结果，所以只写已有的部分，状态保持已确认（Requirement 7.13）。
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
修复:
  提交: cf05466001c2dd4fa358bfbb29427975d38717e9
说明: >-
  修复提交 cf05466（与 N1 同一提交）在 service-principals.sql 中为 shuzhiren_runtime_worker 授予 live_interactions(id, status) 的列级 select，
  表级 SELECT 仍不授予。提交没有新增或修改测试；现有的 service-principals:integration 不检查 worker 对 live_interactions(id, status) 的 select，
  也没有以 worker 主体执行 markDelivered 的测试。缺回归测试及其修复前失败、修复后通过两项证据，状态保持已确认。
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
修复:
  提交: 2e010f0ed958a6096f46bf439a1e1be21034e502
  回归测试: ["npm run release:workflow:gate:test"]
  修复后通过: { run id: "41978941738" }
说明: >-
  修复提交 2e010f0 让 workflow_dispatch 的每个输入经 step env 进入 shell，新增 validate-inputs 与 validate-signing 步骤，Release_Workflow_Gate
  对 run: 中读取 inputs 或 github.event 的表达式报 RUN_INPUT_INTERPOLATION。回归测试 scripts/test-release-workflow-gate.mjs 由本提交修改。
  修复后通过：node-unit 的 release:workflow:gate:test 在含修复的 CI 运行（#494，run 41978941738，提交 734ee8e，V-20261105-12）中实际执行并为 success。完整修复（去掉 inputs，改由 release-production environment 提供取值，Requirement 13）
  要等仓库所有者配置该 environment；release.yml 本身没有运行过。缺修复前失败：CI 中没有该回归测试在不含修复的代码上失败的运行，提交说明也没有记录在父提交 cf05466 上运行它的命令与结果，所以只写已有的部分，状态保持已确认（Requirement 7.13）。
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
修复:
  提交: 0ff66216b69307e24cb806939b6cdc3afba800ed
  回归测试: ["npm run deploy:check:test"]
  修复后通过: { run id: "42009594325" }
说明: >-
  主修复提交 0ff6621：Compose 以 stream_key secret 挂载密钥并只传 --stream_key_file，LiveTalking 补丁与 launcher 在日志、选项输出、
  /api/admin/config 与 HTTP 响应中屏蔽密钥，deploy:check 拒绝 env 中的 STREAM_KEY 并校验密钥文件；其余提交 dfb1296 改正密钥文件的属主与权限说明。
  回归测试 scripts/test-deployment-config.mjs 由 0ff6621 修改，并运行 runtime/livetalking/tests/test_stream_secret.py。
  修复后通过：node-unit 的 deploy:check:test 在含修复的 CI 运行（#500，run 42009594325，提交 dfb1296，V-20261105-18）中实际执行并为 success。只能在 4090/Linux 运行时主机上验证的部分：真实 RTMP 推流时 ps、docker inspect、
  LiveTalking 与 FFmpeg 日志以及 /api/admin/config 中都不出现密钥。缺修复前失败：CI 中没有该回归测试在不含修复的代码上失败的运行，提交说明也没有记录在父提交 c0763c3 上运行它的命令与结果，所以只写已有的部分，状态保持已确认（Requirement 7.13）。
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
修复:
  提交: 261e260a219168760439f426365943d7342ada3a
  回归测试: ["python3 scripts/test-runtime-gateway-concurrency.py", "npm run runtime:gateway:errors:test", "npm run deploy:check:test", "npm run control-plane:integration"]
  修复后通过: { run id: "42023849073" }
说明: >-
  主修复提交 261e260：Gateway 把节目脚本与 /v1/speak 按句切分，由 CosyVoice 依序合成并经 /humanaudio 注入，不再调用 LiveTalking 的 /human
  （edge-tts）。其余提交：97285c0（worker 转发冻结的声线绑定）、8e0a644（LiveTalking 以 --tts none 启动，CosyVoice 成为受检依赖）、2109ab8
  （控制台与 worker 在节目与语音命令上写入冻结的声线绑定）。回归测试由这些提交新增或修改。修复后通过：python-gateway、node-unit 与 postgres-integration 中的上述步骤在含修复的 CI 运行（#501，run 42023849073，提交 2109ab8，V-20261105-19）中实际执行并为 success。
  只能在 4090 上验证的部分：实际合成的音质、所用声线与授权声线一致、口型同步（与 M18 相同，Readiness_Matrix）。
  缺修复前失败：CI 中没有该回归测试在不含修复的代码上失败的运行，提交说明也没有记录在父提交 013d65d 上运行它的命令与结果，所以只写已有的部分，状态保持已确认（Requirement 7.13）。
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
修复:
  提交: a9c34203781318158b1a2795e430435f55dca6e4
  回归测试: ["npm run control-plane:integration"]
  修复后通过: { run id: "41993338992" }
说明: >-
  修复提交 a9c3420 校验冻结快照时去掉其中嵌入的 sha256 再计算哈希，并要求嵌入值等于 manifest_sha256，已写入的快照也能通过。提交没有修改测试，
  回归测试是 control-plane:integration 中已有的断言 the stored release manifest snapshot must verify against its hash（第 346 行，按 230e4c7）。
  修复后通过：control-plane:integration 在含修复的 CI 运行（#498，run 41993338992，提交 a2804d1，V-20261105-16）中实际执行并为 success。#497（run 41988230415）中该测试在第 235 行（M1）失败后停止，第 346 行没有执行，不能作为修复前失败的证据。
  缺修复前失败：CI 中没有该回归测试在不含修复的代码上失败的运行，提交说明也没有记录在父提交 34236ef 上运行它的命令与结果，所以只写已有的部分，状态保持已确认（Requirement 7.13）。
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
修复:
  提交: 1f1846fccd5fa68fd9b90eab93dd9a381f1f5c47
  回归测试: ["npm run output-probe:config:test", "npm run output-probe:test"]
  修复后通过: { run id: "41978941738" }
说明: >-
  修复提交 1f1846f 把请求处理移到 apps/output-probe/handler.mjs 并包在 guardedHandler 中：无法解析的请求目标答 400 invalid_request_target，
  探针 id 中错误的百分号编码在鉴权后答 400 invalid_probe_id，Authorization 用定长 SHA-256 摘要与 timingSafeEqual 比较（L1 的 output-probe 部分）。
  回归测试 scripts/test-output-probe-config.mjs 与 scripts/test-output-probe.mjs 由本提交修改。修复后通过：node-unit 的这两个步骤在含修复的 CI 运行（#494，run 41978941738，提交 734ee8e，V-20261105-12）中实际执行并为 success。
  提交说明称修复前 GET // 会使进程退出，但没有记录在父提交上运行测试的命令。缺修复前失败：CI 中没有该回归测试在不含修复的代码上失败的运行，提交说明也没有记录在父提交 39ebbc0 上运行它的命令与结果，所以只写已有的部分，状态保持已确认（Requirement 7.13）。
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
修复:
  提交: 4a94e72e54093fd7bc4657bc9d8208266af8525e
  回归测试: ["npm run channel-adapter:test"]
  修复后通过: { run id: "41978941738" }
说明: >-
  修复提交 4a94e72 在转发失败（502 control_plane_rejected、502 control_plane_unreachable、504 control_plane_timeout）后释放本次请求领取的租约，
  租约有效期内的请求答 503 event_processing，租约到期按数据库时钟判断；在迁移 071 增加 lease_token 之前，以行版本的 xmin 作为租约令牌。
  回归测试 scripts/test-channel-adapter.mjs 由本提交修改。修复后通过：node-unit 的 channel-adapter:test 在含修复的 CI 运行（#494，run 41978941738，提交 734ee8e，V-20261105-12）中实际执行并为 success。缺修复前失败：CI 中没有该回归测试在不含修复的代码上失败的运行，提交说明也没有记录在父提交 50a36ff 上运行它的命令与结果，所以只写已有的部分，状态保持已确认（Requirement 7.13）。
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
修复:
  提交: 333f685994f3304862160511c9cd2bb8f71ddc2c
  回归测试: ["python3 scripts/test-runtime-gateway-concurrency.py", "npm run control-plane:integration"]
  修复后通过: { run id: "42040219509" }
说明: >-
  主修复提交 333f685：Command_Journal 改为 reserved、completed、failed_definite、uncertain 四个状态并由 SQLite 触发器约束，旧日志在一个事务中迁移，
  遗留的 reserved 变为 uncertain（legacy_reserved）；结果不确定的命令对重试答 409 command_outcome_uncertain，可经 GET /v1/ops/uncertain-commands 与
  POST /v1/ops/uncertain-commands/{id}/resolution 列出与处置。其余提交：fcacdbc（先校验请求再预留日志 id）、3e1858b（迁移 080，
  outbox_events.outcome_uncertain_at）、94b0329（worker 遇到 command_outcome_uncertain 不重试并开告警）、a3b5c25（worker 对 PostgreSQL 的测试）、
  4066902（failed_definite 的同载荷重试回放已记录的失败）。fcacdbc 的改动在 #499（run 42007377400）中由 python3 scripts/test-runtime-gateway-concurrency.py
  执行并为 success，但它只是 H7 的一部分。修复后通过：两项回归测试在含全部 H7 提交的 CI 运行（#502，run 42040219509，提交 fd9179d，V-20261105-20）中
  实际执行并为 success（python-gateway 第 10 步、postgres-integration 第 12 步）。缺修复前失败：CI 中没有该回归测试在不含修复的代码上失败的运行，
  提交说明也没有记录在父提交上运行它的命令与结果，所以只写已有的部分，状态保持已确认（Requirement 7.13）。
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
状态: 已修复
对应需求: ["20"]
证据:
  - "审计报告 §4 M1"
  - "CI #497（run 41988230415，提交 230e4c7）control-plane:integration 的断言 a restricted operator must not read an unassigned live-run outbox event 得到 500 !== 404"
核实:
  - 提交: 230e4c77d0296f37b4c306dd62ee7c5247840f1c
    方法: CI_Pipeline 运行
    结论: 已确认
    证据:
      run id: "41988230415"
      步骤: ["Run npm run control-plane:integration"]
修复:
  提交: 34236ef4bcc65292dbb4d1f53d0ade3c9ffaaf96
  回归测试: ["npm run control-plane:integration"]
  修复前失败: { run id: "41988230415" }
  修复后通过: { run id: "41993338992" }
说明: >-
  #497 中 GET /api/v1/runtime/outbox/{eventId} 在 try 之外调用 requestContextFrom、requireRole 与 getOutboxEvent，getOutboxEvent 抛出的 404 Response
  被 Next.js 当作未处理异常答为 500，与审计报告 M1 所指的机制相同（dc2916e 中 products/[productId]/versions/route.ts 第 9 行同样在 try 之外调用
  requestContextFrom 与 requireRole）。主修复提交 34236ef 让 44 个路由文件中的全部处理函数在 try 中运行，把抛出的 Response 映射为带状态码的 { error }；
  提交没有修改测试，回归测试是 control-plane:integration 中已有的第 235 行断言（按 230e4c7）。修复前失败：#497（run 41988230415，提交 230e4c7，
  即 34236ef 的父提交）中该断言失败（V-20261105-15）；修复后通过：#498（run 41993338992，提交 a2804d1）中 control-plane:integration 为 success
  （V-20261105-16）。其余提交 a21e0c7 补上 M1 的另一半：statusText 为空的 Response 曾被映射为 { error: "" }，8 个处理函数现在回退到固定错误码；
  membership:authz:check 由该提交修改，在 #499（run 42007377400）中为 success。本轮执行中把 34236ef 当作新发现处理过，这里按机制归入 M1，不另登记 N 编号。
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
修复:
  提交: 3da13246827be11c20adf7df7e86836e2d5be254
  回归测试: ["npm run preflight:check"]
  修复后通过: { run id: "42007377400" }
说明: >-
  修复提交 3da1324 为每个预检输入增加 InTransaction 版本，arm 与 START 在调用方的事务连接上依次读取，不再在持有连接与直播场次锁时另取连接。
  preflight:check（LOCAL_CHECKS 中标为 static）由本提交修改，用取第二个连接就失败的假连接池驱动 arm 与 START；提交说明称它在旧代码上失败，
  但没有记录命令。修复后通过：static-gates 的 preflight:check 在含修复的 CI 运行（#499，run 42007377400，提交 806d24a，V-20261105-17）中实际执行并为 success。缺修复前失败：CI 中没有该回归测试在不含修复的代码上失败的运行，提交说明也没有记录在父提交 e3bad9b 上运行它的命令与结果，所以只写已有的部分，状态保持已确认（Requirement 7.13）。
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
修复:
  提交: 2e6a81acc316e58a6905441986e36587fa704ca2
  回归测试: ["npm run runtime:worker:health:test", "npm run channel-adapter:test", "npm run alert-notifier:test", "npm run preflight:check", "npm run control-plane:integration"]
  修复后通过: { run id: "42007377400" }
说明: >-
  主修复提交 2e6a81a：runtime-worker、channel-adapter 与 alert-notifier 经同一份 db.mjs 创建连接池并注册 error 监听；其余提交 c9d5129 为控制台的
  createDatabasePool 注册监听并改正 withTenantTransaction 的回滚与释放。回归测试由这两个提交修改：各服务对假 PostgreSQL 以 FATAL 57P01 断开空闲连接后
  进程必须存活并重新提供 /healthz，控制台的集成测试终止其空闲后端后仍须提供 /api/health。修复后通过：上述步骤在含修复的 CI 运行（#499，run 42007377400，提交 806d24a，V-20261105-17）中实际执行并为 success。缺修复前失败：CI 中没有该回归测试在不含修复的代码上失败的运行，提交说明也没有记录在父提交 5c67f88 上运行它的命令与结果，所以只写已有的部分，状态保持已确认（Requirement 7.13）。
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
修复:
  提交: 234265fdb3178727d7975e67578c2b3f71d0e318
  回归测试: ["npm run db:migrate:integrity:test"]
  修复后通过: { run id: "42007377400" }
说明: >-
  修复提交 234265f 让 loadMigrations 在计算哈希与执行前把 CR LF 换为 LF，Schema_Verifier 共用该加载器，.gitattributes 让 *.sql 与 *.sh 在任何检出中都是 LF。
  回归测试 scripts/test-migration-integrity.mjs 由本提交修改。修复后通过：postgres-integration 的 db:migrate:integrity:test 在含修复的 CI 运行（#499，run 42007377400，提交 806d24a，V-20261105-17）中实际执行并为 success。缺修复前失败：CI 中没有该回归测试在不含修复的代码上失败的运行，提交说明也没有记录在父提交 c9d5129 上运行它的命令与结果，所以只写已有的部分，状态保持已确认（Requirement 7.13）。
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
修复:
  提交: e3bad9bcb3027a8041d8f854328537d5628adea4
  回归测试: ["npm run db:migrate:integrity:test"]
  修复后通过: { run id: "42007377400" }
说明: >-
  主修复提交 e3bad9b：Schema_Verifier 从 pg_class 读取全部带 tenant_id 的表，逐个报告缺少 ENABLE、FORCE 或两者，集合为空时失败。其余提交 f4703fc
  在删除每次运行的 RLS 探针角色前先撤销授权；#492 至 #497 的 PostgreSQL 服务日志中都有 role "shuzhiren_rls_probe_*" cannot be dropped because some
  objects depend on it。回归测试 scripts/test-migration-integrity.mjs 由 e3bad9b 修改。修复后通过：db:migrate:integrity:test 在含修复的 CI 运行（#499，run 42007377400，提交 806d24a，V-20261105-17）中实际执行并为 success。缺修复前失败：CI 中没有该回归测试在不含修复的代码上失败的运行，提交说明也没有记录在父提交 234265f 上运行它的命令与结果，所以只写已有的部分，状态保持已确认（Requirement 7.13）。
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
修复:
  提交: 20c79361a8ba3da49a8df943c3d700d0fa4df89d
  回归测试: ["npm run console:page-auth:check", "npm run deploy:check:test"]
  修复后通过: { run id: "42007377400" }
说明: >-
  主修复提交 20c7936：请求头身份、跳过 JWT 与 CSRF、内置演示服务 token 都只在 CONTROL_PLANE_DEV_HEADER_IDENTITY=true 且只监听回环地址时生效，
  生产环境同时开启时 instrumentation 拒绝启动。其余提交 0649c05 让 Deploy_Check 拒绝该开关。回归测试由这两个提交修改。
  修复后通过：console:page-auth:check 与 deploy:check:test 在含修复的 CI 运行（#499，run 42007377400，提交 806d24a，V-20261105-17）中实际执行并为 success。缺修复前失败：CI 中没有该回归测试在不含修复的代码上失败的运行，提交说明也没有记录在父提交 41f7591 上运行它的命令与结果，所以只写已有的部分，状态保持已确认（Requirement 7.13）。
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
修复:
  提交: 1977e2c64d59dcadd7a8d634d4609defe2e0a95f
  回归测试: ["npm run deploy:check:test"]
  修复后通过: { run id: "42007377400" }
说明: >-
  修复提交 1977e2c 让 runtime Compose 以原字面量为默认值插值 OUTBOX_MAX_ATTEMPTS 等五个调优变量，deploy:check 解析 runtime Compose 并报告
  RC-UNDEFINED、RC-CONFLICT 与 RC-LITERAL。回归测试 scripts/test-deployment-config.mjs 由本提交修改。修复后通过：deploy:check:test 在含修复的 CI 运行（#499，run 42007377400，提交 806d24a，V-20261105-17）中实际执行并为 success。缺修复前失败：CI 中没有该回归测试在不含修复的代码上失败的运行，提交说明也没有记录在父提交 3fd7235 上运行它的命令与结果，所以只写已有的部分，状态保持已确认（Requirement 7.13）。
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
修复:
  提交: fb763f5c9a491e45967d4e0e6ede2d84dcdb6363
  回归测试: ["npm run output-probe:response:check", "npm run console:client-requests:check"]
  修复后通过: { run id: "42023849073" }
说明: >-
  修复提交 fb763f5 评估了 36 个 static 检查脚本：多数的行为已由 control-plane:integration、db:verify、service-principals:integration、各服务测试与
  deploy:check:test 覆盖，只有 output-probe:response:check 与 console:client-requests:check 没有行为对应项，本提交为这两个检查加入行为断言。
  修复后通过：static-gates 中的这两个检查在含修复的 CI 运行（#501，run 42023849073，提交 2109ab8，V-20261105-19）中实际执行并为 success。提交说明写明两者在当前代码上通过；它们为原有行为补上断言，不存在在修复前代码上失败的运行，
  所以缺修复前失败，状态保持已确认。其余 34 个检查仍只做文本匹配。
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
修复:
  提交: 2c7d5d9bb036f8da7787a1eb25804fb1c4162982
  回归测试: ["npm run runtime:images:check", "npm run deploy:images:test"]
  修复后通过: { run id: "42023849073" }
说明: >-
  主修复提交 2c7d5d9：engines.node 为 ^24.11.0，@types/node 为 24，六个 Node Dockerfile 改用 node:24 基础镜像，runtime:images:check 拒绝非 24 的版本。
  其余提交 b829fe5 在 release.yml 的两个 job 中固定 setup-node。CI 自 371a203 起使用 Node.js 24。修复后通过：runtime:images:check 与 deploy:images:test 在含修复的 CI 运行（#501，run 42023849073，提交 2109ab8，V-20261105-19）中实际执行并为 success。
  缺修复前失败：CI 中没有该回归测试在不含修复的代码上失败的运行，提交说明也没有记录在父提交 39f844c 上运行它的命令与结果，所以只写已有的部分，状态保持已确认（Requirement 7.13）。
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
状态: 已确认
对应需求: ["28"]
证据:
  - "审计报告 §4 M10"
核实:
  - 提交: 0ff66216b69307e24cb806939b6cdc3afba800ed
    方法: 代码阅读
    结论: 已确认
    证据:
      - 文件: apps/runtime-worker/index.mjs
        行号范围: "253-255,317-321,445,455"
        推理: >-
          markDelivered（第 253 行起）在第 255 行只按 id 把 outbox_events 写为 delivered，markFailed（第 317 行起）在第 321 行同样只按 id 写入，
          都不检查 state = 'delivering' 与领取时的 attempts，租约过期并被另一实例领取后，原持有者的写入仍会覆盖新领取者的状态。markDelivered 在投递成功之后
          应用回执，回执无法应用而抛出时，tick 的 catch（第 455 行）把事件当作可重试失败，下一次领取会再次下发已被接受的命令。计量 meterLiveUsage 在投递循环中
          调用（第 445 行），慢投递会推迟计量。
修复:
  提交: 2d9706653a081482210bfb4bac0d83244cf2bc93
  回归测试: ["npm run control-plane:integration", "npm run runtime:worker:config:test"]
  修复后通过: { run id: "42007377400" }
说明: >-
  修复提交 2d97066（迁移 077）：markDelivered 与 markFailed 以 (id, state = delivering, attempts) 为围栏，请求时长受剩余租约限制，接受首次接受的回执，
  回执无法应用时立即耗尽，清扫最后一次尝试租约过期的事件并开告警，同一场次的 media.dispatch 按顺序领取，计量在独立循环中运行。回归测试由本提交修改。
  修复后通过：control-plane:integration 与 runtime:worker:config:test 在含修复的 CI 运行（#499，run 42007377400，提交 806d24a，V-20261105-17）中实际执行并为 success。缺修复前失败：CI 中没有该回归测试在不含修复的代码上失败的运行，提交说明也没有记录在父提交 0ff6621 上运行它的命令与结果，所以只写已有的部分，状态保持已确认（Requirement 7.13）。
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
状态: 已确认
对应需求: ["28"]
证据:
  - "审计报告 §4 M11"
核实:
  - 提交: 44857e13e02cb5bd5501dafe44b9c61894dbdc98
    方法: 代码阅读
    结论: 已确认
    证据:
      - 文件: apps/console/lib/control-plane/outbox.ts
        行号范围: "115-132,176,238"
        推理: >-
          deliverOutboxEvent（第 115 行起）在同一个 try 中下发并调用 markDelivered（第 129 行），catch（第 131、132 行）把任何错误都写为 failed，
          包括 Gateway 已接受、只是记录投递失败的情况，下一次手工或 worker 投递会再次下发同一命令。第 176 行的 delivered 写入与第 238 行的 failed 写入都只按 id
          匹配，不以领取时的 attempts 为围栏，租约已转给另一领取者时，迟到的写入会覆盖其状态。
修复:
  提交: f627116550e61d52d62817e5c1417c4783c59e02
  回归测试: ["npm run control-plane:integration"]
  修复后通过: { run id: "42023849073" }
说明: >-
  修复提交 f627116 以领取时的 (id, attempts) 为围栏，只有 Gateway 失败才写 failed，记录已接受的投递失败时保留租约并答 503
  delivery_accepted_state_unconfirmed，租约期内的重复请求答 409。回归测试 scripts/test-control-plane-postgres.mjs 由本提交修改。
  修复后通过：control-plane:integration 在含修复的 CI 运行（#501，run 42023849073，提交 2109ab8，V-20261105-19）中实际执行并为 success。缺修复前失败：CI 中没有该回归测试在不含修复的代码上失败的运行，提交说明也没有记录在父提交 44857e1 上运行它的命令与结果，所以只写已有的部分，状态保持已确认（Requirement 7.13）。
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
状态: 已确认
对应需求: ["30"]
证据:
  - "审计报告 §4 M12"
  - "来源标记说明：报告状态列为 待复核，取决于迁移角色"
核实:
  - 提交: f627116550e61d52d62817e5c1417c4783c59e02
    方法: 代码阅读
    结论: 已确认
    证据:
      - 文件: infra/postgres/migrations/048_runtime_alert_open_uniqueness.sql
        行号范围: "3-11"
        推理: >-
          数据修复语句在 FORCE RLS 的 runtime_alerts 上执行 UPDATE。迁移以表属主身份、在没有 BYPASSRLS 且没有设置 app.tenant_id 的会话中运行时，
          策略把所有行过滤掉，语句改动 0 行，迁移仍会被记录为已应用。
      - 文件: infra/postgres/migrations/061_channel_verification_remediation.sql
        行号范围: "68-77"
        推理: >-
          同样是对 FORCE RLS 的 channel_connections 的 UPDATE，在上述条件下改动 0 行，未验证的连接不会被禁用，迁移照常记录。
修复:
  提交: ba28eabe6a1a5472ca52057db3d52411bf072dcb
  回归测试: ["npm run db:migrate:integrity:test"]
  修复后通过: { run id: "42023849073" }
说明: >-
  修复提交 ba28eab 新增迁移 079：migration_fix_update 等函数先在解除 FORCE、关闭 row_security 后统计目标行数，再在正常 RLS 下执行语句，两者不同时报错并回滚；
  迁移器拒绝编号 079 及以后、含顶层数据修改语句却未经这些函数的迁移。048 与 061 不变。回归测试 scripts/test-migration-integrity.mjs 由本提交修改。
  修复后通过：db:migrate:integrity:test 在含修复的 CI 运行（#501，run 42023849073，提交 2109ab8，V-20261105-19）中实际执行并为 success。提交说明记录的 048、061 重放（过滤后 rowCount=0，未过滤为 2）没有给出命令。缺修复前失败：CI 中没有该回归测试在不含修复的代码上失败的运行，提交说明也没有记录在父提交 f627116 上运行它的命令与结果，所以只写已有的部分，状态保持已确认（Requirement 7.13）。
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
状态: 已确认
对应需求: ["29"]
证据:
  - "审计报告 §4 M13"
核实:
  - 提交: 15c1777b04b1912bb8fe6337d4690695e834b5d9
    方法: 代码阅读
    结论: 已确认
    证据:
      - 文件: infra/postgres/migrations/051_governed_evidence_immutability.sql
        行号范围: "146-159"
        推理: >-
          product_versions、show_revisions、policy_profiles、model_releases 的治理触发器都声明为 before update or delete，INSERT 不经过它们，
          直接插入 approved 状态的行没有审批人与审批时间的检查。
      - 文件: infra/postgres/migrations/058_media_asset_content_verification.sql
        行号范围: "63-64"
        推理: >-
          media_assets 的治理触发器同样只在 update 或 delete 时触发，直接插入 approved 的素材不需要内容核验证据。
修复:
  提交: f9bf8dcb3ad2dc44d54d40e62179725fe7d6ea74
  回归测试: ["npm run db:verify -- --allow-privileged"]
  修复后通过: { run id: "42007377400" }
说明: >-
  修复提交 f9bf8dc 新增迁移 075：五张表上的 BEFORE INSERT 触发器拒绝缺少证据列的 approved 行（23514 approved_insert_requires_evidence）。
  回归测试 scripts/verify-postgres-schema.mjs 由本提交修改。修复后通过：db:verify 在含修复的 CI 运行（#499，run 42007377400，提交 806d24a，V-20261105-17）中实际执行并为 success。缺修复前失败：CI 中没有该回归测试在不含修复的代码上失败的运行，提交说明也没有记录在父提交 15c1777 上运行它的命令与结果，所以只写已有的部分，状态保持已确认（Requirement 7.13）。
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
状态: 已确认
对应需求: ["29"]
证据:
  - "审计报告 §4 M14"
核实:
  - 提交: 7e7ed12e27fd9a51c5290a7569ff62ba5624918d
    方法: 代码阅读
    结论: 已确认
    证据:
      - 文件: infra/postgres/migrations/054_governed_membership_authorization.sql
        行号范围: "28-45"
        推理: >-
          删除、降级或停用管理员时，函数用普通读取（第 29 至 31 行、第 40 至 43 行）检查是否还有其他活跃管理员。两个并发事务各移除一个不同的管理员时，
          各自都看到对方仍然活跃，都能提交，租户最后没有活跃管理员。
修复:
  提交: 13282e5a2f782588daf82312d5336bcd5e5d7ab4
  回归测试: ["npm run control-plane:integration"]
  修复后通过: { run id: "42007377400" }
说明: >-
  修复提交 13282e5 新增迁移 076：membership_admin_guards 每租户一行，移除活跃管理员前先写该行，使并发移除串行化。回归测试由本提交修改，
  在三种隔离级别下验证两次并发移除只有一次成功。修复后通过：control-plane:integration 在含修复的 CI 运行（#499，run 42007377400，提交 806d24a，V-20261105-17）中实际执行并为 success。提交说明称 076 之前 read committed 的情形会失去全部管理员，
  但没有记录命令。缺修复前失败：CI 中没有该回归测试在不含修复的代码上失败的运行，提交说明也没有记录在父提交 7e7ed12 上运行它的命令与结果，所以只写已有的部分，状态保持已确认（Requirement 7.13）。
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
状态: 已确认
对应需求: ["30"]
证据:
  - "审计报告 §4 M15"
  - "来源标记说明：报告状态列为 待复核，可利用性取决于应用层校验"
  - "位置说明：审计报告写作 多个迁移"
核实:
  - 提交: f4703fcce0281ae5c7ea90a96ac0bd42ce83b55b
    方法: 代码阅读
    结论: 已确认
    证据:
      - 文件: infra/postgres/migrations/001_control_plane.sql
        行号范围: "61,72"
        推理: >-
          show_revisions.show_id 与引用 show_revisions 的外键都是单列 references，不包含 tenant_id。PostgreSQL 检查外键时不应用行级安全，
          应用层漏掉租户检查时，一行可以引用另一租户的行，被引用的行也可以改到另一租户。
修复:
  提交: 806d24a764a797d0afae7d1d1907d8725b061dd3
  回归测试: ["npm run db:verify -- --allow-privileged"]
  修复后通过: { run id: "42007377400" }
说明: >-
  修复提交 806d24a 新增迁移 078：为租户表之间的 54 个外键各加一个 (tenant_id, 列) 的复合外键及其所需的唯一约束。回归测试 scripts/verify-postgres-schema.mjs
  由本提交修改。修复后通过：db:verify 在含修复的 CI 运行（#499，run 42007377400，提交 806d24a，V-20261105-17）中实际执行并为 success。提交说明称 078 之前三次跨租户写入都会成功，但没有记录命令。缺修复前失败：CI 中没有该回归测试在不含修复的代码上失败的运行，提交说明也没有记录在父提交 f4703fc 上运行它的命令与结果，所以只写已有的部分，状态保持已确认（Requirement 7.13）。
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
状态: 已确认
对应需求: ["25"]
证据:
  - "审计报告 §4 M16"
核实:
  - 提交: 13282e5a2f782588daf82312d5336bcd5e5d7ab4
    方法: 代码阅读
    结论: 已确认
    证据:
      - 文件: apps/console/lib/control-plane/auth-context.ts
        行号范围: "59"
        推理: >-
          jwtVerify 只传 issuer 与 audience：jose 只在 exp 存在时检查它，没有 exp 的 token 永不过期；也没有 algorithms 白名单，JWKS 密钥能验证的任何算法都被接受。
      - 文件: apps/console/proxy.ts
        行号范围: "20"
        推理: >-
          代理中的 jwtVerify 调用同样只传 issuer 与 audience。
修复:
  提交: cd251cf14afdc2ece32cf37d078124c4c76ef112
  回归测试: ["npm run console:page-auth:check"]
  修复后通过: { run id: "42007377400" }
说明: >-
  修复提交 cd251cf 让两处都经 lib/control-plane/oidc.ts 校验：要求 exp，算法限于非对称白名单（OIDC_ALLOWED_ALGORITHMS），可选校验 typ。
  回归测试 scripts/check-console-page-auth.mjs（LOCAL_CHECKS 中标为 static）由本提交修改。修复后通过：console:page-auth:check 在含修复的 CI 运行（#499，run 42007377400，提交 806d24a，V-20261105-17）中实际执行并为 success。缺修复前失败：CI 中没有该回归测试在不含修复的代码上失败的运行，提交说明也没有记录在父提交 13282e5 上运行它的命令与结果，所以只写已有的部分，状态保持已确认（Requirement 7.13）。
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
状态: 已确认
对应需求: ["31"]
证据:
  - "审计报告 §4 M17"
核实:
  - 提交: f9bf8dcb3ad2dc44d54d40e62179725fe7d6ea74
    方法: 代码阅读
    结论: 已确认
    证据:
      - 文件: infra/compose/docker-compose.runtime.yml
        行号范围: "2,38,72,98,118,139,161,184"
        推理: >-
          文件中八个服务（runtime-gateway、runtime-worker、runtime-observer、output-probe、channel-adapter、alert-notifier、livetalking、cosyvoice）
          都没有 networks 设置，全部在默认网络上，任一边车都能直接访问没有鉴权的 LiveTalking 与 CosyVoice API，绕过 runtime-gateway。
修复:
  提交: 7e7ed12e27fd9a51c5290a7569ff62ba5624918d
  回归测试: ["npm run runtime:compose:check"]
  修复后通过: { run id: "42007377400" }
说明: >-
  修复提交 7e7ed12 把 runtime-gateway、livetalking、cosyvoice 放到 internal 的 runtime-media 网络，livetalking 另加只用于 RTMP 推流的 livetalking-egress，
  runtime:compose:check 报告 RCT-NETWORK。修复后通过：runtime:compose:check 在含修复的 CI 运行（#499，run 42007377400，提交 806d24a，V-20261105-17）中实际执行并为 success。runtime-observer 的只读 Gateway 凭据（同属 Requirement 31）不在本提交中。
  只能在 Linux 运行时主机上验证的部分：实际部署中边车容器无法连到 LiveTalking 与 CosyVoice。缺修复前失败：CI 中没有该回归测试在不含修复的代码上失败的运行，提交说明也没有记录在父提交 f9bf8dc 上运行它的命令与结果，所以只写已有的部分，状态保持已确认（Requirement 7.13）。
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
修复:
  提交: 261e260a219168760439f426365943d7342ada3a
  回归测试: ["python3 scripts/test-runtime-gateway-concurrency.py", "npm run deploy:check:test"]
  修复后通过: { run id: "42023849073" }
说明: >-
  主修复提交 261e260（与 H3 相同）；其余提交 8e0a644 为 CosyVoice 增加 /openapi.json 健康检查，Gateway 需要 COSYVOICE_MODEL_KIND 与只读声音库，
  COSYVOICE_REQUIRED 默认为 true。修复后通过：python-gateway 与 node-unit 中的这两个步骤在含修复的 CI 运行（#501，run 42023849073，提交 2109ab8，V-20261105-19）中实际执行并为 success。来源标记为需环境验证，本记录没有核实项，状态保持需环境验证：
  CosyVoice 服务在 4090 上能否加载模型并在时限内合成、/humanaudio 注入后的音质与口型，只能在 4090 上验证（Readiness_Matrix）。CI 中没有在修复前失败的运行，
  也缺修复前失败。
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
修复:
  提交: 14afbe2f642955509ec244679f7cf2d405422296
  回归测试: ["python3 scripts/test-runtime-gateway-state-backup.py"]
  修复后通过: { run id: "42007377400" }
说明: >-
  修复提交 14afbe2：空闲的 WAL 日志（没有 -wal 与 -shm）不打开而直接复制，前后核对 inode、大小、mtime、ctime 与 SHA-256；有旁路文件时仍用在线备份；
  任何失败只输出一行 ERROR 并删除本次产生的文件。回归测试由本提交修改，只读目录的用例需要 Linux 与非 root 用户，在 python-gateway 中运行。
  修复后通过：python-gateway 的该步骤在含修复的 CI 运行（#499，run 42007377400，提交 806d24a，V-20261105-17）中实际执行并为 success。来源标记为需环境验证，本记录没有核实项，状态保持需环境验证：在 Linux 主机上由 systemd 单元以 ReadOnlyPaths=
  实际运行备份（含 Gateway 正在写入时）的结果尚未取得。CI 中没有在修复前失败的运行，也缺修复前失败。
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
说明: >-
  状态不变。371a203 起 CI 拆为六个 job、顶层 permissions 为 contents: read，新增 CosyVoice 镜像构建与 membership:scopes:check、
  governance:tenant-scope:check，ci.yml 与 release.yml 的 action 按 SHA 固定（c9ad0d1、b497103）；首次全绿的运行为 #498（run 41993338992，
  VERIFICATION_LOG.md#v-20261105-16）。这些改动没有作为 M20 的修复记录登记，M20 的其余内容由 Requirement 2、3 的任务处理。
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
状态: 已确认
对应需求: ["34"]
证据:
  - "审计报告 §4 M21"
核实:
  - 提交: 8e0a644eb8bbe7de74ea0edc9a1ebaf472056eb0
    方法: 代码阅读
    结论: 已确认
    证据:
      - 文件: scripts/write-release-image-result.mjs
        行号范围: "28"
        推理: >-
          构建结果把 sbom 与 provenance 写成常量 "oci-buildx-attached"，没有读取任何 attestation；汇总脚本与 Deploy_Check 只比较这个常量，
          签名的索引因此为没有人看过的 SBOM 与 provenance 作证。
修复:
  提交: 4672ebc6b728cfc57d98c07e59c4999e6aeef11c
  回归测试: ["npm run release:evidence:test", "npm run deploy:check:test"]
  修复后通过: { run id: "42023849073" }
说明: >-
  主修复提交 4672ebc：构建结果为 schemaVersion 2，只写推送的摘要；汇总脚本按摘要从 registry 读取镜像索引，要求一个 linux/amd64 镜像、一个引用它的
  Buildx attestation 清单及其中各一份 SPDX SBOM 与 SLSA provenance，全部十个镜像通过才写文件。其余提交 b829fe5 让 release.yml 经 env 传入 RELEASE_REGISTRY
  与只读凭据。回归测试由 4672ebc 修改。修复后通过：node-unit 的 release:evidence:test 与 deploy:check:test 在含修复的 CI 运行（#501，run 42023849073，提交 2109ab8，V-20261105-19）中实际执行并为 success。release.yml 本身没有运行过。
  缺修复前失败：CI 中没有该回归测试在不含修复的代码上失败的运行，提交说明也没有记录在父提交 8e0a644 上运行它的命令与结果，所以只写已有的部分，状态保持已确认（Requirement 7.13）。
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
状态: 已确认
对应需求: ["33"]
证据:
  - "审计报告 §4 M22"
核实:
  - 提交: e427a45384439d703d02ad22932b40b06602c3db
    方法: 代码阅读
    结论: 已确认
    证据:
      - 文件: infra/compose/docker-compose.yml
        行号范围: "3-9,19-21,27"
        推理: >-
          PostgreSQL 以固定口令 replace-in-local-env 发布在 "5432:5432"，Redis 发布在 "6379:6379"（短格式端口映射绑定所有网卡），
          MinIO 使用 minio/minio:latest。
修复:
  提交: 5c67f88f2f1081ba8582fb365cb1fc1c8de2a69d
  回归测试: ["npm run control-plane:compose:check"]
  修复后通过: { run id: "42007377400" }
说明: >-
  修复提交 5c67f88 让端口绑定 127.0.0.1，所有凭据改为必填变量（取自 config/dev-compose.example.env），Redis 需要口令，MinIO 使用固定版本标签；
  control-plane:compose:check（static）由本提交修改。修复后通过：control-plane:compose:check 在含修复的 CI 运行（#499，run 42007377400，提交 806d24a，V-20261105-17）中实际执行并为 success。缺修复前失败：CI 中没有该回归测试在不含修复的代码上失败的运行，提交说明也没有记录在父提交 e427a45 上运行它的命令与结果，所以只写已有的部分，状态保持已确认（Requirement 7.13）。
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
状态: 已确认
对应需求: ["33"]
证据:
  - "审计报告 §4 M23"
核实:
  - 提交: b80ce32500c72e0f23636d5031736a0234b06636
    方法: 代码阅读
    结论: 已确认
    证据:
      - 文件: runtime/livetalking/Dockerfile.dockerignore
        行号范围: "5-13,22-25"
        推理: >-
          .env、secrets、models、data、logs、*.log 等规则只匹配构建上下文根目录；第 23 至 25 行先排除 vendor/*，再用 !vendor/LiveTalking/**
          把子模块的全部内容重新纳入，子模块中的 .env、models/、data/ 与日志因此进入镜像 /app。
修复:
  提交: c8ab9d8c52afaab186f0fba3995951e01e138343
  回归测试: ["npm run deploy:check:test", "npm run runtime:images:check", "docker build --load --file runtime/livetalking/Dockerfile --tag shuzhiren/livetalking:ci ."]
  修复后通过: { run id: "42007377400" }
说明: >-
  主修复提交 c8ab9d8：两个运行时镜像的 ignore 文件改为先排除全部、只允许锁定的源码与补丁，再以 **/ 规则重新排除禁止的类别；deploy:check 与
  runtime:images:check 用 Docker 匹配规则的离线模型核对必须排除与必须保留的路径。其余提交：43718f8（N6，排除子模块的 .git）、d7ac789（恢复发布门禁要求的
  CosyVoice 规则）。修复后通过：deploy:check:test、runtime:images:check 与 LiveTalking 镜像构建在含修复的 CI 运行（#499，run 42007377400，提交 806d24a，V-20261105-17）中实际执行并为 success。缺修复前失败：CI 中没有该回归测试在不含修复的代码上失败的运行，提交说明也没有记录在父提交 b80ce32 上运行它的命令与结果，所以只写已有的部分，状态保持已确认（Requirement 7.13）。
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
状态: 已确认
对应需求: ["35"]
证据:
  - "审计报告 §4 M24"
  - "位置说明：审计报告写作 各 Dockerfile、requirements；dc2916e 中共有这 9 个 Dockerfile"
核实:
  - 提交: 2c7d5d9bb036f8da7787a1eb25804fb1c4162982
    方法: 代码阅读
    结论: 已确认
    证据:
      - 文件: runtime/gateway/Dockerfile
        行号范围: "1,5"
        推理: >-
          基础镜像按标签 python:3.12-slim 引用，没有摘要；依赖以 pip install -r requirements.txt 安装，没有哈希锁定。其余 Dockerfile 的基础镜像同样只按标签引用。
修复:
  提交: 44857e13e02cb5bd5501dafe44b9c61894dbdc98
  回归测试: ["npm run runtime:images:check", "npm run ci:workflow:check", "npm run deploy:images:test"]
  修复后通过: { run id: "42023849073" }
说明: >-
  修复提交 44857e1：九个发布 Dockerfile 以 <repo>:<tag>@sha256:<多架构索引摘要> 引用基础镜像，Gateway 镜像与 python-gateway job 以 --require-hashes
  安装 runtime/gateway/requirements.lock。修复后通过：这三个步骤在含修复的 CI 运行（#501，run 42023849073，提交 2109ab8，V-20261105-19）中实际执行并为 success。CosyVoice 与 LiveTalking 的 pip 安装仍未锁定。缺修复前失败：CI 中没有该回归测试在不含修复的代码上失败的运行，提交说明也没有记录在父提交 2c7d5d9 上运行它的命令与结果，所以只写已有的部分，状态保持已确认（Requirement 7.13）。
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
状态: 已确认
对应需求: ["38"]
证据:
  - "审计报告 §4 M25"
核实:
  - 提交: 2e6a81acc316e58a6905441986e36587fa704ca2
    方法: 代码阅读
    结论: 已确认
    证据:
      - 文件: runtime/gateway/app.py
        行号范围: "186-191,211,286,412-415,453,484,491"
        推理: >-
          命令日志用同步 sqlite3.connect(path, timeout=5)（第 191 行）打开，并在请求处理中直接调用（第 211、286 行）；gpu_observation（第 412 行起）
          同步调用 nvmlInit，并由 async 的 /healthz（第 453 行）与观测接口（第 484、491 行）直接调用。日志写锁或缓慢的 nvmlInit 会阻塞事件循环上的全部请求。
修复:
  提交: b80ce32500c72e0f23636d5031736a0234b06636
  回归测试: ["python3 scripts/test-runtime-gateway-concurrency.py"]
  修复后通过: { run id: "42007377400" }
说明: >-
  修复提交 b80ce32 让日志读写、/healthz 的日志检查与 gpu_observation 经 asyncio.to_thread 运行，忙超时后答 503。回归测试由本提交修改。
  修复后通过：python-gateway 的该步骤在含修复的 CI 运行（#499，run 42007377400，提交 806d24a，V-20261105-17）中实际执行并为 success。缺修复前失败：CI 中没有该回归测试在不含修复的代码上失败的运行，提交说明也没有记录在父提交 2e6a81a 上运行它的命令与结果，所以只写已有的部分，状态保持已确认（Requirement 7.13）。
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
状态: 已确认
对应需求: ["17", "37"]
证据:
  - "审计报告 §5 L1"
  - "位置说明：审计报告写作 apps/console/lib/control-plane/runtime-service-auth.ts:24 与 apps/output-probe/index.mjs:35；dc2916e 中前者位于 apps/console/lib/runtime-service-auth.ts（第 24 行），output-probe 的比较在第 36 行"
核实:
  - 提交: 8e97b0f374e5a8c19c7f4efa040bf6f3d6862642
    方法: 代码阅读
    结论: 已确认
    证据:
      - 文件: apps/console/lib/runtime-service-auth.ts
        行号范围: "24"
        推理: >-
          requireTenantService 用 !== 比较 Authorization 头与 Bearer <token>，字符串比较在第一个不同的字节处返回，耗时与匹配的前缀长度相关。
修复:
  提交: 38665a8439328f7b7d54a3c906af0203c9e1495a
  回归测试: ["npm run service-ingest:auth:check", "npm run output-probe:config:test"]
  修复后通过: { run id: "42007377400" }
说明: >-
  主修复提交 38665a8：tokenMatches 比较两个 SHA-256 摘要并用 timingSafeEqual，未配置 token 的租户走同一路径。其余提交 1f1846f 修复 output-probe 的比较（H5）。
  回归测试由这两个提交修改。修复后通过：service-ingest:auth:check 与 output-probe:config:test 在含修复的 CI 运行（#499，run 42007377400，提交 806d24a，V-20261105-17）中实际执行并为 success。缺修复前失败：CI 中没有该回归测试在不含修复的代码上失败的运行，提交说明也没有记录在父提交 8e97b0f 上运行它的命令与结果，所以只写已有的部分，状态保持已确认（Requirement 7.13）。
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
状态: 已确认
对应需求: ["37"]
证据:
  - "审计报告 §5 L2"
核实:
  - 提交: 14afbe2f642955509ec244679f7cf2d405422296
    方法: 代码阅读
    结论: 已确认
    证据:
      - 文件: apps/console/lib/runtime-service-auth.ts
        行号范围: "5-14"
        推理: >-
          configuredTenantTokens 解析 JSON 后用 filter 静默丢弃租户 id 为空、值不是字符串等条目（第 14 行），配置错误的租户只会在请求时得到 401，没有任何报错。
修复:
  提交: b1f113817fb40dd7a4563a17ccfaef4294ef9d5c
  回归测试: ["npm run service-ingest:auth:check", "npm run control-plane:integration"]
  修复后通过: { run id: "42007377400" }
说明: >-
  修复提交 b1f1138：parseTenantTokenMap 在第一个错误条目处拒绝整个映射，instrumentation.ts 在启动时校验七个 *_TENANT_TOKENS 并以 1 退出，只输出变量名、
  条目位置与原因。回归测试由本提交修改。修复后通过：这两个步骤在含修复的 CI 运行（#499，run 42007377400，提交 806d24a，V-20261105-17）中实际执行并为 success。缺修复前失败：CI 中没有该回归测试在不含修复的代码上失败的运行，提交说明也没有记录在父提交 14afbe2 上运行它的命令与结果，所以只写已有的部分，状态保持已确认（Requirement 7.13）。
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
状态: 已确认
对应需求: ["37"]
证据:
  - "审计报告 §5 L3"
核实:
  - 提交: 86f90bfbdae4d656380ae745e428c3385d0f3934
    方法: 代码阅读
    结论: 已确认
    证据:
      - 文件: apps/console/next.config.ts
        行号范围: "4"
        推理: >-
          所有路由共用一条静态 CSP，script-src 含 'unsafe-inline'；文件中没有 Strict-Transport-Security 头。
修复:
  提交: c3314791bb03fa7903910a89cbe82bd05fe4268e
  回归测试: ["npm run console:security-headers:check", "npm run control-plane:integration"]
  修复后通过: { run id: "42007377400" }
说明: >-
  修复提交 c331479：页面使用每请求 nonce 的 CSP，/api/* 使用拒绝一切的 CSP，构建后的服务发送 HSTS。回归测试由本提交修改。
  修复后通过：这两个步骤在含修复的 CI 运行（#499，run 42007377400，提交 806d24a，V-20261105-17）中实际执行并为 success。缺修复前失败：CI 中没有该回归测试在不含修复的代码上失败的运行，提交说明也没有记录在父提交 86f90bf 上运行它的命令与结果，所以只写已有的部分，状态保持已确认（Requirement 7.13）。
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
状态: 已确认
对应需求: ["37"]
证据:
  - "审计报告 §5 L4"
核实:
  - 提交: cd251cf14afdc2ece32cf37d078124c4c76ef112
    方法: 代码阅读
    结论: 已确认
    证据:
      - 文件: apps/console/app/api/v1/runtime/health/route.ts
        行号范围: "12-13"
        推理: >-
          catch 把 error.message 原样返回给客户端，Gateway 状态细节、引用上游响应体的 JSON 解析错误与配置错误都会外泄。
修复:
  提交: 13f4dd408e95e6a5dbab8e16d73399fe1311316f
  回归测试: ["npm run console:security-headers:check"]
  修复后通过: { run id: "42007377400" }
说明: >-
  修复提交 13f4dd4：任何失败都答 503 {"error":"runtime_unavailable"}，原因写入服务日志并屏蔽 RUNTIME_SHARED_TOKEN 的值。回归测试由本提交修改，
  提交说明称其中 500 的用例在旧代码上失败，但没有记录命令。修复后通过：console:security-headers:check 在含修复的 CI 运行（#499，run 42007377400，提交 806d24a，V-20261105-17）中实际执行并为 success。缺修复前失败：CI 中没有该回归测试在不含修复的代码上失败的运行，提交说明也没有记录在父提交 cd251cf 上运行它的命令与结果，所以只写已有的部分，状态保持已确认（Requirement 7.13）。
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
状态: 已确认
对应需求: ["34"]
证据:
  - "审计报告 §5 L5"
核实:
  - 提交: d7ac7895a88d76a74dfd2b0493e883a8b2a343f1
    方法: 代码阅读
    结论: 已确认
    证据:
      - 文件: apps/console/lib/release-manifest.ts
        行号范围: "138"
        推理: >-
          canonicalJson 用 localeCompare 排序键，结果取决于进程的默认 locale。
      - 文件: scripts/check-deployment-config.mjs
        行号范围: "86"
        推理: >-
          部署脚本中的另一份 canonicalJson 同样用 localeCompare 排序。
修复:
  提交: c0763c3bbf77a7d62dcff93fa9fcbce20cae7e56
  回归测试: ["npm run runtime:program-output:check", "npm run deploy:check:test"]
  修复后通过: { run id: "42007377400" }
说明: >-
  主修复提交 c0763c3：apps/console/lib/canonical-json.mjs 按 Unicode 码点排序（规则版本 2），快照校验接受规则 2 或规则 1。其余提交 cbbd5b0 让部署脚本改用该模块。
  回归测试由这两个提交修改。修复后通过：这两个步骤在含修复的 CI 运行（#499，run 42007377400，提交 806d24a，V-20261105-17）中实际执行并为 success。缺修复前失败：CI 中没有该回归测试在不含修复的代码上失败的运行，提交说明也没有记录在父提交 d7ac789 上运行它的命令与结果，所以只写已有的部分，状态保持已确认（Requirement 7.13）。
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
状态: 已确认
对应需求: ["34"]
证据:
  - "审计报告 §5 L6"
  - "位置说明：审计报告没有写文件；dc2916e 中生成端的 30 天上限在 create-deployment-release-manifest.mjs，校验端的 31 天上限与写作 30 天的报错文案在 check-deployment-config.mjs"
核实:
  - 提交: 2d9706653a081482210bfb4bac0d83244cf2bc93
    方法: 代码阅读
    结论: 已确认
    证据:
      - 文件: scripts/check-deployment-config.mjs
        行号范围: "174"
        推理: >-
          Deploy_Check 接受最长 31 天（31 * 24 * 60 * 60 * 1000 毫秒）的有效期，生成脚本只允许 30 天，报错文案也写 30 天。
修复:
  提交: b662f72d54379859f0dbdfb82056b6b9e42bd05d
  回归测试: ["npm run deploy:check:test", "npm run deploy:manifest:test"]
  修复后通过: { run id: "42007377400" }
说明: >-
  修复提交 b662f72 让 Deploy_Check 使用同一个 30 天上限。回归测试由本提交修改，其中 30 天加 1 毫秒的用例在旧的 31 天检查下会通过。
  修复后通过：这两个步骤在含修复的 CI 运行（#499，run 42007377400，提交 806d24a，V-20261105-17）中实际执行并为 success。缺修复前失败：CI 中没有该回归测试在不含修复的代码上失败的运行，提交说明也没有记录在父提交 2d97066 上运行它的命令与结果，所以只写已有的部分，状态保持已确认（Requirement 7.13）。
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
状态: 已确认
对应需求: ["38"]
证据:
  - "审计报告 §5 L7"
核实:
  - 提交: a21e0c7467f6296ad1a4d31c69a5efef0f150893
    方法: 代码阅读
    结论: 已确认
    证据:
      - 文件: apps/channel-adapter/index.mjs
        行号范围: "61"
        推理: >-
          文件中没有 SIGTERM 或 SIGINT 处理函数（全文检索无 SIGTERM、SIGINT、process.on），第 61 行启动监听后进程作为容器 PID 1 运行，docker stop 要等满 10 秒后以 SIGKILL 结束。
      - 文件: apps/output-probe/index.mjs
        行号范围: "42"
        推理: >-
          同样没有信号处理函数。
修复:
  提交: 86f90bfbdae4d656380ae745e428c3385d0f3934
  回归测试: ["npm run channel-adapter:test", "npm run output-probe:test"]
  修复后通过: { run id: "42007377400" }
说明: >-
  修复提交 86f90bf：两个服务的 installGracefulShutdown 在首个 SIGTERM 或 SIGINT 时停止监听、给进行中的请求 5 秒、再中止下游调用并以 0 退出。
  回归测试由本提交修改。修复后通过：这两个步骤在含修复的 CI 运行（#499，run 42007377400，提交 806d24a，V-20261105-17）中实际执行并为 success。缺修复前失败：CI 中没有该回归测试在不含修复的代码上失败的运行，提交说明也没有记录在父提交 a21e0c7 上运行它的命令与结果，所以只写已有的部分，状态保持已确认（Requirement 7.13）。
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
状态: 已确认
对应需求: ["29"]
证据:
  - "审计报告 §5 L8"
核实:
  - 提交: 13f4dd408e95e6a5dbab8e16d73399fe1311316f
    方法: 代码阅读
    结论: 已确认
    证据:
      - 文件: apps/console/lib/memberships.ts
        行号范围: "59"
        推理: >-
          createMembership 对全局 users 表执行 on conflict (external_subject) do update set display_name = excluded.display_name，
          租户 A 的管理员开通已属于租户 B 的主体时，会改掉此人在所有租户中的显示名。
修复:
  提交: 5e1ef6e1e002baf5a80dee96aad471eba0a03261
  回归测试: ["npm run control-plane:integration"]
  修复后通过: { run id: "42007377400" }
说明: >-
  修复提交 5e1ef6e 改为 on conflict do nothing 并读回已有行。回归测试由本提交修改。修复后通过：control-plane:integration 在含修复的 CI 运行（#499，run 42007377400，提交 806d24a，V-20261105-17）中实际执行并为 success。
  数据库函数 sync_control_plane_actor 仍按请求上下文更新 display_name，需要新的迁移，不在本提交中。缺修复前失败：CI 中没有该回归测试在不含修复的代码上失败的运行，提交说明也没有记录在父提交 13f4dd4 上运行它的命令与结果，所以只写已有的部分，状态保持已确认（Requirement 7.13）。
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
状态: 已确认
对应需求: ["37"]
证据:
  - "审计报告 §5 L9"
核实:
  - 提交: fcacdbc12503bc11879b3b57d13527fdb194e7cd
    方法: 代码阅读
    结论: 已确认
    证据:
      - 文件: runtime/gateway/app.py
        行号范围: "52,77,88,102,119,127,375"
        推理: >-
          FastAPI 以默认参数创建（第 52 行），/docs 与 /openapi.json 无需鉴权；第 77 行用 hmac.compare_digest 比较 str，非 ASCII 的 Authorization
          头会抛 TypeError 并得到 500；第 88、102、119、127 行的 response.json() 不在 try 中；第 375 行把 NVIDIA_VISIBLE_DEVICES 的第一个值当作容器内的 NVML 编号。
修复:
  提交: eed87dfce824aa426659dbb8993c18cbdb3c3afa
  回归测试: ["npm run runtime:gateway:config:test", "npm run runtime:gateway:errors:test"]
  修复后通过: { run id: "42007377400" }
说明: >-
  修复提交 eed87df 不再注册文档路由，按原始字节的 SHA-256 摘要比较 token，读取 NVML 设备 0，上游 2xx 但不是 JSON 对象时答 502。回归测试由本提交修改。
  修复后通过：这两个步骤在含修复的 CI 运行（#499，run 42007377400，提交 806d24a，V-20261105-17）中实际执行并为 success。缺修复前失败：CI 中没有该回归测试在不含修复的代码上失败的运行，提交说明也没有记录在父提交 fcacdbc 上运行它的命令与结果，所以只写已有的部分，状态保持已确认（Requirement 7.13）。
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
状态: 已确认
对应需求: ["26"]
证据:
  - "审计报告 §5 L10"
核实:
  - 提交: 1977e2c64d59dcadd7a8d634d4609defe2e0a95f
    方法: 代码阅读
    结论: 已确认
    证据:
      - 文件: infra/compose/docker-compose.runtime.yml
        行号范围: "29,46,61,64,87-90"
        推理: >-
          各服务从 *_PORT 读取监听端口，但 expose 与健康检查 URL 写死端口（如第 64 行的 8080、第 88、90 行的 8084），worker 的默认
          CHANNEL_ADAPTER_URL（第 46 行）固定为 8082；修改端口后健康检查失败、适配器不可达。
修复:
  提交: 41f7591cfefc13d12f090bd855ca6be66b98b1e1
  回归测试: ["npm run runtime:compose:check", "npm run deploy:check:test"]
  修复后通过: { run id: "42007377400" }
说明: >-
  修复提交 41f7591 让 expose、健康检查与默认适配器 URL 使用端口变量，runtime:compose:check 报告 RCT-PORT，deploy:check 报告 RC-CHANNEL-PORT。
  回归测试由本提交修改。修复后通过：这两个步骤在含修复的 CI 运行（#499，run 42007377400，提交 806d24a，V-20261105-17）中实际执行并为 success。缺修复前失败：CI 中没有该回归测试在不含修复的代码上失败的运行，提交说明也没有记录在父提交 1977e2c 上运行它的命令与结果，所以只写已有的部分，状态保持已确认（Requirement 7.13）。
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
状态: 已确认
对应需求: ["26"]
证据:
  - "审计报告 §5 L11"
核实:
  - 提交: 20c79361a8ba3da49a8df943c3d700d0fa4df89d
    方法: 代码阅读
    结论: 已确认
    证据:
      - 文件: infra/compose/docker-compose.runtime.yml
        行号范围: "168,172-174,192,194"
        推理: >-
          LIVETALKING_AVATAR_ID、MODEL_VOLUME_PATH、AVATAR_VOLUME_PATH、RECORDINGS_VOLUME_PATH、COSYVOICE_MODEL_DIR、COSYVOICE_MODEL_PATH 的提示写作
          set-in-runtime-env，但只有 config/runtime-gateway.example.env 定义它们，两份模板的变量因此不一致。
修复:
  提交: 15c1777b04b1912bb8fe6337d4690695e834b5d9
  回归测试: ["npm run runtime:compose:check", "npm run deploy:check:test"]
  修复后通过: { run id: "42007377400" }
说明: >-
  修复提交 15c1777 把这六个提示改为 set-in-runtime-gateway-env，runtime:compose:check 报告 RCT-HINT 与 RCT-REQUIRED。回归测试由本提交修改。
  修复后通过：这两个步骤在含修复的 CI 运行（#499，run 42007377400，提交 806d24a，V-20261105-17）中实际执行并为 success。缺修复前失败：CI 中没有该回归测试在不含修复的代码上失败的运行，提交说明也没有记录在父提交 20c7936 上运行它的命令与结果，所以只写已有的部分，状态保持已确认（Requirement 7.13）。
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
状态: 已确认
对应需求: ["38"]
证据:
  - "审计报告 §5 L12"
  - "位置说明：审计报告没有写文件；dc2916e 中两个备份单元是这两个 .service 文件"
核实:
  - 提交: 6a6de3c57bd2dca5f1d96e346b9b4fda18f49415
    方法: 代码阅读
    结论: 已确认
    证据:
      - 文件: infra/systemd/shuzhiren-postgres-backup.service
        行号范围: "11,18"
        推理: >-
          没有 TimeoutStartSec；EnvironmentFile 为 /etc/shuzhiren/backup.env，ReadWritePaths 写死。
      - 文件: infra/systemd/shuzhiren-runtime-gateway-backup.service
        行号范围: "10,18"
        推理: >-
          Gateway 日志备份单元加载同一个 /etc/shuzhiren/backup.env，因此拿到 PostgreSQL 备份用的 DATABASE_URL；同样没有 TimeoutStartSec，ReadWritePaths 写死。
修复:
  提交: 00adee23c3f6b6ebffc19448726fd27171ea2be4
  回归测试: ["npm run backup:automation:check"]
  修复后通过: { run id: "42007377400" }
说明: >-
  修复提交 00adee2：PostgreSQL 单元 TimeoutStartSec=1h，Gateway 单元 TimeoutStartSec=10min 并改用不含数据库凭据的 runtime-gateway-backup.env，
  两个单元写明改路径的 drop-in。backup:automation:check（static）由本提交修改。修复后通过：backup:automation:check 在含修复的 CI 运行（#499，run 42007377400，提交 806d24a，V-20261105-17）中实际执行并为 success。只能在 Linux 主机上验证的部分：
  systemd 实际加载、超时与只读路径的行为。缺修复前失败：CI 中没有该回归测试在不含修复的代码上失败的运行，提交说明也没有记录在父提交 6a6de3c 上运行它的命令与结果，所以只写已有的部分，状态保持已确认（Requirement 7.13）。
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
状态: 已确认
对应需求: ["38"]
证据:
  - "审计报告 §5 L13"
核实:
  - 提交: eed87dfce824aa426659dbb8993c18cbdb3c3afa
    方法: 代码阅读
    结论: 已确认
    证据:
      - 文件: infra/observability/prometheus.example.yml
        行号范围: "7"
        推理: >-
          抓取目标写作 console:3000，而 Compose 中的服务名是 control-plane。
修复:
  提交: c9f3b683d440c86e7c4a9f4e435dcc7f3fa4c0c8
  回归测试: ["npm run control-plane:compose:check"]
  修复后通过: { run id: "42007377400" }
说明: >-
  修复提交 c9f3b68 改正目标，control-plane:compose:check（static）解析示例并要求每个目标是 Compose 服务及其容器端口。修复后通过：control-plane:compose:check 在含修复的 CI 运行（#499，run 42007377400，提交 806d24a，V-20261105-17）中实际执行并为 success。
  缺修复前失败：CI 中没有该回归测试在不含修复的代码上失败的运行，提交说明也没有记录在父提交 eed87df 上运行它的命令与结果，所以只写已有的部分，状态保持已确认（Requirement 7.13）。
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
状态: 已确认
对应需求: ["38"]
证据:
  - "审计报告 §5 L14"
核实:
  - 提交: 38665a8439328f7b7d54a3c906af0203c9e1495a
    方法: 代码阅读
    结论: 已确认
    证据:
      - 文件: scripts/backup-postgres.sh
        行号范围: "43"
        推理: >-
          pg_dump --dbname="$database_url" 把含口令的连接串放在命令行上，本机任何用户都能在 /proc/<pid>/cmdline 中读到。
      - 文件: scripts/restore-postgres-drill.sh
        行号范围: "31-39"
        推理: >-
          psql 与 pg_restore 同样以含口令的 drill_database_url 为命令行参数。
修复:
  提交: 6a6de3c57bd2dca5f1d96e346b9b4fda18f49415
  回归测试: ["bash scripts/test-postgres-backup-direct.sh", "bash scripts/test-postgres-restore-drill.sh", "npm run backup:automation:check"]
  修复后通过: { run id: "42007377400" }
说明: >-
  修复提交 6a6de3c 把口令从 URI 中拆出，只经 PGPASSWORD 传给每个客户端进程。两个 shell 测试的客户端替身由本提交修改，argv 中出现口令即失败。
  修复后通过：node-unit 的两个 bash 测试与 backup:automation:check 在含修复的 CI 运行（#499，run 42007377400，提交 806d24a，V-20261105-17）中实际执行并为 success。缺修复前失败：CI 中没有该回归测试在不含修复的代码上失败的运行，提交说明也没有记录在父提交 38665a8 上运行它的命令与结果，所以只写已有的部分，状态保持已确认（Requirement 7.13）。
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
状态: 已确认
对应需求: ["38"]
证据:
  - "审计报告 §5 L15"
核实:
  - 提交: 3da13246827be11c20adf7df7e86836e2d5be254
    方法: 代码阅读
    结论: 已确认
    证据:
      - 文件: apps/console/scripts/migrate.mjs
        行号范围: "18-32"
        推理: >-
          迁移事务（第 27 至 32 行）没有设置 lock_timeout 或 statement_timeout，排在应用锁之后的迁移会无限期等待并让锁队列一直堵住；
          未记录的文件即使排在已记录的最新迁移之前也会被应用。
修复:
  提交: 8e97b0f374e5a8c19c7f4efa040bf6f3d6862642
  回归测试: ["npm run db:migrate:lock:test"]
  修复后通过: { run id: "42007377400" }
说明: >-
  修复提交 8e97b0f 为每个迁移事务设置 lock_timeout 与 statement_timeout，拒绝排在最新已记录迁移之前的未记录文件。回归测试由本提交修改。
  修复后通过：db:migrate:lock:test 在含修复的 CI 运行（#499，run 42007377400，提交 806d24a，V-20261105-17）中实际执行并为 success。缺修复前失败：CI 中没有该回归测试在不含修复的代码上失败的运行，提交说明也没有记录在父提交 3da1324 上运行它的命令与结果，所以只写已有的部分，状态保持已确认（Requirement 7.13）。
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
状态: 已确认
对应需求: ["30"]
证据:
  - "审计报告 §5 L16"
核实:
  - 提交: b1f113817fb40dd7a4563a17ccfaef4294ef9d5c
    方法: 代码阅读
    结论: 已确认
    证据:
      - 文件: infra/postgres/migrations/030_audit_hash_chain.sql
        行号范围: "22-24,100,114"
        推理: >-
          seal_audit_event 不是 security definer，以插入者的身份运行；verify_audit_chain 用 <> 比较哈希，event_hash 或 previous_hash 被改为 null 时比较结果为 null，篡改不会被发现。
      - 文件: infra/postgres/service-principals.sql
        行号范围: "51"
        推理: >-
          runtime worker 拥有 audit_chain_heads 的 select、insert、update，可以直接移动租户的链头。
修复:
  提交: 3fd7235866802e1d36cee8fbc3501f8ef810392f
  回归测试: ["npm run service-principals:integration"]
  修复后通过: { run id: "42007377400" }
说明: >-
  修复提交 3fd7235（迁移 074）：seal_audit_event 为 security definer，audit_chain_heads 只能在触发器内写入，verify_audit_chain 改为 null 安全比较，
  worker 不再有 audit_chain_heads 的权限。回归测试由本提交修改。修复后通过：service-principals:integration 在含修复的 CI 运行（#499，run 42007377400，提交 806d24a，V-20261105-17）中实际执行并为 success。缺修复前失败：CI 中没有该回归测试在不含修复的代码上失败的运行，提交说明也没有记录在父提交 b1f1138 上运行它的命令与结果，所以只写已有的部分，状态保持已确认（Requirement 7.13）。
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
状态: 已确认
对应需求: ["39"]
证据:
  - "审计报告 §5 L17"
核实:
  - 提交: ba28eabe6a1a5472ca52057db3d52411bf072dcb
    方法: 代码阅读
    结论: 已确认
    证据:
      - 文件: package-lock.json
        行号范围: "479,577,3247"
        推理: >-
          锁文件锁定了 @img/sharp-win32-x64（第 479 行）与 @next/swc-win32-x64-msvc（第 577 行），第 3247 行只把 @next/swc-linux-x64-musl 列为
          可选依赖，文件中没有任何 node_modules/@next/swc-linux* 或 node_modules/@img/sharp-linux* 条目，Linux 镜像中 npm ci 安装的平台二进制没有被锁定。
修复:
  提交: 013d65d8f32b08653852307d7bb419bcb7e62ed0
  回归测试: ["npm run runtime:images:check", "npm run deploy:images:test", "npm run deploy:check:test"]
  修复后通过: { run id: "42023849073" }
说明: >-
  主修复提交 013d65d 重新生成 package-lock.json（414 个条目都有 resolved 与 sha512 integrity），runtime:images:check 拒绝缺少锁定的条目。其余提交 d5c0fd8
  按路径、父仓库 gitlink 与镜像锁定每个 vendored 源码并加入 Matcha-TTS。修复后通过：这三个步骤在含修复的 CI 运行（#501，run 42023849073，提交 2109ab8，V-20261105-19）中实际执行并为 success。缺修复前失败：CI 中没有该回归测试在不含修复的代码上失败的运行，提交说明也没有记录在父提交 ba28eab 上运行它的命令与结果，所以只写已有的部分，状态保持已确认（Requirement 7.13）。
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
状态: 已确认
对应需求: ["39"]
证据:
  - "审计报告 §5 L18"
  - "位置说明：模型权重不在仓库中，由 docker-compose.runtime.yml 以 MODEL_VOLUME_PATH 与 COSYVOICE_MODEL_PATH 挂载进容器"
核实:
  - 提交: 646d67810c5b7dead7dbd71c62675f0ca380f1ca
    方法: 代码阅读
    结论: 已确认
    证据:
      - 文件: runtime/livetalking/Dockerfile
        行号范围: "11-12,25"
        推理: >-
          镜像只复制 LiveTalking 源码、补丁与两个模块，不复制许可证、NOTICE 或修改声明；646d678 的主仓库树中也没有 NOTICE、THIRD_PARTY 或 LICENSE 文件，
          被修改的 LiveTalking 文件没有按 Apache-2.0 标注修改。
修复:
  提交: 211f3798e6397c73db0c3a0e528a981aa3e20b63
  回归测试: ["npm run runtime:images:licenses:test"]
  修复后通过: { run id: "42040219509" }
说明: >-
  主修复提交 211f379：标注被修改的 LiveTalking 文件，在镜像中附带修改声明，并检查镜像中的许可证文件。其余提交 0493135 增加第三方声明文档。
  模型权重许可证的审查与 edge-tts 服务条款的评估是人工事项，不由测试证明。修复后通过：runtime:images:licenses:test 在含修复的 CI 运行（#502，
  run 42040219509，提交 fd9179d，V-20261105-20）中实际执行并为 success（node-unit 第 8 步）；同一运行中 docker-build 第 15、18 步对 LiveTalking 与
  CosyVoice 镜像的许可证检查也为 success。缺修复前失败：CI 中没有该回归测试在不含修复的代码上失败的运行，提交说明也没有记录在父提交 2109ab8 上运行它的
  命令与结果，所以只写已有的部分，状态保持已确认（Requirement 7.13）。
```

## 新缺陷（本规格执行期间发现）

新缺陷的初始状态为待复核（Requirement 7.5）。N1–N5 与 N9–N12 的代码阅读核实以各自修复提交的父提交为准（Requirement 7.8），N6–N8 的核实为 CI_Pipeline 运行。N5 不属于 Requirement 1 至 40 的验收标准，用户 2026-11-05 决定在本规格内修复。

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
状态: 已确认
对应需求: ["12", "28"]
证据:
  - "设计文档跨部分裁决 15"
  - "设计文档第 6 部分 Requirement 28 §28.1 第 7 条"
核实:
  - 提交: 416df392aa1c574b7f4a04a640752a1c297dce61
    方法: 代码阅读
    结论: 已确认
    证据:
      - 文件: infra/postgres/service-principals.sql
        行号范围: "34"
        推理: >-
          只授予 shuzhiren_runtime_worker 对 outbox_events 的 select、update，没有 insert。
      - 文件: apps/runtime-worker/index.mjs
        行号范围: "158,231"
        推理: >-
          scheduleDueRun 与 degradeStaleLiveRun 在租户事务中向 outbox_events 插入 media.dispatch 事件，以 worker 主体运行时报 permission denied 并整体回滚。
修复:
  提交: cf05466001c2dd4fa358bfbb29427975d38717e9
说明: >-
  service-principals.sql 第 34 行只授予 shuzhiren_runtime_worker 对 outbox_events 的 select、update；
  scheduleDueRun（第 95 行起，INSERT 在第 158 行）与 degradeStaleLiveRun（第 193 行起，INSERT 在第 231 行）
  都在租户事务中向 outbox_events 插入 media.dispatch 事件。以 worker 主体运行时这两条路径报 permission denied
  并整体回滚：到期的 ARMED 场次收不到 start_program，遥测过期的 LIVE 场次不会降级。优先级定为 P0，理由是在部署的
  服务主体下定时开播与看门狗降级都无法执行，属于需求文档优先级定义中的部署阻断项。修复与 C4 在 service-principals.sql
  中一起完成（任务 13.1），对应 Requirement 12 的授权改动与 Requirement 28.14 以 worker 主体运行的测试。
  核实为代码阅读（416df39，即修复提交 cf05466 的父提交）。cf05466 为 worker 授予 outbox_events 的 insert；提交没有新增或修改测试，现有的
  service-principals:integration 不检查 worker 对 outbox_events 的 insert。缺回归测试及其两项执行证据，状态为已确认。
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
状态: 已确认
对应需求: ["8"]
证据:
  - "设计文档跨部分裁决 18"
  - "设计文档第 2 部分 §0.1（route 第 23 行）"
核实:
  - 提交: c9f3b683d440c86e7c4a9f4e435dcc7f3fa4c0c8
    方法: 代码阅读
    结论: 已确认
    证据:
      - 文件: apps/console/app/api/v1/channels/connections/route.ts
        行号范围: "27-28"
        推理: >-
          第 27 行 createChannelConnection 在自己的事务中插入并提交，第 28 行再由 recordAuditEvent 另开事务写 channel_connection.created。
      - 文件: apps/console/lib/channels.ts
        行号范围: "89,101"
        推理: >-
          createChannelConnection（第 89 行起）在第 101 行的 withTenantTransaction 中完成插入，与审计写入不在同一事务。
修复:
  提交: e427a45384439d703d02ad22932b40b06602c3db
  回归测试: ["npm run control-plane:integration"]
  修复后通过: { run id: "42007377400" }
说明: >-
  route.ts 第 22 行的 createChannelConnection 在自己的 withTenantTransaction（channels.ts 第 101 至 107 行）中插入并提交；
  第 23 行再由 recordAuditEvent 另开事务写 channel_connection.created。审计写入失败时连接已经存在，接口却返回 500，
  审计链中也缺少这条创建记录。修复见 Requirement 8.8、8.9（任务 10.3）。
  核实为代码阅读（c9f3b68，即修复提交 e427a45 的父提交；行号因 34236ef 的改动与登记时不同）。e427a45 在同一事务中写入连接与审计事件，
  回归测试由本提交修改（单条审计事件、名称去空白、重名 409、审计插入失败时回滚）。修复后通过：control-plane:integration 在含修复的 CI 运行（#499，run 42007377400，提交 806d24a，V-20261105-17）中实际执行并为 success。缺修复前失败：CI 中没有该回归测试在不含修复的代码上失败的运行，提交说明也没有记录在父提交 c9f3b68 上运行它的命令与结果，所以只写已有的部分，状态保持已确认（Requirement 7.13）。
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
状态: 已确认
对应需求: ["11"]
证据:
  - "设计文档跨部分裁决 18"
  - "设计文档第 2 部分 §4.1 第 4 点"
核实:
  - 提交: 1f1846fccd5fa68fd9b90eab93dd9a381f1f5c47
    方法: 代码阅读
    结论: 已确认
    证据:
      - 文件: apps/alert-notifier/index.mjs
        行号范围: "13-14,22"
        推理: >-
          连接池把 connectionTimeoutMillis 与 query_timeout 都设为 databaseTimeoutMs（第 13、14 行），/healthz 的 select 1（第 22 行）先等连接、
          再执行查询，两段分别计时，总时长最长约为 2 × DATABASE_QUERY_TIMEOUT_MS。
修复:
  提交: 9be485d75569af0a7b13725ba7fec46c12212ddc
  回归测试: ["npm run alert-notifier:test"]
  修复后通过: { run id: "41978941738" }
说明: >-
  index.mjs 第 14 行的连接池把 connectionTimeoutMillis 与 query_timeout 都设为 DATABASE_QUERY_TIMEOUT_MS（第 13 行）；
  /healthz 的 select 1（第 22 行）先等待取得连接、再执行查询，两段分别计时，总时长最长约为 2 × DATABASE_QUERY_TIMEOUT_MS。
  修复为用 withDeadline 限定总时长（任务 12.1）。
  核实为代码阅读（1f1846f，即修复提交 9be485d 的父提交）。9be485d 用 withDeadline 限定总时长，回归测试由本提交修改（连接 900 ms 后才给出、
  查询永不返回、超时 1000 ms 时 /healthz 须在 1500 ms 内答 503）。修复后通过：alert-notifier:test 在含修复的 CI 运行（#494，run 41978941738，提交 734ee8e，V-20261105-12）中实际执行并为 success。缺修复前失败：CI 中没有该回归测试在不含修复的代码上失败的运行，提交说明也没有记录在父提交 1f1846f 上运行它的命令与结果，所以只写已有的部分，状态保持已确认（Requirement 7.13）。
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
状态: 已确认
对应需求: ["11"]
证据:
  - "设计文档跨部分裁决 18"
  - "设计文档第 2 部分 §4.1 第 6 点"
核实:
  - 提交: 9be485d75569af0a7b13725ba7fec46c12212ddc
    方法: 代码阅读
    结论: 已确认
    证据:
      - 文件: apps/alert-notifier/index.mjs
        行号范围: "86-87,94"
        推理: >-
          claim 只领取 attempts 小于上限的记录（第 86、87 行），领取时把 attempts 加 1 并置为 delivering（第 94 行）；最后一次尝试后进程停止时，
          记录停在 delivering 且 attempts 等于上限，此后既不会被领取，也不会被标为 failed。
修复:
  提交: 50a36ff56ed7fabcfc34b0cb12ac5a665c06bbb9
  回归测试: ["npm run alert-notifier:test"]
  修复后通过: { run id: "41978941738" }
说明: >-
  claimDelivery 只领取 attempts 小于 ALERT_NOTIFIER_MAX_ATTEMPTS 的记录（第 83 至 84 行），领取时把 attempts 加 1
  并置为 delivering（第 91 行）。最后一次尝试领取之后进程崩溃时，retry 没有执行，记录的 attempts 等于上限、状态为
  delivering，此后既不会再被领取，也不会被标为 failed。修复为 claim 事务中的清扫（任务 12.1）。
  核实为代码阅读（9be485d，即修复提交 50a36ff 的父提交）。50a36ff 在 claim 事务中先把这类记录置为 failed，回归测试由本提交修改。
  修复后通过：alert-notifier:test 在含修复的 CI 运行（#494，run 41978941738，提交 734ee8e，V-20261105-12）中实际执行并为 success。缺修复前失败：CI 中没有该回归测试在不含修复的代码上失败的运行，提交说明也没有记录在父提交 9be485d 上运行它的命令与结果，所以只写已有的部分，状态保持已确认（Requirement 7.13）。
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
状态: 已确认
对应需求: ["无：不属于 Requirement 1 至 40 的验收标准"]
证据:
  - "设计文档跨部分裁决 18"
  - "设计文档第 5 部分 Requirement 21 §21.2"
核实:
  - 提交: a3b5c258f730bc7d7a8f5520dfea08434d3f49b8
    方法: 代码阅读
    结论: 已确认
    证据:
      - 文件: apps/console/app/api/v1/live-runs/[runId]/commands/route.ts
        行号范围: "22-25"
        推理: >-
          第 22 行 issueCommand 在自己的事务中写入命令与 outbox 事件并提交，第 24、25 行再分别用独立事务写 live_command.accepted 与
          media_command.enqueued；审计写入失败时命令已入队，接口却返回 500。
修复:
  提交: ac33f61228207d3a6927635d545622a89d04c2d4
  回归测试: ["npm run control-plane:integration", "npm run media:evidence:check", "npm run recording:evidence:check"]
  修复后通过: { run id: "42040219509" }
说明: >-
  commands 路由第 22 行的 issueCommand 在自己的事务中写入命令与 outbox 事件并提交；第 24、25 行再分别调用
  recordAuditEvent 写 live_command.accepted 与 media_command.enqueued，各自是独立的事务。审计写入失败时命令已经入队，
  接口却返回 500，审计链中也缺少这两条记录。第 5 部分发现，第 6 部分未处理；本计划不包含 N5 的修复任务。
  用户 2026-11-05 决定在本规格内修复 N5。核实为代码阅读（a3b5c25，即修复提交 ac33f61 的父提交）。ac33f61 让 issueCommand 在插入命令与 outbox 事件的
  事务中写两条审计事件，并以同样方式改正其余控制台写路由的提交后审计；集成测试断言审计插入失败时不留下命令、outbox 事件与审计事件。修复后通过：三项回归测试在含修复的 CI 运行（#502，run 42040219509，提交 fd9179d，
  V-20261105-20）中实际执行并为 success（postgres-integration 第 12 步、static-gates 第 50、51 步）。缺修复前失败：CI 中没有该回归测试在不含修复的代码上
  失败的运行，提交说明也没有记录在父提交 a3b5c25 上运行它的命令与结果，所以只写已有的部分，状态保持已确认（Requirement 7.13）。
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
状态: 已修复
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
  提交: 43718f8a1b05027de98316d94394d199e86edf39
  回归测试: ["docker build --load --file runtime/livetalking/Dockerfile --tag shuzhiren/livetalking:ci ."]
  修复前失败: { run id: "41965741382" }
  修复后通过: { run id: "41972571602" }
说明: >-
  失败输出最初由用户 2026-11-05 登录 GitHub 后从 job 127042212017 的第 14 步日志抄录；之后以用户授权的 GITHUB_TOKEN 下载该 job 日志确认，
  git 的错误行为 fatal: not a git repository: /app/../../.git/modules/vendor/LiveTalking，随后是：
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
  改写整个 dockerignore 与镜像路径检查仍由 Requirement 33 的任务完成，M23 的状态不因本修复改变。修复提交为 43718f8。
  回归测试就是 docker-build 中的这一构建步骤，两次运行中它都实际执行：修复前在 run 41965741382（提交 8226fa3，43718f8 的父提交）
  第 14 步为 failure；修复后在 run 41972571602（CI #493，提交 1657254，43718f8 的子提交，只改动 scripts/test-runtime-observer.mjs
  与 docs/AUDIT_REGISTER.md，两者都不进入 LiveTalking 构建上下文）第 14 步为 success，运行约 4 分 25 秒（05:16:54Z 至 05:21:19Z）。
  两次运行的全部步骤见 VERIFICATION_LOG.md#v-20261105-09 与 VERIFICATION_LOG.md#v-20261105-10。#493 中其后的 CosyVoice 构建
  得以执行并失败，另登记为 N8。
```

### N7 observer:runtime:test 的等待没有上限，失败时卡住直到 CI job 超时

```yaml
编号: N7
标题: observer:runtime:test 的等待没有上限，失败时卡住直到 CI job 超时
来源: 本规格执行期间新发现（CI 第 492 次运行，run 41965741382，node-unit 第 15 步）
来源标记: 新发现
优先级: P0
位置:
  - "scripts/test-runtime-observer.mjs:68,73,78-79,83,104,113,121,138,147,164,174"
  - "apps/runtime-observer/index.mjs:52,176,198,215"
状态: 已修复
对应需求: ["1", "2"]
证据:
  - "CI #492（run 41965741382，提交 8226fa38502dbcfa068fa8940fb1850805962734）node-unit 第 15 步 Run npm run observer:runtime:test 运行约 29 分钟后结论为 cancelled，job 注解为 The job has exceeded the maximum execution time of 30m0s，其后 11 个验证步骤为 skipped"
核实:
  - 提交: 8226fa38502dbcfa068fa8940fb1850805962734
    方法: CI_Pipeline 运行
    结论: 已确认
    证据:
      run id: "41965741382"
      步骤: ["Run npm run observer:runtime:test"]
  - 提交: 8226fa38502dbcfa068fa8940fb1850805962734
    方法: 代码阅读
    结论: 已确认
    证据:
      文件: scripts/test-runtime-observer.mjs
      行号范围: "68,73,78-79,83,104,113,121,138,147,164,174"
      推理: >-
        四个场景都用 stdio pipe 启动 observer 子进程（第 68 行等），但从不读取它的 stdout 与 stderr；observer 每个 10 ms
        周期写一行日志（apps/runtime-observer/index.mjs 第 52 行）。场景结束时 finally 先 kill("SIGTERM")，再无超时地等待
        child.once("exit")（第 83、121、147、174 行）：子进程在此之前已经退出时，exit 事件已经发出，这个等待永远不会结束；
        Linux 上 SIGTERM 只把 stopping 置为真（index.mjs 第 176 行），子进程要等当前周期结束并关闭健康服务器（第 198、215 行）
        才退出，而 Node.js 文档说明 POSIX 上写入管道是异步的，父进程不再读取、管道写满后子进程无法完成退出。/healthz 的
        fetch 没有超时（第 73、104、113 行等），子进程不响应时 waitFor 不会检查截止时间。第 78、79 行等待样本数恰好等于 1，
        而 observer 每 10 ms 投递一次，首次检查前已收到第二条时条件永远不成立。Windows 上 kill() 强制终止进程，所以本机只会
        在子进程提前退出这一条路径上卡住。
  - 提交: 43718f8a1b05027de98316d94394d199e86edf39
    方法: 本机测试
    结论: 已确认
    证据:
      测试名称: observer:runtime:test（observer 健康端口 0.0.0.0:18084 已被另一进程占用）
      命令: node %TEMP%\observer-probe\old-test.mjs（43718f8 的 scripts/test-runtime-observer.mjs，只把 root 改为仓库路径）
修复:
  提交: 16572549bb72d718ad898248fc27e7b74e284e35
  回归测试: ["npm run observer:runtime:test"]
  修复前失败: { run id: "41965741382" }
  修复后通过: { run id: "41972571602" }
说明: >-
  2026-11-05 在本机（Windows 11，Node.js v20.19.2）先用一个监听 0.0.0.0:18084 的进程占住端口，再运行 43718f8 中的测试
  （与 8226fa3、dc2916e 中的文件相同，只把 root 改为仓库路径后从临时目录运行）：observer 子进程以 EADDRINUSE 退出，
  测试 25 秒后仍未结束（卡住），被强制结束；同样条件下修复后的测试 5.1 秒后以退出码 1 结束，并在 stderr 输出
  observer 的退出码与 EADDRINUSE 错误。正常条件下修复前后的测试在本机都在 2 秒内通过（各连续运行 6 至 8 次）。
  另一个本机探针（与测试相同的 10 ms 轮询）在 12 次运行中有 2 次在首次看到健康响应时已经收到 2 条样本。该测试在
  run 41571439672（提交 dc47566，runs-on: ubuntu-latest，Node.js 20）中 1 秒通过；此后测试与 observer 共有 6 个提交的改动，CI 改用
  Node.js 24，现在的测试代码在 #492 之前没有在 Linux 上运行过（之后的运行都在 compose 步骤失败）。CI 中究竟是哪一条路径
  触发了卡住，没有 job 日志与 Linux 环境无法确认。修复只改测试脚手架：持续读取子进程输出并保留最后 8000 个字符，场景失败时
  先输出 observer 的退出状态与输出尾部；退出等待在启动时就挂上 exit 监听，SIGTERM 后最多等 10 秒，超时则 SIGKILL 并报错；
  /healthz 请求设 1 秒超时并读完响应体；fixture 服务器关闭前先关闭全部连接；两处等待条件由"恰好 1 条"改为"至少 1 条"，
  断言仍检查第一条样本与第一条节目观测的完整内容。断言没有删除或放宽。优先级定为 P0：它使 node-unit 验证组无法结束，
  其后 11 个验证步骤被跳过，属于需求文档优先级定义中的 CI 恢复。修复提交为 1657254。回归测试就是 node-unit 中的
  Run npm run observer:runtime:test 步骤，两次运行中它都实际执行：修复前在 run 41965741382（提交 8226fa3）第 15 步运行约 29 分钟后
  因 job 超时为 cancelled（测试没有在 30 分钟内结束，这正是本缺陷的表现）；修复后在 run 41972571602（CI #493，提交 1657254
  本身）第 15 步为 success，用时约 2 秒（05:13:26Z 至 05:13:28Z），其后 11 个验证步骤都执行并为 success，node-unit 的 skipped
  步骤数为 0。8226fa3 与 1657254 之间的 43718f8 没有改动本测试或 observer。两次运行的全部步骤见
  VERIFICATION_LOG.md#v-20261105-09 与 VERIFICATION_LOG.md#v-20261105-10。CI 中当时是哪一条路径触发了卡住仍未确认（见上文），
  修复后通过只说明有上限的测试在 Linux 上执行并通过。
```

### N8 CI 中 CosyVoice 镜像构建因 setuptools 不再提供 pkg_resources、openai-whisper 无法构建而失败

```yaml
编号: N8
标题: CI 中 CosyVoice 镜像构建因 setuptools 不再提供 pkg_resources、openai-whisper 无法构建而失败
来源: 本规格执行期间新发现（CI 第 493 次运行，run 41972571602，docker-build 第 16 步）
来源标记: 新发现
优先级: P0
位置:
  - "runtime/cosyvoice/Dockerfile:24-29"
状态: 已修复
对应需求: ["1", "2", "35"]
证据:
  - "CI #493（run 41972571602，提交 16572549bb72d718ad898248fc27e7b74e284e35）docker-build 第 16 步 docker build runtime/cosyvoice (committed Miniforge pin) 的结论为 failure，其后只有 Post Set up Node.js 为 skipped（全部步骤见 VERIFICATION_LOG.md#v-20261105-10）"
  - "job 127063954495 的日志：pip 为 openai-whisper==20231117 执行 Getting requirements to build wheel 时报 ModuleNotFoundError: No module named 'pkg_resources'，随后为 ERROR: Failed to build 'openai-whisper' when getting requirements to build wheel"
核实:
  - 提交: 16572549bb72d718ad898248fc27e7b74e284e35
    方法: CI_Pipeline 运行
    结论: 已确认
    证据:
      run id: "41972571602"
      步骤: ["docker build runtime/cosyvoice (committed Miniforge pin)"]
修复:
  提交: 26726126774bde14bedd9f0eee5778b6456cca2b
  回归测试: ["docker build runtime/cosyvoice (committed Miniforge pin)"]
  修复前失败: { run id: "41978941738" }
  修复后通过: { run id: "41986504433" }
说明: >-
  登记时只知道 Dockerfile 第 24 至 29 行的整条 RUN 以退出码 1 结束。2026-11-05 以用户授权读取 CI 的 GITHUB_TOKEN 下载 job 127063954495（#493）
  与 127084279924（#494）的日志后确认：失败发生在第 28 行的 pip install -r（vendor/CosyVoice/requirements.txt 第 25 行的 openai-whisper==20231117），
  pip 在隔离的构建环境中执行该包的 setup.py，traceback 停在 File "<string>", line 5 的 import，报 ModuleNotFoundError: No module named
  'pkg_resources'。修复提交 2672612 的说明称 setuptools 82 删除了 pkg_resources，并以 --build-constraint 传入 setuptools<81，因为 cosyvoice 环境中的
  pip 26.2 不再把 PIP_CONSTRAINT 应用到隔离的构建环境。修复前失败：#494（run 41978941738，提交 734ee8e，不含 2672612）中同一步骤以同样的错误失败
  （V-20261105-12）；#493 中也一样。修复后通过：#495（run 41986504433，提交 2672612）中该步骤为 success（V-20261105-13），此后各次运行都为 success。
  #492 中该步骤因 N6 为 skipped。优先级定为 P0：它使 CI_Pipeline 的 docker-build 验证组失败（Requirement 1.2、2.5、35.3），属于需求文档优先级定义中的
  CI 恢复。用户此前决定由阶段 6 的任务 44.2 修复，本轮由 2672612 先行修复；任务 44.2 中以带 hash 的锁文件安装 CosyVoice 依赖的部分不受影响。
```

### N9 channel-adapter 的 /v1/replies 处理没有 await，下发失败会成为未处理的 rejection 并终止进程

```yaml
编号: N9
标题: channel-adapter 的 /v1/replies 处理没有 await，下发失败会成为未处理的 rejection 并终止进程
来源: 本规格执行期间新发现（修复提交 734ee8e）
来源标记: 新发现
优先级: P1
位置:
  - "apps/channel-adapter/index.mjs:38"
状态: 已确认
对应需求: ["40"]
证据:
  - "提交 734ee8e 对 apps/channel-adapter/index.mjs 第 38 行的改动与 scripts/test-channel-adapter.mjs 新增的用例"
核实:
  - 提交: 4a94e72e54093fd7bc4657bc9d8208266af8525e
    方法: 代码阅读
    结论: 已确认
    证据:
      文件: apps/channel-adapter/index.mjs
      行号范围: "38"
      推理: >-
        请求监听函数是 async 函数，第 38 行在 try 中执行 return dispatchReply(request, response)，没有 await。dispatchReply 返回的 promise 被拒绝时，
        rejection 不会进入外层 try 的 catch，而是成为 http.createServer 忽略的返回值上的未处理 rejection；Node.js 默认在未处理的 rejection 上终止进程，
        一次回复下发中的错误（例如请求体无效或平台不可达）就会让适配器退出。
修复:
  提交: 734ee8e877723f4042d3a6e1b45ce7548c578671
  回归测试: ["npm run channel-adapter:test"]
  修复后通过: { run id: "41978941738" }
说明: >-
  修复把第 38 行改为 return await dispatchReply(request, response)，被拒绝的下发进入外层的错误处理。回归测试 scripts/test-channel-adapter.mjs 由本提交
  新增用例：无效的回复与平台不可达时都要得到响应而不是断开连接，失败后 /healthz 仍须答 200。修复后通过：#494（run 41978941738，提交 734ee8e）中
  node-unit 的 channel-adapter:test 为 success（V-20261105-12）。缺修复前失败：#493 中旧版本的 channel-adapter:test 为 success，没有新用例在父提交
  4a94e72 上失败的运行，734ee8e 的提交说明只有标题，没有记录命令，状态保持已确认（Requirement 7.13）。优先级定为 P1，属于需求文档优先级定义中的
  运行时加固；/v1/replies 是 Requirement 40.10 规定的出站回复接口。
```

### N10 结算对账单导入在 PostgreSQL 17 上对 uuid 列调用 min()，每次导入都返回 500

```yaml
编号: N10
标题: 结算对账单导入在 PostgreSQL 17 上对 uuid 列调用 min()，每次导入都返回 500
来源: 本规格执行期间新发现（修复提交 4576a01）
来源标记: 新发现
优先级: P1
位置:
  - "apps/console/lib/settlements.ts:44"
状态: 已确认
对应需求: ["无：不属于 Requirement 1 至 40 的验收标准"]
证据:
  - "提交 4576a01 对 apps/console/lib/settlements.ts 第 44 行的改动"
核实:
  - 提交: a9c34203781318158b1a2795e430435f55dca6e4
    方法: 代码阅读
    结论: 已确认
    证据:
      文件: apps/console/lib/settlements.ts
      行号范围: "44"
      推理: >-
        importSettlementBatch 汇总运营侧订单时对 commerce_events.live_run_id（uuid）执行 min(live_run_id)::text。提交说明称 PostgreSQL 17 没有 uuid 版本的
        min 聚合；CI 的 postgres-integration 与开发 compose 都使用 postgres:17-alpine。在这样的服务器上该语句报错，导入请求以 500 结束。
修复:
  提交: 4576a01eb4f459919845ad4b7f14c43875bf9ce5
  回归测试: ["npm run control-plane:integration"]
  修复后通过: { run id: "41993338992" }
说明: >-
  修复改为 min(live_run_id::text)，列本来就以 text 返回。提交没有修改测试，回归测试是 control-plane:integration 中已有的断言 a private settlement statement
  import must be accepted（第 771 行，按 230e4c7）。修复后通过：#498（run 41993338992，提交 a2804d1）中 control-plane:integration 为 success
  （V-20261105-16）。缺修复前失败：#497 中该测试在第 235 行（M1）失败后停止，第 771 行没有执行；提交说明没有记录在父提交 a9c3420 上运行的命令，
  状态保持已确认（Requirement 7.13）。优先级定为 P1：结算导入在目标 PostgreSQL 版本上完全不可用，属于需求文档优先级定义中的行为测试与运行时加固。
```

### N11 重放已存在的节目输出观测时只读取观测列，相同的重试返回 500

```yaml
编号: N11
标题: 重放已存在的节目输出观测时只读取观测列，相同的重试返回 500
来源: 本规格执行期间新发现（修复提交 e68a3ee）
来源标记: 新发现
优先级: P1
位置:
  - "apps/console/lib/program-output-observations.ts:93,137"
状态: 已确认
对应需求: ["无：不属于 Requirement 1 至 40 的验收标准"]
证据:
  - "提交 e68a3ee 对 apps/console/lib/program-output-observations.ts 第 93 行的改动"
核实:
  - 提交: 4576a01eb4f459919845ad4b7f14c43875bf9ce5
    方法: 代码阅读
    结论: 已确认
    证据:
      文件: apps/console/lib/program-output-observations.ts
      行号范围: "93,137"
      推理: >-
        recordProgramOutputObservation 查找已存在的观测时（第 93 行）只选取观测列，不含 verifier_issuer、verifier_key_id、attested_at、attestation_expires_at
        与 attestation_sha256。persistentObservation（第 137 行）对 attested_at 与 attestation_expires_at 执行 new Date(...).toISOString()，值为 undefined 时
        抛出 RangeError，于是相同的重试得到 500，而不是返回已有的观测。
修复:
  提交: e68a3ee24488ac1ba394f58be680c6c1f14c7391
  回归测试: ["npm run control-plane:integration"]
  修复后通过: { run id: "41993338992" }
说明: >-
  修复让查找语句同时读取五个 attestation 列。提交没有修改测试，回归测试是 control-plane:integration 中已有的断言 an identical output observation retry
  must be idempotent（第 865 行，按 230e4c7）。修复后通过：#498（run 41993338992，提交 a2804d1）中 control-plane:integration 为 success
  （V-20261105-16）。缺修复前失败：#497 中该测试在第 235 行（M1）失败后停止，第 865 行没有执行；提交说明没有记录在父提交 4576a01 上运行的命令，
  状态保持已确认（Requirement 7.13）。优先级定为 P1，属于需求文档优先级定义中的行为测试与运行时加固。
```

### N12 控制台按进程时区解析 PostgreSQL 的 date 列，在 UTC 以东的时区下日期提前一天

```yaml
编号: N12
标题: 控制台按进程时区解析 PostgreSQL 的 date 列，在 UTC 以东的时区下日期提前一天
来源: 本规格执行期间新发现（修复提交 8aee413）
来源标记: 新发现
优先级: P1
位置:
  - "apps/console/lib/database.ts"
  - "apps/console/lib/recordings.ts:133"
  - "apps/console/lib/assets.ts:192,221,252"
  - "apps/console/lib/release-manifest.ts:102"
  - "apps/console/lib/entitlements.ts:66"
状态: 已确认
对应需求: ["无：不属于 Requirement 1 至 40 的验收标准"]
证据:
  - "提交 8aee413 的说明与它对 apps/console/lib 下五个文件的改动"
核实:
  - 提交: ac33f61228207d3a6927635d545622a89d04c2d4
    方法: 代码阅读
    结论: 已确认
    证据:
      - 文件: apps/console/lib/recordings.ts
        行号范围: "133"
        推理: >-
          node-postgres 把 date 列解析为进程时区当天零点的 Date；retentionUntil 再用 new Date(value).toISOString().slice(0, 10) 取 UTC 日期，
          进程运行在 UTC 以东（如 TZ=Asia/Shanghai）时得到前一天，录像的保留日期与其幂等重试不再相等。
      - 文件: apps/console/lib/release-manifest.ts
        行号范围: "102"
        推理: >-
          发布清单中素材的 expiresAt 用同样的写法取得，清单哈希的输入因此随进程时区变化；assets.ts 第 192、221、252 行的到期判断与
          entitlements.ts 第 66 行的生效日期也一样。
修复:
  提交: 8aee413a1a79d1b273993f3588a4dc3f47333117
  回归测试: ["npm run preflight:check", "npm run control-plane:integration"]
  修复后通过: { run id: "42040219509" }
说明: >-
  修复让控制台连接池用池级的 TypeOverrides 把 date（OID 1082）解析为 YYYY-MM-DD 文本，相关列直接使用这些字符串；全局 pg.types 与其他类型不变，
  TZ=UTC 时所有值（包括发布清单哈希输入）不变。preflight:check 在 TZ=Asia/Shanghai 与 TZ=UTC 的子进程中断言 date 返回 2027-03-31，集成测试断言
  保存的保留日期与到期日期。修复后通过：两项回归测试在含修复的 CI 运行（#502，run 42040219509，提交 fd9179d，V-20261105-20）中实际执行并为 success
  （static-gates 第 36 步、postgres-integration 第 12 步）；CI 的 PostgreSQL 集成测试在 UTC 下运行。缺修复前失败：CI 中没有该回归测试在不含修复的代码上失败的
  运行；提交说明称修复前在 Asia/Shanghai 下得到 2027-03-30 的 Date，但没有记录命令，状态保持已确认（Requirement 7.13）。部署配置不需要改变。优先级定为 P1：日期错位会使幂等重试失败并改变发布清单
  哈希的输入，属于需求文档优先级定义中的运行时加固。
```

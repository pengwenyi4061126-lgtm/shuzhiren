# 下一轮治理审计报告（已由抖音 Adapter 后续复核更新）

> 审计日期：2026-11-11  
> 审计对象：`E:\shuzizhibo`  
> 审计范围：Git HEAD、`docs/DEPLOYMENT_READINESS.md`、`docs/FRAMEWORK_STATUS.md`、`docs/DELIVERY_PLAN.md`、`docs/VERIFICATION_LOG.md`，以及“一个内容项目、两个输出 / 抖音 Adapter / 4090 外部验收”目标。

## 总结判定

当前仓库已经形成**产品框架、治理门禁、平台无关 Channel_Adapter、Studio 工作流、本机/CI 证据和 4090 短时内部 smoke**；但还没有达到以下完整目标：

- 一个真实、已审核并冻结的内容项目；
- 同一项目稳定地产生录播和实时两个可追溯输出；
- 抖音真实账号驱动的 OAuth、原生 Webhook、商品同步、账单四类外部验收；
- 4090 主机上的目标端输出、独立探针、画面/音频质量、故障演练和 4 小时连续验收。

因此当前结论应保持为：**仓库能力部分完成；抖音 Adapter 代码与 mock 契约已完成，但生产闭环与外部放行未完成，不得写成通过。**

## 审计现场基线

- 当前 `HEAD`：`51d1b7846331b0527917313e37675f32e1d1a2cb`。
- `origin/master` 与当前 `HEAD` 相同。
- 审计开始时当前分支为 `master`，工作树干净。
- 最终只读复核时，工作树出现 4 个已跟踪文件修改，以及 `apps/douyin-adapter/` 下 10 个未跟踪文件和 `docs/providers/douyin/OFFICIAL_API_RESEARCH.md` 1 个未跟踪文件；这些路径不是本次审计的写入目标，本次审计未对其执行写操作，均保持原状。 - 本报告的交付判断以当前提交 `HEAD` 和已登记证据为准；最终工作树中的未提交/未跟踪内容不计入 HEAD 交付，也不计入已验证结果（该工作树状态未验证）。
- `HEAD` 提交主题为 `test: record full local verification`；其相对于 V-20261111-13 所引用的 `4a1aaa3` 仅新增 `docs/VERIFICATION_LOG.md` 记录，未见源码文件变化。
- 本次审计只执行了 Git 状态/引用核对和文档读取；未运行本机测试、Docker、PostgreSQL、4090 主机命令、抖音接口或外部验收。

## 已完成

### 1. 目标和产品边界已写清

`DELIVERY_PLAN.md:3-11` 已把目标定义为“一个内容项目、两个输出”：同一项目组织素材、授权、数字人、商品事实、脚本和审核记录，并分别生成实时直播与录播视频；直播输出明确要求 4090 和目标端试播验收。

`FRAMEWORK_STATUS.md:3-5` 也已将桌面版目标收敛到同一边界，并明确 4090 GPU smoke 不等于生产放行。

### 2. 仓库侧框架和治理能力已形成

- `/studio` 项目工作台、素材/商品/脚本/形象/直播路径已存在；本机验证记录覆盖 Studio 内容工作流（`DELIVERY_PLAN.md:15-24`）。
- 平台无关的标准化 Webhook、回复契约、provider 注册表、重放租约和出站回复链路已存在。
- AIGC 标识、画面层、默认预设、互动规则、输出观测证据和策略门禁已有仓库实现及对应治理条目（`DEPLOYMENT_READINESS.md:164-175`）。
- 目标平台决策 D1 已记录为抖音，日期为 2026-11-05；但覆盖规格仍为空（`DEPLOYMENT_READINESS.md:177-183`）。

### 3. 代码侧契约测试已有记录

- `V-20261111-12`：`npm run channel-adapter:test` 退出码为 0，provider 白名单、能力矩阵、AI 标识门槛、标准化入口和出站回复契约通过（`VERIFICATION_LOG.md:365-387`）。
- `V-20261111-13`：`npm run verify:local` 记录为 94 项检查、退出码 0，覆盖治理测试、Studio 内容工作流、渠道契约、类型检查、Lint、构建和运行时验收合同测试（`VERIFICATION_LOG.md:390-421`）。
- 历史 `V-20261108-13` 记录了六个 CI job 全部 success；该证据对应 2026-11-08 的旧提交，不等于当前 HEAD 或 4090 外部验收。

## 已验证（依据 [V-20261111-14](VERIFICATION_LOG.md#v-20261111-14) 等日志条目）

以下只按文档中明确的行为验证/本机或 CI 结果计入：

1. Git 当前引用和工作树状态已由本次审计现场核对。
2. 本机 `verify:local` 的 94 项记录为成功；但该条记录的 CI、PostgreSQL、Docker、Python Gateway 和外部主机部分明确列为未执行。
3. Channel_Adapter provider 契约本机测试已成功；其 PostgreSQL 集成复验和真实平台 Adapter 仍未覆盖。
4. Readiness 矩阵中 RW-000-13 至 RW-000-21 等仓库内治理能力被标为“代码已完成且有验证证据”；这些状态只证明相应代码/测试范围，不扩大到真实平台或目标端。

## 已观察但不计为“已验证通过”（未验证）

### 1. 4090 短时运行链路

`V-20261111-02` 记录了动态 WebRTC session、Gateway start/stop、内部 RTMP sink、AIGC 指标和 5.056 秒 MP4 录制结果；但该条自身判定为“未验证”，并明确未覆盖外部目标端、独立 output-probe、画面观感和 4 小时连续开播（`VERIFICATION_LOG.md:54-82`）。

当前 `OUTPUT_PROBE_TARGETS=[]`，所以内部 sink 不能证明抖音或其它正式目标端已经输出。

### 2. Avatar Builder 短视频冒烟

`V-20261111-01` 记录了上传、GPU 处理、候选预览和 Publisher 发布结果，但判定仍为“未验证”，且明确未覆盖 LiveTalking/CosyVoice/Gateway 全量 Compose、RTMP 目标端、录播归档、音画同步、4 小时开播和观看端画面（`VERIFICATION_LOG.md:5853-5879`）。

## 未完成

### 1. “一个内容项目、两个输出”尚未完成真实闭环

- 当前有 Studio 工作流和短时运行记录，但没有一条证据同时证明：真实审核资产、商品事实、脚本、数字人形象、声线在同一项目中冻结，并分别生成可追溯录播与实时直播。
- `DELIVERY_PLAN.md:111-116` 仍把“创建第一个完整内容项目并生成录播”列为下一动作。
- 现有 MP4 是短时运行产物，不等同于 P1 规定的项目内归档、授权、版本追踪和跨设备复核。

### 2. 抖音 Adapter 代码已完成，真实平台仍待验收

后续实现已落在 `apps/douyin-adapter/`，控制台已注册 `douyin` provider，规格与资料分别位于 `docs/providers/douyin/README.md` 和 `OFFICIAL_API_RESEARCH.md`。`V-20261111-14` 记录 `npm run douyin-adapter:test` 的 9 项本机 mock 行为测试通过，覆盖 OAuth、Webhook、生活服务商品请求、交易/资金账单、结算请求、账单下载和显式 CSV 映射。

- RW-040-01：代码已完成且有验证证据；真实应用审核和 token 仍依赖 EP-02。
- RW-040-02：代码已完成但待外部环境验证；真实 Webhook、Msg-Id 重试和互动权限仍依赖 EP-17。
- RW-040-03：代码已完成但待外部环境验证；当前只实现已核验生活服务商品端点，抖店全品类商品字段未在官方资料中确认。
- RW-040-04：代码已完成但待外部环境验证；真实账单 URL、CSV 表头和佣金/服务费/退款等语义仍需平台样本。

标准化 provider bridge、`POST /v1/webhooks/{channelConnectionId}` 或平台无关账单模型仍不能替代真实平台权限与目标端证据。

### 3. 4090 外部验收未完成

仍未形成以下证据：

- 4090 实机画面中的 AIGC 标识、字幕、商品卡、价格贴片和背景观感；
- 独立音频活动、音画同步、帧率/码率和目标端输出证据；
- 网络断开、RTMP 拒绝、GPU OOM、TTS 超时、黑屏、静音、Gateway/PostgreSQL 恢复演练；
- 单路单 Avatar 连续 4 小时的 `runtime-acceptance.json`；
- `npm run runtime:acceptance:verify -- --evidence ...` 退出码 0 的真实验收记录。

### 4. 外部资源和生产部署尚未齐备

- 远程主机可用空间约 78 GiB，低于至少 150 GiB 门槛。
- 真实模型权重、声线、形象和商品素材及其授权记录尚未挂载/核实。
- 正式 RTMP 目标、推流密钥、独立 output-probe 和 `avSyncProbeUrl` 尚未配置。
- 签名 release manifest、OCI registry/provenance、OIDC、生产 PostgreSQL、对象存储版本化/保留锁和独立 evidence verifier 尚未形成完整部署证据。

## 真正阻塞

| 阻塞项 | 事实依据 | 阻断影响 |
| --- | --- | --- |
| 真实开播硬门禁 | Readiness 规定必须同时满足 4090 验收证据校验退出码 0 和 EP-01 至 EP-19 全部满足；当前除 EP-12 外的 18 项仍为“未满足”（`DEPLOYMENT_READINESS.md:27-34`） | 不能进入真实生产开播判定 |
| 4090 容量门槛 | 当前约 78 GiB，可用空间低于 150 GiB（`FRAMEWORK_STATUS.md:24-30`、`DELIVERY_PLAN.md:40-43`） | 主机预检和生产验收被直接阻断 |
| 抖音平台条件 | 账号、应用审核、OAuth scope、RTMP/Stream Secret、互动事件权限和平台规则证据尚未齐备（EP-02、EP-17、EP-19） | 无法验证真实抖音 OAuth/Webhook/输出/互动链路 |
| 平台条件 | EP-02、EP-17、EP-19 仍未满足；抖店全品类商品接口与真实账单样本未确认 | 不能验证真实 OAuth/Webhook/目标端输出/商品权限/账单语义 |
| 模型与素材授权 | 权重、声线、形象和商品授权仍为外部缺口（EP-07、EP-08、EP-13、EP-14、EP-16） | 无法形成可发布的真实内容项目 |
| 生产证据链 | release manifest、目标端 verifier、对象存储留存和生产基础设施仍缺证据 | 短时 smoke 不能升级为发布证据 |
| 治理基线陈旧 | `DEPLOYMENT_READINESS.md:12` 仍以 2026-11-08 的 `0223d4c` 作为核对基准，而当前 HEAD/origin/master 已为 `51d1b78` | 下一轮必须先刷新证据基线，避免把历史 CI 结果误标为当前 HEAD 结果 |

## 下一轮最小验收

按最小可判定闭环执行，任何一项缺失都不要写成完成：

1. **刷新基线**：以当前 `51d1b784...` 记录新的核对提交；重新登记本机/CI 证据，区分 static、behavioral、需外部环境和未执行。
2. **先解主机硬门槛**：扩容至至少 150 GiB，执行 `bash scripts/check-runtime-host.sh`，留存完整输出和日期。
3. **补齐可发布输入**：准备已核验许可证和哈希的模型权重、一个已审核形象、一个已审核声线、一个商品事实和一份脚本；在 Studio 创建并冻结一个内容项目。
4. **完成抖音真实接入验收**：代码规格和 mock 契约已完成；取得平台账号/权限后，补真实 OAuth、原生 Webhook、商品样本、账单 CSV、结算语义和目标端回调证据。未取得平台账号/权限时，标记为外部阻塞，不用标准化 bridge 冒充完成。
5. **验收录播输出**：从上述冻结项目生成一条录播，完成文件质量、授权、SHA-256、项目/版本/审核记录和归档证据核对。
6. **验收实时输出**：仍使用同一冻结项目创建一条直播场次；配置正式 RTMP/抖音目标、独立 output-probe 和 `avSyncProbeUrl`，核对 AIGC 标识、字幕、商品卡、声音、画面和输出证据。
7. **先短后长**：完成至少 30 分钟单路试播和故障演练；随后形成 4 小时单 Avatar 的 `runtime-acceptance.json`，执行：
   ```
   npm run runtime:acceptance:verify -- --evidence /srv/shuzhiren/evidence/runtime-acceptance.json
   ```
   只有退出码为 0 且所有 EP 行都有合格位置/日期/提供方证据，才可将真实开播标为放行。
8. **最后回写治理状态**：更新 Readiness 的 RW/EP 状态、Verification_Log 的证据引用和当前 HEAD 基线；短时内部 RTMP、容器 healthy、Gateway accepted、Avatar Builder 完成均不得替代目标端或长时证据。

## 最终审计结论

当前最小可信表述是：

> **仓库治理和产品框架已具备；抖音 Adapter 代码与本机 mock 契约已验证；4090 远程短时内部链路已观察到但治理上仍未验证；真实内容项目双输出、抖音账号/目标端验收和 4090 外部生产验收均未完成。**




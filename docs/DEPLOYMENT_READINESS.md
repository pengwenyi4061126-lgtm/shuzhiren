# 商业部署就绪矩阵

本仓库可以完成控制面、治理、Gateway、观测、部署校验和验收证据门禁；它不能替代租用 GPU、取得平台账号、签署授权或提供生产凭据。每项工作单独占一行：`EP-NN` 是外部先决条件，`RW-NNN-MM` 是仓库交付项（NNN 为主需求编号，`000` 表示不属于 Requirement 1 至 40 的现有交付物）。`npm run docs:governance:check` 按 `scripts/lib/readiness-matrix.mjs` 校验本文件的结构、状态与证据。

填写规则（Requirement 40.5–40.7 与 6.3、6.4 的流程部分，门禁只能校验格式与一致性）：

- 用户对待决策事项作出决定后，第一个修改本矩阵的提交写入所选平台和决策日期（YYYY-MM-DD），并在同一提交中改写 RW-040-01 至 RW-040-04 的状态。
- 为所选平台 Adapter 建立规格后，第一个修改本矩阵的提交在"覆盖规格"列写明规格目录路径；规格不在本仓库时写成 `<仓库或工作区>:<路径>`。
- 证据列只写引用（`V-` 编号，或 `位置=…，日期=…，提供方=…`），不写推流地址、推流密钥、签名私钥、OAuth 应用密钥或 registry 凭据的值。
- "说明"列中的"验证方式"是验证所用的命令或步骤，本身不是证据。

核对基准：`origin/master` = `e3046789e5917d5f588a3975f14290d4e087fff8`（2026-11-06 核对）。VERIFICATION_LOG 中最近一条登记的 CI 运行是 #502（run 42040219509，提交 fd9179d，`V-20261105-20`）；之后的 #503、#504 只改动文档，结论为 success，没有登记条目。

## 状态定义

每行只取以下六个状态之一：

- **代码已完成且有验证证据**：证据列引用至少一条 VERIFICATION_LOG 条目，该条目的判定为"行为验证"，且含类别为"本机运行"或"CI 或 Linux 运行"的来源（Requirement 6.4）。本矩阵另加一条取证规则：该条目中与本行相关的检查必须是标签为 behavioral 且结论为 success 的步骤；只有 static 检查覆盖的行不标此状态。审计修复行以 Audit_Register 登记的回归测试作为"相关检查"。
- **代码已完成但待 CI 或 Linux 验证**：代码已在 `master` 上，但没有满足上一条的条目，或只能在 Linux 主机上验证（Requirement 6.6、32.11）。
- **代码已完成但待外部环境验证**：代码已在 `master` 上，验证只能在 4090 主机、平台账号或 `release-production` environment 等外部环境中进行（Requirement 6.6）。
- **代码未完成**：仓库中缺少该交付物或其必需的测试。
- **External_Prerequisite**：只用于 `EP-` 行，另在"外部条件"列标"已满足"或"未满足"。标"已满足"须在证据列同时写出 `位置=`、`日期=YYYY-MM-DD`、`提供方=`；只由开发态 fixture、Gateway `/healthz` 响应、容器 `running` 状态或口头确认构成的材料不算证据，没有合格证据的行一律"未满足"（Requirement 6.3）。仓库提供的接口、脚本或门禁不能使任何 EP 行变为"已满足"。
- **待用户决策**：交付方向取决于用户尚未作出的决定（见"待决策事项"）。

Audit_Register 的"已确认"与本矩阵的状态记录不同事实：审计记录为"已确认"而非"已修复"，多数是因为缺少修复前提交上回归测试失败的证据（Requirement 7.11–7.13），这不改变本矩阵对修复代码与修复后运行的判定。相关审计编号写在各行"说明"列。

## 真实开播放行条件

真实开播须同时满足以下两项，缺任一项即不放行：

1. 以 4090 验收证据文件运行 `npm run runtime:acceptance:verify -- --evidence /srv/shuzhiren/evidence/runtime-acceptance.json`，并以退出码 0 结束。
2. 全部 External_Prerequisite 行（EP-01 至 EP-14）均标为"已满足"。

截至核对日，EP-12 之外的 13 行都为"未满足"，所以不放行。任何缺失的外部项都是上线阻断，不能通过开发态 fixture、Gateway `/healthz`、容器 `running` 状态或口头确认绕过。

## 外部先决条件

| 编号 | 事项 | 状态 | 外部条件 | 证据 | 对应需求 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| EP-01 | 4090 GPU 主机及端到端推流试播（至少 30 分钟的内部试播） | External_Prerequisite | 未满足 | — | 6 | 仓库中做准备的产物：`scripts/check-runtime-host.sh`、Runtime_Compose、`npm run runtime:acceptance:verify`。验证方式：`bash scripts/check-runtime-host.sh`；30 分钟内部试播报告与目的端输出探针记录 |
| EP-02 | 平台账号、应用审核、OAuth scope、RTMP 推流地址与 Stream_Secret | External_Prerequisite | 未满足 | — | 6, 14, 40 | D1 已选定抖音（2026-11-05），抖音开放平台账号、应用审核与 scope 尚未取得。仓库中做准备的产物：Channel_Adapter 的标准化 Webhook 与回复契约、`STREAM_KEY_FILE` 只读文件注入与日志脱敏。平台 Adapter 本身是 RW-040-01 至 RW-040-04 |
| EP-03 | OIDC 提供商 | External_Prerequisite | 未满足 | — | 6, 25 | 仓库中做准备的产物：控制台 OIDC JWT 校验（issuer、audience、exp、算法白名单、typ）与 `config/control-plane.example.env`；真实成员同步也依赖本项 |
| EP-04 | TLS 证书与反向代理 | External_Prerequisite | 未满足 | — | 6, 37 | 仓库中做准备的产物：生产环境 HSTS 与 nonce CSP、Deployment_Runbook 的部署说明 |
| EP-05 | KMS 或 HSM 与签名私钥 | External_Prerequisite | 未满足 | — | 6, 13, 34 | 仓库中做准备的产物：Release_Workflow 签名步骤、`scripts/release-environment.mjs` 的 signing 校验、`verify-deployment-images.mjs` 的 Ed25519 受信公钥校验 |
| EP-06 | 对象存储版本化与保留锁 | External_Prerequisite | 未满足 | — | 6 | 仓库中做准备的产物：`media:evidence:check`、`recording:evidence:check` 与 Runbook 的存储要求；站外复制与恢复演练也依赖本项 |
| EP-07 | 受许可的模型权重 | External_Prerequisite | 未满足 | — | 6, 39 | 仓库中做准备的产物：`MODEL_VOLUME_PATH`、`COSYVOICE_MODEL_PATH` 模板变量；逐组许可证审查见 EP-13、EP-14 |
| EP-08 | 授权素材（肖像、声音、音乐、商品、脚本） | External_Prerequisite | 未满足 | — | 6, 15 | 仓库中做准备的产物：授权声线绑定与声线 ID 校验、素材审批证据触发器、`COSYVOICE_VOICE_LIBRARY_PATH` 声线库格式 |
| EP-09 | 输出、素材、录制和渠道证据 verifier 的部署 | External_Prerequisite | 未满足 | — | 6 | 仓库中做准备的产物：`PROGRAM_OUTPUT_VERIFIER_TRUST`、`MEDIA_EVIDENCE_VERIFIER_*`、`RECORDING_EVIDENCE_VERIFIER_*`、`CHANNEL_EVIDENCE_VERIFIER_*` 契约与 `media:evidence:check`、`recording:evidence:check`、`channel:verification:check` 门禁、Output_Probe |
| EP-10 | OCI registry 与受信签名 runner | External_Prerequisite | 未满足 | — | 6, 13, 34 | 仓库中做准备的产物：`.github/workflows/release.yml`（environment、SHA 锁定、registry 白名单）、attestation 汇总与镜像核验。自托管签名 runner 尚未提供；Release_Workflow 尚无运行记录 |
| EP-11 | 4 小时单路验收证据（试播时长至少 240 分钟，同时运行的数字人数为 1） | External_Prerequisite | 未满足 | — | 6 | 验证方式：`npm run runtime:acceptance:verify -- --evidence <验收证据文件>`，证据格式见 `config/runtime-acceptance.example.json` |
| EP-12 | `release-production` environment 的 GitHub 设置：部署分支仅限受保护分支；至少一名必需审核人；`REGISTRY_USERNAME`、`REGISTRY_PASSWORD` 和五个签名与构建变量只定义在该 environment（Requirement 13.9） | External_Prerequisite | 已满足 | 位置=GitHub 仓库设置（2026-11-05，仓库所有者配置，API 核对 secret 名称与 environment 规则），日期=2026-11-05，提供方=仓库所有者 | 13 | 2026-11-05 由仓库所有者配置 `release-production` environment、两个 registry secret 与 `master` 分支保护。2026-11-06 以公开接口复核：该 environment 存在，规则为 required_reviewers（1 名审核人）与 branch_policy（protected_branches 为 true），`master` 的 protected 为 true；secret 与变量的名称和所在层级需要仓库权限才能读取，本次未复核。registry 白名单初始值 `ghcr.io` 是依据现有 `packages: write` 权限的假设，使用其他 registry 时提交 PR 修改 `.github/release-registry-allowlist.json` |
| EP-13 | 模型权重许可证审查：LiveTalking_Runtime `--model musetalk` 从 `MODEL_VOLUME_PATH` 加载的权重（Requirement 39.16） | External_Prerequisite | 未满足 | — | 39 | 权重目录变量 `MODEL_VOLUME_PATH`；仓库中做准备的产物：`runtime/open-source.lock.json`、`scripts/check-runtime-image-licenses.mjs`；审查结论由部署方在仓库外取得 |
| EP-14 | 模型权重许可证审查：CosyVoice_Service 从 `COSYVOICE_MODEL_PATH` 加载的模型（当前模板为 Fun-CosyVoice3-0.5B-2512）（Requirement 39.16） | External_Prerequisite | 未满足 | — | 39 | 权重目录变量 `COSYVOICE_MODEL_PATH`；其余同 EP-13 |

## 仓库交付项

证据列中的 `V-20261105-20` 是 #502（run 42040219509，提交 fd9179d）：六个 job 全部 success，skipped 步骤数为 0。下表所列修复提交都是 fd9179d 的祖先（2026-11-06 以 `git merge-base --is-ancestor` 核对）。审计修复行的事项只覆盖该审计问题的修复范围，没有逐条核对所属需求的全部验收标准。

| 编号 | 事项 | 状态 | 证据 | 对应需求 | 说明 |
| --- | --- | --- | --- | --- | --- |
| RW-001-01 | CI 六个 job 在 `master` 推送时全部为 success，skipped 步骤为 0 | 代码已完成且有验证证据 | V-20261105-16；V-20261105-20 | 1, 2 | #498（run 41993338992）是 #491 之后第一次全绿；#499 至 #502 均已登记为 success。#491 的失败基线见 V-20261104-01 |
| RW-001-02 | CI 中的数据库步骤在缺少数据库时失败而不是跳过 | 代码已完成且有验证证据 | V-20261105-20 | 1 | 相关检查：node-unit 的 `ci:db-fail-closed:test`（behavioral） |
| RW-002-01 | 失败隔离：一个 job 失败时其余 job 仍执行到结束 | 代码已完成但待 CI 或 Linux 验证 | V-20261105-09；V-20261105-10 | 2 | 这两条失败运行中其余 job 仍执行到结束，但条目判定为"未验证"；任务 4.2 的隔离演练没有登记 |
| RW-002-02 | CI_Coverage_Gate：Local_Verification 的每项检查在 CI 中都有对应步骤 | 代码已完成且有验证证据 | V-20261105-20 | 2 | 相关检查：`ci:gates:test`（behavioral）；门禁 `ci:coverage:check` 本身为 static |
| RW-002-03 | CI 构建 CosyVoice 镜像（N8：已修复） | 代码已完成但待 CI 或 Linux 验证 | — | 2, 35 | docker-build 第 17 步在 #502 中为 success（见 V-20261105-20 的说明），该步骤为 static 镜像构建，且未列入条目的步骤 |
| RW-003-01 | `ci.yml` 顶层 permissions 为 `contents: read`，W1–W12 结构门禁 | 代码已完成且有验证证据 | V-20261105-20 | 3 | 相关检查：`ci:gates:test`、`ci:evidence:test`（behavioral）。M20：已确认，没有登记修复记录 |
| RW-003-02 | `ci.yml` 与 `release.yml` 的第三方 action 按 commit SHA 锁定（`.github/action-pins.json`） | 代码已完成且有验证证据 | V-20261105-20 | 3 | 相关检查：`release:workflow:gate:test`（behavioral）；`ci:action-pins:verify` 为 static |
| RW-004-01 | VERIFICATION_LOG 条目 schema 与 `docs:governance:check`（判定复核、标签、机密扫描） | 代码已完成且有验证证据 | V-20261105-20 | 4 | 相关检查：node-unit 的 `docs:governance:test`（behavioral） |
| RW-005-01 | Handoff_Doc 更正与 CLAIM、CI-CLAIM、RUN-REF、AUDIT-LIST、CHECKPOINT、STALE-SYNC、MATRIX-STATUS、D1-* 门禁（`scripts/lib/handoff-docs.mjs`） | 代码已完成但待 CI 或 Linux 验证 | — | 4, 5, 40 | 与本矩阵同一提交引入，尚无包含该提交的 CI 运行登记。`docs/DEPLOYMENT_RUNBOOK.md` 的 CLAIM 命中暂只输出 NOTE，待该文件的维护方处理 |
| RW-006-01 | 六状态就绪矩阵与 RM-* 门禁（`scripts/lib/readiness-matrix.mjs`） | 代码已完成但待 CI 或 Linux 验证 | — | 6, 32, 40 | 与本矩阵同一提交引入，尚无包含该提交的 CI 运行登记 |
| RW-007-01 | Audit_Register 登记与 AR-* 门禁 | 代码已完成且有验证证据 | V-20261105-20 | 7 | 相关检查：`docs:governance:test`。66 条记录：已修复 5、已确认 59、需环境验证 2 |
| RW-008-01 | C1：`channel_connections` 的 INSERT 不再失败 | 代码已完成且有验证证据 | V-20261105-20 | 8, 10 | C1：已修复（f35eb30）；相关检查：postgres-integration 的 `db:verify -- --allow-privileged` |
| RW-008-02 | N2：渠道连接创建与 `channel_connection.created` 审计在同一事务 | 代码已完成且有验证证据 | V-20261105-20 | 8 | N2：已确认（e427a45）；相关检查：`control-plane:integration` |
| RW-009-01 | C2：结算批次与差异记录的不可变治理触发器 | 代码已完成且有验证证据 | V-20261105-20 | 9, 10 | C2：已确认（416df39）；相关检查：`db:verify -- --allow-privileged` |
| RW-010-01 | Migration_Lint（`db:migrations:lint`）报告触发器中对 TG_OP 的小写比较 | 代码未完成 | — | 10 | 核对时 `package.json` 中没有该脚本 |
| RW-011-01 | C3：Alert_Notifier 逐目标轮询并投递告警 | 代码已完成且有验证证据 | V-20261105-20 | 11 | C3：已确认（39ebbc0）；相关检查：`alert-notifier:test`；`control-plane:integration` 在真实 PostgreSQL 上断言 `alert_notification_deliveries` |
| RW-011-02 | N3、N4：`/healthz` 查询总时长与最后一次尝试后崩溃的投递记录 | 代码已完成且有验证证据 | V-20261105-20 | 11 | N3（9be485d）、N4（50a36ff）：已确认；相关检查：`alert-notifier:test` |
| RW-012-01 | C4、N1：Runtime_Worker 对 `live_interactions` 的列级 SELECT 与 `outbox_events` 的 INSERT 授权 | 代码已完成但待 CI 或 Linux 验证 | — | 12, 28 | 修复提交 cf05466；Audit_Register 中 C4、N1 没有登记回归测试与修复后通过记录 |
| RW-013-01 | H1：Release_Workflow 删除可注入的输入，registry 与签名配置改由 `release-production` environment 提供 | 代码已完成且有验证证据 | V-20261105-20 | 13 | H1：已确认（2e010f0）；相关检查：`release:workflow:gate:test`。Release_Workflow 本身尚无运行记录 |
| RW-013-02 | 13.7：清空 `release-production` 变量后 release job 失败且不生成 Release_Manifest | 代码已完成但待外部环境验证 | — | 13 | 环境：release-production environment 与签名 runner。验收入口：一次故意清空变量的演练运行，记录 run id；尚无记录 |
| RW-014-01 | H2：推流密钥改由只读 secret 文件提供，Deploy_Check 拒绝 env 文件中的推流密钥值 | 代码已完成且有验证证据 | V-20261105-20 | 14 | H2：已确认（0ff6621）；相关检查：`deploy:check:test` |
| RW-014-02 | 14.1：LiveTalking_Runtime 容器内任何进程的命令行参数不携带推流密钥 | 代码已完成但待外部环境验证 | — | 14 | 环境：4090。验收入口：设计第 3 部分 §2.5 的 4090 验收命令表（`ps`、`docker inspect`） |
| RW-014-03 | 14.6：运行参数日志以脱敏后的推流地址代替原值 | 代码已完成但待外部环境验证 | — | 14 | 环境：4090。验收入口同 RW-014-02 |
| RW-014-04 | 14.7：推流开始日志只写脱敏后的推流地址 | 代码已完成但待外部环境验证 | — | 14 | 环境：4090。验收入口同 RW-014-02 |
| RW-014-05 | 14.8：容器标准输出与标准错误不出现推流密钥，含推流失败的错误日志与异常堆栈 | 代码已完成但待外部环境验证 | — | 14 | 环境：4090。验收入口同 RW-014-02 |
| RW-015-01 | H3：节目脚本与语音先经 CosyVoice 以授权声线合成，再经 `/humanaudio` 注入，不调用 `/human` | 代码已完成且有验证证据 | V-20261105-20 | 15 | H3：已确认（261e260）；相关检查：`test-runtime-gateway-concurrency.py`、`runtime:gateway:errors:test`、`deploy:check:test`、`control-plane:integration`。M18（CosyVoice 链路实际可用性）：需环境验证 |
| RW-015-02 | 15.14(a)：授权声线在 4090 上合成音频的试听验收结论 | 代码已完成但待外部环境验证 | — | 15 | 环境：4090。验收入口：设计第 3 部分 §3.5。当前证据状态：无记录 |
| RW-015-03 | 15.14(b)：首段合成音频到达 LiveTalking 目标会话的延迟 p50、p95 | 代码已完成但待外部环境验证 | — | 15 | 环境：4090。验收入口：`runtime_command_timing.audio_ack_ms`。当前证据状态：无记录 |
| RW-015-04 | 15.14(c)：800 字符 Program_Script 的完整合成耗时小于单命令总时限 | 代码已完成但待外部环境验证 | — | 15 | 环境：4090。验收入口：3 次 `insert_program`。当前证据状态：无记录 |
| RW-015-05 | 15.14(d)：SFT 部署的预置说话人；`zero_shot` 部署记为不适用 | 代码已完成但待外部环境验证 | — | 15 | 环境：4090。验收入口：`list_available_spks()`。当前证据状态：无记录 |
| RW-016-01 | H4：发布清单冻结快照按清单主体封存与校验 | 代码已完成且有验证证据 | V-20261105-20 | 16 | H4：已确认（a9c3420）；相关检查：`control-plane:integration` |
| RW-017-01 | H5：Output_Probe 在无鉴权或异常请求下不崩溃 | 代码已完成且有验证证据 | V-20261105-20 | 17 | H5：已确认（1f1846f）；相关检查：`output-probe:test`、`output-probe:config:test` |
| RW-018-01 | H6：Channel_Adapter 转发失败时释放 Replay_Lease | 代码已完成且有验证证据 | V-20261105-20 | 18 | H6：已确认（4a94e72）；相关检查：`channel-adapter:test` |
| RW-019-01 | H7：Gateway 命令日志先校验后预留、四状态与结果不确定命令的人工处置 | 代码已完成且有验证证据 | V-20261105-20 | 19 | H7：已确认（333f685 至 d265159 共 6 个提交）；相关检查：`test-runtime-gateway-concurrency.py`、`control-plane:integration` |
| RW-020-01 | M1：API 的 401、403 不再变成 500 | 代码已完成且有验证证据 | V-20261105-20 | 20 | M1：已修复（34236ef）；相关检查：`control-plane:integration` |
| RW-021-01 | M2：开播预检与命令事务只用一个连接 | 代码已完成但待 CI 或 Linux 验证 | — | 21 | M2：已确认（3da1324）；登记的回归测试 `preflight:check` 为 static |
| RW-022-01 | M3：所有 Node 服务的 pg.Pool 注册 error 监听 | 代码已完成且有验证证据 | V-20261105-20 | 22 | M3：已确认（2e6a81a）；相关检查：`runtime:worker:health:test`、`channel-adapter:test`、`alert-notifier:test`、`control-plane:integration` |
| RW-023-01 | M4：迁移 checksum 不受换行符影响 | 代码已完成且有验证证据 | V-20261105-20 | 23 | M4：已确认（234265f）；相关检查：`db:migrate:integrity:test` |
| RW-024-01 | M5：Schema_Verifier 不漏检 RLS 表 | 代码已完成且有验证证据 | V-20261105-20 | 24 | M5：已确认（e3bad9b）；相关检查：`db:migrate:integrity:test` |
| RW-025-01 | M6：开发请求头身份只由显式开关启用，Deploy_Check 拒绝开启 | 代码已完成且有验证证据 | V-20261105-20 | 25 | M6：已确认（20c7936）；相关检查：`deploy:check:test` |
| RW-025-02 | M16：OIDC 校验要求 exp、算法白名单与 typ | 代码已完成但待 CI 或 Linux 验证 | — | 25 | M16：已确认（cd251cf）；登记的回归测试 `console:page-auth:check` 为 static |
| RW-026-01 | M7、L10、L11：运行时 compose 去字面量、端口三处一致、两份运行时模板变量一致 | 代码已完成且有验证证据 | V-20261105-20 | 26 | M7（1977e2c）、L10（41f7591）、L11（15c1777）：已确认；相关检查：`deploy:check:test` |
| RW-027-01 | M9：Node 运行时改为 Node 24（`engines.node` 为 `^24.11.0`，镜像为 Node 24） | 代码已完成且有验证证据 | V-20261105-20 | 27 | M9：已确认（2c7d5d9）；相关检查：`deploy:images:test`。Node 24 维护期到 2028-04-30 |
| RW-028-01 | M10：Runtime_Worker 的租约围栏与重试语义 | 代码已完成且有验证证据 | V-20261105-20 | 28 | M10：已确认（2d97066）；相关检查：`control-plane:integration` |
| RW-028-02 | M11：手工投递在下发已被接受、写库失败时不重复下发 | 代码已完成且有验证证据 | V-20261105-20 | 28 | M11：已确认（f627116）；相关检查：`control-plane:integration` |
| RW-029-01 | M13：以 approved 状态插入须带审批证据 | 代码已完成且有验证证据 | V-20261105-20 | 29 | M13：已确认（f9bf8dc）；相关检查：`db:verify -- --allow-privileged` |
| RW-029-02 | M14：并发移除最后一名管理员时至少一个事务失败 | 代码已完成且有验证证据 | V-20261105-20 | 29 | M14：已确认（13282e5）；相关检查：`control-plane:integration` |
| RW-029-03 | L8：成员接口不改写已有用户的显示名 | 代码已完成且有验证证据 | V-20261105-20 | 29 | L8：已确认（5e1ef6e）；相关检查：`control-plane:integration` |
| RW-030-01 | M12：数据修复迁移的行数守卫 | 代码已完成且有验证证据 | V-20261105-20 | 30 | M12：已确认（ba28eab）；相关检查：`db:migrate:integrity:test` |
| RW-030-02 | M15：租户一致的复合外键 | 代码已完成且有验证证据 | V-20261105-20 | 30 | M15：已确认（806d24a）；相关检查：`db:verify -- --allow-privileged` |
| RW-030-03 | L16：审计哈希链与链头不可被服务主体改写 | 代码已完成且有验证证据 | V-20261105-20 | 30 | L16：已确认（3fd7235）；相关检查：`service-principals:integration` |
| RW-031-01 | M17：运行时媒体私有网络与 Observer 只读凭据 | 代码已完成但待 CI 或 Linux 验证 | — | 31 | M17：已确认（7e7ed12）；登记的回归测试 `runtime:compose:check` 为 static |
| RW-031-02 | 31.4：Gateway 能访问 LiveTalking 与 CosyVoice（`/healthz` 中两个依赖均可用） | 代码已完成但待外部环境验证 | — | 31 | 环境：4090。验收入口 `scripts/acceptance/runtime-network-isolation.sh` 尚不在仓库中（任务 32.5） |
| RW-031-03 | 31.5：Gateway 以外的运行时服务无法连接 LiveTalking 与 CosyVoice | 代码已完成但待外部环境验证 | — | 31 | 环境：4090。验收入口同 RW-031-02 |
| RW-031-04 | 31.6：LiveTalking 经 `livetalking-egress` 推流成功 | 代码已完成但待外部环境验证 | — | 31 | 环境：4090。验收入口同 RW-031-02，另需 RTMP 接收端记录 |
| RW-032-01 | 32.2：只读状态目录中 WAL 模式 Command_Journal 备份的 CI 行为测试 | 代码已完成且有验证证据 | V-20261105-20 | 32 | M19：需环境验证（14afbe2）；相关检查：python-gateway 的 `test-runtime-gateway-state-backup.py` |
| RW-032-02 | 32.7：RTMP 模式下 LiveTalking 只列出会话 `"0"` | 代码已完成但待外部环境验证 | — | 32 | 环境：4090。验收入口 `scripts/acceptance/livetalking-session-zero.sh` 尚不在仓库中（任务 33.4） |
| RW-032-03 | 32.8：会话 ID 为 `0` 的 `start_program` 得到 accepted 回执 | 代码已完成但待外部环境验证 | — | 32 | 环境：4090。验收入口同 RW-032-02 |
| RW-032-04 | 32.1：以 `shuzhiren-runtime-gateway-backup.service` 在 Gateway 无日志连接时备份 | 代码已完成但待 CI 或 Linux 验证 | — | 32 | 环境：Linux。验收入口：`systemctl start shuzhiren-runtime-gateway-backup.service` 与 `journalctl -u` 输出 |
| RW-032-05 | 会话 ID `"0"` 的绑定校验与逐字符透传（32.3–32.6）及其行为测试（32.9） | 代码未完成 | — | 32 | 32.3 的拒绝逻辑在 `apps/console` 的两个场次路由中；以 `0` 为会话 ID 的行为测试不在仓库中 |
| RW-033-01 | M22：开发 compose 只绑定回环地址，凭据来自环境变量 | 代码已完成但待 CI 或 Linux 验证 | — | 33 | M22：已确认（5c67f88）；登记的回归测试 `control-plane:compose:check` 为 static |
| RW-033-02 | M23：LiveTalking 镜像不带入敏感内容 | 代码已完成且有验证证据 | V-20261105-20 | 33 | M23：已确认（c8ab9d8）；相关检查：`deploy:check:test` |
| RW-033-03 | N6：CI checkout 中 LiveTalking 镜像构建不因悬空的 `.git` 文件失败 | 代码已完成但待 CI 或 Linux 验证 | — | 33, 1 | N6：已修复（43718f8）；回归测试为 static 镜像构建 |
| RW-034-01 | M21：发布证据按 digest 读取 registry 的 attestation 汇总 | 代码已完成且有验证证据 | V-20261105-20 | 34 | M21：已确认（4672ebc）；相关检查：`release:evidence:test`、`deploy:check:test` |
| RW-034-02 | L5：Canonical_JSON 与 locale 无关 | 代码已完成且有验证证据 | V-20261105-20 | 34 | L5：已确认（c0763c3）；相关检查：`deploy:check:test` |
| RW-034-03 | L6：发布清单有效期上限统一为 30 天 | 代码已完成且有验证证据 | V-20261105-20 | 34 | L6：已确认（b662f72）；相关检查：`deploy:manifest:test`、`deploy:check:test` |
| RW-035-01 | M24：基础镜像 digest 与依赖锁定 | 代码已完成且有验证证据 | V-20261105-20 | 35 | M24：已确认（44857e1）；相关检查：`deploy:images:test` |
| RW-036-01 | M8：静态门禁改为结构化解析而非子串匹配 | 代码已完成但待 CI 或 Linux 验证 | — | 36 | M8：已确认（fb763f5）；登记的回归测试均为 static |
| RW-036-02 | 共享 PostgreSQL 测试 harness、触发器覆盖断言、回归登记表与 `test:registries:check` | 代码未完成 | — | 36 | 核对时（e304678）`scripts/integration/`、`scripts/regression-registry.mjs`、`scripts/static-gate-coverage.mjs` 不在仓库中 |
| RW-037-01 | L1：服务 token 以常量时间比较 | 代码已完成且有验证证据 | V-20261105-20 | 37, 17 | L1：已确认（38665a8）；相关检查：`output-probe:config:test` |
| RW-037-02 | L2：租户 token 映射配置错误时启动失败 | 代码已完成且有验证证据 | V-20261105-20 | 37 | L2：已确认（b1f1138）；相关检查：`control-plane:integration` |
| RW-037-03 | L3：生产环境 HSTS 与每请求 nonce CSP | 代码已完成且有验证证据 | V-20261105-20 | 37 | L3：已确认（c331479）；相关检查：`control-plane:integration` |
| RW-037-04 | L4：错误响应不外泄内部信息 | 代码已完成但待 CI 或 Linux 验证 | — | 37 | L4：已确认（13f4dd4）；登记的回归测试 `console:security-headers:check` 为 static |
| RW-037-05 | L9：Gateway 拒绝无效上游 JSON，NVML 固定读取设备 0 | 代码已完成且有验证证据 | V-20261105-20 | 37 | L9：已确认（eed87df）；相关检查：`runtime:gateway:config:test`、`runtime:gateway:errors:test` |
| RW-038-01 | L7：Channel_Adapter 与 Output_Probe 收到 SIGTERM 后自行退出 | 代码已完成且有验证证据 | V-20261105-20 | 38 | L7：已确认（86f90bf）；相关检查：`channel-adapter:test`、`output-probe:test` |
| RW-038-02 | L12：备份 systemd 单元的启动超时与分开的 EnvironmentFile | 代码已完成但待 CI 或 Linux 验证 | — | 38 | L12：已确认（00adee2）；登记的回归测试 `backup:automation:check` 为 static |
| RW-038-03 | L13：Prometheus 示例目标对齐 compose 服务名 | 代码已完成但待 CI 或 Linux 验证 | — | 38 | L13：已确认（c9f3b68）；登记的回归测试 `control-plane:compose:check` 为 static |
| RW-038-04 | L14：备份与恢复演练脚本经 `PGPASSWORD` 传递口令 | 代码已完成且有验证证据 | V-20261105-20 | 38 | L14：已确认（6a6de3c）；相关检查：`test-postgres-backup-direct.sh`、`test-postgres-restore-drill.sh` |
| RW-038-05 | L15：Migrator 的事务超时与迁移锁 | 代码已完成且有验证证据 | V-20261105-20 | 38 | L15：已确认（8e97b0f）；相关检查：`db:migrate:lock:test` |
| RW-038-06 | M25：Gateway 的阻塞调用移出事件循环 | 代码已完成且有验证证据 | V-20261105-20 | 38 | M25：已确认（b80ce32）；相关检查：`test-runtime-gateway-concurrency.py` |
| RW-039-01 | L17：源码锁定文件与实际部署一致 | 代码已完成且有验证证据 | V-20261105-20 | 39 | L17：已确认（013d65d）；相关检查：`deploy:images:test`、`deploy:check:test` |
| RW-039-02 | L18：LiveTalking 修改声明与镜像许可证文件 | 代码已完成且有验证证据 | V-20261105-20 | 39 | L18：已确认（211f379）；相关检查：`runtime:images:licenses:test`；模型权重许可证审查见 EP-13、EP-14 |
| RW-040-01 | 目标平台 OAuth Adapter | 代码未完成 | — | 40 | D1 已决定（抖音，2026-11-05）；需另立规格，仓库中没有抖音对接代码 |
| RW-040-02 | 目标平台 Webhook Adapter（接收该平台原生 Webhook 事件，区别于 Channel_Adapter 已实现的 `POST /v1/webhooks/{channelConnectionId}`） | 代码未完成 | — | 40 | 同 RW-040-01 |
| RW-040-03 | 目标平台商品同步 Adapter | 代码未完成 | — | 40 | 同 RW-040-01 |
| RW-040-04 | 目标平台账单 Adapter（拉取该平台账单，并映射佣金、服务费、运费、优惠分摊、税费、保证金、跨期退款和打款周期语义；区别于已实现的平台无关账单批次、账单行、订单级差异与结案） | 代码未完成 | — | 40 | 同 RW-040-01 |
| RW-040-05 | N9：Channel_Adapter 的 `/v1/replies` 下发失败时返回错误，不产生未处理的 rejection | 代码已完成且有验证证据 | V-20261105-20 | 40 | N9：已确认（734ee8e）；相关检查：`channel-adapter:test` |
| RW-040-06 | 40.8–40.11 的锁定测试：渠道 provider 白名单的单元与数据库测试、Channel_Adapter 标准化入口与出站回复的契约测试 | 代码未完成 | — | 40 | 任务 49.8、49.9 的测试文件不在仓库中 |
| RW-000-01 | Linux 主机只读预检 `scripts/check-runtime-host.sh` | 代码已完成但待 CI 或 Linux 验证 | — | 无 | 来源：dc2916e 的 `docs/DEPLOYMENT_READINESS.md`。CI 只运行 `bash -n` 与 `--help`（static）；需在 Linux 4090 主机上运行 |
| RW-000-02 | 录制证据登记与 `RECORDING_EVIDENCE_VERIFIER_*` 回执封存 | 代码已完成但待 CI 或 Linux 验证 | — | 无 | 来源同 RW-000-01。CI 中只有 static 检查 `recording:evidence:check` |
| RW-000-03 | 渠道证据 verifier（`CHANNEL_EVIDENCE_VERIFIER_*`）的控制面契约与门禁 | 代码已完成但待 CI 或 Linux 验证 | — | 无 | 来源同 RW-000-01。CI 中只有 static 检查 `channel:verification:check`；verifier 服务的部署是 EP-09 |
| RW-000-04 | 节目输出观测与节目段落、Gateway 回执和审计时间线的关联（066） | 代码已完成且有验证证据 | V-20261105-20 | 无 | 来源同 RW-000-01（原"尚未完成的仓库工作"第 4 条）。相关检查：`control-plane:integration` 中的输出观测用例。实际水印、指纹或目的端回放验证器是 EP-09 |
| RW-000-05 | N5：commands 路由的审计事件与 `issueCommand` 在同一事务 | 代码已完成且有验证证据 | V-20261105-20 | 无 | N5：已确认（ac33f61）；相关检查：`control-plane:integration` |
| RW-000-06 | N10：结算对账单导入在 PostgreSQL 17 上不再对 uuid 列调用 `min()` | 代码已完成且有验证证据 | V-20261105-20 | 无 | N10：已确认（4576a01）；相关检查：`control-plane:integration` |
| RW-000-07 | N11：重放已存在的节目输出观测时返回原记录 | 代码已完成且有验证证据 | V-20261105-20 | 无 | N11：已确认（e68a3ee）；相关检查：`control-plane:integration` |
| RW-000-08 | N12：控制台按日期解析 PostgreSQL 的 date 列，不受进程时区影响 | 代码已完成且有验证证据 | V-20261105-20 | 无 | N12：已确认（8aee413）；相关检查：`control-plane:integration` |
| RW-000-09 | Gateway 命令日志 snapshot 隔离恢复后，媒体与 CosyVoice 已完成命令不重放 | 代码已完成且有验证证据 | V-20261105-20 | 无 | 来源同 RW-000-01。相关检查：`test-runtime-gateway-state-restore-drill.py`。真实 Linux 演练与站外存储依赖 EP-06 |
| RW-000-10 | 部署 release manifest 生产器、Ed25519 验签与部署前 `RepoDigest` 核验 | 代码已完成且有验证证据 | V-20261105-20 | 无 | 来源同 RW-000-01。相关检查：`deploy:manifest:test`、`deploy:images:test`；签名私钥与 registry 依赖 EP-05、EP-10 |
| RW-000-11 | 策略红队、observer、输出探针活动音频与 4090 验收证据门禁的无 GPU 测试 | 代码已完成且有验证证据 | V-20261105-20 | 无 | 来源同 RW-000-01。相关检查：`policy:red-team`、`observer:runtime:test`、`output-probe:test`、`runtime:acceptance:test` |

## 待决策事项

| 编号 | 事项 | 决定 | 所选平台 | 决策日期 | 覆盖规格 |
| --- | --- | --- | --- | --- | --- |
| D1 | 首个目标直播平台 | 已决定 | 抖音 | 2026-11-05 | — |

抖音 Adapter 需另立规格；仓库中没有任何平台对接代码。RW-040-01 至 RW-040-04 的状态为代码未完成，不是外部前置条件；抖音开放平台账号、应用审核和 scope 属于 EP-02。

## 发布判定

1. 在任意开发机先运行 `npm run verify:local`。它执行可在本地完成的配置契约、策略红队、observer、探针、渠道、告警模拟、所有常驻 Node 服务入口解析、控制台类型检查、lint 和生产构建；它不连接 PostgreSQL、不启动 Docker，也不代表 Python 运行时、GPU 或平台验收。若本机已用同一解释器安装 `runtime/gateway/requirements.lock`，再运行 `npm run verify:local -- --with-gateway --python /absolute/path/to/python`。每次运行按 VERIFICATION_LOG 的格式登记后，才能作为 RW 行的证据。
2. 再运行生产配置检查：`npm run deploy:check -- --control /srv/shuzhiren/control.env --control-compose /srv/shuzhiren/control-plane-compose.env --runtime /srv/shuzhiren/runtime.env --gateway /srv/shuzhiren/gateway.env --channel-adapter /srv/shuzhiren/channel-adapter.env --alert-notifier /srv/shuzhiren/alert-notifier.env --require-output-probe --require-cosyvoice`。它拒绝没有 digest、带 tag 或跨服务复用的生产镜像引用，并验证受信 Ed25519 签名的部署 release manifest（RW-000-10、RW-034-01 至 RW-034-03；签名私钥与 registry 是 EP-05、EP-10）。镜像拉取后再运行 `npm run deploy:images:verify -- --manifest /srv/shuzhiren/release/deployment-release-manifest.json`。实时问答语音链路依赖 CosyVoice（RW-015-01，4090 上的结论见 RW-015-02 至 RW-015-05）；仅预制内容试播才可省略 `--require-cosyvoice`。
3. 主机、权重、账号和密钥就绪（EP-01 至 EP-08、EP-13、EP-14）后，执行内部试播、故障演练与独立输出探针验证；至少由水印、指纹、目的端回放或指标验证器（EP-09）产生一条 Ed25519 签名的输出观测，绑定同租户场次、节目命令、冻结段落、内容 SHA-256、受众和短时有效期（RW-000-04）。控制面只接受专用输出证明凭据，不能复用遥测凭据。4090 上的 RW-014-02 至 RW-014-05、RW-031-02 至 RW-031-04、RW-032-02、RW-032-03 在此阶段取得记录。
4. 只有满足"真实开播放行条件"一节的两项（EP-11 的 4 小时验收证据以 `npm run runtime:acceptance:verify` 校验，且全部 EP 行为已满足，包括 PostgreSQL 与 Gateway 命令日志的隔离恢复及不重放验证），才允许真实小规模开播。

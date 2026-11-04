# 系统迁移恢复交接

更新日期：2026-11-04（Asia/Shanghai）

## 当前检查点

- 仓库：`git@github.com:pengwenyi4061126-lgtm/shuzhiren.git`
- 分支：`master`
- 远端检查点：`a42b6c4 docs: add system migration resume handoff`
- 本地检查点：`master` 当前领先远端；恢复 SSH 凭据后用 `git log origin/master..HEAD --oneline` 核对并推送全部本地提交。
- 工作区状态：恢复前先以 `git status --short` 为准；不得通过重装依赖、解压运行时或清理工作区覆盖已有审计修复。
- 本文件不保存任何平台密钥、SSH 私钥、GPU 租机凭据、OIDC 凭据或数据库口令。

最近的运行可靠性与部署安全改进：

1. `078ecf7`：Gateway 在启动前校验上游 URL、CosyVoice 采样率、请求超时、命令缓存和三类动作槽位。
2. `e49601a`：部署预检拒绝重复或超出 `0..255` 的节目、备用、人工接管动作槽位。
3. `87a1922`：渠道 Webhook 对外使用稳定错误码，内部异常仅写服务日志。
4. `8514765`：runtime-observer 在首次遥测成功前明确报告 `lastSuccessfulCycleAt: null`。
5. `fc43a91`：渠道适配器与部署预检拒绝包含嵌入凭据或非 HTTP(S) 的 `CONTROL_PLANE_URL`；渠道和部署测试均已覆盖。
6. 本轮渠道桥治理：`providerReplyEndpoint` 在受控部署中必须是无嵌入凭据的 HTTPS 地址；渠道连接只有取得私网 `CHANNEL_EVIDENCE_VERIFIER_*` 签发、绑定连接配置哈希的 `evidence://`/`urn:` 证明后才能标记 `connected`。`061_channel_verification_remediation.sql` 将旧的自报证据迁移为失败关闭：不合格历史连接被禁用，验证人与租户有效成员关系、连接配置不可变性和验证审计同一事务均由数据库/服务层约束。

## 新系统恢复步骤

1. Windows 控制面开发机至少恢复 Git 和 Node.js 20+。Docker、临时 PostgreSQL 与 Python 3.11+ 只在完整 CI、Gateway 本地测试或 Linux 4090 运行机部署时需要；4090 运行机还需要 NVIDIA 驱动、NVIDIA Container Toolkit 和受许可的模型权重。
2. 配置能访问 GitHub 仓库的 SSH 私钥，再验证：

```powershell
ssh -T git@github.com
```

3. 克隆并恢复锁定的开源源码：

```powershell
git clone --recurse-submodules git@github.com:pengwenyi4061126-lgtm/shuzhiren.git E:\shuzizhibo
Set-Location E:\shuzizhibo
git checkout master
git pull --ff-only
git submodule update --init --recursive
npm ci
```

4. 不要从旧电脑复制 `.env`、SSH 私钥或模型权重到仓库。应从受控密钥管理和加密备份分别恢复生产配置。以 `config/*.example.env` 为模板，补齐真实值后运行：

```powershell
npm run deploy:check
```

5. 在 Windows 本地、Python 没有正确关联到 `python` 命令时，为 Gateway 测试显式设置解释器路径：

```powershell
$env:PYTHON = "C:\path\to\python.exe"
npm run runtime:gateway:config:test
```

6. 恢复完整开发验证时优先执行：

```powershell
npm run deploy:check:test
npm run channel-adapter:test
npm run channel:verification:check
npm run observer:runtime:test
npm run lint
npm run build
```

完整 CI 还需要 Docker、临时 PostgreSQL 与 Python Gateway 依赖，定义在 `.github/workflows/ci.yml`。

## 未完成边界

代码框架、控制面、治理、审计、运行时 Gateway、observer、输出探针、渠道桥、部署门禁和 CI 已持续实现并推送；但以下事项必须在真实受控环境完成，不能用本地 fixture 声称完成：

- 4090 租机上的 LiveTalking + MuseTalk + CosyVoice 端到端推流、显存、首帧、长时稳定性与故障演练。
- 平台账号、RTMP 推流地址/密钥、应用审核、目标平台 OAuth scope 与真实订单/结算数据。
- OIDC、TLS、私网 PostgreSQL、KMS/密钥管理、对象存储、告警 Webhook、录播归档与隔离恢复演练。
- 真实授权素材、声线/肖像授权、模型许可证和发布包验收证据。
- 4 小时单路验收和 `npm run runtime:acceptance:verify` 所需的真实验收证据。

## 代码审计结果与下一步

- 渠道适配器的出站控制面 URL 约束已在 `fc43a91` 完成；本轮把渠道验证改为私网 verifier 签发的配置绑定回执，移除运营者自报证据入口，并在连接状态变化和审计写入间使用同一数据库事务。互动、商品事件、渠道回复和开播预检都会拒绝过期、未来时间或不受控的验证。`npm run channel-adapter:test`、`npm run channel:verification:check`、`npm run deploy:check:test` 覆盖本机可运行部分；PostgreSQL 迁移实际执行仍由 CI 或 Linux 数据库环境负责。
- 已执行 `npm run verify:local`：本机配置契约、策略、权限、运行时可靠性、observer、输出探针、渠道、告警、类型检查、lint 与生产构建均通过。该命令不连接 PostgreSQL、不启动 Docker，也不能证明 Python Gateway、GPU 或平台验收。
- 逐项审计仍在进行，不能以没有 `TODO` 或本地门禁通过替代完成判定。已修复渠道出站 URL、运行时 Compose CI 渲染/LiveTalking 构建门禁，以及商品版本、节目修订、策略、模型发布和直播命令的数据库级不可变性；节目修订已补齐 `DRAFT` 全量编辑、送审冻结、审批人/时间证据、同事务生命周期审计和控制台工作区。CI 的 PostgreSQL 架构与控制面集成测试覆盖草稿改写、送审后拒绝改写及批准状态；本机不启动 PostgreSQL，因此这部分实际数据库执行仍由 CI 负责。
- 受控直播预览不再以控制台中的静态人像示意冒充运行时视频。Gateway 仅在配置独立 `PREVIEW_BROKER_URL` 与专属高熵 token 后，向私有 broker 请求每场次、短时、HTTPS WebRTC embed 授权；拒绝 RTMP、嵌入凭据、片段 URL、非 WebRTC 或过期/过长授权。控制面只允许管理员或运营员为其有范围权限的、已绑定会话场次请求预览，并把请求事实（不含授权 URL）写入审计链。真正预览服务、TLS 域名、WebRTC TURN/STUN 和 broker 实现仍是 4090/私网部署前置条件；未配置时 UI 显示明确状态，不伪造视频或影响 RTMP 主输出。
- 本轮补齐开播前节目修订闭环：`055_governed_show_program_revisions.sql` 建立候选修订请求、RLS、单场次活动请求唯一约束、创建人不得自审、候选依赖绑定封存与场次重绑触发器；服务/API/工作台克隆已批准版本，运营编辑和送审候选段落，独立审核人批准后在同一事务重绑场次、重建发布清单并要求重新预检。`ARMED`、`LIVE`、`DEGRADED` 场次一律拒绝创建或应用候选修订；这不是实时插播功能。`npm run program:revisions:check`、`db:verify` 与 PostgreSQL 控制面集成测试覆盖状态机、封存、独立审批、重绑和重新预检边界。
- 本轮已补齐渠道人工回复的仓库内闭环：`053_channel_reply_workflow.sql`、控制台草稿/送审/审批/拒绝/投递/失败重试界面与 API、来源渠道绑定、不可变证据快照、独立渠道 outbox、worker -> 私网 adapter -> provider bridge 回执，以及“只有 `sent` 才关闭互动”的约束。CI PostgreSQL 集成测试新增该闭环的角色、状态、outbox 和回执断言。本机不启动 PostgreSQL，因此最终迁移/集成执行仍由 CI 或 Linux 数据库环境负责。
- 本轮继续完成成员授权第一层：`054_governed_membership_authorization.sql`、管理员成员 API、首位管理员受审计引导脚本、数据库成员状态/RLS/最后管理员保护，以及所有人工 API 的服务端角色门禁。生产 OIDC 仅确认主体与租户，角色由有效数据库成员关系决定；旧 JWT 角色无法恢复已暂停/撤销成员或覆盖降权。`npm run membership:authz:check`、类型检查与 lint 已覆盖静态授权边界；CI PostgreSQL 集成测试覆盖伪造角色 claim、暂停成员和最后管理员约束。
- 本轮完成服务主体最小权限第一层：`056_service_actor_security.sql` 将 worker 审计主体收敛为只接受固定标识的 `SECURITY DEFINER` 函数，`service-principals.sql` 为 runtime worker、channel adapter 和 alert notifier 分别授予最小表权限；运行时 Compose 与模板要求三个独立数据库 URL，部署预检拒绝与控制面或彼此复用用户名。CI PostgreSQL 会在迁移后实际应用授权脚本并验证允许和禁止的权限；生产仍须由数据库管理员创建三个 `LOGIN NOINHERIT` 账号并保管各自密码。
- 本轮完成成员资源范围第一层：`057_membership_resource_scopes.sql` 为成员增加 `tenant/restricted` 访问模式以及频道、直播两类范围记录，数据库验证范围资源必须属于相同租户、管理员不能降为受限成员，范围记录本身受 RLS 保护。生产认证将有效 membership ID 和范围带入请求上下文；受限成员只能列出、读取和操作被直接分配的直播，或分配频道关联的直播，且不能创建全租户频道。节目单、节目修订、互动、渠道回复、遥测/SLO、发布清单、时间线和按场次策略读取均在服务边界重验范围。管理员可在 `/memberships` 修改范围并勾选频道/场次；范围变更进入审计链。`npm run membership:scopes:check`、`npm run verify:local` 和 CI PostgreSQL 控制面集成测试覆盖该模型。由于本机没有 PostgreSQL/Docker，本轮未在本机执行迁移或集成测试。
- 本轮完成成员资源范围第二层：受限成员不能读取或更改全租户的商品目录、授权素材、模型发布包、策略档案、额度或审计账本，也不能创建全租户场次；控制台同时隐藏这些治理页面及新建频道/场次入口。被授权场次的时间线改用 `runId` 限定的审计查询，不因阻断全租户审计而丢失取证能力。`npm run governance:tenant-scope:check` 覆盖服务与页面边界，CI PostgreSQL 集成测试增加受限成员对商品、素材、审计和场次创建均为 `403` 的断言。本机尚未执行该数据库集成测试。
- 本轮完成成员资源范围第三层：告警、事故单、录制证据、运行时 outbox 和场次经营汇总均按其关联 `live_run` 重新验证受限成员范围；受限成员的全局列表只返回已分配场次的记录，不能借助未授权的告警/事故/outbox ID 确认告警、创建或关闭事故、读取或人工投递命令。`npm run membership:scopes:check` 会阻止这些运行证据服务移除范围过滤，CI PostgreSQL 集成测试为两条不同场次分别构造运行事实并断言列表隔离与未授权操作 `404`。本机尚未执行该数据库集成测试。
- 对象内容验证不再接受调用方自报的 checksum：控制面经独立私网 `MEDIA_EVIDENCE_VERIFIER_*` 凭据向 verifier 请求对象键、不可变版本、SHA-256、字节数、媒体类型、验证时间和证据引用；登记及批准都会验证，数据库只允许带完整验证回执的待审核素材转为已批准，预检和运行时声线派发会拒绝缺少该回执的冻结素材。真实 S3/OSS/MinIO、版本化策略、验证器实现和存储凭据仍是受控部署前置条件，不能进入浏览器、控制面环境模板以外的密钥系统或仓库。
- 录制归档也不再只信任归档服务自报：`063_recording_content_verification.sql` 与 `RECORDING_EVIDENCE_VERIFIER_*` 要求独立私网 verifier 将租户、场次、对象键、不可变版本、SHA-256、字节数、时间窗和留存期绑定后签发受控证据。控制面仅登记新鲜且完全匹配的回执，数据库封存版本、证据引用和验证时间；缺少回执的历史登记保留供审计但不显示为已验证运营录制。实际 S3/OSS/MinIO 版本化、保留锁、归档身份、verifier 服务和恢复演练仍是外部部署前置条件。
- 本轮补齐实时插播的内容治理前置条件：`064_governed_runtime_program_scripts.sql` 新增 `show_revision_segments.runtime_script`，预制讲品/受控互动段落的脚本进入节目哈希、草稿保存、候选修订克隆与控制台编辑。数据库在节目批准和候选修订送审时拒绝缺失脚本的可运行段落；历史已批准节目可读取但不能伪装成可插播内容，必须新建候选修订补齐脚本。`npm run program:runtime-scripts:check`、`db:verify` 与 CI 架构验证覆盖列、长度约束、触发器和工作区边界。本机未启动 PostgreSQL，因此触发器的实际执行仍由 CI 临时数据库验证。
- 本轮完成受控节目插播/回退的回执闭环：`065_governed_program_transition_cursor.sql` 固化插播来源、目标和待确认 outbox 游标；`START`、`RECOVER` 与 `SCHEDULED_START` 会以当前或首个冻结段落建立基线，且仅在受绑定回执后写入 `live_program.activation_accepted`，使首次插播可精确回退。缺少冻结首段的定时场次会清除排期、告警并要求人工修复。`INSERT_PROGRAM` 与 `ROLLBACK_PROGRAM` 只能引用当前已批准修订的 UUID 冻结段落，拒绝待确认并发和已接受插播上的嵌套插播。控制台、人工 outbox 和 runtime worker 在 Gateway 回执前均不移动游标；回执必须绑定命令、会话、动作、段落和新鲜接受时间，才会原子更新游标并写入 `live_program.transition_accepted`。Gateway 只承诺 LiveTalking API 接受冻结脚本，不承诺平台端实际播放。worker 因触发器校验需只读 `show_revision_segments`，已作为最小权限显式授予并由权限测试锁定。CI PostgreSQL 集成测试覆盖定时基线、入队前游标不变、受绑定回执后插播、拒绝嵌套、回退恢复原冻结脚本及审计；本机未启动 PostgreSQL/Docker/Python，因此该集成与 Gateway 并发测试继续由 CI/Linux 环境执行。
- 本轮完成实际输出观测的仓库内证据链：`066_program_output_observations.sql` 只允许追加绑定租户、场次、运行时会话、已送达媒体 outbox、媒体命令、冻结段落、验证器来源、内容 SHA-256、媒体时间、置信度与受控证据引用的记录。控制面和数据库都拒绝未送达、会话/命令/段落不匹配或同一命令冲突重放的证明；成功记录进入 `live_program.output_observed` 哈希链审计并显示在场次时间线。`output-probe` 仅可从私网 `programEvidenceUrl` 读取完整验证器证明，`runtime-observer` 使用租户遥测 token 转发；没有验证器证明时不能由帧率、探针连通性或 Gateway `livetalking_api_accepted` 回执推断为已播出。`npm run verify:local` 于 2026-11-04 通过 58 项本机检查；PostgreSQL 集成中的接收、幂等、冲突、触发器不可改写与审计断言仍由 CI/Linux 临时数据库执行。
- 本轮还把上述证明纳入真实开播门禁：`config/runtime-acceptance.example.json` 与 `runtime:acceptance:verify` 升级至 schema v4，证据必须列出场次、已送达 outbox、`media_` 命令、冻结段落、验证器来源、`evidence://`/`urn:` 引用、内容 SHA-256、媒体时间、置信度和观测时间。模板、Gateway 回执、帧率、`/healthz` 或口头确认都不能绕过这一要求；`runtime:acceptance:test` 与完整本机 58 项校验均已通过。实际水印/指纹、目的端回放或平台指标验证器及其真实证据仍由受控运行环境提供。
- 本轮补齐运营可见性并纠正状态表述：运行监控首页会单独展示最新的“节目输出证据”，包括动作、冻结段落、验证器来源、置信度、观测时间和受控证据引用；没有独立验证器证明时明确显示未收到证明，不会以遥测、probe 连通性或 Gateway 回执替代。`FRAMEWORK_STATUS.md` 同步更正为 `START`、`RECOVER`、定时开始、插播和回退均已走冻结脚本与绑定 Gateway 回执，实际输出仍需要独立验证。`npm run verify:local` 于 2026-11-04 再次通过 58 项本机检查。
- 本轮修复输出证明信任边界：观测接口不再复用 `RUNTIME_TELEMETRY_TENANT_TOKENS`，而是只接受独立 `PROGRAM_OUTPUT_OBSERVATION_TENANT_TOKENS`。验证器返回的 Ed25519 证明包必须绑定 issuer、keyId、`tenantId:runId` audience、签发/到期时间和完整命令观测；控制面按 `PROGRAM_OUTPUT_VERIFIER_TRUST` 的每租户公钥验签，数据库只接受已送达命令后 15 分钟内、证明有效期最多 10 分钟的实时观测，并封存验证器元数据与签名 SHA-256。Probe/observer 的 bearer token 或健康指标不能伪造该记录。真实水印、指纹、目的端回放或平台指标验证器及其密钥轮换、mTLS/工作负载身份仍必须部署在受控外部环境。
- 本轮补齐 PostgreSQL 归档的数据库身份交付：`infra/postgres/backup-principal.sql` 明确要求 DBA 创建唯一的 `shuzhiren_backup LOGIN NOINHERIT BYPASSRLS` 登录，并拒绝超级用户、建库、复制、角色管理及任何继承成员关系。脚本只授予 public schema 的连接、表/序列读取和同一 schema owner 后续迁移对象的默认读取权；备份帐号与控制面/worker/adapter 账号严格分离。CI 的真实 PostgreSQL 服务主体集成会检查该角色的 flags、无成员关系、数据库/schema 访问、表只读和无更新权限。真实生产 `pg_dump`、隔离还原、站外复制和 RPO/RTO 演练仍须在受控 Linux/PostgreSQL 环境完成。
- 本轮继续审计迁移供应链完整性：迁移器现将每个 `infra/postgres/migrations/*.sql` 的 SHA-256 写入 `schema_migrations`，并在执行前拒绝缺失文件、未知数据库记录和已应用 SQL 内容漂移。既有数据库不会静默信任当前 checkout；缺少 checksum 时必须由迁移 schema owner 审阅文件后运行 `npm run db:migrate:checksum-baseline -- --approve-current-files` 一次性建立基线。CI 在真实 PostgreSQL 中篡改已应用 checksum、确认迁移器失败关闭，再模拟旧表的空 checksum 并确认未带审批参数的基线拒绝执行。`db:verify` 同时比对所有迁移哈希。该机制不能替代受控发布、不可变镜像或数据库隔离恢复演练，后三者仍是后续审计项。
- 本轮将生产 Compose 从发布机工作树构建改为只拉取十个独立的 `registry/repository@sha256:<64位>` 服务镜像：控制面与迁移器分离，后者使用仅含迁移脚本和 SQL 的预构建 target；运行时八个服务均由 `runtime.env` 提供 digest。`deploy:check` 会拒绝 tag、`latest`、缺少 digest 或跨服务复用 digest，Compose 静态门禁拒绝重新引入 `build:`。根目录 Docker build context 同时明确排除 `.env`、私密配置、模型、权重、录屏和缓存，避免把主机敏感文件交给 Docker daemon。CI 继续只验证可构建性；实际 registry push、镜像签名、SBOM、漏洞策略、provenance、受签名 release manifest、基础镜像/apt/Python 依赖锁定与发布主机 `RepoDigest` 核验仍是后续仓库/发布基础设施工作，不能宣称已经完成。
- 本轮补齐发布信封的仓库内验收：`DEPLOYMENT_RELEASE_MANIFEST` 现在必须是由 `DEPLOYMENT_RELEASE_MANIFEST_TRUST` 中 Ed25519 公钥验证的 JSON 信封，精确绑定 `RELEASE_REVISION`、控制面/迁移器/八个运行时镜像 digest、SBOM SHA-256、provenance SHA-256 及最多 30 天的有效窗口。部署预检拒绝未受信任 issuer/keyId、篡改签名、过期信封、提交或任一镜像不匹配。`config/deployment-release-manifest.example.json` 只描述格式，不能手填作为发布证据；签名私钥/KMS、生成与保存 SBOM/provenance、registry push/保留、漏洞扫描和部署后 Docker `RepoDigest` 实测仍需要受控发布系统和 Linux 主机完成。
- 本轮把 PostgreSQL 恢复演练从手工说明收紧为 `restore-postgres-drill.sh`：只接受已通过 archive/manifest 验证的 `.dump`，确认值必须绑定该 archive SHA-256，只能写入无 public 表、名称为 `shuzhiren_restore_*` 的隔离数据库；恢复后检查 migration 数量与 tenants/live_runs/audit_events/outbox_events/schema_migrations，并写入不可覆盖的 drill evidence。CI/Linux 以 PostgreSQL client stand-in 覆盖安全目标库拒绝和恢复命令契约；真实 `pg_restore`、DBA 创建/销毁隔离库、RPO/RTO 测量和 Gateway 已完成命令不重放仍须在受控 Linux/PostgreSQL/Gateway 环境演练。
- 平台无关的结算内核现已覆盖账单批次、来源 SHA-256、不可变账单行、订单级差异、独立私网导入 token 与证据化结案。仍待完成的仓库内工作是选定平台的 OAuth/Webhook/商品同步/账单 Adapter，以及该平台佣金、服务费、运费、优惠分摊、税费和跨期退款等结算语义映射。平台账号、应用审核和真实数据是外部前置条件，但 Adapter 实现本身不是。节目切换的仓库内观测关联已完成；仍需在目标平台部署水印/指纹、目的端回放或指标验证器，并以 GPU、平台账号、推流密钥和外部验收证据证明它可信，不能把 Gateway 接受回执误当作已播出证明。
- 渠道回复的 `providerReplyEndpoint` 只是受控标准化桥接契约；抖音、淘宝、视频号等实际 API、OAuth scope、应用审核和商家账号权限仍是外部平台前置条件。缺少回执时 worker 保持失败/可重试状态，不会把互动伪装成已处理。
- 恢复受控 SSH 凭据后推送全部本地提交；继续按上述代码审计项实现，再按部署就绪矩阵在受控环境收集外部证据，并以 `npm run runtime:acceptance:verify` 作为真实开播门禁。

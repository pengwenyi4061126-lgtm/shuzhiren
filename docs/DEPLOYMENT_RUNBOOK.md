# 4090 部署运行手册

部署前先阅读 [商业部署就绪矩阵](DEPLOYMENT_READINESS.md)。它将仓库已完成的代码能力与租机、账号、授权、密钥和平台集成等外部前置条件分开列示。

本手册只覆盖 P0 内部试播。没有完成肖像、声音、脚本、商品和音乐的书面授权，不得部署到真实直播间。

控制面五类私网服务 token 必须按“服务类型 + 租户”唯一分配；部署预检会拒绝跨服务或跨租户复用的 token。

发布 `runtime-observer-targets.json` 时，`--require-targets` 必须同时传入 `--control-env /srv/shuzhiren/control.env` 与 `--runtime-env /srv/shuzhiren/runtime.env`。发布脚本会验证每个场次的遥测 token 和独立 `programOutputToken` 分别来自同租户控制面映射，且 output-probe token 与运行时配置一致；两个控制面 token 不得复用。

若配置 `programEvidenceUrl`，验证器响应必须是 Ed25519 签名证明包。控制面仅信任 `PROGRAM_OUTPUT_VERIFIER_TRUST` 中该租户的 issuer/keyId/public key，且要求证明的 audience 精确为 `<tenantId>:<liveRunId>`、观测绑定已送达媒体命令和冻结段落、签发到期窗口不超过 10 分钟。Probe 与 observer 只转发该包，不能用帧率、连通性、Gateway 回执或未签名 JSON 代替。

```bash
npm run observer:targets:apply -- --candidate /srv/shuzhiren/observer-config/runtime-observer-targets.next.json --destination /srv/shuzhiren/observer-config/runtime-observer-targets.json --control-env /srv/shuzhiren/control.env --runtime-env /srv/shuzhiren/runtime.env --require-targets
```

## 1. 服务器基线

- Ubuntu 22.04 或兼容 Linux，单张 RTX 4090，建议至少 64 GB 内存和 1 TB NVMe。
- 已安装可用的 NVIDIA 驱动、Docker Engine、Docker Compose GPU 支持；`nvidia-smi` 必须可见 GPU。
- 仅对反向代理公开控制台；PostgreSQL、MinIO、Redis、Gateway 与 Worker 位于私网。
- 将模型、头像、录屏目录分别挂载到独立磁盘路径，不将权重、录屏或流密钥写入 Git。模型和头像目录以只读方式挂载；录屏目录必须可由 LiveTalking 容器 UID/GID `10002` 写入，例如 `sudo install -d -m 0700 -o 10002 -g 10002 /srv/shuzhiren/recordings`。

先在仓库根目录执行只读主机预检。它检查 GPU 名称/显存、Docker NVIDIA runtime 和用于模型、镜像、录屏的可用磁盘空间；不会安装软件、拉取镜像或启动容器。默认只检查当前仓库所在磁盘；生产环境必须把模型、Avatar 和录屏的实际宿主机目录一并传入。

```bash
bash scripts/check-runtime-host.sh
```

```bash
REQUIRED_STORAGE_PATHS='/srv/shuzhiren:/srv/shuzhiren/models:/srv/shuzhiren/avatars:/srv/shuzhiren/recordings:/srv/shuzhiren/runtime-gateway-state' \
GATEWAY_STATE_PATH=/srv/shuzhiren/runtime-gateway-state \
bash scripts/check-runtime-host.sh --require-gateway-state-permissions
```

默认要求单张 `RTX 4090`、至少 22 GiB 显存和 150 GiB 可用磁盘。租用方规格不同但已评估可用时，显式传入阈值，例如：

```bash
REQUIRED_GPU_NAME='RTX 4090D' MIN_FREE_GIB=250 bash scripts/check-runtime-host.sh
```

要额外证明容器能够看到 GPU，先独立核验并预拉一个带 `@sha256:` 摘要的 CUDA 镜像，再执行 `GPU_SMOKE_IMAGE=registry.example/cuda@sha256:... bash scripts/check-runtime-host.sh --container-smoke`。脚本不会因预检而下载不受控镜像。

## 2. 部署前配置

1. 使用 `git clone --recurse-submodules` 取得源码；既有工作目录执行 `git submodule update --init --recursive`。三套开源运行时必须保持为锁文件记录的提交，禁止在生产构建目录直接修改 vendor 源码。
2. 从 `config/control-plane.example.env`、`runtime.example.env`、`runtime-gateway.example.env`、`channel-adapter.example.env` 和 `alert-notifier.example.env` 复制五份服务配置到服务器私有目录；再从 `config/control-plane-compose.example.env` 复制控制面 Compose 插值配置。后者只引用私有 `control.env` 并定义控制台绑定地址/端口，不得放入 OIDC、数据库或服务 token。推流密钥不写入任何 env 文件，按 2.3 节准备密钥文件。`control-plane-compose.env` 的 `CONTROL_PLANE_IMAGE` 与 `CONTROL_PLANE_MIGRATOR_IMAGE`，以及 `runtime.env` 的八个 `*_IMAGE`，必须是发布系统生成并审核的 `registry/repository@sha256:<64位>` 引用；生产 Compose 没有 `build:`，不接受 tag、`latest`、本地 image ID 或发布机工作树构建。
   发布系统还必须在 `DEPLOYMENT_RELEASE_MANIFEST` 写入只读的 JSON 信封，格式见 `config/deployment-release-manifest.example.json`。该信封由受控发布签名身份使用 Ed25519 签名，精确绑定 `RELEASE_REVISION`、上述十个镜像引用、SBOM SHA-256、provenance SHA-256 和最多 30 天的签发有效期；发布机只保存 `DEPLOYMENT_RELEASE_MANIFEST_TRUST` 公钥，绝不保存签名私钥。`npm run deploy:check` 会在拉取镜像前拒绝缺失、过期、未受信任、签名无效、提交不匹配或镜像不匹配的清单。SBOM/provenance 原件、签名私钥/KMS、镜像 registry 保留策略与漏洞扫描仍由外部发布系统负责。

   仓库提供 `npm run deploy:manifest:create -- ...` 作为发布系统的确定性 manifest 生产器。它只接受十个 push 后的不可变 image digest、聚合 SBOM/provenance 文件、完整 40 位提交 SHA 和受控 Ed25519 私钥文件路径，计算两个 artifact 的 SHA-256，canonicalize 后签名，并拒绝覆盖既有输出或复用任一镜像 digest。私钥必须由短生命周期的受控 runner 挂载，不能写入 GitHub secret 文本、环境文件、镜像层、日志或部署机；使用不可导出 KMS/HSM 时，发布系统需提供等价 Ed25519 签名适配器，不能将 KMS 密钥导出后再使用该 CLI。示例仅说明输入契约，路径和内容都必须由发布基础设施提供：

```bash
npm run deploy:manifest:create -- \
  --images /srv/shuzhiren/release/images.json \
  --sbom /srv/shuzhiren/release/release-sbom.json \
  --provenance /srv/shuzhiren/release/release-provenance.json \
  --private-key /run/shuzhiren-release/ed25519-private.pem \
  --issuer release_issuer \
  --key-id 2026-11 \
  --revision 0123456789abcdef0123456789abcdef01234567 \
  --output /srv/shuzhiren/release/deployment-release-manifest.json
```

   `images.json` 必须只含 `CONTROL_PLANE_IMAGE`、`CONTROL_PLANE_MIGRATOR_IMAGE`、`RUNTIME_GATEWAY_IMAGE`、`RUNTIME_WORKER_IMAGE`、`RUNTIME_OBSERVER_IMAGE`、`OUTPUT_PROBE_IMAGE`、`CHANNEL_ADAPTER_IMAGE`、`ALERT_NOTIFIER_IMAGE`、`LIVETALKING_IMAGE` 和 `COSYVOICE_IMAGE` 十项；每项均为不同的 `registry/repository@sha256:<64位>`。此脚本不会构建、推送或扫描镜像，也不会替代部署后对 Docker `RepoDigest`、OCI revision label、SBOM/provenance artifact subject 的实测核验。

   部署主机拉取十个镜像后，先运行带真实环境文件的 `npm run deploy:check -- ...` 验证 manifest 签名、有效期、提交和 Compose image binding；再执行只读的本地镜像核验。它不会 pull、启动、停止或删除容器，任何一个 digest 或 OCI revision label 不一致都必须阻断升级：

```bash
npm run deploy:images:verify -- --manifest /srv/shuzhiren/release/deployment-release-manifest.json
```

   仓库的 `.github/workflows/release.yml` 是手动触发的十镜像发布工作流，只允许受保护 Git 引用运行。它在普通 Linux runner 上 build/push `linux/amd64`，用 Buildx 将每张镜像的 SBOM/provenance 附着到 OCI digest；随后把十项结果交给标记为 `self-hosted`、`linux`、`x64`、`shuzhiren-release` 的受信任 runner。两个 job 都必须通过 GitHub `release-production` environment 审批；签名 job 只读取 `RELEASE_SIGNING_KEY_PATH` 指向的已挂载私钥文件，生成 signed manifest 和两个 attestation index 后上传 release evidence artifact。工作流没有任何手动输入，registry、镜像命名空间和签名配置都来自该 environment 的变量，触发方法、变量格式和校验规则见 2.11 节。发布前必须由基础设施准备：

   - 受保护 branch/tag 与 `release-production` environment 审批；PR 或非受保护引用不得获得 registry push 或签名权限。
   - 支持 OCI referrer 的 registry、`REGISTRY_USERNAME`/`REGISTRY_PASSWORD`、十个独立 repository 和保留/扫描策略。registry 主机名必须列在 `.github/release-registry-allowlist.json` 中。
   - 受信任的 self-hosted signing runner，私钥仅以受限短生命周期文件挂载；不可导出 KMS/HSM 需要提供等价签名适配器，不能把密钥导出成 GitHub secret。
   - CosyVoice 镜像的 Miniforge 安装脚本 URL 与 SHA-256 取自仓库中经审核的 `runtime/cosyvoice/miniforge.json`，发布时不能另行指定；更换版本须提交 PR 修改该文件。CosyVoice Dockerfile 会拒绝空值、非 HTTPS 或校验和不匹配；模型权重只在部署时通过 `COSYVOICE_MODEL_PATH` 只读挂载，永不进入 release image。

   workflow artifact 不是自动部署。值班人员必须将 `deployment-release-manifest.json`、`release-sbom-index.json`、`release-provenance-index.json` 和 `images.json` 一起放入同一个受控目录，例如 `/srv/shuzhiren/release/`；`deploy:check` 会重算两份 index 的 SHA-256，并要求 artifact 类型、完整提交和十个 image digest 都与签名 manifest 精确一致。任一文件缺失、替换或与 manifest 不一致都必须阻断部署。

   两份 index 的 `schemaVersion` 为 `2`。发布工作流的 assemble 步骤（`scripts/assemble-release-evidence.mjs`）以 `REGISTRY_USERNAME`/`REGISTRY_PASSWORD` 只读访问已校验的 `registry` 输入，按 digest 从 registry 读取每张镜像的 attestation，而不是声明"已附着"：对每个镜像 index，取唯一的 `linux/amd64` 镜像 manifest、引用它的唯一 attestation manifest，以及其中唯一的 SPDX SBOM 层和唯一的 SLSA provenance 层，并核对 in-toto statement 的 `subject` 含该 `linux/amd64` digest。index 的 `attestations.<镜像键>` 记录 `platform`、`platformManifestDigest`、`attestationManifestDigest`、`predicateType` 和该层的 `digest`；`deploy:check` 拒绝缺少任一镜像摘要的 index，`schemaVersion` 1 的旧 index 也会被拒绝。需要复核时，以 `attestationManifestDigest` 从 registry 取回 attestation manifest，确认三件事：镜像 index 中该 digest 的条目带 `vnd.docker.reference.type=attestation-manifest` 且 `vnd.docker.reference.digest` 等于 `platformManifestDigest`；manifest 的 `layers` 中 `in-toto.io/predicate-type` 等于 `predicateType` 的层，其 digest 等于记录的 `digest`；取回该层（blob）后 statement 的 `subject` 含 `platformManifestDigest`。例如：

```bash
docker buildx imagetools inspect --raw <registry>/<namespace>/<repository>@<image index digest>
docker buildx imagetools inspect --raw <registry>/<namespace>/<repository>@<attestationManifestDigest>
```

   这些摘要和 registry 中的 attestation 同样必须保留供审计。完成签名/配置检查和 Docker `RepoDigest` 核验后才能运行 Compose。artifact 上传、registry attestation 和签名成功不代替漏洞策略、许可证审查或部署后真实 GPU/平台验收。
3. 控制面使用 `NODE_ENV=production`、`CONTROL_PLANE_DEMO_MODE=false`，不设置 `CONTROL_PLANE_DEV_HEADER_IDENTITY`，并配置 OIDC issuer、audience、JWKS 和 PostgreSQL；令牌 `exp` 要求与可选的 `OIDC_ALLOWED_ALGORITHMS`、`OIDC_EXPECTED_TYP` 见 2.4 节。`RELEASE_REVISION` 必须填写实际部署的 7 至 40 位 Git 提交；健康接口会返回该值，用于把运行实例、审计证据和发布记录对应到不可变源码。`DATABASE_QUERY_TIMEOUT_MS` 默认 5000，限制数据库连接与查询等待，不能配置为 100 ms 以下或 60 秒以上；它让容器就绪检查在私网数据库异常时及时失败。浏览器同源调用可以使用 `OIDC_ACCESS_TOKEN_COOKIE`（默认 `shuzhiren_access_token`）承载短期 access token；该 cookie 必须由登录网关以 `HttpOnly`、`Secure`、`SameSite=Lax` 或更严格的属性签发，令牌本身不得写入前端存储。生产 Proxy 会在进入 API handler 前校验令牌租户和角色，包含按动作区分的生命周期权限；无权令牌必须收到 `403 insufficient_permission`，不能依赖前端隐藏按钮。Cookie 身份的写操作还必须携带同源或 `OIDC_ALLOWED_ORIGINS` 白名单中的 `Origin`，否则返回 `403 csrf_origin_rejected`；部署在反向代理后时应显式填写公开控制台域名白名单。
4. `control.env`、`runtime.env` 与 `gateway.env` 的 `RUNTIME_SHARED_TOKEN` 必须完全一致，且两个前者必须设置 `RUNTIME_GATEWAY_DEMO_MODE=false`；这是 Gateway 对控制面人工操作和 Worker durable outbox 投递的后端认证凭据，绝不能传给浏览器、渠道 Adapter、租户接入、runtime-observer 或其他服务；observer 只持有只读的 `RUNTIME_GATEWAY_READ_TOKEN`，分发与轮换见 2.10 节。部署预检、Worker 和 Gateway 启动都会拒绝短于 32 个字符或包含空白的共享令牌。所有其余私网服务 token 和签名密钥必须至少 32 个字符、不含空白，且不能跨服务或租户复用；`OUTPUT_PROBE_SHARED_TOKEN` 必须独立。`RUNTIME_GATEWAY_REQUEST_TIMEOUT_MS` 也必须在 `control.env` 与 `runtime.env` 中一致，范围为 100 至 60000；它会让人工会话验证、媒体接管、语音播报和后台 outbox 在 Gateway/网络故障时及时失败并进入既有重试或告警路径，而非无限等待。Node 服务与 Gateway 镜像均以非 root 用户运行，不能依靠容器内 root 权限写入配置或状态。`gateway.env` 中的 `RUNTIME_GATEWAY_STATE_PATH` 必须是主机上的绝对、加密、访问受限且纳入备份的目录；Gateway 以固定 UID `10001` 写入命令日志。启用下方计划备份时，先以运行 Docker 的部署账号创建 setgid 目录，例如 `sudo install -d -m 2750 -o 10001 -g shuzhiren-backup /srv/shuzhiren/runtime-gateway-state`，再启动 Compose。setgid 目录会让 SQLite 日志继承 `shuzhiren-backup` 组，Gateway 以 owner/group 可读、其他用户无权的权限创建日志，因此备份服务可读取它而不需 root 权限。它会挂载为 Gateway 的命令日志目录；不能改用匿名 Docker 卷或临时容器文件系统，否则 Gateway 重启后无法判定已完成命令，可能重复执行媒体动作。Gateway 启动还会验证必需命令日志可写，目录权限错误会直接使容器启动失败。Gateway 宿主机端口由 `RUNTIME_GATEWAY_HOST_BIND` 控制，模板默认 `127.0.0.1`；不得使用 `0.0.0.0` 或 IPv6 通配地址。控制台与 Gateway 分机部署时，只可填写经网络审批的私网地址，并在安全组/防火墙中仅放行控制台来源，不能把 Gateway 直接暴露到公网。控制面使用 `RUNTIME_TELEMETRY_TENANT_TOKENS`、`RUNTIME_RECORDING_TENANT_TOKENS`、`PIM_INGEST_TENANT_TOKENS`、`CHANNEL_INGEST_TENANT_TOKENS` 和 `CHANNEL_COMMERCE_TENANT_TOKENS` 五个 JSON 租户密钥映射；每个租户必须有不同的高熵 secret，且任一 token 不得跨服务或跨租户复用，运行时或渠道 Adapter 只能用自己租户的 token 上报。录制凭据只能由归档进程在完成受批准对象存储复制与 SHA-256 校验后使用，不能复用遥测、浏览器、前端 SDK 或平台网页的 token；录制登记只接受对象键，不接受 URL 或本地文件路径。PIM 凭据仅供完成来源、时间窗和签名校验的服务器端同步器使用，事实仍需审核。评论和交易凭据必须分离，不能共用。交易 Adapter 完成平台签名、时间戳、重放和限流验证后，只能提交不含买家 PII 的曝光、点击、加购、支付和退款事实；支付/退款会写入 append-only 审计。每次启动 `docker-compose.runtime.yml` 都要加载 `deploy:check` 检查无误的 `runtime.env` 与 `gateway.env`；Compose 会在解析整个服务文件时读取两者，不能只传当前 profile 的环境文件。`RUNTIME_OBSERVER_TARGETS_DIR` 必须是生产主机上仅运行时部署账号可读写的绝对目录，目录内创建 `runtime-observer-targets.json`。其数组每项必须包含 `tenantId`、`runId`、`sessionId`、同租户的 `telemetryToken` 与 `outputProbeUrl`，其 token 必须与控制面该租户的遥测密钥对应，不能复用为其他租户或浏览器 token。使用仓库内 `output-probe` 时，每项还应填写 `outputProbeToken`，并与 `OUTPUT_PROBE_SHARED_TOKEN` 匹配；该 token 只用于私网 observer 到探针的读取授权，不能作为控制面或渠道凭据。部署编排把候选清单写入同目录的 `runtime-observer-targets.next.json` 后，执行 `npm run observer:targets:apply -- --candidate /srv/shuzhiren/observer-config/runtime-observer-targets.next.json --destination /srv/shuzhiren/observer-config/runtime-observer-targets.json --control-env /srv/shuzhiren/control.env --runtime-env /srv/shuzhiren/runtime.env --require-targets`。该命令会校验每个场次遥测 token 等于控制面同租户的 `RUNTIME_TELEMETRY_TENANT_TOKENS`，并校验每个探针令牌等于运行时的 `OUTPUT_PROBE_SHARED_TOKEN`，拒绝跨目录替换、收紧为 owner-only 权限后原子替换；observer 自动重载，配置缺失或格式错误时 `/healthz` 会失败。配置 `alert-notifier.example.env` 后，使用 `docker compose --profile alert-notifier --env-file /srv/shuzhiren/runtime.env --env-file /srv/shuzhiren/gateway.env --env-file /srv/shuzhiren/alert-notifier.env -f infra/compose/docker-compose.runtime.yml up --build` 启动私网告警通知器；每个目标必须使用 HTTPS，按租户配置独立 HMAC 密钥。通知器只通知打开时的告警，持久化投递状态可重试和重领；其 `/healthz` 只有在数据库可查且最近一个轮询窗口成功完成时才返回成功。接收方必须按 `x-shuzhiren-event-id` 去重，不能将机器人成功响应理解为事故已恢复。

5. 录制归档进程只能在对象已复制到受批准的站外存储后，调用 `POST /api/v1/runtime/recordings`。请求必须使用该租户的 `RUNTIME_RECORDING_TENANT_TOKENS`，提交 `tenantId`、`runId`、对象键、64 位十六进制校验和、字节数、时长与稳定的 `idempotencyKey`。控制面会使用独立的 `RECORDING_EVIDENCE_VERIFIER_*` 私网凭据请求 verifier；verifier 必须绑定并回显租户、场次、对象键、不可变对象版本、实际 SHA-256、字节数、时间窗与留存期，再签发短时 `evidence://`/`urn:` 回执。控制面拒绝 verifier 不可用、内容不匹配、过期回执或空对象；同一幂等键仅可重试完全相同的证据。接口会拒绝 URL、绝对路径、反斜杠和 `..` 路径段；同一租户对象键不可重复。登记记录及 verifier 回执均为 append-only 证据，不会上传、删除或生成对象存储预签名下载链接。已存在但缺少 verifier 回执的历史登记会保留在数据库审计中，但不会出现在运营录制列表；必须重新完成对象存储验证后再登记新的受控证据。

商品事实接入：PIM/ERP 只能通过私网 `POST /api/v1/integrations/product-facts` 使用独立的 `PIM_INGEST_TENANT_TOKENS` 提交无买家 PII 的商品事实。每个 `eventId` 只对应同一载荷；重试返回同一草稿，不同载荷会被拒绝。接入服务可更新商品名称并建立新版本，但不得自行批准价格、库存、卖点或 FAQ，审核员必须在控制台复核。

经营成本口径：商品事实版本可选登记审核过的 `unitCostCent`。渠道支付事实必须带实际支付件数 `quantity`（未提供时适配器按单件处理）；场次经营页以冻结 SKU 的单位成本乘支付件数，再从退款后净回款中扣除，得到退款后贡献毛利。成本未登记时不得展示零成本或估算毛利。该指标不替代订单级结算、仓配、投流、人力、平台佣金或税费对账，正式财务结算仍需接入渠道与 ERP 的对账系统。

策略包治理：上线前由运营登记策略包名称、版本、自定义关键词规则、验收证据引用和验收摘要；审核角色通过控制台批准。没有已批准策略包时，生产数据库拒绝创建新的直播场次。创建后系统将策略包绑定到场次修订，后续即使有更新版本也不改变已排期场次的互动、草稿和播报判定。审核角色撤销已批准版本时必须写明原因；被绑定场次的预检、自动互动和草稿会 fail-closed，值班人员必须重新建立并审批场次所需的新版本。策略包规则应只描述可审查的业务处置，不得写入密钥、买家 PII 或原始对话样本。
6. 生产单卡保持 `LIVE_MAX_CONCURRENT_AVATARS=1`、`LIVE_ALLOW_LLM_FREEFORM=false`、高风险问题人工接管和 AI 标识开启。
7. 镜像源码以 `runtime/open-source.lock.json`（`schemaVersion` 2）和父仓库记录的子模块提交为准，运行时 env 不再设置 `LIVETALKING_REF`、`MUSETALK_REF`、`COSYVOICE_REF`；旧 env 中残留时 `npm run deploy:check` 只输出 WARN，可以删除。`deploy:check` 对锁文件每个条目（含嵌套的 `vendor/CosyVoice/third_party/Matcha-TTS`）核对真实 Git HEAD、父仓库 gitlink 与干净工作树，嵌套子模块未初始化时报"无法读取 Git 信息"。模型权重的许可证、人物和声音授权另行登记，见第 7 节。
8. 在 Gateway 环境中配置 `PROGRAM_AUDIOTYPE`、`FALLBACK_AUDIOTYPE` 与 `HUMAN_HANDOFF_AUDIOTYPE`，并在 LiveTalking 的已批准 Avatar 包中逐项验证动作含义；三者必须是不同的 `0` 至 `255` 整数，不能将默认索引当作真实人接管或备用节目。Gateway 启动时还会拒绝非 HTTP(S) 的内部服务地址、含嵌入式凭据的 URL、8-192 kHz 以外的 CosyVoice 采样率、超过 120 秒的下游请求超时，以及过短或无界的命令幂等缓存配置。
9. LiveTalking 建立会话后，在“直播场次”中绑定返回的 `sessionid`；无论创建时填写还是后续绑定，都会先由 Gateway 查询会话存活状态，不能只填写任意字符串。当前 Compose 使用 RTMP 单会话模式，LiveTalking 启动时创建固定会话 ID `0`，因此应绑定 `0`。会话只可在武装前或预检中更换，场次进入 `ARMED` 后被锁定，避免直播中的命令被重定向到其他数字人。同一会话只允许被一个 `PREFLIGHT`、`ARMED`、`LIVE` 或 `DEGRADED` 场次占用；草稿和审核中的未来排期可以预先引用它，结束或归档后会自动释放占用。没有绑定运行时会话的场次不得接受媒体控制命令。启用锁定的 `Fun-CosyVoice3-0.5B-2512` 时，`COSYVOICE_SAMPLE_RATE` 必须保持 `24000`；其 FastAPI 服务返回无文件头的 16-bit PCM，Gateway 依此封装 WAV。更换模型必须同步变更此值并在发布包验收中留存试听结果。`COSYVOICE_MODEL_PATH` 是宿主机目录，`COSYVOICE_MODEL_DIR` 则必须是容器内绝对路径；当前 Compose 固定挂载到 `/opt/CosyVoice/CosyVoice/pretrained_models`，模板已指向该目录下的 `Fun-CosyVoice3-0.5B-2512`。
10. runtime worker 会按 `SCHEDULER_POLL_MS` 独立轮询已到排期时间的 `ARMED` 场次。每个场次先在独立数据库事务中创建唯一的 `start_program` outbox 并绑定到场次；手动 `START` 和 `RECOVER` 同样先保留在 `ARMED` 或 `DEGRADED`，只有 Gateway 确认该命令成功后，worker（或场控的单条恢复投递）才将场次切换为 `LIVE`。待确认的 `START` 会以 `ARMED + scheduled_start_event_id` 保留一个并发名额，额度行锁会使手动与定时开播串行评估，避免两个请求同时穿透上限。场控发现排期不应继续时，可将尚未投递或失败的待启动 outbox 取消并把场次退回 `PREFLIGHT`，这会释放并发占用；`delivering` 状态的事件不可取消，必须等待当前 Gateway 调用完成。`END` 也不会在点击时伪造已结束：场次保留当前状态并锁定唯一停止 outbox，只有 Gateway 确认 `stop_program` 后才切为 `ENDED`。恢复还必须先通过 60 秒内的新鲜运行时健康校验。失败事件会保留为 `failed` 供重试，不会伪造“直播中”或“已结束”，也不会重复创建定时开播命令。每一轮最多领取 `SCHEDULER_BATCH_SIZE` 个，它不会自动武装场次，也不会跳过预检。若管理员配置了并发场次或当月直播分钟权益，手动和定时激活都会在进入 Gateway 前检查；`LIVE`、`DEGRADED` 和待确认启动都计入并发，降级是运行质量状态，不会释放通道、场次或时长资源。定时场次超额时保持 `ARMED`、记录告警与审计，不会无声开播。只有配置了当月分钟权益的租户才会由 worker 按 `USAGE_METER_POLL_MS` 为 `LIVE` 和 `DEGRADED` 场次写入幂等分钟桶；该账本用于额度门禁，正式结算仍需对接合同、账单与支付系统。
11. 渠道连接只能使用服务端注册的 Adapter 和 `kms://` 或 `secret://` 密钥引用。每次标记为 `connected`、`degraded` 或 `disabled` 都必须记录验证报告/工单引用；开播预检拒绝超过 24 小时的渠道验证。`generic-rtmp` 只证明受控推流通道，不代表已经完成平台 OAuth、评论、商品挂车或 Webhook 集成。
12. `audit_events` 在数据库层是 append-only：运行时账号不能更新或删除审计记录。哈希链头 `audit_chain_heads` 只由封链触发器维护，任何角色都不能直接改写（见 2.2 节迁移 074）。用户注销、保留期或隐私请求必须走独立的合规数据处理流程，不能用普通业务 SQL 改写历史事件。
13. 租户业务表均启用并强制 PostgreSQL RLS。控制面应用账号不拥有任何表（D4，见 2.9 节），必须在每个事务内设置 `app.tenant_id`；禁止为应用账号授予 `BYPASSRLS`。runtime worker 只能无范围读取 `tenants.id`，随后对每个租户分别设置该上下文并领取/回写任务，不能对业务表执行无租户范围的扫描。

> 更正：本手册中任何遗留的 `docker compose ... up --build` 写法均不适用于当前生产编排。生产 Compose 只拉取 `*_IMAGE` 指定的 digest；告警通知器应执行 `docker compose --profile alert-notifier --env-file /srv/shuzhiren/runtime.env --env-file /srv/shuzhiren/gateway.env --env-file /srv/shuzhiren/alert-notifier.env -f infra/compose/docker-compose.runtime.yml up`，不得在发布机重新构建。

### 2.1 迁移文件完整性

`schema_migrations` 会保存每个已执行 SQL 文件的 SHA-256。正常的新库只需以迁移 owner（`shuzhiren_migration_owner`，见 2.9 节）执行 `npm run db:migrate`；迁移器会在执行前拒绝仓库中缺失的历史文件、数据库记录之外的文件，以及任何已执行 SQL 内容的哈希漂移。

早于该机制的既有数据库首次升级时，迁移器会因缺少 checksum 而失败关闭。先审阅当前 checkout 的全部 `infra/postgres/migrations/*.sql` 和数据库已执行列表，再由迁移 schema owner 显式建立一次基线：

```bash
npm run db:migrate:checksum-baseline
npm run db:migrate:checksum-baseline -- --approve-current-files
npm run db:migrate
```

第一条命令只列出未校验的历史记录并以非零状态退出；第二条命令才会将已审核的当前文件哈希写入数据库。它绝不接受内容已漂移的记录，也不能用于跳过缺失迁移或把未知 SQL 标记为可信。不得让控制面运行时、worker、渠道 Adapter 或日常人工账号执行该基线命令。

**乱序拒绝。** 若仓库中某个迁移文件未记录在 `schema_migrations`，而其文件名按字典序排在已记录的最新文件名之前，迁移器会在应用任何迁移之前以非零状态退出，错误信息 `out-of-order migrations not recorded in schema_migrations: ...` 列出这些文件（`apps/console/scripts/migration-integrity.mjs` 的 `findOutOfOrderMigrations`）。编号空缺不算缺失迁移：当前目录没有 050、068、071–073，这不会触发该检查。遇到乱序时须先查明该文件的来源，不得手工向 `schema_migrations` 插入记录来绕过。

**锁等待与语句超时。** 迁移器在每个迁移事务开始后，以事务级设置写入 `lock_timeout` 与 `statement_timeout`，只作用于该迁移；迁移文件自身的 `SET LOCAL` 可以覆盖它们。两个值来自迁移器进程的环境变量，Compose 迁移 profile 从 `MIGRATION_OWNER_ENV_FILE` 指向的迁移账号 env 文件读取（不加载 `control.env`，见 2.9 节）：

| 变量 | 默认值 | 允许范围 |
| --- | --- | --- |
| `MIGRATION_LOCK_TIMEOUT_MS` | `10000` | 1 至 86400000 的整数（毫秒） |
| `MIGRATION_STATEMENT_TIMEOUT_MS` | `1800000` | 1 至 86400000 的整数（毫秒） |

值非法时迁移器在连接数据库之前退出，不会占用迁移 advisory lock。某条语句因超时被取消时，迁移器回滚该迁移事务，不在 `schema_migrations` 记录它，也不执行后续迁移，随后释放 advisory lock 并以非零状态退出；错误信息写明文件名和 `(lock_timeout)` 或 `(statement_timeout)`。锁等待超时通常表示应用仍持有相关表的锁，应在业务低峰重试；只有确认迁移本身需要更长时间时，才为该次运行临时调大对应变量。

### 2.2 迁移 074–081 的部署影响

以下迁移随 `npm run db:migrate` 按顺序执行，均不需要额外参数：

- **074 审计链头写保护**：`audit_chain_heads` 只能由插入审计事件时的封链触发器 `seal_audit_event()`（以函数属主身份运行）维护。任何角色（包括表属主）直接对它执行 INSERT、UPDATE、DELETE 或 TRUNCATE 都会被触发器以 `insufficient_privilege` 拒绝。`infra/postgres/service-principals.sql` 不再授予服务账号该表的任何权限；该脚本开头会撤销三个服务账号在 public 表上的全部权限，因此升级后由迁移 owner 按 2.9 节重新执行一次授权脚本，即可清除旧版本授予的链头权限。`verify_audit_chain()` 改为空值安全比较：已入链记录的 `previous_hash` 或 `event_hash` 为空时，校验现在判为失败，而此前会被判为通过。升级后若某租户的链校验失败，应按审计事件处理。
- **075 已批准行的插入证据**：直接以 `approved` 状态插入 `product_versions`、`show_revisions`、`model_releases`、`policy_profiles` 时必须带 `approved_by` 与 `approved_at`；`media_assets` 还必须带 `verified_object_version`、`verified_bytes`、`verified_content_type`、`verification_evidence_ref` 和 `verified_at`。缺任一列时插入以 `check_violation` 失败。已有行不受影响。
- **076 `membership_admin_guards`**：新增按租户一行的保护表（启用并强制 RLS）。移除一个活跃管理员时，触发器先写该租户的保护行再检查是否仍有其他活跃管理员，因此同一租户并发移除最后两个管理员时，READ COMMITTED 下后一个事务会等待前一个提交后失败（`cannot remove the last active tenant admin`），REPEATABLE READ 或 SERIALIZABLE 下后一个事务以 `40001` 失败。应用账号不需要该表的权限。
- **077 媒体指令顺序**：插入 `media.dispatch` 类型的 outbox 事件时会锁定对应直播场次行，并以当时的时钟写入 `created_at`。
- **078 复合租户外键**：对每个两端都有 `tenant_id` 的租户表外键（引用 `tenants`、`users` 的除外），增加 `(tenant_id, <列>)` 的复合外键，并在被引用表上补充所需的 `(tenant_id, <列>)` 唯一约束；原单列外键及其 ON DELETE 行为保留。添加外键时会不经 RLS 校验全部现有行：已有跨租户引用时，迁移以 `23503` 失败并写明表和约束名，整个迁移回滚。此后修改被引用行的 `tenant_id` 会被拒绝。该迁移的执行时间随数据量增长，并受上面两个超时变量约束；大库升级前应先在演练环境用生产副本执行一次。
- **079 数据修复守卫**：新增 `migration_unfiltered_count`、`migration_assert_row_count`、`migration_fix_update`、`migration_fix_delete` 与 `migration_fix_insert` 五个函数，本身不改动任何已有数据。这些函数先在临时解除 FORCE RLS、关闭 `row_security` 的情况下统计目标行数，再在正常 RLS 下执行数据修复语句；两个数字不同时以 `data-fix row count mismatch on <表>: expected N rows, affected M` 报错，迁移回滚且不写入 `schema_migrations`。同时，迁移器在应用任何文件之前，拒绝编号为 079 及以后、含有未经这些函数的顶层 `UPDATE`、`DELETE`、`MERGE`、`INSERT ... SELECT` 或修改数据的 `WITH`（包括 `DO` 块内）的待执行迁移，报出文件名与行号，不应用任何文件。已应用的 048 与 061 不变。运维上不需要额外操作；收到这两类错误时不要手工改写迁移记录，应交回开发修正迁移文件。
- **080 `outbox_events.outcome_uncertain_at`**：新增一个可空的时间列，记录 Runtime Gateway 对该事件答复 `command_outcome_uncertain` 的时间；已有行为空，不加触发器；worker 现有的表级 SELECT、UPDATE 授权包含这一列，不需要新的授权。设置了该列的事件不会再被 worker 自动领取（处于 `delivering` 的除外），处理方法见 2.7 节。
- **081 `sync_control_plane_actor` 不再改写显示名（L8）**：`users` 由所有租户共享。054 版本的函数在每次请求时用请求方提供的名字覆盖 `users.display_name`，任一租户的请求都会改掉同一个人在其他租户中显示的名字。081 改为 `ON CONFLICT DO NOTHING` 后再读回：已有的 `external_subject` 保留原来的 id 和显示名；第一次出现的 subject 用去掉首尾空白的请求名字，名字为空时用 subject 本身；另一个事务正在插入同一 subject 而本事务看不到该行时（REPEATABLE READ 或 SERIALIZABLE），函数以 `40001` 失败，调用方重试即可。迁移只替换函数，不改动已有数据，已经被改写的显示名不会恢复。同一提交中 `npm run membership:bootstrap-admin` 也不再改写已有 subject 的显示名（`--display-name` 只用于第一次出现的 subject），并按目标租户统计活跃管理员，因此以超级用户或 BYPASSRLS 的迁移 owner 运行时，可以为新租户创建第一个管理员。不需要新的环境变量或授权。

### 2.3 推流密钥文件

推流密钥只存放在 `runtime.env` 的 `STREAM_KEY_FILE` 所指的宿主机文件中，不再通过 `STREAM_KEY` 环境变量传递。`runtime.env`、`gateway.env`、`channel-adapter.env` 与 `alert-notifier.env` 中任何一个定义了非空的 `STREAM_KEY`，`npm run deploy:check` 都会报错。`STREAM_RTMP_URL` 只写不含密钥的推流基址；LiveTalking 在容器内存中把文件里的密钥拼接为 `${STREAM_RTMP_URL}/<密钥>`。

以运行 `npm run deploy:check` 的部署账号执行以下命令。`read -rs` 不回显输入，密钥只在子 shell 中存在，不进入命令行参数和 shell 历史：

```bash
sudo install -d -m 0700 -o "$USER" /srv/shuzhiren/secrets
(umask 077; read -rs key; printf '%s\n' "$key" > /srv/shuzhiren/secrets/stream-key)
sudo chown "$USER:10002" /srv/shuzhiren/secrets/stream-key
chmod 0440 /srv/shuzhiren/secrets/stream-key
```

文件属主为部署账号，属组为 LiveTalking 容器的 GID `10002`，权限 `0440`：部署账号与容器都能读，任何人都不能写，其他用户不能读。然后在 `runtime.env` 中写入该文件的绝对路径，例如 `STREAM_KEY_FILE=/srv/shuzhiren/secrets/stream-key`。运行时 Compose 将它作为 `stream_key` secret 只读挂载到容器内 `/run/secrets/stream-key`。

`npm run deploy:check`（`scripts/check-deployment-config.mjs`）对该文件的检查：

- `runtime.env` 必须设置 `STREAM_KEY_FILE`，且必须是绝对路径。`--allow-placeholders` 模式只检查这两点。
- 不带 `--allow-placeholders` 时，脚本以部署账号身份读取文件：文件不存在、不是普通文件（符号链接同样被拒绝）或不可读时报错。
- 去掉末尾一个换行（LF 或 CRLF）后，内容必须是 1 至 1024 个可打印 ASCII 字符，不含空白、双引号和反斜杠。
- 在 Linux 上，同组或其他用户可写、其他用户可读时报错。脚本不检查属主和属组，属组 `10002` 是容器读取文件所需的条件。
- `STREAM_RTMP_URL` 必须是 `rtmp://` 或 `rtmps://` 地址，不含用户名或口令、查询串和片段，也不以 `/` 结尾，并且必须与 `gateway.env` 中的值一致。
- 报错信息只说明问题类型，不输出文件内容。

LiveTalking 镜像的启动器会在 LiveTalking 启动前再次校验该文件；文件缺失、不可读、为空或格式非法时，容器以退出码 `78` 结束，不监听端口也不推流。密钥只在 LiveTalking 启动时读取一次，更换密钥后需按上述步骤重写文件并重启 `livetalking` 服务才会生效。

### 2.4 OIDC 令牌与开发身份请求头

- 控制面只接受带数值型、未过期 `exp` 声明的 OIDC 访问令牌，校验不留时钟容差；缺少 `exp` 的令牌会被拒绝（`apps/console/lib/control-plane/oidc.ts`）。
- 签名算法只允许非对称算法。`OIDC_ALLOWED_ALGORITHMS` 是可选的逗号分隔白名单；不设置时接受 `RS256`、`RS384`、`RS512`、`PS256`、`PS384`、`PS512`、`ES256`、`ES384`、`ES512` 和 `EdDSA`。设置为空值或包含其他名称（例如 `HS256`、`none`）时，所有需要令牌的请求都返回 `503 oidc_algorithms_not_configured`。`/api/health` 不检查该变量，因此修改后须用真实令牌请求一次业务 API 确认。
- `OIDC_EXPECTED_TYP` 可选；设置后，令牌 JWT 头部的 `typ` 必须等于该值（例如 `at+jwt`）。
- 开发身份请求头（`x-tenant-id`、`x-actor-id`、`x-actor-name`、`x-actor-role`）只在 `CONTROL_PLANE_DEV_HEADER_IDENTITY` 恰好为 `true` 时生效，`NODE_ENV` 不再决定是否启用。本机 `npm run dev` 会自动设置它并绑定 `127.0.0.1`。该开关禁止用于任何部署：控制面在该值为 `true` 且 `NODE_ENV=production` 或监听地址不是回环地址时启动即退出；生产控制面 Compose 固定 `NODE_ENV=production`、`HOSTNAME=0.0.0.0`；`npm run deploy:check` 在控制面 env 文件把它设为 `true` 时报错，带 `--allow-placeholders` 也一样。`control.env` 中不要出现这个变量。

### 2.5 CosyVoice 语音、模型类型与声线库

节目脚本（`start_program`、`insert_program`、`resume_program`）和每条 `/v1/speak` 播报都由 Runtime Gateway 交给 CosyVoice 合成，合成结果封装为一个 WAV 后经 LiveTalking 的 `/humanaudio` 注入。LiveTalking 以 `--tts none` 启动，自身不合成语音，Gateway 也不再调用 `/human`。因此 CosyVoice 是必需依赖：Compose 中 `COSYVOICE_REQUIRED` 默认 `true`，必须启动 `cosyvoice` profile，生产预检使用 `--require-cosyvoice`。CosyVoice 不可用、超时或返回无效音频时，命令以明确的失败结果返回并释放预留，不会改用其他语音。

`gateway.env` 中的相关变量（以 `config/runtime-gateway.example.env` 为准）：

- `COSYVOICE_MODEL_KIND`：必填，只能是 `sft` 或 `zero_shot`，Compose 与 Gateway 都没有默认值。
  - `sft`：Gateway 调用 `/inference_sft`，以命令冻结的 `runtime_voice_id` 作为 `spk_id`。只有所加载模型自带该说话人时才可选用。
  - `zero_shot`：Gateway 调用 `/inference_zero_shot`，上传声线库中该 `runtime_voice_id` 的参考音频和文本。锁定的 `Fun-CosyVoice3-0.5B-2512` 没有自带 SFT 说话人，使用它时必须选 `zero_shot`（模板值）。
- `COSYVOICE_VOICE_LIBRARY_PATH`：宿主机上的声线库目录，Compose 以只读方式挂载到 Gateway 的 `/run/shuzhiren/voices`。
- `COSYVOICE_CHUNK_MAX_CHARS`：长脚本按句末切分后每段请求的最大字符数，范围 20 至 800，模板 120。
- `RUNTIME_COMMAND_DEADLINE_SECONDS`：一条命令从预留起的上游总时限，范围 1 至 59 秒，模板 15；合成在时限前 `min(3 秒, 25%)` 停止，为 LiveTalking 注入留出时间。它须小于 `runtime.env` 的 `RUNTIME_GATEWAY_REQUEST_TIMEOUT_MS`。

准备 `zero_shot` 声线库：

1. 在加密、访问受限的磁盘上创建声线库目录，例如 `/srv/shuzhiren/voices`，写入 `gateway.env` 的 `COSYVOICE_VOICE_LIBRARY_PATH`。目录对 Gateway 的 UID `10001` 可读即可，不需要可写。
2. 为每个已批准的声线建立一个子目录，名称等于控制台中该声线的 `runtime_voice_id`（字母或数字开头，只含字母、数字、`_`、`-`，最长 128 个字符）。
3. 子目录中放 `prompt.wav`：控制台已批准的声音素材本身，必须逐字节一致。Gateway 每次合成前计算它的 SHA-256，与命令携带的已批准校验和比较，不一致时拒绝合成；文件须是 RIFF/WAVE 格式，不超过 16 MiB。
4. 子目录中放 `prompt.txt`：UTF-8 文本，1 至 1000 个字符，末尾换行会被去掉。使用 Fun-CosyVoice3 时，内容为 `You are a helpful assistant.<|endofprompt|>` 后接 `prompt.wav` 的逐字转写；CosyVoice3 在 prompt 文本中找不到 `<|endofprompt|>` 时会拒绝合成（`vendor/CosyVoice/cosyvoice/llm/llm.py`）。Gateway 不检查这个标记，须在试播中用每个声线实际合成一次确认。
5. 参考音频是真人录音，放入前必须取得声音本人的书面授权，见第 7 节。声线库不进入 Git、镜像或备份以外的位置。

`sft` 模式不读取声线库，但 Compose 仍要求设置 `COSYVOICE_VOICE_LIBRARY_PATH`，可指向一个空的只读目录。

### 2.6 升级前排空旧的媒体与播报命令

从使用 LiveTalking 内置 TTS 的版本升级到上述 CosyVoice 路径时，升级前写入 outbox 的 `media.dispatch` 和 `speech.dispatch` 事件没有完整的冻结声线绑定。新的 Gateway 会以 `400` 拒绝缺少 `runtime_voice_id`/`voice_checksum` 的带脚本媒体命令，在 `zero_shot` 模式下也拒绝缺少 `voice_checksum` 的播报；worker 会一直重试到 `OUTBOX_MAX_ATTEMPTS` 耗尽，进行中的节目会因此中断。升级前按以下步骤排空：

1. 不再武装或开播新场次，让进行中的场次正常结束（`END` 经 Gateway 确认后场次才变为 `ENDED`）。
2. 保持旧版本 worker 与 Gateway 运行，直到每个租户都没有未完成的旧事件。outbox 启用了 RLS，须按租户查询，例如以控制面运行时账号执行：

```sql
begin;
select set_config('app.tenant_id', '<tenant uuid>', true);
select event_type, state, count(*)
from outbox_events
where event_type in ('media.dispatch', 'speech.dispatch')
  and (state in ('pending', 'delivering') or (state = 'failed' and attempts < <OUTBOX_MAX_ATTEMPTS>))
group by event_type, state;
commit;
```

3. 结果为空后再停止旧服务、升级镜像并启动新版本。仍有投递不出去的事件时，待启动命令可按第 2 节第 10 条在控制台取消，其他事件记录后等待其重试耗尽；不要直接改写 `outbox_events`。
4. 升级后第一场开播前，用每个已批准声线做一次内部试播播报，确认 Gateway 日志出现 `cosyvoice_chunk` 记录、`/healthz` 中 `cosyvoice.model_kind` 与配置一致，并且输出流中能听到该声线。

### 2.7 结果不确定命令的核对与处置

Runtime Gateway 把每条媒体命令（`/v1/media`）与播报命令（`/v1/speak`）记在命令日志（`RUNTIME_COMMAND_JOURNAL_PATH`，Compose 中为 `/var/lib/shuzhiren-runtime/commands.sqlite3`）中。每条记录只有四个状态之一，由 SQLite 触发器限制转换：

- `reserved`：命令 id 已预留，正在执行。之后只能变为下面三种之一。
- `completed`：命令已生效。同一 id、同一载荷的重试直接返回记录的结果，不再执行。
- `failed_definite`：确定没有生效，例如 CosyVoice 合成失败，或在向 LiveTalking 发出请求之前命令时限已经用完。同一 id、同一载荷的重试返回记录的失败响应（`duplicate: true`），不再调用 CosyVoice 或 LiveTalking。
- `uncertain`：命令可能已部分生效，或无法判断结果，例如 LiveTalking 请求本身失败，或本命令已有一次 LiveTalking 调用成功之后又出现任何失败（原因 `partial_execution`）。重试一律以 `409 command_outcome_uncertain` 拒绝。只有运维处置能把它改为 `completed` 或 `failed_definite`。

`reserved` 与 `uncertain` 的记录不会被清理，Gateway 重启后仍然保留。Gateway 启动时把所有 `reserved` 记录转为 `uncertain`（原因 `gateway_restarted_during_execution`）；运行中遇到已经没有执行的 `reserved` 记录（例如结果写不进日志）时也转为 `uncertain`（原因 `execution_interrupted`）。从旧的两状态日志升级时，遗留的 `reserved` 记录在同一事务中转为 `uncertain`，原因记为 `legacy_reserved`。每次调用 LiveTalking 都受 `RUNTIME_COMMAND_DEADLINE_SECONDS` 限制。

Gateway 在 stderr 中为这些事件各写一行 JSON，可以这样查看：

```bash
docker compose --env-file /srv/shuzhiren/runtime.env --env-file /srv/shuzhiren/gateway.env -f infra/compose/docker-compose.runtime.yml logs runtime-gateway | grep 'runtime_command\.'
```

- `runtime_command.uncertain`：命令变为 `uncertain`，含 `command_id`、`kind`、`reason`、`failed_step` 与时间。
- `runtime_command.resolved`：处置完成，含原状态、新状态、原因、处置时间与处置说明。
- `runtime_command.resolution_rejected`：处置请求被拒绝，`reason` 为 `unauthorized`、`not_found`、`invalid_request`、`not_uncertain` 或 `identity_unavailable`。

Runtime worker 收到 `command_outcome_uncertain` 时不重试：该 outbox 事件立即置为 `failed`（attempts 记为 `OUTBOX_MAX_ATTEMPTS`），写入 `outbox_events.outcome_uncertain_at`（迁移 080），并为该场次打开 `runtime_command_delivery_exhausted` 告警，同时写审计事件 `runtime_command.delivery_exhausted`（detail 含 `outcomeUncertain: true`）。`media.dispatch` 的告警级别为 `critical`，`speech.dispatch` 为 `warning`；告警文字说明需要人工核对媒体会话后处置并重新投递。带有该标记的事件不会再被 worker 自动领取。收到 `command_failed_definite` 时，worker 同样不重试，直接置为 `failed` 并清除标记；普通的 `503` 仍按退避重试。

处置步骤：

1. 从告警取得场次与 outbox 事件 id。outbox 启用了 RLS，须按租户查询带标记的事件，例如以控制面运行时账号执行：

   ```sql
   begin;
   select set_config('app.tenant_id', '<tenant uuid>', true);
   select id, event_type, aggregate_id, state, attempts, outcome_uncertain_at, last_error
   from outbox_events
   where outcome_uncertain_at is not null
   order by outcome_uncertain_at;
   commit;
   ```

   事件 payload 中 `command.id` 就是 Gateway 的 `command_id`。

2. 列出 Gateway 中结果不确定的命令。控制台正在增加处置页面与对应 API；该改动提交后以控制台为首选入口，路径以提交后的代码为准。在此之前，在运行时主机上直接调用 Gateway。这两个接口需要 `RUNTIME_SHARED_TOKEN`，只能在运行时主机或内网调用，不得经公网反向代理暴露。下面的写法让令牌只经过请求头文件，不出现在命令行参数和 shell 历史中：

   ```bash
   auth_header() { printf 'Authorization: Bearer %s\n' "$(sed -n 's/^RUNTIME_SHARED_TOKEN=//p' /srv/shuzhiren/gateway.env)"; }
   curl -sS --fail-with-body -H @<(auth_header) http://127.0.0.1:8090/v1/ops/uncertain-commands
   ```

   返回 `count` 与 `commands`。每项含 `command_id`、`kind`（`media` 或 `speech`）、`reserved_at`、`uncertain_at`、`reason`、`session_id`、媒体命令的 `action` 与 `program_segment_id`、`succeeded_steps`、`failed_step` 和 `identity_available`；不返回播报文本。

3. 核对媒体会话：结合 `succeeded_steps` 与 `failed_step`，用控制室画面、输出探针和录像判断这条命令是否已在直播输出中生效，例如节目段是否已切换、播报是否已播出。无法判断时不要处置；事件保持 `failed` 并带标记，worker 不会盲目重发，应升级给值班负责人。

4. 记录处置。`resolution` 只能是 `completed`（已确认生效）或 `failed_definite`（已确认没有生效），`note` 为 1 至 500 个字符的核对结论：

   ```bash
   curl -sS --fail-with-body -H @<(auth_header) -H 'Content-Type: application/json' \
     --data '{"resolution":"failed_definite","note":"<核对结论>"}' \
     http://127.0.0.1:8090/v1/ops/uncertain-commands/<command_id>/resolution
   ```

   成功时返回 `command_id`、`previous_state`、`state` 与 `resolved_at`。其余结果：`404 command_not_found`；`409 command_not_uncertain`（命令已不是 `uncertain`，响应含当前状态）；`409 command_identity_unavailable`（旧日志中缺少命令身份的记录只能处置为 `failed_definite`）；`422 request_invalid`（`resolution` 或 `note` 不合规）。每次被拒绝的请求都会写一行 `runtime_command.resolution_rejected`。

5. 处置后在控制台 outbox 页面对该事件执行一次手工投递（`POST /api/v1/runtime/outbox/{eventId}/deliver`）。Gateway 不会再次执行这条命令，只返回处置后的结果：处置为 `completed` 时事件记为已投递，并按回执更新场次；处置为 `failed_definite` 时事件以确定失败结束。需要的动作若确实没有生效，应在控制台重新下发一条新命令（新的命令 id），不要改写 `outbox_events` 或命令日志。

6. 处置与重新投递完成后，在控制台确认并关闭对应告警，并把核对依据记入值班记录。

### 2.8 控制台审计写入与日期列（无配置变化）

- 控制台的命令下发与其余写操作（素材、策略、商品、模型发布、场次、运行时会话绑定、互动处理、录像证据、告警确认、手工投递等）现在把业务变更与审计事件写在同一个事务中。审计事件写入失败时，整个请求回滚并返回 5xx，不会再留下没有审计记录、却已进入 outbox 的命令。排查这类失败时先看控制台日志中的数据库错误，不要绕过控制台直接写库。
- 控制台连接池把 PostgreSQL 的 `date` 列按 `YYYY-MM-DD` 文本读取，不再受进程时区影响。以往在 UTC 以东时区（例如 `TZ=Asia/Shanghai`）运行的控制台，会把素材到期日、录像保留日期和权益生效日期读成前一天，录像证据的幂等重试也会因此得到 409；升级后读取的就是数据库中的日期。容器以 UTC 运行时，所有值（包括发布清单的哈希输入）不变。
- 这两项都不需要新的环境变量、迁移或 `TZ` 设置。

### 2.9 数据库账号模型（D4）与既有部署的迁移

从 D4（2026-11-05）起，迁移以专用的迁移 owner 执行，控制面应用账号不拥有任何数据库对象：

| 账号 | 属性 | 拥有的对象与权限 | 连接串所在文件 |
| --- | --- | --- | --- |
| `shuzhiren_migration_owner` | `LOGIN NOINHERIT BYPASSRLS`，不得有 `SUPERUSER`、`CREATEDB`、`CREATEROLE`、`REPLICATION` | 数据库本身，以及迁移创建的全部表、序列、类型和函数；执行迁移器和三个授权脚本 | `MIGRATION_OWNER_ENV_FILE` 指向的文件（模板 `config/control-plane-migration-owner.example.env`）中的 `MIGRATION_OWNER_DATABASE_URL` |
| 控制面账号（默认 `shuzhiren_control_plane`） | `LOGIN NOINHERIT`，没有其他属性 | 不拥有任何对象；权限只来自 `infra/postgres/control-plane-principal.sql`：全部 public 表的 SELECT、INSERT、UPDATE、DELETE，但 `schema_migrations` 与 `audit_chain_heads` 只读，`membership_admin_guards` 无权限；序列的 USAGE、SELECT；迁移 owner 以后新建的表和序列自动获得同样权限 | `control.env` 的 `DATABASE_URL` |
| `shuzhiren_runtime_worker`、`shuzhiren_channel_adapter`、`shuzhiren_alert_notifier` | `LOGIN NOINHERIT` | `infra/postgres/service-principals.sql` 授予的最小权限（第 4 节第 3 步） | 各自服务的 env 文件 |
| `shuzhiren_backup` | `LOGIN NOINHERIT BYPASSRLS` | `infra/postgres/backup-principal.sql` 授予的只读权限（第 3 节） | `/etc/shuzhiren/backup.env` |

控制面 Compose 的一次性 `control-plane-migrate` 服务只加载 `${MIGRATION_OWNER_ENV_FILE}`，不加载 `control.env`；迁移器优先使用 `MIGRATION_OWNER_DATABASE_URL`，未设置时才用 `DATABASE_URL`（`apps/console/scripts/migrate.mjs`）。`MIGRATION_OWNER_ENV_FILE` 写在 `control-plane-compose.env` 中，未设置时 Compose 拒绝渲染。`npm run deploy:check` 通过 `--control-compose <文件>` 与 `--migration-owner <文件>` 读取这两个文件（不传时读取仓库模板），并检查：`MIGRATION_OWNER_ENV_FILE` 与 `CONTROL_PLANE_ENV_FILE` 不是同一个文件；迁移账号 env 文件只定义 `MIGRATION_OWNER_DATABASE_URL`，不定义 `DATABASE_URL`；迁移账号是不同于控制面、runtime worker、渠道 Adapter 和告警通知器的第五个数据库用户；任何应用或服务连接串都不使用 `shuzhiren_migration_owner`；迁移账号与控制面连接同一个数据库名。

**新部署。** DBA 以超级用户创建账号与数据库，口令用 `\password` 交互输入，不写进命令行：

```bash
sudo -u postgres psql -v ON_ERROR_STOP=1 -d postgres
```

```sql
CREATE ROLE shuzhiren_migration_owner LOGIN NOINHERIT BYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
\password shuzhiren_migration_owner
CREATE ROLE shuzhiren_control_plane LOGIN NOINHERIT;
\password shuzhiren_control_plane
CREATE DATABASE shuzhiren OWNER shuzhiren_migration_owner;
```

三个服务账号与 `shuzhiren_backup` 也由 DBA 先行创建（第 4 节第 3 步、第 3 节）。然后：

1. 从 `config/control-plane-migration-owner.example.env` 复制 `/srv/shuzhiren/migration-owner.env`（属主为部署账号，权限 `0600`），写入迁移 owner 的 `MIGRATION_OWNER_DATABASE_URL`；需要时在同一文件中设置 `MIGRATION_LOCK_TIMEOUT_MS` 与 `MIGRATION_STATEMENT_TIMEOUT_MS`（2.1 节）。在 `control-plane-compose.env` 中写 `MIGRATION_OWNER_ENV_FILE=/srv/shuzhiren/migration-owner.env`。`control.env` 的 `DATABASE_URL` 使用控制面账号。
2. 运行 `npm run deploy:check`，带上 `--control-compose /srv/shuzhiren/control-plane-compose.env --migration-owner /srv/shuzhiren/migration-owner.env`（完整命令见第 3 节末尾）。
3. 以一次性 profile 执行迁移：

   ```bash
   docker compose --env-file /srv/shuzhiren/control-plane-compose.env -f infra/compose/docker-compose.control-plane.yml --profile migrate run --rm control-plane-migrate
   ```

4. 以迁移 owner 依次执行三个授权脚本。顺序固定为 `service-principals.sql`、`backup-principal.sql`、`control-plane-principal.sql`；每个脚本开头先撤销该账号已有的表权限，所以可以重复执行，每次迁移之后都要重新执行一遍。`control-plane-principal.sql` 只接受 psql 变量 `control_plane_role`：

   ```bash
   psql "$MIGRATION_OWNER_DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f infra/postgres/service-principals.sql
   psql "$MIGRATION_OWNER_DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f infra/postgres/backup-principal.sql
   psql "$MIGRATION_OWNER_DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -v control_plane_role=shuzhiren_control_plane -f infra/postgres/control-plane-principal.sql
   ```

   连接串含口令，只在部署主机受限的 shell 中设置 `MIGRATION_OWNER_DATABASE_URL`，执行后 `unset`。

5. 校验账号模型：以迁移 owner 连接执行 `npm run db:verify -- --allow-privileged --control-plane-role shuzhiren_control_plane`（`DATABASE_URL` 设为迁移 owner 的连接串）。控制面账号拥有任何表、具备 `SUPERUSER` 或 `BYPASSRLS`、能写 `schema_migrations` 或链头、或缺少业务表 DML 时，校验失败。随后按第 4 节第 1 步以控制面账号再执行一次不带参数的 `npm run db:verify`。

**既有部署的迁移。** D4 之前的部署由控制面应用账号（`control.env` 的 `DATABASE_URL` 用户，下文记为 `<旧账号>`）执行迁移并拥有全部表。改为 D4 模型须在维护窗口内完成：

1. 确认没有 `ARMED`、`LIVE` 或 `DEGRADED` 场次，停止 `control-plane`、`runtime-worker`、`channel-adapter`、`alert-notifier`，再按第 3 节做一次 PostgreSQL 备份并校验 manifest。
2. DBA 以超级用户按上面的 SQL 创建 `shuzhiren_migration_owner` 与 `shuzhiren_control_plane`（不再执行 `CREATE DATABASE`）。
3. DBA 以超级用户连接到 `shuzhiren` 数据库，把数据库与 `<旧账号>` 拥有的全部对象交给迁移 owner：

   ```sql
   ALTER DATABASE shuzhiren OWNER TO shuzhiren_migration_owner;
   REASSIGN OWNED BY <旧账号> TO shuzhiren_migration_owner;
   ```

   `REASSIGN OWNED` 只处理当前数据库中的对象，以及该账号拥有的数据库等共享对象；`<旧账号>` 在同一集群的其他数据库中还拥有对象时，先确认这些对象的归属再执行。执行后 `<旧账号>` 不再拥有任何对象（`service-principals:integration` 用例按这一路径回放并断言）。
4. 按"新部署"第 1、2 步准备 `migration-owner.env`、`MIGRATION_OWNER_ENV_FILE`，并把 `control.env` 的 `DATABASE_URL` 改为 `shuzhiren_control_plane` 的连接串，然后运行 `deploy:check`。
5. 按"新部署"第 3、4、5 步执行迁移（会应用 081 等尚未执行的迁移）、以迁移 owner 依次执行三个授权脚本并校验。
6. 启动控制面和其余服务，确认 `/api/health` 与各服务 `/healthz` 正常后，DBA 对 `<旧账号>` 执行 `ALTER ROLE <旧账号> NOLOGIN`，不要再让任何服务使用它。

### 2.10 运行时 Gateway 令牌分发与轮换

Runtime Gateway 接受两个令牌，作用范围不同（`runtime/gateway/app.py` 的 `authorize`）：

| 令牌 | 写在 | Compose 传给 | 可用的 Gateway 接口 |
| --- | --- | --- | --- |
| `RUNTIME_SHARED_TOKEN` | `control.env`、`runtime.env`、`gateway.env`，三处取值相同 | `control-plane`、`runtime-gateway`、`runtime-worker` | 全部接口，包括 `/v1/media`、`/v1/speak`、`/v1/previews` 与 `/v1/ops/*` |
| `RUNTIME_GATEWAY_READ_TOKEN` | 只写在 `runtime.env`；`gateway.env` 中不写，写了就必须与 `runtime.env` 相同 | `runtime-gateway`、`runtime-observer` | 只有 `GET /v1/observations/{session_id}`；其他接口返回 `403`（`Read-only runtime gateway token cannot use this endpoint`），在命令锁、命令日志和上游调用之前拒绝 |

- `runtime-observer` 的环境中出现 `RUNTIME_SHARED_TOKEN` 时它拒绝启动，并要求 `RUNTIME_GATEWAY_READ_TOKEN`。Runtime Compose 不给 observer 传共享令牌，也不给它 `env_file`；`npm run runtime:compose:check` 检查这几点。
- 两个令牌都必须至少 32 个字符且不含空白。只读令牌不得与 `RUNTIME_SHARED_TOKEN`、`PREVIEW_BROKER_TOKEN` 或任何其他私网服务 token 相同；`deploy:check` 与 Gateway 启动都检查，报错只写出 token 的归属，不写取值。Gateway 中只读令牌为空时只读范围关闭，但 Runtime Compose 把它声明为必填变量，所以生产部署必须设置。

**升级前先加只读令牌。** 升级到包含该凭据的版本之前，先在 `runtime.env` 中加入 `RUNTIME_GATEWAY_READ_TOKEN`，否则 Compose 渲染失败、observer 无法启动。以部署账号执行，令牌不回显、不进入命令行参数：

```bash
(umask 077; printf 'RUNTIME_GATEWAY_READ_TOKEN=%s\n' "$(openssl rand -hex 32)" >> /srv/shuzhiren/runtime.env)
```

然后运行 `deploy:check`，再升级镜像并重建 `runtime-gateway` 与 `runtime-observer`。

**轮换。** Gateway 对每种令牌只接受一个值，新旧值不能同时生效，所以轮换在没有 `ARMED`、`LIVE` 或 `DEGRADED` 场次时进行：

- 只读令牌：在 `runtime.env` 中替换为新值（`gateway.env` 中若有也一起替换），运行 `deploy:check`，再执行 `docker compose --env-file /srv/shuzhiren/runtime.env --env-file /srv/shuzhiren/gateway.env -f infra/compose/docker-compose.runtime.yml up -d runtime-gateway runtime-observer`。两个服务重建之间 observer 的读取会被拒绝；`RUNTIME_OBSERVER_FAIL_CLOSED=true` 时这会打开告警，所以不在直播中轮换。
- 共享令牌：在 `control.env`、`runtime.env`、`gateway.env` 中同时替换为同一个新值，运行 `deploy:check`，确认 outbox 中没有 `pending` 或 `delivering` 的运行时命令后，重建 `runtime-gateway`、`runtime-worker` 与 `control-plane`，重建期间不下发命令。令牌不符的请求被 Gateway 以 `401` 拒绝；worker 只重试 `429` 和 `5xx`，所以这期间投递的 outbox 事件会直接记为 `failed`，需要在控制台重新投递。
- 怀疑任一令牌泄露时立即按上面的步骤轮换，并检查 Gateway 日志中这段时间的请求。

### 2.11 发布镜像（Release_Workflow）

`.github/workflows/release.yml`（Release Images）只能手动触发，没有任何输入。在 GitHub Actions 页面选择 Release Images，按 Run workflow 并选择受保护分支或 tag；也可以用 `gh workflow run release.yml --ref master`。两个 job 都带 `if: github.ref_protected`，在非受保护引用上不会运行；两个 job 都声明 `environment: release-production`，开始前需要该 environment 的必需审核人批准（EP-12）。

发布值全部是 `release-production` environment 的 variables（不是 secrets），工作流以 `vars.*` 读取，再由 `scripts/release-environment.mjs` 在运行时校验：

| 变量 | 格式 | 用途 |
| --- | --- | --- |
| `RELEASE_REGISTRY` | 必须与 `.github/release-registry-allowlist.json` 的 `registries` 中某一项逐字符相同（不去空白、不转小写，端口是条目的一部分）；条目本身是小写主机名，可带 `:端口`。当前白名单只有 `ghcr.io` | 推送镜像与读取 attestation 的 registry，`docker/login-action` 之前校验 |
| `RELEASE_IMAGE_NAMESPACE` | 小写的路径分段，例如 `owner/shuzhiren`（每段为字母数字，可用 `.`、`_`、`-` 连接） | 镜像推送到 `<RELEASE_REGISTRY>/<RELEASE_IMAGE_NAMESPACE>/<镜像名>:<提交 SHA>` |
| `RELEASE_SIGNING_KEY_PATH` | 签名 runner 上的绝对 POSIX 路径，只含字母、数字、`.`、`_`、`/`、`-`，不含 `..`，必须是可读的普通文件（校验不读取内容） | Ed25519 签名私钥文件 |
| `RELEASE_ISSUER` | `^[a-z][a-z0-9_-]{1,63}$` | release manifest 的签发者，须与部署主机 `DEPLOYMENT_RELEASE_MANIFEST_TRUST` 中的 issuer 一致 |
| `RELEASE_KEY_ID` | `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` | 签名密钥 id，须与 `DEPLOYMENT_RELEASE_MANIFEST_TRUST` 中该 issuer 下的 key id 一致 |

`REGISTRY_USERNAME` 与 `REGISTRY_PASSWORD` 是同一 environment 的 secrets。任一变量未定义、为空或格式不符时，对应步骤以 `::error::` 写出变量名和失败类别（不写取值）后失败：registry 校验在登录 registry 之前，签名校验在汇总证据与签名之前，因此不会生成 Release_Manifest。使用其他 registry 时，先提交 PR 修改 `.github/release-registry-allowlist.json`。CosyVoice 镜像的 `MINIFORGE_URL` 与 `MINIFORGE_SHA256` 由 `release-environment.mjs build-args` 从 `runtime/cosyvoice/miniforge.json` 读取，其余镜像只得到 `RELEASE_REVISION`（等于触发提交的 SHA）。

截至 2026-11-06，`release-production` environment 已配置审核规则与两个 registry secret，五个变量尚未设置（见就绪矩阵 EP-12），设置之前 Release_Workflow 会在校验步骤失败。产物的下载与部署前核验见第 2 节第 2 条。

## 3. 备份与恢复演练

- 目标：数据库 RPO 不高于 15 分钟，控制面 RTO 不高于 60 分钟。录屏和对象存储必须在生成后复制到已批准的站外存储；单机 Docker volume 不构成备份。
- `RECORDINGS_VOLUME_PATH` 必须是主机上加密、受访问控制、可备份的绝对路径。运行时 Compose 拒绝使用匿名录屏卷。
- `RUNTIME_GATEWAY_STATE_PATH` 也必须进入加密备份与隔离恢复范围。该目录保存 Gateway 已完成命令的有界哈希和响应摘要，不保存播报文本；恢复演练必须在同一 `commandId` 重发已完成命令，确认 Gateway 返回重复结果且不再次调用 LiveTalking 或 CosyVoice。遇到未完成的预留记录时，Gateway 会 fail-closed；值班人员应先核验实际媒体会话，而不是删除日志后盲目重试。
- 以下脚本只生成或验证 PostgreSQL 自定义格式归档，绝不执行恢复、覆盖数据库、自动轮转或删除任何历史备份。

创建并验证一次备份。生产环境优先使用安装了 PostgreSQL client 的备份账号和私网 `DATABASE_URL`；脚本不会把连接串写入清单。同一备份目录有任务运行时，第二个实例会立即失败，不能并发写入或覆盖归档；等待前一个任务完成后再重试。未提供 `DATABASE_URL` 时才兼容本地开发 Compose 的 `postgres` 服务。

```bash
DATABASE_URL='postgresql://shuzhiren_backup:***@private-postgres:5432/shuzhiren' \
POSTGRES_BACKUP_DIR=/srv/shuzhiren/backups/postgres \
bash scripts/backup-postgres.sh
```

校验已复制的归档。验证器强制读取同名 `.manifest`，并核对 archive 名称、SHA-256、字节数、来源和创建时间；可选 `EXPECTED_SHA256` 只能作为额外交叉检查，不能替代 manifest：

```bash
BACKUP_FILE=/srv/shuzhiren/backups/postgres/shuzhiren-postgres-YYYYMMDDTHHMMSSZ.dump \
bash scripts/verify-postgres-backup.sh
```

为 Gateway 命令日志创建一致性快照（脚本使用 SQLite backup API，不能用普通文件复制替代）：

```bash
RUNTIME_GATEWAY_STATE_PATH=/srv/shuzhiren/runtime-gateway-state \
BACKUP_DIR=/srv/shuzhiren/backups/runtime-gateway \
bash scripts/backup-runtime-gateway-state.sh
```

校验已复制的 Gateway 快照时同样强制验证相邻 manifest：

```bash
BACKUP_FILE=/srv/shuzhiren/backups/runtime-gateway/shuzhiren-runtime-gateway-state-YYYYMMDDTHHMMSSZ.sqlite3 \
bash scripts/verify-runtime-gateway-state-backup.sh
```

恢复只能在隔离的空数据库演练环境中由值班负责人执行。先由 DBA 创建名称以 `shuzhiren_restore_` 开头、无 public 表的独立数据库，再执行仓库脚本；脚本会先验证 archive/manifest，要求确认值精确绑定 archive SHA-256，拒绝非隔离数据库名、非空目标、覆盖既有证据或缺失关键表/迁移：

```bash
ARCHIVE=/srv/shuzhiren/backups/postgres/shuzhiren-postgres-YYYYMMDDTHHMMSSZ.dump
ARCHIVE_SHA256="$(sha256sum "$ARCHIVE" | awk '{print $1}')"
BACKUP_FILE="$ARCHIVE" \
DRILL_DATABASE_URL='postgresql://restore_owner:***@restore-postgres:5432/shuzhiren_restore_YYYYMMDD' \
DRILL_EVIDENCE_FILE=/srv/shuzhiren/evidence/restore/postgres-YYYYMMDD.manifest \
RESTORE_DRILL_CONFIRM="restore-${ARCHIVE_SHA256}" \
bash scripts/restore-postgres-drill.sh
```

Gateway 快照同样只能在隔离 Gateway 实例中恢复，且必须保持只读的原始备份；不要为方便而提供一键覆盖生产库、命令日志或运行中挂载目录的脚本。每月完成一次恢复演练，并将归档校验值、演练目标、开始/结束时间、RPO、RTO 和结果写入发布证据。

### Gateway 命令日志隔离恢复演练

先从经 `verify-runtime-gateway-state-backup.sh` 校验、站外复制的 SQLite snapshot 和同名 manifest 计算确认值，创建一个空的、非生产状态目录。`restore-runtime-gateway-state-drill.sh` 只会恢复到该空目录，拒绝与 `RUNTIME_GATEWAY_STATE_PATH` 相同的目标，不会启动 Gateway、覆盖生产 journal 或删除原始 snapshot。evidence 文件必须位于隔离目录外，且不可覆盖：

```bash
SNAPSHOT=/srv/shuzhiren/backups/runtime-gateway/shuzhiren-runtime-gateway-state-20261104T000000Z.sqlite3
SNAPSHOT_SHA256="$(sha256sum "$SNAPSHOT" | awk '{print $1}')"
sudo install -d -m 2750 -o 10001 -g shuzhiren-backup /srv/shuzhiren/restore-drills/runtime-gateway-20261104
sudo env \
BACKUP_FILE="$SNAPSHOT" \
DRILL_GATEWAY_STATE_PATH=/srv/shuzhiren/restore-drills/runtime-gateway-20261104 \
DRILL_EVIDENCE_FILE=/srv/shuzhiren/evidence/runtime-gateway-restore-20261104.manifest \
DRILL_GATEWAY_UID=10001 \
DRILL_GATEWAY_BACKUP_GROUP=shuzhiren-backup \
RESTORE_DRILL_CONFIRM="restore-${SNAPSHOT_SHA256}" \
RUNTIME_GATEWAY_STATE_PATH=/srv/shuzhiren/runtime-gateway-state \
PYTHON_BIN=/usr/bin/python3 \
bash scripts/restore-runtime-gateway-state-drill.sh
```

恢复脚本会再次验证 manifest、SHA-256、SQLite 完整性和 Gateway 实际读取所需的 journal 字段，将文件交还 `DRILL_GATEWAY_UID:DRILL_GATEWAY_BACKUP_GROUP` 并固定为 `0640`，再在 evidence 中记录 snapshot SHA-256、目标文件 owner/group/mode、行数、已完成命令数和 `gateway_started=false`。随后必须启动一个完全独立、不可写生产状态目录的 Gateway 实例，向它重试该 snapshot 中一条已完成的媒体命令和一条 CosyVoice 语音命令。两次都必须返回 `duplicate: true` 与原始回执，且隔离实例的 LiveTalking/CosyVoice 访问日志必须显示零次下游调用；保留 Gateway 响应、三类下游访问日志和 evidence 文件。`reserved`、缺少 `response_json` 或身份不匹配的命令应返回 `409`，绝不能通过恢复演练被重放。CI 的临时目录演练覆盖这条代码路径，但真实 RPO/RTO、独立实例和访问日志仍是部署方的外部验收责任。

MinIO 对象、模型权重和录屏不由上述数据库脚本覆盖。上线前必须在对象存储层启用版本控制，配置站外复制，并以一次恢复演练确认复制可用（就绪矩阵 EP-06）；在此之前不得把对象恢复能力表述为已完成。

### 受控定时备份

仓库提供了两个每 15 分钟触发的 systemd 模板，分别生成 PostgreSQL archive 和 Gateway 命令日志 SQLite 一致性快照。它们只创建和校验本机备份；站外不可变复制仍必须由已经批准的存储/备份系统完成。先安装 PostgreSQL client，并创建不具备登录 shell 的备份账号与受限目录：

```bash
sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin shuzhiren-backup
sudo install -d -m 0700 -o shuzhiren-backup -g shuzhiren-backup /srv/shuzhiren/backups/postgres
sudo install -d -m 0700 -o shuzhiren-backup -g shuzhiren-backup /srv/shuzhiren/backups/runtime-gateway
sudo install -d -m 2750 -o 10001 -g shuzhiren-backup /srv/shuzhiren/runtime-gateway-state
sudo install -d -m 0755 -o root -g root /etc/shuzhiren
sudo install -m 0600 -o root -g root config/backup.example.env /etc/shuzhiren/backup.env
sudo install -m 0600 -o root -g root config/runtime-gateway-backup.example.env /etc/shuzhiren/runtime-gateway-backup.env
```

两个单元各自读取独立的环境文件（`EnvironmentFile=`），由 systemd 以 root 读取后再以 `shuzhiren-backup` 运行脚本：

| 单元 | 环境文件 | 模板 | 必填变量 |
| --- | --- | --- | --- |
| `shuzhiren-postgres-backup.service` | `/etc/shuzhiren/backup.env` | `config/backup.example.env` | `DATABASE_URL`（备份主体）、`POSTGRES_BACKUP_DIR` |
| `shuzhiren-runtime-gateway-backup.service` | `/etc/shuzhiren/runtime-gateway-backup.env` | `config/runtime-gateway-backup.example.env` | `RUNTIME_GATEWAY_STATE_PATH`、`GATEWAY_BACKUP_DIR`（或 `BACKUP_DIR`）；`PYTHON_BIN` 可选，默认 `python3` |

将 `/etc/shuzhiren/backup.env` 的 `DATABASE_URL` 和备份目录替换为真实私网值。`runtime-gateway-backup.env` 不含数据库凭据，Gateway 备份单元也绝不加载 `backup.env`；其中的 `DRILL_*` 变量只在每月隔离恢复演练时使用，日常备份不读取。不要将这两个文件放入 Git、镜像或容器环境。

两个单元的 `ReadWritePaths`（Gateway 单元还有 `ReadOnlyPaths`）写死为 `/srv/shuzhiren/backups/postgres`、`/srv/shuzhiren/backups/runtime-gateway` 和 `/srv/shuzhiren/runtime-gateway-state`，systemd 不会展开环境文件中的变量。环境文件中的目录必须与之一致；改用其他目录时，按单元文件注释中的示例用 drop-in 覆盖，然后执行 `sudo systemctl daemon-reload`。两个单元的 `ExecStart` 运行 `/srv/shuzhiren/scripts/` 下的备份脚本，该目录必须存在当前发布版本的仓库脚本。

**缺少环境文件时单元会被静默跳过。** 两个单元都声明了 `ConditionPathExists=`，指向各自的环境文件。文件不存在时，计时器照常触发，但服务不会运行，也不会进入 failed 状态，`systemctl --failed` 看不到它。因此 `systemctl list-timers` 显示正常不能证明备份在运行。

然后安装并启用计时器：

在启用 PostgreSQL 定时任务前，DBA 必须创建专用数据库登录并以**迁移 owner**（`shuzhiren_migration_owner`，见 2.9 节）运行授权脚本。此角色需要 `BYPASSRLS` 才能产生完整租户 archive，因此它是高信任的备份主体：不得授予应用、控制台、渠道 Adapter 或人工日常会话，也不得使用超级用户、角色管理、建库或复制权限。

```bash
sudo -u postgres psql -d shuzhiren -c "CREATE ROLE shuzhiren_backup LOGIN NOINHERIT BYPASSRLS PASSWORD 'replace-from-secret-manager';"
psql "$MIGRATION_OWNER_DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f infra/postgres/backup-principal.sql
```

`backup-principal.sql` 会授予当前与后续迁移所建 public 表/序列的只读访问，拒绝写入、函数执行和角色继承。迁移若改由新的 schema owner 执行，必须由该新 owner 再执行一次此脚本，使其默认权限覆盖新对象。

```bash
sudo install -m 0644 infra/systemd/shuzhiren-postgres-backup.service /etc/systemd/system/
sudo install -m 0644 infra/systemd/shuzhiren-postgres-backup.timer /etc/systemd/system/
sudo install -m 0644 infra/systemd/shuzhiren-runtime-gateway-backup.service /etc/systemd/system/
sudo install -m 0644 infra/systemd/shuzhiren-runtime-gateway-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now shuzhiren-postgres-backup.timer shuzhiren-runtime-gateway-backup.timer
sudo systemctl list-timers 'shuzhiren-*backup*'
```

每次修改备份配置后先手动执行 `sudo systemctl start shuzhiren-postgres-backup.service` 和 `sudo systemctl start shuzhiren-runtime-gateway-backup.service`，检查 `journalctl -u` 的成功记录及每个备份旁的 manifest，再允许计时器承担 RPO。定时任务失败、延迟或站外复制失败必须进入值班告警，不能由下一次定时成功静默掩盖。

确认 Gateway 备份确实在运行（PostgreSQL 单元同理，把单元名、环境文件和目录换成对应值）：

```bash
sudo test -f /etc/shuzhiren/runtime-gateway-backup.env && echo env-present
systemctl status shuzhiren-runtime-gateway-backup.service
journalctl -u shuzhiren-runtime-gateway-backup.service --since '-1h'
sudo ls -l /srv/shuzhiren/backups/runtime-gateway/
```

- `systemctl status` 的 `Condition:` 一行若显示 start condition failed，并指出 `ConditionPathExists=/etc/shuzhiren/runtime-gateway-backup.env` 未满足，说明环境文件缺失、单元被跳过。此时 `journalctl` 只有"条件不满足、已跳过"的记录，没有脚本输出。
- 成功的运行会在日志中留下脚本输出的 `PASS   Gateway command journal snapshot created and verified: ...` 和 `PASS   Manifest written: ...`。
- 备份目录中应有成对的 `shuzhiren-runtime-gateway-state-<UTC 时间>.sqlite3` 与同名 `.manifest`，最新一对的时间不早于最近一次计时器触发（间隔 15 分钟）。再用 `scripts/verify-runtime-gateway-state-backup.sh` 校验最新快照（见本节前文）。只有日志和快照都存在，才能认为备份在运行。

示例结构检查：

```powershell
npm run deploy:check -- --allow-placeholders
```

真实配置检查：

```powershell
npm run deploy:check -- --control /srv/shuzhiren/control.env --control-compose /srv/shuzhiren/control-plane-compose.env --migration-owner /srv/shuzhiren/migration-owner.env --runtime /srv/shuzhiren/runtime.env --gateway /srv/shuzhiren/gateway.env --channel-adapter /srv/shuzhiren/channel-adapter.env --alert-notifier /srv/shuzhiren/alert-notifier.env --require-output-probe --require-cosyvoice
```

## 4. 启动顺序

1. 准备已批准的私网 PostgreSQL；开发用 `infra/compose/docker-compose.yml` 暴露的 PostgreSQL、Redis、MinIO 不是生产编排（本机开发用法见第 8 节）。生产应用账号不得为超级用户或拥有 `BYPASSRLS`。先用一次性迁移 profile 执行迁移；迁移器以数据库 advisory lock 串行化，同一数据库已有迁移运行时第二个实例会立即失败，必须等待前一个完成后再重试。随后以控制面运行时账号执行 `npm run db:verify`；验证脚本只读检查迁移、关键表、RLS、租户上下文与账号权限。仅在本地使用管理员账号进行排障时才可显式加 `-- --allow-privileged`。

```bash
docker compose --env-file /srv/shuzhiren/control-plane-compose.env -f infra/compose/docker-compose.control-plane.yml --profile migrate run --rm control-plane-migrate
```

2. 启动控制台和 OIDC 配置。控制台 Compose 默认只绑定 `127.0.0.1:3000`；对外访问必须经过已经配置 TLS、HSTS、OIDC 回调和来源限制的反向代理，不能将应用端口直接暴露到公网。控制台自身对全部路由发送 CSP、反点击劫持、MIME 嗅探防护、Referrer 与浏览器权限限制头；反向代理不得覆盖或删除这些响应头。生产 Proxy 在任何控制台页面或业务 API 渲染/执行前验证 JWT；只有 `/api/health`、Next 静态资源和 favicon 不要求浏览器令牌。`/api/health` 只有在生产数据库可查询且 OIDC issuer、audience、JWKS 完整有效时才返回 `200`，Docker 健康检查使用该端点；公开生产 OIDC URL 必须为 HTTPS，本地 loopback URL 只允许集成测试。它不替代 Gateway、GPU 或输出探针的运行时健康判定。

```bash
docker compose --env-file /srv/shuzhiren/control-plane-compose.env -f infra/compose/docker-compose.control-plane.yml up -d control-plane
```
3. 数据库迁移完成后，由数据库管理员在密钥管理系统中创建 `shuzhiren_runtime_worker`、`shuzhiren_channel_adapter` 和 `shuzhiren_alert_notifier` 三个独立的 `LOGIN NOINHERIT` 账号，再以迁移 owner 按 2.9 节依次执行三个授权脚本（第一个是 `infra/postgres/service-principals.sql`）。该脚本不创建密码、不授予成员、商品、节目、素材、策略或审批表访问；adapter 仅能持久化 webhook 重放，notifier 仅能投递告警，worker 仅能处理运行时 outbox、状态、额度、告警和审计。将三个独立 URL 分别写入 `runtime.env` 的 `RUNTIME_WORKER_DATABASE_URL`、`channel-adapter.env` 的 `CHANNEL_ADAPTER_DATABASE_URL` 与 `alert-notifier.env` 的 `ALERT_NOTIFIER_DATABASE_URL`；部署预检会拒绝它们与控制面复用数据库用户名。准备 `RUNTIME_OBSERVER_TARGETS_DIR/runtime-observer-targets.json` 的私网目标清单后，再启动 Gateway、LiveTalking、CosyVoice 和 runtime worker。Compose 会等待 LiveTalking 会话接口与 Gateway `/healthz` 健康后才拉起 worker；worker 的 `/healthz` 会同时检查数据库和轮询循环，observer 的 `/healthz` 检查观测循环及目标清单健康，两者都必须健康。先观察这些健康状态，不能仅以容器 `running` 作为可开播依据。Gateway 也需要以相同的 `NVIDIA_VISIBLE_DEVICES` 读取只读 NVML 指标。节目脚本和播报都由 CosyVoice 合成（见 2.5 节），所以任何会出声的场次都必须启动 Compose `cosyvoice` profile 并保持 `COSYVOICE_REQUIRED=true`（Compose 默认值），再用 `--require-cosyvoice` 使部署预检拒绝缺失语音依赖。真实场次必须额外启用 `docker compose --profile output-probe ... up`，并在启动前用 `npm run deploy:check -- ... --require-output-probe --require-cosyvoice` 校验目标和独立密钥：`output-probe` 用 ffprobe 检查视频/音频流、帧率、宽高和码率，并要求独立 `avSyncProbeUrl` 提供音画同步数值；若 target 配置了预期帧率或宽高，实际不符也返回 `503`，不会伪造成健康。
4. 用非公开推流地址进行 30 分钟内部试播；确认遥测到达、媒体 outbox 可投递、录屏生成和人工接管成功。
5. 执行 4 小时连续试播与断网、RTMP 拒绝、GPU OOM、TTS 超时、黑屏和静音演练后，才允许真实小规模场次。使用私网共享令牌调用 Gateway 的 `GET /v1/observations/{session_id}`，核验会话仍在、录制状态、进程内推理/输出 FPS 和 GPU 指标。该接口不能证明平台目的端接收、真实上行码率或音画同步；这些必须另行采集并人工核验，不能把 `/healthz` 或 writer 状态当作质量结论。
6. 为每个真实场次启动 `runtime-observer` 前，必须部署同网段、只读且已验收的输出探针。它返回的 JSON 仅允许包含布尔 `outputConnected`/`fallbackReady` 和非负数 `outputFps`/`avSyncMs`/`bitrateMbps`。断开该探针、停止 Gateway、终止输出或让其返回无效数据，均应在一个观测轮询周期内看到控制台告警和受控 `DEGRADED`；默认 `RUNTIME_OBSERVER_FAIL_CLOSED=true`，不要为掩盖监控故障改成 fail-open。除此之外，worker 每 `RUNTIME_WATCHDOG_POLL_MS` 检查 LIVE 场次，若最后样本超过 `RUNTIME_TELEMETRY_MAX_AGE_SECONDS`（默认 60 秒），会原子写入 `runtime_telemetry_stale` 告警、降级场次并将备用节目或人工接管命令写入 outbox；它绝不自动恢复为 LIVE。监控页的 15 分钟 95% 健康采样质量目标要求至少 3 个样本，样本不足只能显示不可评估；它用于判断观测覆盖与阈值健康，不能替代平台目的端、CDN 或渠道侧的端到端可用性 SLA。场次预检的“推流与备用节目”同样只认可该阈值内的健康遥测；历史 `output_ready` 字段不再可手工放行或阻塞预检。

## 5. 上线阻断项

- 控制台预检存在任一阻塞项。
- 运行时遥测缺失，或输出帧率低于 24 FPS、音画同步超过 120 ms、备用节目未就绪。
- 直播中发生推流断开、输出帧率低于 24 FPS 或备用节目未就绪时，必须由可验证的运行时观测器将场次切为 `DEGRADED` 并写入降级媒体指令；恢复直播必须由场控确认后执行，禁止自动反复恢复。当前锁定的开源运行时尚未暴露完整的目的端/FPS/音画同步指标，因此该观测器和试播验收是正式对外直播前的阻断项。
- 任何人物、声音、音乐、商品资料或脚本缺少授权与批准状态。
- 渠道连接未验证、验证无可审计证据，或最后验证超过 24 小时。
- 高风险问题没有人工场控值守与接管路径。
- 未完成 PostgreSQL 归档校验与隔离恢复演练，或录屏/对象存储没有受控的站外复制路径。

## 6. 4090 实机验收证据

代码、Compose 和本地开发页面通过不等于单卡 4090 可以真实开播。完成内部试播后，从 `config/runtime-acceptance.example.json` 创建仅存于受控服务器的证据文件，填入真实主机信息、场次发布清单 SHA-256、连续试播观测、录屏证据和故障演练记录，然后执行：

验收证据还必须包含独立输出音频活动探针的验证结论及其证据引用；只证明输出流存在音频轨不足以通过静音演练。版本 4 还必须列出一条实际输出观测：它要关联场次、已送达媒体 outbox、`media_` 命令、冻结节目段落、内容 SHA-256、验证器来源、媒体时间和 `evidence://`/`urn:` 引用；Gateway 接受回执、帧率或口头确认都不能替代该记录。

```bash
npm run runtime:acceptance:verify -- --evidence /srv/shuzhiren/evidence/runtime-acceptance.json
```

该门禁要求至少 240 分钟单路试播、单路数字人、最低输出 24 FPS、1280x720、2 Mbps、最高音画偏差 120 ms、有效输出探针及其独立证据、录屏证据，以及一条绑定节目命令和冻结段落的实际输出观测；断网、RTMP 拒绝、GPU OOM、TTS 超时、黑屏和静音六类演练必须全部通过。还必须有 PostgreSQL 隔离恢复、Gateway 日志快照、Gateway 隔离恢复及恢复后已完成命令不重放的证据。模板占位符、口头结论或 `/healthz` 不能通过该校验。此文件是发布证据索引，不应写入流密钥、访问令牌、买家信息、原始音视频或私人 URL。
### 输出音频活动事实

从 2026-11-03 的运行时协议起，`runtime-observer` 的输出探针 JSON 必须包含布尔 `audioActive`。该值必须由独立输出音频分析器给出，不可由数字人或 TTS 进程自行声明；缺失、`false` 或探针不可达时均会 fail-closed，生成严重静音告警并受控降级。

仓库内 `output-probe` 已内置活动音频测量：它用 `ffmpeg silencedetect` 对配置的受控回放/中继流采样，并将结果作为 `audioActive` 返回给 observer。`avSyncProbeUrl` 仍必须由独立分析器提供真实 `avSyncMs`；不要让同一数字人进程同时充当被测媒体源和质量判定源。

### 已直播场次的模型/素材撤销

对已冻结在直播场次中的模型发布包或授权素材执行撤销，不只是阻止下一次预检：生产控制面会立即将所有仍为 `LIVE` 的关联场次隔离到 `DEGRADED`。已绑定运行时会话的场次会写入受控 `switch_to_human` 指令；撤销结果页面显示隔离数和实际入队接管数。值班人员应从场次时间线确认 `live_run.governance_quarantined` 审计事件和 outbox 投递结果，再依照对应的人工接管处置手册完成现场处置。没有绑定运行时会话的场次仍会被降级并记录审计，但不能把“没有可投递会话”误报为已完成接管。

## 7. 模型权重、素材与第三方许可证

仓库引入的开源组件、锁定提交、许可证文件、LiveTalking 修改说明和需挂载的权重列在根目录 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。该文件只记录能从仓库确认的事实，不是许可证审查结论。上线前部署方需自行取得并留存：

1. **模型权重的许可证**：权重的许可证与代码许可证相互独立，仓库不含任何权重及其许可证文本。至少包括 LiveTalking 以 `--model musetalk` 运行时从 `MODEL_VOLUME_PATH` 加载的权重（`musetalkV15`、`sd-vae-ft-mse`、`whisper`、`face-parse-bisent` 等），以及 CosyVoice 从 `COSYVOICE_MODEL_PATH` 加载的模型（模板为 `Fun-CosyVoice3-0.5B-2512`）。每组权重的下载来源、许可证和商业使用条件需部署方确认。
2. **肖像授权**：`AVATAR_VOLUME_PATH` 中 `LIVETALKING_AVATAR_ID` 对应的人物形象需取得本人书面授权。
3. **声线授权**：声线来源取决于 `COSYVOICE_MODEL_KIND`（见 2.5 节）。`sft` 使用模型自带的说话人，使用条件以权重许可证为准，由真人录音训练的说话人还需声音本人的书面授权。`zero_shot` 以声线库中的 `prompt.wav` 合成同一声音，每段参考音频都必须取得声音本人的书面授权，范围覆盖直播语音合成的用途、平台和期限。
4. **在线语音服务**：运行时 Compose 以 `--tts none` 启动 LiveTalking，语音只由 CosyVoice 合成后经 `/humanaudio` 注入，不调用 edge-tts 的外部在线服务。`edge_tts` 包仍随 LiveTalking 镜像安装（来自上游 `requirements.txt`），其许可证随 SBOM 依赖一并审查；改动 Compose 或补丁重新启用在线 TTS 前，需另行评估该服务条款。
5. 商品图片、音乐和脚本的授权，以及发布 SBOM 所列依赖的许可证审查结论。

LiveTalking 以 Apache License 2.0 发布，本仓库通过 `runtime/patches/` 修改了它。再分发 LiveTalking 镜像时须随附其许可证与修改说明；锁定提交没有 NOTICE 文件。镜像中是否已包含这些文件，以及这些义务是否已满足，需部署方确认。

## 8. 本机开发环境

开发用 `infra/compose/docker-compose.yml` 启动的 PostgreSQL、Redis、MinIO 没有默认口令。首次使用前，从模板复制插值文件并把每个值替换为本机随机生成的字符串：

```bash
cp config/dev-compose.example.env infra/compose/.env
```

`infra/compose/.env` 已被 `.gitignore` 忽略，不得提交，也不得在其他环境复用其中的值。以 `docker compose -f infra/compose/docker-compose.yml ...` 运行时，Compose 默认从该文件所在目录读取 `.env`；缺少 `DEV_POSTGRES_PASSWORD`、`DEV_REDIS_PASSWORD`、`DEV_MINIO_ROOT_USER` 或 `DEV_MINIO_ROOT_PASSWORD` 时，Compose 会报错并拒绝启动。

本机 `npm run dev` 绑定 `127.0.0.1` 并自动启用开发身份请求头（`CONTROL_PLANE_DEV_HEADER_IDENTITY=true`）。若用 `-H` 绑定非回环地址，必须显式设置 `CONTROL_PLANE_DEV_HEADER_IDENTITY=false` 并配置 OIDC，否则控制面启动即退出。该开关不得出现在任何部署环境中（见 2.4 节）。

## 9. 回归证据工具

`scripts/regression-registry.mjs` 登记 Audit_Register 中可以在修复提交的第一个父提交上运行的回归测试。`npm run regression:evidence` 为其中一条登记取得"修复前失败、修复后通过"的证据，不属于 CI_Pipeline，也不部署到生产主机：

```bash
npm run regression:evidence -- --issue C3 --mode parent
npm run regression:evidence -- --issue C3 --mode fix
```

- `--mode parent` 在修复提交的第一个父提交上运行测试，只覆盖登记的测试文件与 fixture；只有出现断言失败、且失败用例包含登记的断言时才算符合预期。`--mode fix` 在修复提交上运行，测试通过才算符合预期。
- 一个问题有多条登记时，用 `--fix <40 位 SHA>` 或 `--target <测试路径>` 选择其中一条。其他选项：`--json` 只输出 JSON，`--keep-worktree` 保留临时 worktree 供排查，`--python <解释器>` 指定 Python 测试的解释器（也可设置 `REGRESSION_PYTHON` 或 `PYTHON`），`--timeout-ms <毫秒>` 改变单次运行时限（默认 30 分钟）。
- 工具在临时 `git worktree` 中检出目标提交，复用或安装该提交的 `node_modules`，运行结束后删除 worktree。种类为 `integration` 的登记需要 `DATABASE_URL`，没有时结果为 `invalid`（`database_unavailable`）。
- 输出一行 JSON、一段摘要和一行可写入 `docs/AUDIT_REGISTER.md` 的 YAML。退出码：0 表示所选登记都符合该模式的预期；1 表示有登记不符合（包括 `invalid`）；2 表示参数、登记表或 git 错误。

需要 PostgreSQL 或 Linux 环境时，在 GitHub Actions 中手动运行 `regression-evidence` 工作流（`.github/workflows/regression-evidence.yml`，只有 `workflow_dispatch`，输入 `issue`、`mode`，可选 `fix_sha`、`target`），例如 `gh workflow run regression-evidence.yml -f issue=C3 -f mode=parent`。它带 PostgreSQL 17 服务和 Gateway 的 Python 依赖，结果写入该次运行的 job summary。

登记表、静态门禁覆盖表与该工作流由 `npm run regression:registry:check` 检查，CI 的 `static-gates` 运行它。按 VERIFICATION_LOG 与 Audit_Register 的规则登记结果之后，这些结果才能作为审计记录的证据。

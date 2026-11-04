# 4090 部署运行手册

部署前先阅读 [商业部署就绪矩阵](DEPLOYMENT_READINESS.md)。它将仓库已完成的代码能力与租机、账号、授权、密钥和平台集成等外部前置条件分开列示。

本手册只覆盖 P0 内部试播。没有完成肖像、声音、脚本、商品和音乐的书面授权，不得部署到真实直播间。

控制面五类私网服务 token 必须按“服务类型 + 租户”唯一分配；部署预检会拒绝跨服务或跨租户复用的 token。

发布 `runtime-observer-targets.json` 时，`--require-targets` 必须同时传入 `--control-env /srv/shuzhiren/control.env` 与 `--runtime-env /srv/shuzhiren/runtime.env`。发布脚本会验证每个场次的遥测 token 来自同租户控制面映射，且 output-probe token 与运行时配置一致。

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
2. 从 `config/control-plane.example.env`、`runtime.example.env`、`runtime-gateway.example.env`、`channel-adapter.example.env` 和 `alert-notifier.example.env` 复制五份服务配置到服务器私有目录；再从 `config/control-plane-compose.example.env` 复制控制面 Compose 插值配置。后者只引用私有 `control.env` 并定义控制台绑定地址/端口，不得放入 OIDC、数据库或服务 token。
3. 控制面使用 `NODE_ENV=production`、`CONTROL_PLANE_DEMO_MODE=false`，并配置 OIDC issuer、audience、JWKS 和 PostgreSQL。`RELEASE_REVISION` 必须填写实际部署的 7 至 40 位 Git 提交；健康接口会返回该值，用于把运行实例、审计证据和发布记录对应到不可变源码。`DATABASE_QUERY_TIMEOUT_MS` 默认 5000，限制数据库连接与查询等待，不能配置为 100 ms 以下或 60 秒以上；它让容器就绪检查在私网数据库异常时及时失败。浏览器同源调用可以使用 `OIDC_ACCESS_TOKEN_COOKIE`（默认 `shuzhiren_access_token`）承载短期 access token；该 cookie 必须由登录网关以 `HttpOnly`、`Secure`、`SameSite=Lax` 或更严格的属性签发，令牌本身不得写入前端存储。生产 Proxy 会在进入 API handler 前校验令牌租户和角色，包含按动作区分的生命周期权限；无权令牌必须收到 `403 insufficient_permission`，不能依赖前端隐藏按钮。Cookie 身份的写操作还必须携带同源或 `OIDC_ALLOWED_ORIGINS` 白名单中的 `Origin`，否则返回 `403 csrf_origin_rejected`；部署在反向代理后时应显式填写公开控制台域名白名单。
4. `control.env`、`runtime.env` 与 `gateway.env` 的 `RUNTIME_SHARED_TOKEN` 必须完全一致，且两个前者必须设置 `RUNTIME_GATEWAY_DEMO_MODE=false`；这是 Gateway 对控制面人工操作和 Worker durable outbox 投递的后端认证凭据，绝不能传给浏览器、渠道 Adapter、租户接入或其他服务。部署预检、Worker 和 Gateway 启动都会拒绝短于 32 个字符或包含空白的共享令牌。所有其余私网服务 token 和签名密钥必须至少 32 个字符、不含空白，且不能跨服务或租户复用；`OUTPUT_PROBE_SHARED_TOKEN` 必须独立。`RUNTIME_GATEWAY_REQUEST_TIMEOUT_MS` 也必须在 `control.env` 与 `runtime.env` 中一致，范围为 100 至 60000；它会让人工会话验证、媒体接管、语音播报和后台 outbox 在 Gateway/网络故障时及时失败并进入既有重试或告警路径，而非无限等待。Node 服务与 Gateway 镜像均以非 root 用户运行，不能依靠容器内 root 权限写入配置或状态。`gateway.env` 中的 `RUNTIME_GATEWAY_STATE_PATH` 必须是主机上的绝对、加密、访问受限且纳入备份的目录；Gateway 以固定 UID `10001` 写入命令日志。启用下方计划备份时，先以运行 Docker 的部署账号创建 setgid 目录，例如 `sudo install -d -m 2750 -o 10001 -g shuzhiren-backup /srv/shuzhiren/runtime-gateway-state`，再启动 Compose。setgid 目录会让 SQLite 日志继承 `shuzhiren-backup` 组，Gateway 以 owner/group 可读、其他用户无权的权限创建日志，因此备份服务可读取它而不需 root 权限。它会挂载为 Gateway 的命令日志目录；不能改用匿名 Docker 卷或临时容器文件系统，否则 Gateway 重启后无法判定已完成命令，可能重复执行媒体动作。Gateway 启动还会验证必需命令日志可写，目录权限错误会直接使容器启动失败。Gateway 宿主机端口由 `RUNTIME_GATEWAY_HOST_BIND` 控制，模板默认 `127.0.0.1`；不得使用 `0.0.0.0` 或 IPv6 通配地址。控制台与 Gateway 分机部署时，只可填写经网络审批的私网地址，并在安全组/防火墙中仅放行控制台来源，不能把 Gateway 直接暴露到公网。控制面使用 `RUNTIME_TELEMETRY_TENANT_TOKENS`、`RUNTIME_RECORDING_TENANT_TOKENS`、`PIM_INGEST_TENANT_TOKENS`、`CHANNEL_INGEST_TENANT_TOKENS` 和 `CHANNEL_COMMERCE_TENANT_TOKENS` 五个 JSON 租户密钥映射；每个租户必须有不同的高熵 secret，且任一 token 不得跨服务或跨租户复用，运行时或渠道 Adapter 只能用自己租户的 token 上报。录制凭据只能由归档进程在完成受批准对象存储复制与 SHA-256 校验后使用，不能复用遥测、浏览器、前端 SDK 或平台网页的 token；录制登记只接受对象键，不接受 URL 或本地文件路径。PIM 凭据仅供完成来源、时间窗和签名校验的服务器端同步器使用，事实仍需审核。评论和交易凭据必须分离，不能共用。交易 Adapter 完成平台签名、时间戳、重放和限流验证后，只能提交不含买家 PII 的曝光、点击、加购、支付和退款事实；支付/退款会写入 append-only 审计。每次启动 `docker-compose.runtime.yml` 都要加载已通过 `deploy:check` 的 `runtime.env` 与 `gateway.env`；Compose 会在解析整个服务文件时读取两者，不能只传当前 profile 的环境文件。`RUNTIME_OBSERVER_TARGETS_DIR` 必须是生产主机上仅运行时部署账号可读写的绝对目录，目录内创建 `runtime-observer-targets.json`。其数组每项必须包含 `tenantId`、`runId`、`sessionId`、同租户的 `telemetryToken` 与 `outputProbeUrl`，其 token 必须与控制面该租户的遥测密钥对应，不能复用为其他租户或浏览器 token。使用仓库内 `output-probe` 时，每项还应填写 `outputProbeToken`，并与 `OUTPUT_PROBE_SHARED_TOKEN` 匹配；该 token 只用于私网 observer 到探针的读取授权，不能作为控制面或渠道凭据。部署编排把候选清单写入同目录的 `runtime-observer-targets.next.json` 后，执行 `npm run observer:targets:apply -- --candidate /srv/shuzhiren/observer-config/runtime-observer-targets.next.json --destination /srv/shuzhiren/observer-config/runtime-observer-targets.json --control-env /srv/shuzhiren/control.env --runtime-env /srv/shuzhiren/runtime.env --require-targets`。该命令会校验每个场次遥测 token 等于控制面同租户的 `RUNTIME_TELEMETRY_TENANT_TOKENS`，并校验每个探针令牌等于运行时的 `OUTPUT_PROBE_SHARED_TOKEN`，拒绝跨目录替换、收紧为 owner-only 权限后原子替换；observer 自动重载，配置缺失或格式错误时 `/healthz` 会失败。配置 `alert-notifier.example.env` 后，使用 `docker compose --profile alert-notifier --env-file /srv/shuzhiren/runtime.env --env-file /srv/shuzhiren/gateway.env --env-file /srv/shuzhiren/alert-notifier.env -f infra/compose/docker-compose.runtime.yml up --build` 启动私网告警通知器；每个目标必须使用 HTTPS，按租户配置独立 HMAC 密钥。通知器只通知打开时的告警，持久化投递状态可重试和重领；其 `/healthz` 只有在数据库可查且最近一个轮询窗口成功完成时才返回成功。接收方必须按 `x-shuzhiren-event-id` 去重，不能将机器人成功响应理解为事故已恢复。

5. 录制归档进程只能在对象已复制到受批准的站外存储后，调用 `POST /api/v1/runtime/recordings`。请求必须使用该租户的 `RUNTIME_RECORDING_TENANT_TOKENS`，提交 `tenantId`、`runId`、对象键、64 位十六进制校验和、字节数、时长与稳定的 `idempotencyKey`。控制面会使用独立的 `RECORDING_EVIDENCE_VERIFIER_*` 私网凭据请求 verifier；verifier 必须绑定并回显租户、场次、对象键、不可变对象版本、实际 SHA-256、字节数、时间窗与留存期，再签发短时 `evidence://`/`urn:` 回执。控制面拒绝 verifier 不可用、内容不匹配、过期回执或空对象；同一幂等键仅可重试完全相同的证据。接口会拒绝 URL、绝对路径、反斜杠和 `..` 路径段；同一租户对象键不可重复。登记记录及 verifier 回执均为 append-only 证据，不会上传、删除或生成对象存储预签名下载链接。已存在但缺少 verifier 回执的历史登记会保留在数据库审计中，但不会出现在运营录制列表；必须重新完成对象存储验证后再登记新的受控证据。

商品事实接入：PIM/ERP 只能通过私网 `POST /api/v1/integrations/product-facts` 使用独立的 `PIM_INGEST_TENANT_TOKENS` 提交无买家 PII 的商品事实。每个 `eventId` 只对应同一载荷；重试返回同一草稿，不同载荷会被拒绝。接入服务可更新商品名称并建立新版本，但不得自行批准价格、库存、卖点或 FAQ，审核员必须在控制台复核。

经营成本口径：商品事实版本可选登记审核过的 `unitCostCent`。渠道支付事实必须带实际支付件数 `quantity`（未提供时适配器按单件处理）；场次经营页以冻结 SKU 的单位成本乘支付件数，再从退款后净回款中扣除，得到退款后贡献毛利。成本未登记时不得展示零成本或估算毛利。该指标不替代订单级结算、仓配、投流、人力、平台佣金或税费对账，正式财务结算仍需接入渠道与 ERP 的对账系统。

策略包治理：上线前由运营登记策略包名称、版本、自定义关键词规则、验收证据引用和验收摘要；审核角色通过控制台批准。没有已批准策略包时，生产数据库拒绝创建新的直播场次。创建后系统将策略包绑定到场次修订，后续即使有更新版本也不改变已排期场次的互动、草稿和播报判定。审核角色撤销已批准版本时必须写明原因；被绑定场次的预检、自动互动和草稿会 fail-closed，值班人员必须重新建立并审批场次所需的新版本。策略包规则应只描述可审查的业务处置，不得写入密钥、买家 PII 或原始对话样本。
6. 生产单卡保持 `LIVE_MAX_CONCURRENT_AVATARS=1`、`LIVE_ALLOW_LLM_FREEFORM=false`、高风险问题人工接管和 AI 标识开启。
7. `runtime.example.env` 的 `LIVETALKING_REF`、`MUSETALK_REF`、`COSYVOICE_REF` 必须逐项等于 `runtime/open-source.lock.json`；`npm run deploy:check` 还会读取 `vendor/` 下真实 Git HEAD 并拒绝脏源码。模型权重的许可证、人物和声音授权另行登记。
8. 在 Gateway 环境中配置 `PROGRAM_AUDIOTYPE`、`FALLBACK_AUDIOTYPE` 与 `HUMAN_HANDOFF_AUDIOTYPE`，并在 LiveTalking 的已批准 Avatar 包中逐项验证动作含义；三者必须是不同的 `0` 至 `255` 整数，不能将默认索引当作真实人接管或备用节目。Gateway 启动时还会拒绝非 HTTP(S) 的内部服务地址、含嵌入式凭据的 URL、8-192 kHz 以外的 CosyVoice 采样率、超过 120 秒的下游请求超时，以及过短或无界的命令幂等缓存配置。
9. LiveTalking 建立会话后，在“直播场次”中绑定返回的 `sessionid`；无论创建时填写还是后续绑定，都会先由 Gateway 查询会话存活状态，不能只填写任意字符串。当前 Compose 使用 RTMP 单会话模式，LiveTalking 启动时创建固定会话 ID `0`，因此应绑定 `0`。会话只可在武装前或预检中更换，场次进入 `ARMED` 后被锁定，避免直播中的命令被重定向到其他数字人。同一会话只允许被一个 `PREFLIGHT`、`ARMED`、`LIVE` 或 `DEGRADED` 场次占用；草稿和审核中的未来排期可以预先引用它，结束或归档后会自动释放占用。没有绑定运行时会话的场次不得接受媒体控制命令。启用锁定的 `Fun-CosyVoice3-0.5B-2512` 时，`COSYVOICE_SAMPLE_RATE` 必须保持 `24000`；其 FastAPI 服务返回无文件头的 16-bit PCM，Gateway 依此封装 WAV。更换模型必须同步变更此值并在发布包验收中留存试听结果。`COSYVOICE_MODEL_PATH` 是宿主机目录，`COSYVOICE_MODEL_DIR` 则必须是容器内绝对路径；当前 Compose 固定挂载到 `/opt/CosyVoice/CosyVoice/pretrained_models`，模板已指向该目录下的 `Fun-CosyVoice3-0.5B-2512`。
10. runtime worker 会按 `SCHEDULER_POLL_MS` 独立轮询已到排期时间的 `ARMED` 场次。每个场次先在独立数据库事务中创建唯一的 `start_program` outbox 并绑定到场次；手动 `START` 和 `RECOVER` 同样先保留在 `ARMED` 或 `DEGRADED`，只有 Gateway 确认该命令成功后，worker（或场控的单条恢复投递）才将场次切换为 `LIVE`。待确认的 `START` 会以 `ARMED + scheduled_start_event_id` 保留一个并发名额，额度行锁会使手动与定时开播串行评估，避免两个请求同时穿透上限。场控发现排期不应继续时，可将尚未投递或失败的待启动 outbox 取消并把场次退回 `PREFLIGHT`，这会释放并发占用；`delivering` 状态的事件不可取消，必须等待当前 Gateway 调用完成。`END` 也不会在点击时伪造已结束：场次保留当前状态并锁定唯一停止 outbox，只有 Gateway 确认 `stop_program` 后才切为 `ENDED`。恢复还必须先通过 60 秒内的新鲜运行时健康校验。失败事件会保留为 `failed` 供重试，不会伪造“直播中”或“已结束”，也不会重复创建定时开播命令。每一轮最多领取 `SCHEDULER_BATCH_SIZE` 个，它不会自动武装场次，也不会跳过预检。若管理员配置了并发场次或当月直播分钟权益，手动和定时激活都会在进入 Gateway 前检查；`LIVE`、`DEGRADED` 和待确认启动都计入并发，降级是运行质量状态，不会释放通道、场次或时长资源。定时场次超额时保持 `ARMED`、记录告警与审计，不会无声开播。只有配置了当月分钟权益的租户才会由 worker 按 `USAGE_METER_POLL_MS` 为 `LIVE` 和 `DEGRADED` 场次写入幂等分钟桶；该账本用于额度门禁，正式结算仍需对接合同、账单与支付系统。
11. 渠道连接只能使用服务端注册的 Adapter 和 `kms://` 或 `secret://` 密钥引用。每次标记为 `connected`、`degraded` 或 `disabled` 都必须记录验证报告/工单引用；开播预检拒绝超过 24 小时的渠道验证。`generic-rtmp` 只证明受控推流通道，不代表已经完成平台 OAuth、评论、商品挂车或 Webhook 集成。
12. `audit_events` 在数据库层是 append-only：运行时账号不能更新或删除审计记录。用户注销、保留期或隐私请求必须走独立的合规数据处理流程，不能用普通业务 SQL 改写历史事件。
13. 租户业务表均启用并强制 PostgreSQL RLS。即使部署时应用数据库账号是表所有者，也必须在每个事务内设置 `app.tenant_id`；禁止为应用账号授予 `BYPASSRLS`。runtime worker 只能无范围读取 `tenants.id`，随后对每个租户分别设置该上下文并领取/回写任务，不能对业务表执行无租户范围的扫描。

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

校验已复制的归档，`EXPECTED_SHA256` 使用同名 `.manifest` 中的值：

```bash
BACKUP_FILE=/srv/shuzhiren/backups/postgres/shuzhiren-postgres-YYYYMMDDTHHMMSSZ.dump \
EXPECTED_SHA256=replace-with-manifest-sha256 \
bash scripts/verify-postgres-backup.sh
```

为 Gateway 命令日志创建一致性快照（脚本使用 SQLite backup API，不能用普通文件复制替代）：

```bash
RUNTIME_GATEWAY_STATE_PATH=/srv/shuzhiren/runtime-gateway-state \
BACKUP_DIR=/srv/shuzhiren/backups/runtime-gateway \
bash scripts/backup-runtime-gateway-state.sh
```

校验已复制的 Gateway 快照，`EXPECTED_SHA256` 使用同名 `.manifest` 中的值：

```bash
BACKUP_FILE=/srv/shuzhiren/backups/runtime-gateway/shuzhiren-runtime-gateway-state-YYYYMMDDTHHMMSSZ.sqlite3 \
EXPECTED_SHA256=replace-with-manifest-sha256 \
bash scripts/verify-runtime-gateway-state-backup.sh
```

恢复只能在隔离的空数据库演练环境中由值班负责人执行：先创建独立数据库，人工检查 `pg_restore --list`，再以明确的目标数据库名执行 `pg_restore`。Gateway 快照同样只能在隔离 Gateway 实例中恢复，且必须保持只读的原始备份；不要为方便而提供一键覆盖生产库、命令日志或运行中挂载目录的脚本。每月完成一次恢复演练，并将归档校验值、演练目标、开始/结束时间、RPO、RTO 和结果写入发布证据。

MinIO 对象、模型权重和录屏不由上述数据库脚本覆盖。上线前必须在对象存储层启用版本控制，并配置已验证的站外复制；在此之前不得把对象恢复能力表述为已完成。

### 受控定时备份

仓库提供了两个每 15 分钟触发的 systemd 模板，分别生成 PostgreSQL archive 和 Gateway 命令日志 SQLite 一致性快照。它们只创建和校验本机备份；站外不可变复制仍必须由已经批准的存储/备份系统完成。先安装 PostgreSQL client，并创建不具备登录 shell 的备份账号与受限目录：

```bash
sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin shuzhiren-backup
sudo install -d -m 0700 -o shuzhiren-backup -g shuzhiren-backup /srv/shuzhiren/backups/postgres
sudo install -d -m 0700 -o shuzhiren-backup -g shuzhiren-backup /srv/shuzhiren/backups/runtime-gateway
sudo install -d -m 2750 -o 10001 -g shuzhiren-backup /srv/shuzhiren/runtime-gateway-state
sudo install -m 0600 -o root -g root config/backup.example.env /etc/shuzhiren/backup.env
```

将 `/etc/shuzhiren/backup.env` 的 `DATABASE_URL`、备份目录和 Gateway 状态目录替换为真实私网值；不要将该文件放入 Git、镜像或容器环境。然后安装并启用计时器：

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

示例结构检查：

```powershell
npm run deploy:check -- --allow-placeholders
```

真实配置检查：

```powershell
npm run deploy:check -- --control /srv/shuzhiren/control.env --runtime /srv/shuzhiren/runtime.env --gateway /srv/shuzhiren/gateway.env --channel-adapter /srv/shuzhiren/channel-adapter.env --alert-notifier /srv/shuzhiren/alert-notifier.env --require-output-probe --require-cosyvoice
```

## 4. 启动顺序

1. 准备已批准的私网 PostgreSQL；开发用 `infra/compose/docker-compose.yml` 暴露的 PostgreSQL、Redis、MinIO 不是生产编排。生产应用账号不得为超级用户或拥有 `BYPASSRLS`。先用一次性迁移 profile 执行迁移；迁移器以数据库 advisory lock 串行化，同一数据库已有迁移运行时第二个实例会立即失败，必须等待前一个完成后再重试。随后以控制面运行时账号执行 `npm run db:verify`；验证脚本只读检查迁移、关键表、RLS、租户上下文与账号权限。仅在本地使用管理员账号进行排障时才可显式加 `-- --allow-privileged`。

```bash
docker compose --env-file /srv/shuzhiren/control-plane-compose.env -f infra/compose/docker-compose.control-plane.yml --profile migrate run --rm control-plane-migrate
```

2. 启动控制台和 OIDC 配置。控制台 Compose 默认只绑定 `127.0.0.1:3000`；对外访问必须经过已经配置 TLS、HSTS、OIDC 回调和来源限制的反向代理，不能将应用端口直接暴露到公网。控制台自身对全部路由发送 CSP、反点击劫持、MIME 嗅探防护、Referrer 与浏览器权限限制头；反向代理不得覆盖或删除这些响应头。生产 Proxy 在任何控制台页面或业务 API 渲染/执行前验证 JWT；只有 `/api/health`、Next 静态资源和 favicon 不要求浏览器令牌。`/api/health` 只有在生产数据库可查询且 OIDC issuer、audience、JWKS 完整有效时才返回 `200`，Docker 健康检查使用该端点；公开生产 OIDC URL 必须为 HTTPS，本地 loopback URL 只允许集成测试。它不替代 Gateway、GPU 或输出探针的运行时健康判定。

```bash
docker compose --env-file /srv/shuzhiren/control-plane-compose.env -f infra/compose/docker-compose.control-plane.yml up --build -d control-plane
```
3. 数据库迁移完成后，由数据库管理员在密钥管理系统中创建 `shuzhiren_runtime_worker`、`shuzhiren_channel_adapter` 和 `shuzhiren_alert_notifier` 三个独立的 `LOGIN NOINHERIT` 账号，再以控制面 schema owner 执行 `psql "$DATABASE_URL" -f infra/postgres/service-principals.sql`。该脚本不创建密码、不授予成员、商品、节目、素材、策略或审批表访问；adapter 仅能持久化 webhook 重放，notifier 仅能投递告警，worker 仅能处理运行时 outbox、状态、额度、告警和审计。将三个独立 URL 分别写入 `runtime.env` 的 `RUNTIME_WORKER_DATABASE_URL`、`channel-adapter.env` 的 `CHANNEL_ADAPTER_DATABASE_URL` 与 `alert-notifier.env` 的 `ALERT_NOTIFIER_DATABASE_URL`；部署预检会拒绝它们与控制面复用数据库用户名。准备 `RUNTIME_OBSERVER_TARGETS_DIR/runtime-observer-targets.json` 的私网目标清单后，再启动 Gateway、LiveTalking、CosyVoice 和 runtime worker。Compose 会等待 LiveTalking 会话接口与 Gateway `/healthz` 健康后才拉起 worker；worker 的 `/healthz` 会同时检查数据库和轮询循环，observer 的 `/healthz` 检查观测循环及目标清单健康，两者都必须健康。先观察这些健康状态，不能仅以容器 `running` 作为可开播依据。Gateway 也需要以相同的 `NVIDIA_VISIBLE_DEVICES` 读取只读 NVML 指标。实时问答场次必须启动 Compose `cosyvoice` profile 并设置 `COSYVOICE_REQUIRED=true`，再用 `--require-cosyvoice` 使部署预检拒绝缺失语音依赖；仅预制内容试播才可明确省略该门禁。真实场次必须额外启用 `docker compose --profile output-probe ... up`，并在启动前用 `npm run deploy:check -- ... --require-output-probe --require-cosyvoice` 校验目标和独立密钥：`output-probe` 用 ffprobe 检查视频/音频流、帧率、宽高和码率，并要求独立 `avSyncProbeUrl` 提供音画同步数值；若 target 配置了预期帧率或宽高，实际不符也返回 `503`，不会伪造成健康。
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

验收证据还必须包含独立输出音频活动探针的验证结论及其证据引用；只证明输出流存在音频轨不足以通过静音演练。

```bash
npm run runtime:acceptance:verify -- --evidence /srv/shuzhiren/evidence/runtime-acceptance.json
```

该门禁要求至少 240 分钟单路试播、单路数字人、最低输出 24 FPS、1280x720、2 Mbps、最高音画偏差 120 ms、有效输出探针及其独立证据、录屏证据，以及断网、RTMP 拒绝、GPU OOM、TTS 超时、黑屏和静音六类演练全部通过。还必须有 PostgreSQL 隔离恢复、Gateway 日志快照、Gateway 隔离恢复及恢复后已完成命令不重放的证据。模板占位符、口头结论或 `/healthz` 不能通过该校验。此文件是发布证据索引，不应写入流密钥、访问令牌、买家信息、原始音视频或私人 URL。
### 输出音频活动事实

从 2026-11-03 的运行时协议起，`runtime-observer` 的输出探针 JSON 必须包含布尔 `audioActive`。该值必须由独立输出音频分析器给出，不可由数字人或 TTS 进程自行声明；缺失、`false` 或探针不可达时均会 fail-closed，生成严重静音告警并受控降级。

仓库内 `output-probe` 已内置活动音频测量：它用 `ffmpeg silencedetect` 对配置的受控回放/中继流采样，并将结果作为 `audioActive` 返回给 observer。`avSyncProbeUrl` 仍必须由独立分析器提供真实 `avSyncMs`；不要让同一数字人进程同时充当被测媒体源和质量判定源。

### 已直播场次的模型/素材撤销

对已冻结在直播场次中的模型发布包或授权素材执行撤销，不只是阻止下一次预检：生产控制面会立即将所有仍为 `LIVE` 的关联场次隔离到 `DEGRADED`。已绑定运行时会话的场次会写入受控 `switch_to_human` 指令；撤销结果页面显示隔离数和实际入队接管数。值班人员应从场次时间线确认 `live_run.governance_quarantined` 审计事件和 outbox 投递结果，再依照对应的人工接管处置手册完成现场处置。没有绑定运行时会话的场次仍会被降级并记录审计，但不能把“没有可投递会话”误报为已完成接管。

# 4090 部署运行手册

本手册只覆盖 P0 内部试播。没有完成肖像、声音、脚本、商品和音乐的书面授权，不得部署到真实直播间。

## 1. 服务器基线

- Ubuntu 22.04 或兼容 Linux，单张 RTX 4090，建议至少 64 GB 内存和 1 TB NVMe。
- 已安装可用的 NVIDIA 驱动、Docker Engine、Docker Compose GPU 支持；`nvidia-smi` 必须可见 GPU。
- 仅对反向代理公开控制台；PostgreSQL、MinIO、Redis、Gateway 与 Worker 位于私网。
- 将模型、头像、录屏目录分别挂载到独立磁盘路径，不将权重、录屏或流密钥写入 Git。

先在仓库根目录执行只读主机预检。它检查 GPU 名称/显存、Docker NVIDIA runtime 和用于模型、镜像、录屏的可用磁盘空间；不会安装软件、拉取镜像或启动容器。

```bash
bash scripts/check-runtime-host.sh
```

默认要求单张 `RTX 4090`、至少 22 GiB 显存和 150 GiB 可用磁盘。租用方规格不同但已评估可用时，显式传入阈值，例如：

```bash
REQUIRED_GPU_NAME='RTX 4090D' MIN_FREE_GIB=250 bash scripts/check-runtime-host.sh
```

要额外证明容器能够看到 GPU，先独立核验并预拉一个带 `@sha256:` 摘要的 CUDA 镜像，再执行 `GPU_SMOKE_IMAGE=registry.example/cuda@sha256:... bash scripts/check-runtime-host.sh --container-smoke`。脚本不会因预检而下载不受控镜像。

## 2. 部署前配置

1. 使用 `git clone --recurse-submodules` 取得源码；既有工作目录执行 `git submodule update --init --recursive`。三套开源运行时必须保持为锁文件记录的提交，禁止在生产构建目录直接修改 vendor 源码。
2. 从 `config/*.example.env` 复制三份文件到服务器私有目录，填入真实值。
3. 控制面使用 `NODE_ENV=production`、`CONTROL_PLANE_DEMO_MODE=false`，并配置 OIDC issuer、audience、JWKS 和 PostgreSQL。浏览器同源调用可以使用 `OIDC_ACCESS_TOKEN_COOKIE`（默认 `shuzhiren_access_token`）承载短期 access token；该 cookie 必须由登录网关以 `HttpOnly`、`Secure`、`SameSite=Lax` 或更严格的属性签发，令牌本身不得写入前端存储。生产 Proxy 会在进入 API handler 前校验令牌租户和角色，包含按动作区分的生命周期权限；无权令牌必须收到 `403 insufficient_permission`，不能依赖前端隐藏按钮。Cookie 身份的写操作还必须携带同源或 `OIDC_ALLOWED_ORIGINS` 白名单中的 `Origin`，否则返回 `403 csrf_origin_rejected`；部署在反向代理后时应显式填写公开控制台域名白名单。
4. `RUNTIME_SHARED_TOKEN` 必须在运行时与 Gateway 中完全一致。控制面使用 `RUNTIME_TELEMETRY_TENANT_TOKENS`、`CHANNEL_INGEST_TENANT_TOKENS` 和 `CHANNEL_COMMERCE_TENANT_TOKENS` 三个 JSON 租户密钥映射；每个租户必须有不同的高熵 secret，运行时或渠道 Adapter 只能用自己租户的 token 上报。后两个凭据必须分别给评论接入与交易事件接入，不能共用，也不能给浏览器、前端 SDK 或平台网页直接使用。交易 Adapter 完成平台签名、时间戳、重放和限流验证后，只能提交不含买家 PII 的曝光、点击、加购、支付和退款事实；支付/退款会写入 append-only 审计。`RUNTIME_OBSERVER_TARGETS` 由运行时私密环境文件提供：每项必须包含 `tenantId`、`runId`、`sessionId`、同租户的 `telemetryToken` 与 `outputProbeUrl`，其 token 必须与控制面该租户的遥测密钥对应，不能复用为其他租户或浏览器 token。使用仓库内 `output-probe` 时，每项还应填写 `outputProbeToken`，并与 `OUTPUT_PROBE_SHARED_TOKEN` 匹配；该 token 只用于私网 observer 到探针的读取授权，不能作为控制面或渠道凭据。
5. 生产单卡保持 `LIVE_MAX_CONCURRENT_AVATARS=1`、`LIVE_ALLOW_LLM_FREEFORM=false`、高风险问题人工接管和 AI 标识开启。
6. `runtime.example.env` 的 `LIVETALKING_REF`、`MUSETALK_REF`、`COSYVOICE_REF` 必须逐项等于 `runtime/open-source.lock.json`；`npm run deploy:check` 还会读取 `vendor/` 下真实 Git HEAD 并拒绝脏源码。模型权重的许可证、人物和声音授权另行登记。
7. 在 Gateway 环境中配置 `PROGRAM_AUDIOTYPE`、`FALLBACK_AUDIOTYPE` 与 `HUMAN_HANDOFF_AUDIOTYPE`，并在 LiveTalking 的已批准 Avatar 包中逐项验证动作含义；不能将默认索引当作真实人接管或备用节目。
8. LiveTalking 建立会话后，将返回的 `sessionid` 通过 `PUT /api/v1/live-runs/{runId}/runtime-session` 绑定到场次；没有绑定运行时会话的场次不得接受媒体控制命令。
9. runtime worker 会按 `SCHEDULER_POLL_MS` 独立轮询已到排期时间的 `ARMED` 场次。每个场次先在独立数据库事务中创建唯一的 `start_program` outbox 并绑定到场次；手动 `START` 和 `RECOVER` 同样先保留在 `ARMED` 或 `DEGRADED`，只有 Gateway 确认该命令成功后，worker（或场控的单条恢复投递）才将场次切换为 `LIVE`。恢复还必须先通过 60 秒内的新鲜运行时健康校验。失败事件会保留为 `failed` 供重试，不会伪造“直播中”，也不会重复创建定时开播命令。每一轮最多领取 `SCHEDULER_BATCH_SIZE` 个，它不会自动武装场次，也不会跳过预检。
10. 渠道连接只能使用服务端注册的 Adapter 和 `kms://` 或 `secret://` 密钥引用。每次标记为 `connected`、`degraded` 或 `disabled` 都必须记录验证报告/工单引用；开播预检拒绝超过 24 小时的渠道验证。`generic-rtmp` 只证明受控推流通道，不代表已经完成平台 OAuth、评论、商品挂车或 Webhook 集成。
11. `audit_events` 在数据库层是 append-only：运行时账号不能更新或删除审计记录。用户注销、保留期或隐私请求必须走独立的合规数据处理流程，不能用普通业务 SQL 改写历史事件。
12. 租户业务表均启用并强制 PostgreSQL RLS。即使部署时应用数据库账号是表所有者，也必须在每个事务内设置 `app.tenant_id`；禁止为应用账号授予 `BYPASSRLS`。runtime worker 只能无范围读取 `tenants.id`，随后对每个租户分别设置该上下文并领取/回写任务，不能对业务表执行无租户范围的扫描。

## 3. 备份与恢复演练

- 目标：数据库 RPO 不高于 15 分钟，控制面 RTO 不高于 60 分钟。录屏和对象存储必须在生成后复制到已批准的站外存储；单机 Docker volume 不构成备份。
- `RECORDINGS_VOLUME_PATH` 必须是主机上加密、受访问控制、可备份的绝对路径。运行时 Compose 拒绝使用匿名录屏卷。
- 以下脚本只生成或验证 PostgreSQL 自定义格式归档，绝不执行恢复、覆盖数据库、自动轮转或删除任何历史备份。

创建并验证一次备份：

```bash
BACKUP_DIR=/srv/shuzhiren/backups/postgres \
POSTGRES_DB=shuzhiren POSTGRES_USER=shuzhiren \
bash scripts/backup-postgres.sh
```

校验已复制的归档，`EXPECTED_SHA256` 使用同名 `.manifest` 中的值：

```bash
BACKUP_FILE=/srv/shuzhiren/backups/postgres/shuzhiren-postgres-YYYYMMDDTHHMMSSZ.dump \
EXPECTED_SHA256=replace-with-manifest-sha256 \
bash scripts/verify-postgres-backup.sh
```

恢复只能在隔离的空数据库演练环境中由值班负责人执行：先创建独立数据库，人工检查 `pg_restore --list`，再以明确的目标数据库名执行 `pg_restore`。不得为方便而提供一键覆盖生产库的脚本。每月完成一次恢复演练，并将归档校验值、演练目标、开始/结束时间、RPO、RTO 和结果写入发布证据。

MinIO 对象、模型权重和录屏不由上述数据库脚本覆盖。上线前必须在对象存储层启用版本控制，并配置已验证的站外复制；在此之前不得把对象恢复能力表述为已完成。

示例结构检查：

```powershell
npm run deploy:check -- --allow-placeholders
```

真实配置检查：

```powershell
npm run deploy:check -- --control /srv/shuzhiren/control.env --runtime /srv/shuzhiren/runtime.env --gateway /srv/shuzhiren/gateway.env
```

## 4. 启动顺序

1. 启动 PostgreSQL、Redis、MinIO，运行 `npm run db:migrate`，再以控制面运行时账号执行 `npm run db:verify`。验证脚本只读检查迁移、关键表、RLS、租户上下文与账号权限；生产应用账号不得为超级用户或拥有 `BYPASSRLS`。仅在本地使用管理员账号进行排障时才可显式加 `-- --allow-privileged`。
2. 启动控制台和 OIDC 配置，确认 `/api/health` 与数据库健康接口正常。
3. 启动 Gateway、LiveTalking、CosyVoice（如启用）和 runtime worker。Compose 会等待 LiveTalking 会话接口与 Gateway `/healthz` 健康后才拉起 worker；先观察这两个健康状态，不能仅以容器 `running` 作为可开播依据。Gateway 也需要以相同的 `NVIDIA_VISIBLE_DEVICES` 读取只读 NVML 指标。只有启用 Compose `cosyvoice` profile 时才将 `COSYVOICE_REQUIRED=true`。若以受控中继或回放地址作为目的端证据，可额外启用 `docker compose --profile output-probe ... up`：`output-probe` 用 ffprobe 检查视频/音频流、帧率和码率，并要求独立 `avSyncProbeUrl` 提供音画同步数值；任一值缺失时返回 `503`，不会伪造成健康。
4. 用非公开推流地址进行 30 分钟内部试播；确认遥测到达、媒体 outbox 可投递、录屏生成和人工接管成功。
5. 执行 4 小时连续试播与断网、RTMP 拒绝、GPU OOM、TTS 超时、黑屏和静音演练后，才允许真实小规模场次。使用私网共享令牌调用 Gateway 的 `GET /v1/observations/{session_id}`，核验会话仍在、录制状态、进程内推理/输出 FPS 和 GPU 指标。该接口不能证明平台目的端接收、真实上行码率或音画同步；这些必须另行采集并人工核验，不能把 `/healthz` 或 writer 状态当作质量结论。
6. 为每个真实场次启动 `runtime-observer` 前，必须部署同网段、只读且已验收的输出探针。它返回的 JSON 仅允许包含布尔 `outputConnected`/`fallbackReady` 和非负数 `outputFps`/`avSyncMs`/`bitrateMbps`。断开该探针、停止 Gateway、终止输出或让其返回无效数据，均应在一个观测轮询周期内看到控制台告警和受控 `DEGRADED`；默认 `RUNTIME_OBSERVER_FAIL_CLOSED=true`，不要为掩盖监控故障改成 fail-open。除此之外，worker 每 `RUNTIME_WATCHDOG_POLL_MS` 检查 LIVE 场次，若最后样本超过 `RUNTIME_TELEMETRY_MAX_AGE_SECONDS`（默认 60 秒），会原子写入 `runtime_telemetry_stale` 告警、降级场次并将备用节目或人工接管命令写入 outbox；它绝不自动恢复为 LIVE。场次预检的“推流与备用节目”同样只认可该阈值内的健康遥测；历史 `output_ready` 字段不再可手工放行或阻塞预检。

## 5. 上线阻断项

- 控制台预检存在任一阻塞项。
- 运行时遥测缺失，或输出帧率低于 24 FPS、音画同步超过 120 ms、备用节目未就绪。
- 直播中发生推流断开、输出帧率低于 24 FPS 或备用节目未就绪时，必须由可验证的运行时观测器将场次切为 `DEGRADED` 并写入降级媒体指令；恢复直播必须由场控确认后执行，禁止自动反复恢复。当前锁定的开源运行时尚未暴露完整的目的端/FPS/音画同步指标，因此该观测器和试播验收是正式对外直播前的阻断项。
- 任何人物、声音、音乐、商品资料或脚本缺少授权与批准状态。
- 渠道连接未验证、验证无可审计证据，或最后验证超过 24 小时。
- 高风险问题没有人工场控值守与接管路径。
- 未完成 PostgreSQL 归档校验与隔离恢复演练，或录屏/对象存储没有受控的站外复制路径。

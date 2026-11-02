# 4090 部署运行手册

本手册只覆盖 P0 内部试播。没有完成肖像、声音、脚本、商品和音乐的书面授权，不得部署到真实直播间。

## 1. 服务器基线

- Ubuntu 22.04 或兼容 Linux，单张 RTX 4090，建议至少 64 GB 内存和 1 TB NVMe。
- 已安装可用的 NVIDIA 驱动、Docker Engine、Docker Compose GPU 支持；`nvidia-smi` 必须可见 GPU。
- 仅对反向代理公开控制台；PostgreSQL、MinIO、Redis、Gateway 与 Worker 位于私网。
- 将模型、头像、录屏目录分别挂载到独立磁盘路径，不将权重、录屏或流密钥写入 Git。

## 2. 部署前配置

1. 从 `config/*.example.env` 复制三份文件到服务器私有目录，填入真实值。
2. 控制面使用 `NODE_ENV=production`、`CONTROL_PLANE_DEMO_MODE=false`，并配置 OIDC issuer、audience、JWKS 和 PostgreSQL。浏览器同源调用可以使用 `OIDC_ACCESS_TOKEN_COOKIE`（默认 `shuzhiren_access_token`）承载短期 access token；该 cookie 必须由登录网关以 `HttpOnly`、`Secure`、`SameSite=Lax` 或更严格的属性签发，令牌本身不得写入前端存储。生产 Proxy 会在进入 API handler 前校验令牌租户和角色，包含按动作区分的生命周期权限；无权令牌必须收到 `403 insufficient_permission`，不能依赖前端隐藏按钮。Cookie 身份的写操作还必须携带同源或 `OIDC_ALLOWED_ORIGINS` 白名单中的 `Origin`，否则返回 `403 csrf_origin_rejected`；部署在反向代理后时应显式填写公开控制台域名白名单。
3. `RUNTIME_SHARED_TOKEN` 必须在运行时与 Gateway 中完全一致；`RUNTIME_TELEMETRY_TOKEN` 只给运行时上报控制面。
4. 生产单卡保持 `LIVE_MAX_CONCURRENT_AVATARS=1`、`LIVE_ALLOW_LLM_FREEFORM=false`、高风险问题人工接管和 AI 标识开启。
5. 固定 `runtime/open-source.lock.json` 中的提交；模型权重的许可证、人物和声音授权另行登记。
6. 在 Gateway 环境中配置 `PROGRAM_AUDIOTYPE`、`FALLBACK_AUDIOTYPE` 与 `HUMAN_HANDOFF_AUDIOTYPE`，并在 LiveTalking 的已批准 Avatar 包中逐项验证动作含义；不能将默认索引当作真实人接管或备用节目。
7. LiveTalking 建立会话后，将返回的 `sessionid` 通过 `PUT /api/v1/live-runs/{runId}/runtime-session` 绑定到场次；没有绑定运行时会话的场次不得接受媒体控制命令。
8. runtime worker 会按 `SCHEDULER_POLL_MS` 独立轮询已到排期时间的 `ARMED` 场次。每个场次都在独立数据库事务内切换为 `LIVE` 并写入 `start_program` outbox；每一轮最多领取 `SCHEDULER_BATCH_SIZE` 个，既不会重复开播，也不会让大批到期场次按单条轮询周期逐个积压。它不会自动武装场次，也不会跳过预检。

示例结构检查：

```powershell
npm run deploy:check -- --allow-placeholders
```

真实配置检查：

```powershell
npm run deploy:check -- --control /srv/shuzhiren/control.env --runtime /srv/shuzhiren/runtime.env --gateway /srv/shuzhiren/gateway.env
```

## 3. 启动顺序

1. 启动 PostgreSQL、Redis、MinIO，运行 `npm run db:migrate`，再以控制面运行时账号执行 `npm run db:verify`。验证脚本只读检查迁移、关键表、RLS、租户上下文与账号权限；生产应用账号不得为超级用户或拥有 `BYPASSRLS`。仅在本地使用管理员账号进行排障时才可显式加 `-- --allow-privileged`。
2. 启动控制台和 OIDC 配置，确认 `/api/health` 与数据库健康接口正常。
3. 启动 Gateway、LiveTalking、CosyVoice（如启用）和 runtime worker。Compose 会等待 LiveTalking 会话接口与 Gateway `/healthz` 健康后才拉起 worker；先观察这两个健康状态，不能仅以容器 `running` 作为可开播依据。只有启用 Compose `cosyvoice` profile 时才将 `COSYVOICE_REQUIRED=true`。
4. 用非公开推流地址进行 30 分钟内部试播；确认遥测到达、媒体 outbox 可投递、录屏生成和人工接管成功。
5. 执行 4 小时连续试播与断网、RTMP 拒绝、GPU OOM、TTS 超时、黑屏和静音演练后，才允许真实小规模场次。

## 4. 上线阻断项

- 控制台预检存在任一阻塞项。
- 运行时遥测缺失，或输出帧率低于 24 FPS、音画同步超过 120 ms、备用节目未就绪。
- 直播中发生推流断开、输出帧率低于 24 FPS 或备用节目未就绪时，控制面会将场次切为 `DEGRADED` 并写入降级媒体指令；恢复直播必须由场控确认后执行，禁止自动反复恢复。
- 任何人物、声音、音乐、商品资料或脚本缺少授权与批准状态。
- 高风险问题没有人工场控值守与接管路径。

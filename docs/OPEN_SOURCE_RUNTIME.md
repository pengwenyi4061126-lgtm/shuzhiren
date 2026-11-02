# 开源运行时接入

控制面不直接调用模型脚本。它把受策略和审核约束的媒体命令交给 `runtime-gateway`；Gateway 再调用开源服务，形成明确的权限边界。

```text
Console / Policy / Product Truth
             |
             | approved media command
             v
      Runtime Gateway (token protected)
        |                         |
        | /humanaudio             | /human fallback
        v                         v
  CosyVoice FastAPI ------> LiveTalking ------> RTMP / WebRTC
                                  |
                                  v
                             MuseTalk avatar
```

## 已固定的源码

源码快照以 Git submodule 存放在 `vendor/`，精确提交和许可证在 `runtime/open-source.lock.json`。部署主机必须使用 `git clone --recurse-submodules` 或执行 `git submodule update --init --recursive`；`npm run deploy:check` 会比对环境变量、锁文件和三个实际源码 HEAD，并拒绝未提交的 vendor 修改。当前锁定版本为：

- MuseTalk: `0a89dec45a0192b824e3cf4daf96c239440c5ed8`，MIT。
- CosyVoice: `074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc`，Apache-2.0。
- LiveTalking: `c7269433a2b6ecebcd9342445d2ecc882c98b0da`，Apache-2.0。

模型权重、真人形象和声音样本不进入 Git，也不会随源码下载。只在取得肖像、声音和模型许可证确认后放入服务器的受限目录。每个候选 runtime、口型驱动和语音发布包还必须登记可复查的验收证据引用和验收摘要；没有证据的发布包不能批准，也不能通过开播预检。

## 4090 服务器启动

1. Ubuntu 主机安装 NVIDIA 驱动、Docker Engine 与 NVIDIA Container Toolkit。
2. 将 `config/runtime-gateway.example.env` 复制为主机上的私密环境文件，并填入 RTMP、模型和形象的绝对路径。
3. 准备 LiveTalking/MuseTalk 所需权重到 `MODEL_VOLUME_PATH`，准备已授权 Avatar 到 `AVATAR_VOLUME_PATH`。
4. 先启动画面和回退 TTS：

```bash
docker compose --env-file /srv/shuzhiren/runtime.env -f infra/compose/docker-compose.runtime.yml up --build
```

5. 启用 CosyVoice 语音链路时使用 profile：

```bash
docker compose --profile cosyvoice --env-file /srv/shuzhiren/runtime.env -f infra/compose/docker-compose.runtime.yml up --build
```

CosyVoice 与 MuseTalk 同占一张 4090 时必须做真实压测。首版只开一个 Avatar 会话；如果长时间直播中显存、帧率或首包延迟不稳定，优先将 CosyVoice 改为第二 GPU 或独立语音服务，不能牺牲画面稳定性。

Compose 会先探测 LiveTalking `/api/admin/sessions`，再探测 Gateway `/healthz`；只有二者健康后才启动 runtime worker。首次载入模型时 LiveTalking 有 60 秒启动宽限，超过后仍不健康会保留失败状态而不是让 worker 盲目投递。CosyVoice 是可选 profile，只有显式设置 `COSYVOICE_REQUIRED=true` 才会把其不可用升级为 Gateway 健康失败。

## 控制面接口

- `GET /api/v1/runtime/health`：检查 Gateway 是否可用；本地开发返回 `demo`。
- `POST /api/v1/runtime/media`：向已存在的直播运行派发媒体命令。需要 `admin` 或 `operator`，且会写审计事件。
- `POST /api/v1/live-runs/{runId}/speech-dispatches`：只接收观众问题与幂等键，不接收自由播报文本。控制面仅在场次直播中、已绑定真实会话、冻结商品版本仍获批准且策略允许时，从已批准商品事实生成文案并写入 `speech.dispatch`；高风险问题仅返回人工接管结论，不会入队。
- Gateway 的 `POST /v1/speak`：必须带 outbox 生成的 `command_id`；默认走 CosyVoice -> WAV -> LiveTalking `/humanaudio`，`provider: "livetalking"` 才允许使用 LiveTalking 的回读模式。与媒体命令共用有界幂等缓存，网络重试不会重复播报相同语音。
- Gateway 的 `POST /v1/media`：只接受 `start_program`、`switch_to_fallback`、`switch_to_human`、`stop_program`。开播会选择 `PROGRAM_AUDIOTYPE` 并开始录制；回退和人工接管会先打断当前语音再切换到各自固定动作；结束会中断语音并结束录制。三个动作索引必须在已批准的 LiveTalking Avatar 包中配置。
- Gateway 的 `GET /healthz` 会实际请求 LiveTalking 的 `/api/admin/sessions`，而不是只检查环境变量；CosyVoice 通过 `/openapi.json` 探测。若 `COSYVOICE_REQUIRED=true`，CosyVoice 不可用会让 Gateway 健康检查返回 `503`。
- 该健康检查仅证明 Gateway 能连通已启动的开源服务，不证明 RTMP 目的端已收到视频、实际输出帧率/码率、音画同步或平台侧接收正常；这些必须由后续运行时观测器和试播验收分别证明，不能把 `200` 当作开播质量结论。
- 镜像构建会以 `runtime/patches/livetalking-observability.patch` 为外置补丁向固定的 LiveTalking 源码增加只读 `/api/admin/runtime-metrics`。Gateway 的受保护接口 `GET /v1/observations/{session_id}` 据此返回会话存活、说话/录制状态、进程内推理 FPS、RTMP writer 接收帧状态、配置码率和 GPU 利用率/显存；`npm run deploy:check` 会验证该补丁可以应用。RTMP writer 接收帧并不等于平台目的端收到视频，配置码率也不等于实测上行码率。
- `apps/runtime-observer` 是唯一允许将运行时观测写入控制面的常驻私网进程。它从 Gateway 读取会话/GPU事实，再从每个场次配置的私网输出探针读取 `outputConnected`、实测 `outputFps`、`avSyncMs`、`bitrateMbps` 和 `fallbackReady`，合并后调用控制面遥测入口。`RUNTIME_OBSERVER_TARGETS` 的每项必须绑定一个租户、场次、LiveTalking 会话、该租户独立遥测密钥和探针 URL；默认 fail-closed，Gateway、探针或遥测入口异常时上报断流并触发既有告警/降级逻辑。该探针是平台或中继 Adapter 的职责，不代表已经接通任一直播平台。
- 每个 `POST /v1/media` 必须带来自 outbox 的 `command_id`。Gateway 在有界 TTL 内对相同命令返回先前结果，拒绝同一 ID 的不同载荷，避免网络重试重复执行录制、切换或停止动作；数据库 outbox 仍保存长期投递状态和审计记录。
- 每个 `live_run` 必须先绑定 LiveTalking 创建时返回的真实 `sessionid`；媒体 outbox 将该绑定值作为下游会话参数，不能将控制面场次 UUID 直接当作 LiveTalking 会话 ID。

媒体与语音命令当前先写入开发态 outbox，再由投递接口发送；状态包含 `pending`、`delivering`、`delivered` 与 `failed`，重复投递保持幂等。`POST /api/v1/live-runs/:runId/speech-dispatches` 仅允许 `admin`/`operator` 发送 `{ question, idempotencyKey }`：控制面只会用冻结的已批准商品事实生成 `ready` 文案；高风险问题返回人工接管而不会创建 outbox。`idempotencyKey` 是安全 ID（UUID 可用）且同时作为语音命令 ID；同一租户重复提交会返回既有事件，而非再次播报。`speech.dispatch` 载荷必须包含运行时会话、命令 ID、播报文本、已批准声线和冻结商品版本证据；worker 只把它投给 Gateway 的 CosyVoice 链路。排期开播不会在创建 outbox 时直接标为 `LIVE`：`live_runs.scheduled_start_event_id` 绑定唯一开播事件，Gateway 成功确认后才切换状态；失败会保留 `ARMED` 与失败事件，供场控重试，避免“控制台显示已开播而推流没有启动”。生产 worker 将 `available_at` 作为领取租约：崩溃后超过 `OUTBOX_LEASE_SECONDS` 的 `delivering` 事件可被其他 worker 重领；失败按 `OUTBOX_RETRY_BASE_MS` 到 `OUTBOX_RETRY_MAX_MS` 指数退避，达到 `OUTBOX_MAX_ATTEMPTS` 后保留为 `failed` 并记录 `outbox.exhausted`。不能把网络调用塞进数据库事务或在状态转换后静默失败。

`apps/runtime-worker` 是生产投递器：它只从不承载业务数据的 `tenants` 表读取租户 ID，然后在每个领取、排期和状态回写事务中设置 `app.tenant_id`，再使用 `FOR UPDATE SKIP LOCKED` 处理该租户的待投递事件。轮询游标会在租户间轮转，避免一个租户的积压长期饿死其他租户；业务表仍受强制 RLS 保护，worker 不需要也不得拥有 `BYPASSRLS`。它调用 Gateway，并记录成功/失败和尝试次数，仅运行在私有网络，不接受浏览器请求。

控制台的“投递队列”只展示状态、尝试次数和最后错误，并提供场控确认后的单条“立即投递”。它不是替代 worker 的常规通道：有实际 Gateway 时才可验证人工恢复，重复请求会由 Gateway 的 `command_id` 幂等逻辑折叠。

## 平台评论接入边界

平台 Adapter 必须在自己的私网服务中完成平台要求的 Webhook 签名、时间戳、重放和限流验证，再使用 `CHANNEL_INGEST_TENANT_TOKENS` 中当前租户对应的独立 secret 调用控制面的 `POST /api/v1/runtime/channel-interactions`。该入口只接受租户、场次、已绑定渠道、平台事件 ID 和评论文本；服务端令牌先约束租户，再验证场次正在 `LIVE` 或 `DEGRADED`、渠道已连接且声明支持评论 Webhook，并以 `tenant + run + channel source + event ID` 数据库唯一索引去重。重复投递返回既有互动；相同平台事件 ID 但不同评论文本会返回 `409`，不能产生第二次播报或审计噪声。

首个 `normalized-webhook-rtmp` Adapter 只是受控的标准化桥接契约，不能被描述成已完成某个平台的 OAuth、评论或商品 API 集成。实际接入每个平台时仍必须分别实现签名校验、重放保护、错误码映射、限流、审核要求和验收证据。

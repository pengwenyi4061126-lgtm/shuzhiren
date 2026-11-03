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
2. 将 `config/runtime.example.env` 和 `config/runtime-gateway.example.env` 分别复制为主机上的私密 `runtime.env` 与 `gateway.env`，填入 RTMP、模型和形象的绝对路径。每次 Docker Compose 启动都必须同时加载这两个文件；前者提供 worker、observer 和输出探针配置，后者提供 Gateway、Avatar、录屏和 CosyVoice 模型配置。
3. 准备 LiveTalking/MuseTalk 所需权重到 `MODEL_VOLUME_PATH`，准备已授权 Avatar 到 `AVATAR_VOLUME_PATH`。
4. 先启动画面和回退 TTS：

```bash
docker compose --env-file /srv/shuzhiren/runtime.env --env-file /srv/shuzhiren/gateway.env -f infra/compose/docker-compose.runtime.yml up --build
```

5. 启用 CosyVoice 语音链路时使用 profile：

```bash
docker compose --profile cosyvoice --env-file /srv/shuzhiren/runtime.env --env-file /srv/shuzhiren/gateway.env -f infra/compose/docker-compose.runtime.yml up --build
```

CosyVoice 与 MuseTalk 同占一张 4090 时必须做真实压测。首版只开一个 Avatar 会话；如果长时间直播中显存、帧率或首包延迟不稳定，优先将 CosyVoice 改为第二 GPU 或独立语音服务，不能牺牲画面稳定性。仓库锁定的 `Fun-CosyVoice3-0.5B-2512` 输出原始 16-bit PCM 为 24 kHz，因此 Gateway 默认 `COSYVOICE_SAMPLE_RATE=24000` 并将 PCM 封装为 WAV 后投给 LiveTalking；切换模型前必须按该模型实际采样率显式修改此值并试听验收，不能沿用 22,050 Hz 造成音高和时长异常。`COSYVOICE_MODEL_PATH` 是宿主机权重目录，Compose 将它只读挂载到容器 `/opt/CosyVoice/CosyVoice/pretrained_models`；`COSYVOICE_MODEL_DIR` 必须写成该容器内的绝对模型路径，不能写相对路径。

Compose 会先探测 LiveTalking `/api/admin/sessions`，再探测 Gateway `/healthz`；只有二者健康后才启动 runtime worker。worker 的私网 `/healthz` 同时检查数据库连通性与轮询新鲜度，observer 的私网 `/healthz` 检查观测循环新鲜度；两者均使用 Compose 内部端口且带 `unless-stopped` 重启策略。首次载入模型时 LiveTalking 有 60 秒启动宽限，超过后仍不健康会保留失败状态而不是让 worker 盲目投递。CosyVoice 是可选 profile，只有显式设置 `COSYVOICE_REQUIRED=true` 才会把其不可用升级为 Gateway 健康失败。

`STREAM_FPS` 会实际传入 LiveTalking；当前锁定的 MuseTalk 路径要求 `25`，部署预检会拒绝其他值。画面分辨率由经过批准的 Avatar 源视频决定，当前开源运行时没有可安全覆盖它的通用启动参数，因此模板不提供看似有效但实际无效的 `STREAM_RESOLUTION` 开关。推流目的端的真实帧率、码率与分辨率仍必须由私网输出探针和试播验收测得。

## 控制面接口

`ENDED` 场次可由管理员或场控归档为 `ARCHIVED`。归档是终态整理动作，不删除录屏、审计、发布清单或其他证据。

- `GET /api/v1/runtime/health`：检查 Gateway 是否可用；本地开发返回 `demo`。
- `POST /api/v1/runtime/media`：仅允许对处于 `LIVE` 的场次发起受控的备用节目或人工接管；服务端只使用该场次已绑定的运行时会话，并将场次切至 `DEGRADED`。`START`、`RECOVER` 和 `END` 必须走场次命令接口，不能绕过预检、额度、状态机和 Gateway 确认。
- `POST /api/v1/live-runs/{runId}/speech-dispatches`：只接收观众问题与幂等键，不接收自由播报文本。控制面仅在场次直播中、已绑定真实会话、冻结商品版本仍获批准且策略允许时，从已批准商品事实生成文案并写入 `speech.dispatch`；高风险问题仅返回人工接管结论，不会入队。
- 每个声音授权资产还必须登记运行时声线标识。场次创建时冻结该资产，实际 `speech.dispatch` 只从冻结资产读取该标识；全局环境变量不能替换任何租户或场次的授权声线。声音资产撤销、到期或缺失标识时，播报会 fail-closed。
- Gateway 的 `POST /v1/speak`：必须带 outbox 生成的 `command_id`；默认走 CosyVoice -> WAV -> LiveTalking `/humanaudio`，`provider: "livetalking"` 才允许使用 LiveTalking 的回读模式。与媒体命令共用有界幂等缓存，网络重试不会重复播报相同语音。
- Gateway 的 `POST /v1/media`：只接受 `start_program`、`switch_to_fallback`、`switch_to_human`、`stop_program`。开播会选择 `PROGRAM_AUDIOTYPE` 并开始录制；回退和人工接管会先打断当前语音再切换到各自固定动作；结束会中断语音并结束录制。三个动作索引必须在已批准的 LiveTalking Avatar 包中配置。
- Gateway 的 `GET /healthz` 会实际请求 LiveTalking 的 `/api/admin/sessions`，而不是只检查环境变量；CosyVoice 通过 `/openapi.json` 探测。若 `COSYVOICE_REQUIRED=true`，CosyVoice 不可用会让 Gateway 健康检查返回 `503`。
- 该健康检查仅证明 Gateway 能连通已启动的开源服务，不证明 RTMP 目的端已收到视频、实际输出帧率/码率、音画同步或平台侧接收正常；这些必须由后续运行时观测器和试播验收分别证明，不能把 `200` 当作开播质量结论。
- 镜像构建会以 `runtime/patches/livetalking-observability.patch` 为外置补丁向固定的 LiveTalking 源码增加只读 `/api/admin/runtime-metrics`。Gateway 的受保护接口 `GET /v1/observations/{session_id}` 据此返回会话存活、说话/录制状态、进程内推理 FPS、RTMP writer 接收帧状态、配置码率和 GPU 利用率/显存；`npm run deploy:check` 会验证该补丁可以应用。RTMP writer 接收帧并不等于平台目的端收到视频，配置码率也不等于实测上行码率。
- `apps/runtime-observer` 是唯一允许将运行时观测写入控制面的常驻私网进程。它从 Gateway 读取会话/GPU事实，再从每个场次配置的私网输出探针读取 `outputConnected`、实测 `outputFps`、`avSyncMs`、`bitrateMbps` 和 `fallbackReady`，合并后调用控制面遥测入口。Compose 从 `RUNTIME_OBSERVER_TARGETS_DIR/runtime-observer-targets.json` 以只读目录挂载加载目标，并在文件内容原子替换后自动重载，不必重启 observer 或媒体服务；文件中的每项必须绑定租户、场次、LiveTalking 会话、该租户独立遥测密钥和探针 URL。可选 `outputProbeToken` 会作为 Bearer token 传给私网探针。只读目标文件无法读取、格式错误时 observer 保留最近有效清单但 `/healthz` 返回 `503`，使编排系统和遥测看门狗进入受控降级；恢复有效文件后自动恢复健康。直接运行二进制或本地测试才使用 `RUNTIME_OBSERVER_TARGETS` 环境 JSON。默认 fail-closed，Gateway、探针或遥测入口异常时上报断流并触发既有告警/降级逻辑。其 Compose 私网 `/healthz` 不替代任何输出事实。该探针是平台或中继 Adapter 的职责，不代表已经接通任一直播平台。
- `apps/output-probe` 是受控中继或可合法拉取的回放流的参考 Adapter，可通过 Compose `output-probe` profile 部署。它仅从启动时提供的环境配置读取目标 URL；HTTP 请求不能注入新 URL。服务用 `ffprobe` 读取音视频流、帧率、宽高和码率，并从独立的 `avSyncProbeUrl` 读取真实音画同步值；每个 target 可声明 `expectedFps` 及成对的 `expectedWidth`/`expectedHeight`，实际输出不匹配即返回 `503`。缺少音频、视频、帧率、码率或同步值同样返回 `503`，因此 observer 会 fail-closed。它不是平台私有回执的替代品；没有合法的回放/中继地址或平台回调时，必须维持不可开播状态。
- 每个 `POST /v1/media` 必须带来自 outbox 的 `command_id`。Gateway 在有界 TTL 内对相同命令返回先前结果，拒绝同一 ID 的不同载荷，避免网络重试重复执行录制、切换或停止动作；数据库 outbox 仍保存长期投递状态和审计记录。
- 每个 `live_run` 必须先绑定 LiveTalking 创建时返回的真实 `sessionid`；绑定接口会先通过 Gateway 读取会话事实，拒绝不存在的会话，且场次进入 `ARMED` 后不再允许重绑。当前 Compose 的 RTMP 单会话启动路径会创建固定 `sessionid` `0`；同一个会话在 `PREFLIGHT`、`ARMED`、`LIVE` 或 `DEGRADED` 状态只能被一个场次占用，结束或归档即释放。媒体 outbox 将该绑定值作为下游会话参数，不能将控制面场次 UUID 直接当作 LiveTalking 会话 ID。

媒体与语音命令先写入内存（开发）或 PostgreSQL（生产）outbox，再由投递器发送；状态包含 `pending`、`delivering`、`delivered`、`failed` 与仅用于取消待启动事件的 `cancelled`，重复投递保持幂等。`POST /api/v1/live-runs/:runId/speech-dispatches` 仅允许 `admin`/`operator` 发送 `{ question, idempotencyKey }`：控制面只会用冻结的已批准商品事实生成 `ready` 文案；高风险问题返回人工接管而不会创建 outbox。`idempotencyKey` 是安全 ID（UUID 可用）且同时作为语音命令 ID；同一租户重复提交会返回既有事件，而非再次播报。`speech.dispatch` 载荷必须包含运行时会话、命令 ID、播报文本、已批准声线和冻结商品版本证据；worker 只把它投给 Gateway 的 CosyVoice 链路。排期开播、手动 `START` 和 `RECOVER` 都不会在创建 outbox 时直接标为 `LIVE`：`live_runs.scheduled_start_event_id` 绑定唯一待确认的激活事件，Gateway 成功确认后才切换状态；`RECOVER` 还必须通过最新运行时健康校验。场控可把尚未投递或已失败的待启动事件取消，场次回到 `PREFLIGHT` 并释放待确认开播占用；正在 `delivering` 的事件不可取消，必须等待本轮投递结束后再处置。`END` 也会保留 `LIVE` 或 `DEGRADED`，用独立 `pending_media_event_id` 锁定唯一停止事件，只有 `stop_program` 被 Gateway 确认后才切换为 `ENDED`。失败事件保留原状态和失败原因，指挥台会提示场控进入投递队列确认重试，避免“控制台显示已开播/已结束而媒体未执行”。生产 worker 将 `available_at` 作为领取租约：崩溃后超过 `OUTBOX_LEASE_SECONDS` 的 `delivering` 事件可被其他 worker 重领；失败按 `OUTBOX_RETRY_BASE_MS` 到 `OUTBOX_RETRY_MAX_MS` 指数退避，达到 `OUTBOX_MAX_ATTEMPTS` 后保留为 `failed` 并记录 `outbox.exhausted`。不能把网络调用塞进数据库事务或在状态转换后静默失败。

`apps/runtime-worker` 是生产投递器：它只从不承载业务数据的 `tenants` 表读取租户 ID，然后在每个领取、排期、健康看门狗和状态回写事务中设置 `app.tenant_id`，再使用 `FOR UPDATE SKIP LOCKED` 处理该租户的待投递事件。轮询游标会在租户间轮转，避免一个租户的积压长期饿死其他租户；业务表仍受强制 RLS 保护，worker 不需要也不得拥有 `BYPASSRLS`。健康看门狗每 `RUNTIME_WATCHDOG_POLL_MS` 扫描 LIVE 场次，最后遥测超过 `RUNTIME_TELEMETRY_MAX_AGE_SECONDS` 时只执行一次原子降级：打开 `runtime_telemetry_stale` 告警、写审计、并将切备用或人工接管命令写入 outbox。新遥测会关闭该告警，但不会自动把场次恢复为 LIVE。它调用 Gateway，并记录成功/失败和尝试次数；仅在 Compose 私网暴露 `/healthz`，该端点同时检查数据库和轮询新鲜度，不接受业务命令或浏览器流量。

控制台的“投递队列”只展示状态、尝试次数和最后错误，并提供场控确认后的单条“立即投递”。它不是替代 worker 的常规通道：有实际 Gateway 时才可验证人工恢复，重复请求会由 Gateway 的 `command_id` 幂等逻辑折叠。

## 平台评论接入边界

平台 Adapter 必须在自己的私网服务中完成平台要求的 Webhook 签名、时间戳、重放和限流验证，再使用 `CHANNEL_INGEST_TENANT_TOKENS` 中当前租户对应的独立 secret 调用控制面的 `POST /api/v1/runtime/channel-interactions`。该入口只接受租户、场次、已绑定渠道、平台事件 ID 和评论文本；服务端令牌先约束租户，再验证场次正在 `LIVE` 或 `DEGRADED`、渠道已连接且声明支持评论 Webhook，并以 `tenant + run + channel source + event ID` 数据库唯一索引去重。重复投递返回既有互动；相同平台事件 ID 但不同评论文本会返回 `409`，不能产生第二次播报或审计噪声。

首个 `normalized-webhook-rtmp` Adapter 只是受控的标准化桥接契约，不能被描述成已完成某个平台的 OAuth、评论或商品 API 集成。实际接入每个平台时仍必须分别实现签名校验、重放保护、错误码映射、限流、审核要求和验收证据。

仓库还提供 `apps/channel-adapter` 作为私网参考桥接服务：使用 `CHANNEL_ADAPTER_TARGETS` 中每个渠道独立的 HMAC secret，对 `x-shuzhiren-timestamp`、`x-shuzhiren-event-id` 和 `x-shuzhiren-signature` 校验五分钟时间窗与正文签名。无效签名不会消耗渠道速率额度；服务先把事件 ID 和正文 SHA-256 以持久化 `delivering/delivered` 状态写入 PostgreSQL，再只对首次需要出站的已验证事件计入本地限流。已投递的重试不会被限流误伤；被限流的新事件会释放本次租约，使平台可以稍后安全重试。租约内同一事件只允许一个实例出站，异常后可在租约到期安全重试，正文不同的重用 ID 会被拒绝。它还按渠道执行 `CHANNEL_ADAPTER_MAX_REQUESTS_PER_MINUTE` 本地速率上限；多副本部署仍必须由反向代理或平台网关提供全局限流。`/healthz` 会查询 PostgreSQL，数据库不可用时返回失败，不能只因进程存活而显示健康。它只接受标准化的 `interaction` 或 `commerce` JSON，不是任何真实平台的签名算法实现。通过 `docker compose --profile channel-adapter --env-file /srv/shuzhiren/runtime.env --env-file /srv/shuzhiren/gateway.env --env-file /srv/shuzhiren/channel-adapter.env -f infra/compose/docker-compose.runtime.yml up --build` 启动，必须放在完成平台验签或由平台直连的受控反向代理之后；不可把其 HMAC secret、控制面服务 token 或数据库地址交给浏览器。未启用的可选 profile 不会因缺少其自身目标变量阻塞基础 Compose 解析；一旦启用，服务会拒绝空目标配置。
### 渠道 Adapter 凭据对应关系

每个 `CHANNEL_ADAPTER_TARGETS` 项的 `interactionToken` 必须等于控制面 `CHANNEL_INGEST_TENANT_TOKENS` 中同一租户的值，`commerceToken` 必须等于 `CHANNEL_COMMERCE_TENANT_TOKENS` 中同一租户的值。部署预检会拒绝不一致配置，避免服务看似启动正常但每一次下游回调都被控制面拒绝。

### 输出探针当前契约

输出探针除连接、帧率、同步、码率和备用节目事实外，还必须返回布尔 `audioActive`，且该值由独立输出音频分析器测得。缺失该字段、返回 `false` 或探针不可用均会被 observer fail-closed 上报；控制面据此打开 `audio_silence` 严重告警并进入降级，而不是把“存在音频流”误认为正在发声。

仓库内 `output-probe` 现已使用容器内的 `ffmpeg silencedetect` 在配置的受控输出流上直接测量 `audioActive`；`avSyncProbeUrl` 只需要提供真实 `avSyncMs`。默认采样 5 秒，将从采样起点持续 2 秒以上且没有恢复的低于 -50 dB 音频判为静音；这三个阈值只能由运行时私密环境配置调整，不能由 HTTP 请求注入。

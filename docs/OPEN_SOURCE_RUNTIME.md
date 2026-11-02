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

源码快照在 `vendor/`，精确提交和许可证在 `runtime/open-source.lock.json`。当前锁定版本为：

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
- Gateway 的 `POST /v1/speak`：默认走 CosyVoice -> WAV -> LiveTalking `/humanaudio`，`provider: "livetalking"` 才允许使用 LiveTalking 的回读模式。
- Gateway 的 `POST /v1/media`：只接受 `start_program`、`switch_to_fallback`、`switch_to_human`、`stop_program`。开播会选择 `PROGRAM_AUDIOTYPE` 并开始录制；回退和人工接管会先打断当前语音再切换到各自固定动作；结束会中断语音并结束录制。三个动作索引必须在已批准的 LiveTalking Avatar 包中配置。
- Gateway 的 `GET /healthz` 会实际请求 LiveTalking 的 `/api/admin/sessions`，而不是只检查环境变量；CosyVoice 通过 `/openapi.json` 探测。若 `COSYVOICE_REQUIRED=true`，CosyVoice 不可用会让 Gateway 健康检查返回 `503`。
- 每个 `POST /v1/media` 必须带来自 outbox 的 `command_id`。Gateway 在有界 TTL 内对相同命令返回先前结果，拒绝同一 ID 的不同载荷，避免网络重试重复执行录制、切换或停止动作；数据库 outbox 仍保存长期投递状态和审计记录。
- 每个 `live_run` 必须先绑定 LiveTalking 创建时返回的真实 `sessionid`；媒体 outbox 将该绑定值作为下游会话参数，不能将控制面场次 UUID 直接当作 LiveTalking 会话 ID。

媒体命令当前先写入开发态 outbox，再由投递接口发送；状态包含 `pending`、`delivering`、`delivered` 与 `failed`，重复投递保持幂等。生产数据库迁移已包含 `outbox_events`，租机前要将同一 Repository 接到 PostgreSQL，并由独立 Worker 轮询或消费队列。不能把网络调用塞进数据库事务或在状态转换后静默失败。

`apps/runtime-worker` 是生产投递器：它用 `FOR UPDATE SKIP LOCKED` 从 PostgreSQL 领取待投递事件，调用 Gateway，并记录成功/失败和尝试次数。Worker 使用部署侧数据库连接，仅运行在私有网络，不接受浏览器请求。

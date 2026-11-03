# 高拟真 4090 直播架构

## 1. 技术选型

| 责任 | 选型 | 原因 | 不负责 |
| --- | --- | --- | --- |
| 实时编排 | LiveTalking | 有直播数字人与多后端集成能力，适合作为媒体会话适配层 | 商品事实、运营策略 |
| 人像驱动 | MuseTalk | 真人素材口型同步效果适合半身固定镜头 | 直播导演、商品问答 |
| 语音合成 | CosyVoice | 中文语音能力和本地部署选择 | 未授权声音克隆 |
| 对话与检索 | 可替换 LLM + RAG | 按商品事实和规则生成受控回答 | 直接决定价格、库存和活动 |
| 推流 | FFmpeg / OBS | RTMP、字幕、录屏与故障恢复成熟 | 生成数字人画面 |
| 控制台 | Web Control Plane | 场控、审核、插播、接管、告警 | 直接承载 GPU 推理 |

LiveTalking、MuseTalk、CosyVoice 都必须固定到经审核的版本和模型清单。代码许可证不等于人物、声音、权重、训练素材或音乐具有商用权。

## 2. 三平面设计

### 媒体平面

媒体平面必须以连续推流稳定性为第一优先级。

1. `Asset Library` 存放已审核的人物原始视频、预制商品片段、BGM 和字幕模板。
2. `Playlist Director` 根据场次、SKU 和运营指令输出节目单。
3. `Avatar Worker` 处理实时语音到嘴型视频；单卡模式只允许单路实时会话。
4. `Media Switcher` 在预制片段、实时数字人与真人接管间无黑屏切换。
5. `Streamer` 负责水印、AI 标识、录屏分段、RTMP 和重连。

### 决策平面

决策平面不得直接控制媒体生成，而只生成已审核的动作请求。

- `Product Truth Service`：返回带版本的 SKU、价格、库存、赠品、物流、资质和售后事实。
- `Policy Engine`：识别医疗、金融、功效、低价、投诉、敏感和超出知识库的问题。
- `Conversation Director`：决定回答、播放片段、追问、拒答或转人工。
- `LLM Gateway`：封装模型调用、提示词版本、限速、超时和审计。

### 控制与审计平面

- 场控界面必须有：开始/暂停、切真人、插播片段、静音、结束推流、人工回复、风险告警。
- 每条回答保存：商品数据版本、规则版本、检索证据、模型版本、生成文本和最终媒体片段 ID。
- 每场保存：录屏、互动事件、推流状态、告警和人工接管记录。

## 3. 直播状态机

```text
DRAFT -> REVIEW -> APPROVED -> PREFLIGHT -> ARMED
                                             |  |
                                  disarm ----+  +-- START acknowledged --> LIVE
                                             |                             |  |
                                             +-----------------------------+  +-- PAUSE / HANDOFF / watchdog --> DEGRADED
                                                                                                              |       |
                                                                                              RECOVER acknowledged --+       +-- END acknowledged --> ENDED -> ARCHIVED
                                                                                                                      |
                                                                                                                      +-----------------------------> LIVE
```

`LIVE` 的入口条件：商品数据版本有效、直播脚本已审核、GPU 健康、推流可用、AI 标识已启用，并且 `START` 已收到 Gateway 确认。`RECOVER` 和 `END` 同样必须先收到 Gateway 确认才改变场次状态。`ARMED` 的待启动事件只有在 `pending` 或 `failed` 时可由场控取消；取消后回到 `PREFLIGHT`，而正在投递的事件必须等待本轮结果。`ARCHIVED` 是保留审计、录屏与发布清单的终态，不是删除操作。任何一个关键条件失效时，进入 `DEGRADED`、预制内容或人工接管，不让 LLM 继续自由回复。

## 4. 单张 4090 部署策略

单卡方案不是全功能并行方案。建议把 GPU 作为视觉设备：

- MuseTalk 单独进程，设置显存上限、单会话队列和健康检查。
- TTS 优先批量合成短句并缓存；高峰时不得和视频推理无限并发。
- ASR 可用 CPU 或独立低显存设备运行。
- LLM 用独立服务；若必须本地运行，使用量化小模型并限制请求串行化，必要时暂停实时口型任务。
- 强制保留显存余量；出现 OOM 时立即切到预制片段，而非重启整个直播。

第二张 GPU 的优先级高于把 720p 升到 1080p：GPU 0 固定给 MuseTalk，GPU 1 给 LLM/TTS/ASR，系统的尾延迟和稳定性会更可控。

## 5. 商品回答协议

LLM 只能输出下列结构化决策：

```json
{
  "action": "answer | play_clip | handoff | refuse",
  "sku_id": "string",
  "evidence_ids": ["product-versioned-source"],
  "script_id": "approved-script-or-null",
  "text": "approved-or-generated-text",
  "risk_level": "low | medium | high"
}
```

价格、库存、优惠、功效、赠品、售后和物流必须通过工具读取后写入回答；无证据或高风险内容必须 `handoff` 或 `refuse`。

## 6. 验收指标

P0 和 P1 不以“像真人”作为唯一验收标准：

- 连续推流 4 小时无人工重启。
- 单路 720p、25 FPS 下无持续音画漂移。
- 切片、实时互动和人工接管均可回到预制内容。
- 价格/库存/赠品问答 100% 可追溯到商品数据版本。
- 高风险测试集不得产生未经证据支持的功效、价格或售后承诺。
- 每场具备可回放视频与可检索审计记录。

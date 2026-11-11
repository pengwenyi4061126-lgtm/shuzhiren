# Shuzhiren

单张 RTX 4090 的高拟真数字人直播系统设计。系统以真人录制的商品内容为主，以实时数字人承担受控互动，而非承诺全自动无人带货。

## 设计结论

推荐技术路线不是让一个模型承担全部直播任务，而是分层：

- **稳定成交层**：经过审核的真人商品讲解片段，按商品、价格和活动编排。
- **实时互动层**：LiveTalking 负责编排；MuseTalk 驱动授权真人形象；CosyVoice 生成授权声线。
- **商业事实层**：价格、库存、SKU、赠品、资质和售后只能来自受审核的数据服务，LLM 不得自行编造。
- **人工控制层**：场控可暂停、插播、切换真人和接管高风险问题。

项目设计、部署边界和实施计划见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)、[docs/PRODUCT_BLUEPRINT.md](docs/PRODUCT_BLUEPRINT.md)、[docs/GLOBAL_BENCHMARK_GAP_ANALYSIS.md](docs/GLOBAL_BENCHMARK_GAP_ANALYSIS.md) 与 [docs/DELIVERY_PLAN.md](docs/DELIVERY_PLAN.md)。

开源运行时已按源码锁定并接入统一网关；具体目录、接口和 4090 部署步骤见 [docs/OPEN_SOURCE_RUNTIME.md](docs/OPEN_SOURCE_RUNTIME.md)。

4090 服务器的部署前配置校验、控制台/GPU 运行时启动顺序与试播阻断项见 [docs/DEPLOYMENT_RUNBOOK.md](docs/DEPLOYMENT_RUNBOOK.md)。控制台提供 Next standalone 镜像和默认回环绑定的 Compose；真实环境变量准备好后先运行 `npm run deploy:check`，再启动服务。

## 一张 4090 的生产边界

| 能做 | 不应承诺 |
| --- | --- |
| 单路 720p、半身、固定镜头的 MuseTalk 数字人 | 高保真 1080p 全身、多角色并发 |
| 预制讲品片段 + 实时欢迎/FAQ/SKU 切换 | 24 小时完全无人值守 |
| 商品数据检索、规则化回答、人工接管 | LLM 自由生成价格、功效和售后承诺 |
| 本地推流和录屏审计 | 同一张 GPU 同时稳定运行高质量视频、大 LLM 和多个会话 |

单卡配置中，4090 优先专供 MuseTalk 视频驱动。LLM 建议先使用受控 API 或独立第二卡；不要让视频驱动与本地 LLM 在直播时抢显存。

## 目标架构

```text
已审核商品资料 / 价格库存 / 禁说规则
                    |
          Product Truth Service
                    |
评论、语音 ---> Director + Policy Engine ---> 话术 / 转人工
                    |                              |
              场控控制台                         CosyVoice
                    |                              |
预制真人片段 ----> Media Switcher <---- MuseTalk / LiveTalking
                    |
          字幕、AI 标识、录屏、FFmpeg
                    |
                RTMP / 平台直播间
```

## 上线前的必备输入

- Linux 4090 服务器的 SSH 访问；当前验收基线为 Ubuntu 24.04、NVIDIA 驱动和 Docker 已就绪。生产部署仍须满足至少 150 GiB 可用磁盘；本轮 4090 GPU Docker smoke 已通过，但当前主机约 78 GiB 可用，因此不能标记为生产验收通过（[V-20261111-03](docs/VERIFICATION_LOG.md#v-20261111-03)、[V-20261111-07](docs/VERIFICATION_LOG.md#v-20261111-07)；外部证据的治理判定仍为“未验证”）。
- 目标平台合法推流地址和 Stream Key。Stream Key 只写入 `STREAM_KEY_FILE` 指向的只读文件，不写入任何 env 文件（见 Runbook 2.3 节）。
- 对真人肖像、声音、商品图片、音乐和脚本的书面授权。
- 所用模型权重的许可证确认。语音全部由 CosyVoice 合成后经 LiveTalking `/humanaudio` 注入，LiveTalking 以 `--tts none` 运行，不调用 edge-tts 等在线语音服务。
- CosyVoice 模型类型 `COSYVOICE_MODEL_KIND`（`sft` 或 `zero_shot`；锁定的 Fun-CosyVoice3 只能用 `zero_shot`）和只读声线库 `COSYVOICE_VOICE_LIBRARY_PATH`：每个已批准声线一个 `<runtime_voice_id>/` 目录，含 `prompt.wav` 与 `prompt.txt`（Fun-CosyVoice3 的 prompt 文本须含 `<|endofprompt|>`）。准备步骤见 Runbook 2.5 节；从旧版本升级前须按 2.6 节排空旧的 `media.dispatch`/`speech.dispatch` 事件。

## 许可证与授权

仓库根目录没有 `LICENSE` 文件，仓库自有代码的分发许可证需仓库所有者确认。第三方开源组件（LiveTalking、CosyVoice、Matcha-TTS、MuseTalk）的锁定提交、许可证、LiveTalking 修改说明，以及部署时挂载的模型权重见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

模型权重、数字人形象和声线素材都不在仓库中，部署方需自行取得：每组权重的许可证与商业使用确认、人物肖像的本人书面授权，以及 `zero_shot` 声线库中每段参考音频的声音本人书面授权。清单见 [docs/DEPLOYMENT_RUNBOOK.md](docs/DEPLOYMENT_RUNBOOK.md) 第 7 节。这些授权与审查结论由部署方在仓库之外留存。
- SKU 主数据：价格、库存、规格、赠品、资质、售后、禁说项和 FAQ。
- 场控负责人及高风险问题的人工接管规则。

## 下一步

1. 当前 P0 的 Ubuntu 24.04 + Docker + RTX 4090 GPU smoke 和短时内部运行链路已完成（[V-20261111-02](docs/VERIFICATION_LOG.md#v-20261111-02)、[V-20261111-03](docs/VERIFICATION_LOG.md#v-20261111-03)；外部证据的治理判定仍为“未验证”）；继续补齐真实模型、授权素材、正式 RTMP/output-probe 与 4090 实机验收。
2. 继续收敛 P1/P2：同一个内容项目分别生成可审核录播和受控实时直播，保留商品、脚本、形象、声线和审核记录的版本追溯。
3. 通过 4 小时连续开播、故障演练和目标平台输出证据后，再进入生产放行；实时 RAG 仍必须服从商品事实和策略治理。

## 当前实现状态

阶段 1 已完成；阶段 2 至 6 的控制面、治理、Gateway、观测、告警、渠道标准化接入、用量门禁和多租户框架已经落在仓库中。控制台代码位于 `apps/console`，开源运行时入口位于 `runtime/gateway` 与 `infra/compose`。`scripts/acceptance/` 提供只读优先的 GPU Compose 网络、LiveTalking 会话 `"0"` 和显式执行验收入口；本机代码与合同测试已通过，证据见 `docs/VERIFICATION_LOG.md#v-20261110-01`。当前远程 Ubuntu 24.04 + RTX 4090 主机的 Docker GPU smoke 已通过（[V-20261111-03](docs/VERIFICATION_LOG.md#v-20261111-03)、[V-20261111-07](docs/VERIFICATION_LOG.md#v-20261111-07)；外部证据的治理判定仍为“未验证”）：容器内 `nvidia-smi` 可见 RTX 4090，运行时容器健康，内部 RTMP/短时会话也已有记录；但可用磁盘约 78 GiB，低于 150 GiB 生产门槛，所以真实 4090 输出仍按就绪矩阵单列。首个目标直播平台已定为抖音（D1，2026-11-05），抖音的 OAuth/Webhook/商品同步/账单 Adapter 尚未实现（RW-040-01 至 RW-040-04：代码未完成，需另立规格）。真实 RTMP/output-probe、4090 画面观感、4 小时连续开播、真实模型/授权素材、签名 release/OIDC/对象存储以及结算对账仍是部署方必须接入并留存证据的外部工作，不能用开发态或模拟服务替代。

P0 新增的三项功能（各项状态以就绪矩阵为准，部署说明见 Runbook 2.12 至 2.14 节）：

- 默认预设库：迁移 082 的平台级预设目录（两个默认声音、一个形象槽位）、`/api/v1/presets` 与资产页“从默认库添加”。仓库不附带任何声音或形象素材，三条预设都标为“商用授权未核实”；使用前须取得授权素材并核实权重许可证（EP-16）。sft 默认声音另需自带“中文女”“中文男”说话人的 CosyVoice 权重，并在 4090 上运行。
- AIGC 标识：LiveTalking 在每一帧推流和录制画面上叠加显式标识，开播前检查核对运行时报告的标识文字，release manifest 与录制登记保存隐式标识元数据。画面实机核验需要 4090 与抖音观看端（RW-000-12），标识是否满足《人工智能生成合成内容标识办法》与 GB 45438-2025 及抖音审核要求，需要法务和平台确认（EP-15）。
- 互动规则引擎：runtime-worker 按已批准的规则，对观众进场、关注、礼物、评论关键词以及定时、冷场触发生成话术，经策略引擎判定后写入语音 outbox 或回复草稿，默认规则含定时播报的 AI 身份提示。接收真实抖音事件需要抖音开放平台的直播互动数据权限（EP-17）和仓库中尚未编写的抖音 Webhook Adapter（RW-040-02）；在此之前只能用归一化 Webhook 模拟。

完整阶段状态见 [docs/IMPLEMENTATION_ROADMAP.md](docs/IMPLEMENTATION_ROADMAP.md)，代码和外部上线条件见 [docs/DEPLOYMENT_READINESS.md](docs/DEPLOYMENT_READINESS.md)。

本地依赖安装完成后使用：

```powershell
npm install
npm run dev
```

`npm run dev` 只绑定 `127.0.0.1`，并启用仅供本机开发的请求头身份。需要本地 PostgreSQL、Redis、MinIO 时，先把 `config/dev-compose.example.env` 复制为 `infra/compose/.env` 并替换其中的值，见 Runbook 第 8 节。

数据库迁移仅在已配置 `DATABASE_URL` 的环境执行：

商品事实以不可变版本管理；节目版本通过 `show_revision_product_versions` 冻结所使用的 SKU 版本。开播预检和 `START` 指令都会验证这些版本仍处于已批准状态。

```powershell
npm run db:migrate
```

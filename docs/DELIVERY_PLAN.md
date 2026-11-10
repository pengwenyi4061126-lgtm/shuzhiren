# 实施计划与交付边界

## 总目标

把桌面版产品收敛为一条小白可操作的内容生产闭环：**一个内容项目，两个输出**。

1. **内容项目**：素材、授权信息、数字人形象、商品事实、脚本、声音、画面层和审核记录在同一项目内组织。
2. **实时直播输出**：冻结项目版本后，创建并绑定一个直播场次，经过运行时预检、预览审核、RTMP 输出、监测、录制与复盘。
3. **录播视频输出**：复用同一项目的审核素材、商品事实和脚本，生成可预览、可下载、可归档的成片，不依赖直播场次。

完成标准不是页面能打开，而是上述两条输出各自有可追溯的输入、审核、产物与运行记录；直播输出另需通过 4090 实机和目标端试播验收。

## 本轮检查点（2026-11-10）

### 已具备的仓库能力

- `/studio` 已形成项目工作台：项目选择、素材上传与审核、商品事实、脚本生成与审核、照片口播录播、数字人形象构建/审核/发布、直播草稿与 AI 身份提示规则均在同一界面路径中。
- 本机 `npm run verify:local` 的最终结果为 `PASS  local verification completed (94 checks; PostgreSQL, Docker, GPU, and platform acceptance are intentionally external; 53 CI verification steps not run locally are listed above; add --with-gateway --python after installing runtime/gateway/requirements.txt to verify Gateway Python)`，退出码为 `0`（[V-20261110-01](VERIFICATION_LOG.md#v-20261110-01)）。
- `/studio` 的 HTTP GET 返回 `200`；生产构建列出了 Studio、录播、直播场次、脚本播放、形象构建与预览授权对应的路由（[V-20261110-01](VERIFICATION_LOG.md#v-20261110-01)）。
- 远程 GPU 主机最新实测为 Ubuntu 24.04、RTX 4090（24,564 MiB 显存）、Driver 595.99.02、Docker 29.1.3，NVIDIA runtime 可用；当前可用磁盘约 106 GiB，低于本项目 150 GiB 门槛，因此这台主机仍不是完整生产验收通过环境（[V-20261111-03](VERIFICATION_LOG.md#v-20261111-03)）。
- 2026-11-11 在同一类 4090 主机上完成了 Avatar Builder 的真实短视频冒烟：数据库锁连接、上传、GPU 预处理、候选预览、完整性清单和 Publisher 发布均通过；详细证据见 [V-20261111-01](VERIFICATION_LOG.md#v-20261111-01)。该条不替代 LiveTalking/CosyVoice/Gateway 全量运行、RTMP 目标端和长时开播验收。

### 4090 实机镜像构建结果

- `shuzhiren/livetalking:00350f2` 已在 4090 主机构建完成，镜像 ID 为 `sha256:c891ce912e01492dc36d842d939bb1ae30a7c90e21ae98e9747e4a743afa7275`。镜像内的 LiveTalking `LICENSE`、项目修改说明分别与源码 SHA-256 一致；`torch 2.9.1+cu128`、`shuzhiren_overlay` 导入通过，并实际报告 `CUDA=True` 与 `NVIDIA GeForce RTX 4090`。
- `shuzhiren/cosyvoice:00350f2` 已在同一主机构建完成，镜像 ID 为 `sha256:b891657a2ff33f327199262d188ba374756c7168cc767663b6edb27a503bbc86`，OCI revision 为 `88d4630726aafbbf178d0302aa0763f02c610f75`。CosyVoice 与 Matcha-TTS 的许可证文件均与源码 SHA-256 一致；`torch 2.3.1+cu121` 与 `AutoModel` 导入通过，并实际报告 `CUDA=True` 与同一张 RTX 4090。
- 当前镜像是主机本地标签，尚未写入带签名证明的镜像仓库，也尚未挂载模型、声线或形象，因此这两项结果证明 GPU 镜像可构建、可导入和可访问显卡，不等同于数字人画面或语音输出验收。

### 当前环境缺口

| 项目 | 当前状态 | 后续动作 |
| --- | --- | --- |
| LiveTalking 与 CosyVoice 运行时镜像 | 两个 GPU 镜像已在 4090 主机构建；远程运行时已启动，Gateway、LiveTalking、CosyVoice 健康检查、短时动态会话/RTMP 和网络隔离验收通过；远程代码已同步到 `212f59e`（[V-20261111-02](VERIFICATION_LOG.md#v-20261111-02)、[V-20261111-03](VERIFICATION_LOG.md#v-20261111-03)） | 将远程标签收敛为受签名 release manifest 约束的镜像引用，并补内部输出探针、目标端试播与长时稳定性证据 |
| 模型权重 | 主机目录中未发现 LiveTalking/MuseTalk 或 CosyVoice 可运行权重 | 按锁定版本下载、校验哈希、记录许可证和挂载路径 |
| 数字人形象与声线 | 尚未挂入真实素材、授权记录和声线库 | 在 Studio 中上传，完成审核，再创建形象构建任务 |
| PostgreSQL、对象存储、OIDC 与生产环境文件 | 租机只有示例环境文件 | 创建独立服务账号、私网数据库、对象存储桶、生产环境文件与密钥目录 |
| RTMP 目的端、推流密钥和独立输出探针 | 尚未配置 | 先接内部 RTMP 中继，再接目标端；以探针记录帧率、码率、音频活动和音画同步 |
| GitHub 同步 | 本地与远程部署副本均已同步到 `212f59e`，远程 `master` 工作树干净，且网络隔离脚本已在显式测试 sink 例外下通过（[V-20261111-03](VERIFICATION_LOG.md#v-20261111-03)） | 后续仍需把镜像引用收敛到受签名 release manifest 的发布流程 |
| 远程宿主机版本与磁盘 | 实际主机为 Ubuntu 24.04，不是目标文档中的 Ubuntu 22.04；可用磁盘约 106 GiB，小于 150 GiB 门槛（[V-20261111-03](VERIFICATION_LOG.md#v-20261111-03)） | 二选一：换用/重装 Ubuntu 22.04 且扩容到至少 150 GiB，或书面接受 Ubuntu 24.04 并扩容；完成前不标记生产验收通过 |

## 分阶段执行方案

### P0：4090 运行时可启动（先做）

目标：让一台 4090 从 Docker GPU runtime 走到 LiveTalking、CosyVoice 与 Gateway 的健康链路。

1. **已完成**：固定可用镜像源，拉取 CUDA devel 基础镜像并构建 `livetalking`、`cosyvoice` 两个 4090 GPU 镜像。
2. **已完成（镜像层与短时服务层）**：为两镜像运行许可证哈希比对、Python import 和 CUDA/RTX 4090 冒烟；远程带权重服务的 `/api/admin/sessions`、`/openapi.json`、动态 WebRTC 会话、内部 RTMP 短时输出和网络隔离已有记录（见 [V-20261111-02](VERIFICATION_LOG.md#v-20261111-02)、[V-20261111-03](VERIFICATION_LOG.md#v-20261111-03)）；**待完成**：外部目标端探针、4 小时连续试播和 4090 画面观感验收。
3. 创建 `/srv/shuzhiren` 的模型、形象、候选形象、录制、Gateway 命令日志、observer 配置和密钥目录；卷均采用最小权限挂载。
4. 启动 Gateway、LiveTalking、CosyVoice、avatar-builder 与 avatar-publisher 的私网 Compose 组合，确认单卡预约逻辑使直播与形象构建不并发抢占 GPU。

验收：Gateway 能读到动态会话、AIGC 角标状态、GPU 利用率与显存事实；CosyVoice 合成语音可注入 LiveTalking；命令日志在重启后保持幂等。

### P1：一个项目生成录播视频

目标：用户从一张商品照片或一段小视频、一个商品事实和一份脚本出发，得到可审核的录播文件。

1. 在 Studio 创建内容项目，上传照片/视频、声音和商品资料，并完成每项授权及媒体质量审核。
2. 用审核后的商品事实生成脚本，编辑后送审；脚本、商品版本、声线和素材的版本一并冻结。
3. 生成照片口播或项目视频，逐帧/音频校验后提供项目内预览与归档记录。
4. 将生成文件上传对象存储，写入不可变录播证据、SHA-256、下载授权与短时预览授权。

验收：换设备重新打开同一项目仍能看到归档视频；替换商品、脚本或素材后必须产生新版本，历史录播保持可追溯。

### P2：同一项目生成实时直播

目标：复用 P1 的项目资产，生成一条受控的实时直播场次，而不让用户重复录入商品、脚本和形象。

1. 选择已发布数字人形象、已批准声音、已批准脚本、商品版本和画面层配置，创建直播草稿。
2. 创建并批准 AI 身份提示规则；预检同时核对授权、商品有效期、形象绑定、AIGC 角标、输出探针和单卡容量。
3. 先取得短时 WebRTC 预览授权，审核口型、声音、字幕、商品卡和 AIGC 角标；通过后才允许 arm/start。
4. 由 Gateway 下发开始节目、插播、备用节目、人工接管和结束命令；worker、observer 和 output-probe 分别处理投递、遥测和目的端输出事实。
5. 录制直播输出，登记录屏证据、节目播放账本、脚本版本、运行事件和告警处置。

验收：实时场次只绑定项目中冻结的资产；一条媒体命令在网络重试和 Gateway 重启后不重复执行；录屏与项目、场次、节目段落可相互追溯。

### P3：内部试播与质量验收

目标：把“容器正在运行”升级为“输出端的画面和声音达到约定质量”。

1. 先配置内部 RTMP 接收端，执行 30 分钟单路 720p/24 FPS 试播。
2. output-probe 测量帧率、宽高、码率、音频活动；独立同步探针记录音画偏差。
3. 验看推流画面和录制文件中的 AIGC 角标、字幕、商品卡、价格贴片与背景，确认没有遮挡和不同步。
4. 依次演练网络断开、RTMP 拒绝、GPU OOM、TTS 超时、黑屏、静音、Gateway 状态恢复和 PostgreSQL 恢复。
5. 在单路稳定后进行 4 小时连续试播，形成 `runtime-acceptance.json`，再运行验收门禁。

验收：输出探针、录制、运行观测和恢复记录齐全；达到 4 小时证据门槛前，生产开播状态保持未放行。

### P4：交付与 Git 收敛

1. 把本轮主机预检、两个 GPU 镜像构建、许可证哈希与 CUDA 冒烟、Compose 健康、试播和故障演练结果逐项登记。
2. 本轮核心运行时变更已推送到 `origin/master`（`212f59e`），远程主机已 fetch 并 reset 到同一提交，工作树干净；过程和网络隔离复核见 [V-20261111-03](VERIFICATION_LOG.md#v-20261111-03)。
3. 下一步把远程部署从“已同步 Git 工作树”收敛为受签名 release manifest 约束的镜像与部署包来源，不再依赖手工压缩包副本。
4. 打包运行手册：模型/权重清单、目录权限、环境变量来源、启动顺序、回滚步骤、日常录播与直播操作步骤。

## 资源与顺序

| 顺序 | 工作包 | 所需输入 | 产出 |
| --- | --- | --- | --- |
| 1 | GPU 镜像构建 | 稳定镜像源 | LiveTalking、CosyVoice GPU 镜像 |
| 2 | 基础设施 | PostgreSQL、对象存储、域名或内网地址 | 生产 Compose 环境 |
| 3 | 模型与素材 | 合规权重、肖像、声音、商品资料 | 已审核项目资产 |
| 4 | 录播闭环 | 项目资产与脚本 | 可预览、可归档录播 |
| 5 | 直播闭环 | RTMP 接收端与探针 | 单路实时直播与录制 |
| 6 | 长时验收 | 连续可用主机 | 4 小时验收证据与复盘记录 |

## 本轮下一动作

1. 为 LiveTalking MuseTalk 与 CosyVoice 准备有来源、许可证、哈希和挂载清单的模型权重；同时从 Studio 完成首个形象与声线的审核发布。
2. 创建模型、已发布形象、候选形象、录制、Gateway 命令日志、observer 配置和密钥目录后，打通 LiveTalking + CosyVoice + Gateway 三服务私网健康检查。
3. 同步补齐 PostgreSQL、对象存储和内部 RTMP 接收端，再从 Studio 创建第一个完整内容项目并生成录播。
4. 将当前主机本地镜像发布为受签名 release manifest 约束的镜像引用；让租机从该 release 获取部署包，取代上传式部署副本。

## 最新远程运行进度（2026-11-11）

本节覆盖上面 2026-11-10 检查点中已经被远程真实验收替代的部分，避免把历史“待启动”描述误读为当前状态。

- **运行时已启动**：Ubuntu GPU 主机上的 `runtime-gateway`、`livetalking`、`cosyvoice`、`runtime-worker`、`runtime-observer` 与内部 `rtmp-sink` 均已运行；LiveTalking 与 CosyVoice 报告 healthy。
- **动态会话闭环短时结果已记录（见 [V-20261111-02](VERIFICATION_LOG.md#v-20261111-02)）**：验收客户端创建真实 WebRTC offer，LiveTalking 返回动态 `sessionid`；Gateway `start_program` 与 `stop_program` 均返回 HTTP 200，回执保留同一 session ID。已修复停止顺序导致的录制收尾 502。
- **内部 RTMP 输出短时结果已记录（见 [V-20261111-02](VERIFICATION_LOG.md#v-20261111-02)）**：RTMP sink 日志出现 `fmle-publish`、`new live source`、`start publish` 和 `cleanup when unpublish`；验收期间记录 `output_connected=true`、`output_fps=9.732`、`last_output_at` 有值。
- **AIGC 标识运行时指标已记录（见 [V-20261111-02](VERIFICATION_LOG.md#v-20261111-02)）**：`enabled=true`，文字为 `本直播由AI数字人生成`，`frames_labelled=14048`，`frames_dropped=0`，`last_error=null`。
- **录播文件容器内 ffprobe 结果已记录（见 [V-20261111-02](VERIFICATION_LOG.md#v-20261111-02)）**：生成 MP4，视频 H.264、512×682，音频 AAC、16 kHz、单声道，时长约 5.056 秒；录播目录已调整为容器 UID 10002、主机用户组可读的 setgid 目录。
- **Git 已同步（见 [V-20261111-03](VERIFICATION_LOG.md#v-20261111-03)）**：远程主机已从 `origin/master` 拉取并切到 `212f59e`，工作树干净；这解决了远程副本落后于本地代码的问题，但还不等于完成签名 release manifest 发布流程。
- **网络隔离已复核（见 [V-20261111-03](VERIFICATION_LOG.md#v-20261111-03)）**：`runtime-network-isolation.sh --network-only` 返回 `0`；默认 egress 仍只允许 LiveTalking，只有显式设置 `RUNTIME_ACCEPTANCE_RTMP_SINK_NAME=compose-rtmp-sink` 时才允许该 `ossrs/srs:5` 测试 sink。该例外不代表正式平台 RTMP 已配置。
- **主机门槛仍未满足（见 [V-20261111-03](VERIFICATION_LOG.md#v-20261111-03)）**：实际系统为 Ubuntu 24.04，当前可用磁盘约 106 GiB；项目目标写的是 Ubuntu 22.04 且至少 150 GiB。两项都未完成前，不把该主机写成最终生产验收通过。
- **还没有冒充完成的部分**：当前 `OUTPUT_PROBE_TARGETS=[]`，所以尚未证明抖音/外部目标端输出、独立音画同步探针、长时连续开播和 4090 实机画面观感；这些仍是单独的外部验收项。

### 下一步只剩三类工作

1. 将已同步的远程 Git 工作树进一步收敛为签名 release manifest 部署，避免手工改远程 Dockerfile。
2. 解决 Ubuntu 版本与磁盘门槛：换用 Ubuntu 22.04 且至少 150 GiB，或明确批准 Ubuntu 24.04 并扩容到至少 150 GiB。
3. 配置真实 RTMP 目标与独立 `output-probe`/`avSyncProbeUrl`，再做目标端试播。
4. 在 4090 上做画面逐项验收和 4 小时稳定性测试；这一步不在本机或短时 smoke test 中虚报完成。

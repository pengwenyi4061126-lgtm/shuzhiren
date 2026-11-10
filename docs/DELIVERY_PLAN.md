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
- 4090 主机的 `scripts/check-runtime-host.sh` 记录了 RTX 4090、24,564 MiB 显存、Docker NVIDIA runtime 和约 239 GiB 初始空闲磁盘；CUDA 基础容器已枚举到同一张 GPU。
- 2026-11-11 在同一类 4090 主机上完成了 Avatar Builder 的真实短视频冒烟：数据库锁连接、上传、GPU 预处理、候选预览、完整性清单和 Publisher 发布均通过；详细证据见 [V-20261111-01](VERIFICATION_LOG.md#v-20261111-01)。该条不替代 LiveTalking/CosyVoice/Gateway 全量运行、RTMP 目标端和长时开播验收。

### 4090 实机镜像构建结果

- `shuzhiren/livetalking:00350f2` 已在 4090 主机构建完成，镜像 ID 为 `sha256:c891ce912e01492dc36d842d939bb1ae30a7c90e21ae98e9747e4a743afa7275`。镜像内的 LiveTalking `LICENSE`、项目修改说明分别与源码 SHA-256 一致；`torch 2.9.1+cu128`、`shuzhiren_overlay` 导入通过，并实际报告 `CUDA=True` 与 `NVIDIA GeForce RTX 4090`。
- `shuzhiren/cosyvoice:00350f2` 已在同一主机构建完成，镜像 ID 为 `sha256:b891657a2ff33f327199262d188ba374756c7168cc767663b6edb27a503bbc86`，OCI revision 为 `88d4630726aafbbf178d0302aa0763f02c610f75`。CosyVoice 与 Matcha-TTS 的许可证文件均与源码 SHA-256 一致；`torch 2.3.1+cu121` 与 `AutoModel` 导入通过，并实际报告 `CUDA=True` 与同一张 RTX 4090。
- 当前镜像是主机本地标签，尚未写入带签名证明的镜像仓库，也尚未挂载模型、声线或形象，因此这两项结果证明 GPU 镜像可构建、可导入和可访问显卡，不等同于数字人画面或语音输出验收。

### 当前环境缺口

| 项目 | 当前状态 | 后续动作 |
| --- | --- | --- |
| LiveTalking 与 CosyVoice 运行时镜像 | 两个 GPU 镜像已在 4090 主机构建，许可证源/镜像哈希、Python import 与 CUDA/RTX 4090 冒烟均通过；尚未启动带模型的服务 | 将本地标签发布为受签名 release manifest 约束的镜像引用，再挂载权重并做服务健康检查 |
| 模型权重 | 主机目录中未发现 LiveTalking/MuseTalk 或 CosyVoice 可运行权重 | 按锁定版本下载、校验哈希、记录许可证和挂载路径 |
| 数字人形象与声线 | 尚未挂入真实素材、授权记录和声线库 | 在 Studio 中上传，完成审核，再创建形象构建任务 |
| PostgreSQL、对象存储、OIDC 与生产环境文件 | 租机只有示例环境文件 | 创建独立服务账号、私网数据库、对象存储桶、生产环境文件与密钥目录 |
| RTMP 目的端、推流密钥和独立输出探针 | 尚未配置 | 先接内部 RTMP 中继，再接目标端；以探针记录帧率、码率、音频活动和音画同步 |
| GitHub 同步 | 本地 `master` 与 `origin/master` 已复核为 `0 0`；当前交付提交 `49940a8` 已同步（[V-20261110-01](VERIFICATION_LOG.md#v-20261110-01)） | 为 4090 主机配置可读取的受控 release 来源，替换现有上传式部署副本 |

## 分阶段执行方案

### P0：4090 运行时可启动（先做）

目标：让一台 4090 从 Docker GPU runtime 走到 LiveTalking、CosyVoice 与 Gateway 的健康链路。

1. **已完成**：固定可用镜像源，拉取 CUDA devel 基础镜像并构建 `livetalking`、`cosyvoice` 两个 4090 GPU 镜像。
2. **已完成（镜像层）**：为两镜像运行许可证哈希比对、Python import 和 CUDA/RTX 4090 冒烟；**待完成（服务层）**：在权重挂载后检查 `/api/admin/sessions` 与 `/openapi.json`。
3. 创建 `/srv/shuzhiren` 的模型、形象、候选形象、录制、Gateway 命令日志、observer 配置和密钥目录；卷均采用最小权限挂载。
4. 启动 Gateway、LiveTalking、CosyVoice、avatar-builder 与 avatar-publisher 的私网 Compose 组合，确认单卡预约逻辑使直播与形象构建不并发抢占 GPU。

验收：Gateway 能读到会话 `0`、AIGC 角标状态、GPU 利用率与显存事实；CosyVoice 合成语音可注入 LiveTalking；命令日志在重启后保持幂等。

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
2. 本轮核心运行时变更已推送到 `origin/master`（`49940a8`），并以 `git rev-list --left-right --count origin/master...master` 复核为 `0 0`（[V-20261110-01](VERIFICATION_LOG.md#v-20261110-01)）；再把主机部署来源切换到 Git 提交或签名 release manifest。
3. 远程主机改为从 Git 提交或签名 release manifest 获取部署包，不再依赖手工压缩包副本。
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

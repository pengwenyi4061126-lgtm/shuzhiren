# 第三方组件声明

本文件列出仓库以 Git 子模块引入、并由运行时镜像使用的开源组件，以及部署时挂载、但不在仓库中的模型权重和素材。内容只记录能从仓库文件确认的事实，依据截至提交 `dfb1296`。本文件不是许可证审查结论：每个组件、权重和素材能否用于商业直播，需部署方自行审查并确认。

Shuzhiren 仓库根目录没有 `LICENSE` 文件，`package.json` 为 `"private": true`。仓库自有代码以何种许可证分发，需仓库所有者确认。

npm 依赖、Python 依赖（`requirements.txt` 安装的包）、CUDA 基础镜像和 Miniforge 不在下表中。发布工作流为每张镜像生成 SBOM（见 `docs/DEPLOYMENT_RUNBOOK.md` 第 2 节），这些依赖的许可证以 SBOM 为清单另行审查，需部署方确认。

## 1. 源码组件

锁定提交以 `runtime/open-source.lock.json` 和父仓库中的子模块记录（`git ls-tree HEAD <路径>`）为准。

| 组件 | 仓库路径 | 上游仓库 | 锁定提交 | 根目录 LICENSE | 根目录 NOTICE | 是否进入镜像 |
| --- | --- | --- | --- | --- | --- | --- |
| LiveTalking | `vendor/LiveTalking` | https://github.com/lipku/LiveTalking.git | `c7269433a2b6ecebcd9342445d2ecc882c98b0da` | Apache License 2.0 | 无 | 是：`runtime/livetalking/Dockerfile` 以 `COPY vendor/LiveTalking/ ./` 复制到 `/app`，并应用 `runtime/patches/` 下的补丁 |
| CosyVoice | `vendor/CosyVoice` | https://github.com/FunAudioLLM/CosyVoice.git | `074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc` | Apache License 2.0 | 无 | 是：`runtime/cosyvoice/Dockerfile` 复制到 `/opt/CosyVoice/CosyVoice`，未修改 |
| Matcha-TTS（CosyVoice 的嵌套子模块） | `vendor/CosyVoice/third_party/Matcha-TTS` | https://github.com/shivammehta25/Matcha-TTS.git（`vendor/CosyVoice/.gitmodules`） | `dd9105b34bf2be2230f4aa1e4769fb586a3c824e` | MIT License，Copyright (c) 2023 Shivam Mehta | 无 | 是：随 CosyVoice 目录一起复制，`PYTHONPATH` 包含该目录 |
| MuseTalk | `vendor/MuseTalk` | https://github.com/TMElyralab/MuseTalk.git | `0a89dec45a0192b824e3cf4daf96c239440c5ed8` | MIT License，Copyright (c) 2024 Tencent Music Entertainment Group；同一文件还列出 sd-vae-ft-mse、whisper、face-parsing.PyTorch（MIT）和 DWpose（Apache-2.0） | 无 | 否：没有 Dockerfile 复制该目录。LiveTalking 以 `--model musetalk` 运行时使用的是 `vendor/LiveTalking/avatars/musetalk` 下的代码 |

说明：

- `runtime/open-source.lock.json` 目前只有 LiveTalking、CosyVoice、MuseTalk 三项，没有 Matcha-TTS 条目。
- 两个 Dockerfile 的构建上下文排除规则（`Dockerfile.dockerignore`）只排除 `.git`、模型、数据、密钥和日志类路径，不排除根目录 `LICENSE`。按此规则，镜像中应有 `/app/LICENSE`、`/opt/CosyVoice/CosyVoice/LICENSE` 和 `/opt/CosyVoice/CosyVoice/third_party/Matcha-TTS/LICENSE`。仓库中没有检查这三个文件确实存在于镜像中的门禁，发布时需部署方在镜像中确认。

## 2. LiveTalking 修改说明

Apache License 2.0 第 4 条要求再分发修改后的作品时附带许可证副本，并让被修改的文件带有显著的修改说明。下列修改由 Shuzhiren 仓库作出，在构建 LiveTalking 镜像时按 `runtime/patches/livetalking.series` 的顺序以 `git apply` 应用到锁定提交 `c7269433a2b6ecebcd9342445d2ecc882c98b0da`。`vendor/LiveTalking` 子模块本身不被修改。

| 顺序 | 补丁文件 | 修改的文件 | 改动摘要 |
| --- | --- | --- | --- |
| 1 | `runtime/patches/livetalking-observability.patch` | `avatars/base_avatar.py`、`server/routes.py`、`streamout/rtmp.py` | 记录进程内推理 FPS、输出 FPS、RTMP 输出连接状态、配置码率、最后输出时间和最后输出错误类型，并新增只读接口 `GET /api/admin/runtime-metrics` 返回各会话的说话、录制状态和这些指标 |
| 2 | `runtime/patches/livetalking-stream-secret.patch` | `app.py`、`config.py`、`server/routes.py`、`streamout/rtmp.py` | 增加 `--stream_key_file`，推流密钥从只读文件读取后在内存中拼接到 `--push_url`；选项日志、RTMP 日志、错误信息和 HTTP 响应中的推流地址与密钥被脱敏 |

镜像另外复制仓库自有的 `runtime/livetalking/launcher.py` 和 `runtime/livetalking/shuzhiren_secrets.py` 到 `/opt/shuzhiren/`。它们是新文件，不是对 LiveTalking 文件的修改。

锁定提交的 `vendor/LiveTalking` 根目录没有 NOTICE 文件，因此没有需要随镜像保留的 NOTICE 内容。

截至 `dfb1296` 尚未完成的部分（属代码与 Dockerfile 范围，见 `docs/AUDIT_REGISTER.md` 的 L18 与 Requirement 39）：

- 补丁只在部分改动处带有 `# Shuzhiren:` 注释，没有在每个被修改文件的开头写明"本文件已被 Shuzhiren 修改"。
- 镜像 `/app` 下没有本修改说明的副本。
- `deploy:check` 不比对本节列出的文件集合与补丁实际修改的文件集合。补丁变更时须同步更新本节。

## 3. 模型权重（不在仓库中，部署时只读挂载）

模型权重的许可证与代码许可证相互独立。仓库不包含任何权重文件，也不包含权重的许可证文本。下表只列出权重的挂载位置和上游文档中可确认的说明；每组权重的来源、许可证和商业使用条件需部署方逐项确认并留存记录。

| 使用方 | 宿主机目录变量 | 容器内路径 | 代码中引用的权重 | 上游文档中的说明 |
| --- | --- | --- | --- | --- |
| LiveTalking（`--model musetalk`） | `MODEL_VOLUME_PATH` | `/app/models`（只读） | `musetalkV15/unet.pth` 与 `musetalkV15/musetalk.json`（`avatars/musetalk/utils/utils.py`）、`sd-vae-ft-mse/`（`avatars/musetalk/models/vae.py`）、`whisper`（`avatars/musetalk_avatar.py`）、`face-parse-bisent/resnet18-5c106cde.pth` 与 `face-parse-bisent/79999_iter.pth`（`avatars/musetalk/utils/face_parsing/__init__.py`） | `vendor/MuseTalk/README.md` 的 "Disclaimer/License" 一节称 MuseTalk 训练得到的模型可用于任何目的（含商业），其他开源模型（whisper、ft-mse-vae、dwpose、S3FD 等）须遵守各自许可证，测试数据仅限非商业研究。`vendor/LiveTalking/README.md` 第 2.1 节给出的网盘下载链接没有附带许可证说明 |
| CosyVoice | `COSYVOICE_MODEL_PATH` | `/opt/CosyVoice/CosyVoice/pretrained_models`（只读） | 模板 `COSYVOICE_MODEL_DIR` 指向 `Fun-CosyVoice3-0.5B-2512` | `vendor/CosyVoice/README.md` 给出 ModelScope 与 Hugging Face 的 `FunAudioLLM/Fun-CosyVoice3-0.5B-2512` 下载地址，未写明权重许可证；其 Disclaimer 一节称上文内容仅用于学术目的。权重许可证以下载来源的模型卡为准，需部署方确认 |

## 4. 肖像与声线素材

- **数字人形象**：LiveTalking 从 `AVATAR_VOLUME_PATH`（容器内 `/app/data/avatars`，只读）加载 `LIVETALKING_AVATAR_ID` 指定的 Avatar 数据。其中人物的肖像使用需取得本人书面授权。
- **声线**：Runtime Gateway 调用 CosyVoice 的 `/inference_sft`，以请求中的 `voice` 作为 `spk_id`（`runtime/gateway/app.py` 的 `cosyvoice_synthesize`），即使用所加载模型目录中的说话人。若该说话人来自真人录音，需取得声音本人的书面授权；模型自带说话人的使用条件以权重许可证为准，需部署方确认。

## 5. 在线语音合成服务（edge-tts）

- `vendor/LiveTalking/requirements.txt` 包含 `edge_tts`，LiveTalking 镜像会安装它。`vendor/LiveTalking/tts/edge.py` 通过 `edge_tts.Communicate` 合成语音。
- `vendor/LiveTalking/config.py` 中 `--tts` 的默认值为 `edgetts`。截至 `dfb1296`，`infra/compose/docker-compose.runtime.yml` 的 `livetalking` 命令没有传 `--tts`，而 Runtime Gateway 把节目脚本以文本发送到 LiveTalking 的 `/human`（`runtime/gateway/app.py` 的 `/v1/media` 中 `start_program`、`insert_program`、`resume_program` 分支，以及 `/v1/speak` 在 `provider` 不是 `cosyvoice` 时的分支）。这些文本因此由 edge-tts 合成，见 `docs/AUDIT_REGISTER.md` 的 H3。
- edge-tts 调用的是外部在线语音服务。该服务的服务条款是否允许本系统的使用方式，以及 `edge_tts` 包本身的许可证，仓库中没有记录，需部署方评估确认。

## 6. 部署方需要自行取得并留存的授权

1. 第 3 节每组模型权重的来源记录、许可证文本和商业使用确认。
2. 第 4 节数字人形象与声线的本人书面授权，以及授权范围（平台、期限、用途）。
3. 第 5 节在线语音合成服务的使用许可；若不使用该服务，需确认运行配置不会调用它。
4. 直播中使用的商品图片、音乐和脚本的授权（见 `docs/DEPLOYMENT_RUNBOOK.md` 开头的部署前提）。
5. 第 1 节源码组件与 SBOM 所列依赖的许可证审查结论。

这些授权和审查结论由部署方在仓库之外取得，不写入本仓库。

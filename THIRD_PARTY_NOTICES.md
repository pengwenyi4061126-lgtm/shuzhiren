# 第三方组件声明

本文件列出仓库以 Git 子模块引入、并由运行时镜像使用的开源组件，以及部署时挂载、但不在仓库中的模型权重和素材。内容只记录能从当前仓库文件确认的事实；运行时代码、Compose 或补丁变更时须同步更新本文件。本文件不是许可证审查结论：每个组件、权重和素材能否用于商业直播，需部署方自行审查并确认。

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

- `runtime/open-source.lock.json`（`schemaVersion` 2）记录上表四个组件的路径、父仓库、锁定提交、许可证名称和使用它的镜像；MuseTalk 的 `images` 为空，只为源码审阅和权重来源追溯保留。`npm run deploy:check` 核对每个条目的源码 HEAD、父仓库记录的子模块提交和干净工作树。
- 两个 Dockerfile 的构建上下文排除规则（`Dockerfile.dockerignore`）只排除 `.git`、模型、数据、密钥和日志类路径，不排除根目录 `LICENSE`。镜像中有 `/app/LICENSE`、`/opt/CosyVoice/CosyVoice/LICENSE` 和 `/opt/CosyVoice/CosyVoice/third_party/Matcha-TTS/LICENSE`。
- `npm run runtime:images:licenses:check` 检查每个进入镜像的组件的 `LICENSE`（锁定提交有 NOTICE 时还有 `NOTICE`）没有被构建上下文排除。CI 的 `docker-build` job 在构建 LiveTalking 与 CosyVoice 镜像后运行 `scripts/check-runtime-image-licenses.mjs`，从镜像中读出这三个 `LICENSE` 文件，与各组件锁定提交中的 `LICENSE` 逐字节比较。

## 2. LiveTalking 修改说明

Apache License 2.0 第 4 条要求再分发修改后的作品时附带许可证副本，并让被修改的文件带有显著的修改说明。下列修改由 Shuzhiren 仓库作出，在构建 LiveTalking 镜像时按 `runtime/patches/livetalking.series` 的顺序以 `git apply` 应用到锁定提交 `c7269433a2b6ecebcd9342445d2ecc882c98b0da`。`vendor/LiveTalking` 子模块本身不被修改。

| 顺序 | 补丁文件 | 修改的文件 | 改动摘要 |
| --- | --- | --- | --- |
| 1 | `runtime/patches/livetalking-observability.patch` | `avatars/base_avatar.py`、`server/routes.py`、`streamout/rtmp.py` | 记录进程内推理 FPS、输出 FPS、RTMP 输出连接状态、配置码率、最后输出时间和最后输出错误类型，并新增只读接口 `GET /api/admin/runtime-metrics` 返回各会话的说话、录制状态和这些指标 |
| 2 | `runtime/patches/livetalking-stream-secret.patch` | `app.py`、`config.py`、`server/routes.py`、`streamout/rtmp.py` | 增加 `--stream_key_file`，推流密钥从只读文件读取后在内存中拼接到 `--push_url`；选项日志、RTMP 日志、错误信息和 HTTP 响应中的推流地址与密钥被脱敏 |
| 3 | `runtime/patches/livetalking-local-tts.patch` | `avatars/base_avatar.py`、`config.yaml`；新增 `tts/none_tts.py` | 注册不做任何合成的 `--tts none` 插件（发到 `/human` 的文本被丢弃，不会到达在线语音服务）；`--tts` 取未知值时启动失败；`config.yaml` 的 `tts` 改为 `none`。语音只以 CosyVoice 合成的音频经 `/humanaudio` 注入 |

| 4 | `runtime/patches/livetalking-aigc-label.patch` | `avatars/base_avatar.py`、`server/routes.py` | 在每一帧推流和录制画面上叠加 AIGC 显式标识（不可关闭，文字与位置由 `AIGC_LABEL_TEXT`、`AIGC_LABEL_POSITION` 配置），无法标识的帧被丢弃；新增只读接口 `GET /api/admin/aigc-label`，`/api/admin/runtime-metrics` 另返回 `aigc_label` |
镜像另外复制仓库自有的 `runtime/livetalking/launcher.py`、`runtime/livetalking/shuzhiren_secrets.py` 和 `runtime/livetalking/shuzhiren_aigc_label.py` 到 `/opt/shuzhiren/`。它们是新文件，不是对 LiveTalking 文件的修改。

锁定提交的 `vendor/LiveTalking` 根目录没有 NOTICE 文件，因此没有需要随镜像保留的 NOTICE 内容。

修改说明随镜像分发，并由门禁核对：

- 每个被修改或新增的 LiveTalking 文件在前 10 行内带有注释 `# Modified by the Shuzhiren project; see /app/LIVETALKING_MODIFICATIONS.md`，由序列中第一个改动该文件的补丁加入。新增的 `tts/none_tts.py` 另有一行注释，写明该文件由 Shuzhiren 新增、不属于上游 LiveTalking。
- `runtime/patches/LIVETALKING_MODIFICATIONS.md` 列出上游仓库、被修改的锁定提交、NOTICE 情况，以及每个补丁的改动摘要和"文件 | 操作"表。`runtime/livetalking/Dockerfile` 把它复制到镜像的 `/app/LIVETALKING_MODIFICATIONS.md`，与 `/app/LICENSE` 放在一起。
- `npm run deploy:check` 比对该文件与锁文件（锁定提交、上游仓库、NOTICE 行）和补丁序列（每个补丁修改、新增、删除或重命名的文件集合），不一致时报错。`npm run runtime:images:licenses:check` 在临时索引中按序列把补丁应用到锁定提交，检查每个被修改或新增的文件前 10 行有上述注释。CI 的 `docker-build` job 在构建出的 LiveTalking 镜像中检查修改说明与仓库文件逐字节一致，并检查镜像中每个被修改或新增的文件带有该注释。

补丁变更时，须在同一提交中更新 `runtime/patches/LIVETALKING_MODIFICATIONS.md` 和本节的表格。

## 3. 模型权重（不在仓库中，部署时只读挂载）

模型权重的许可证与代码许可证相互独立。仓库不包含任何权重文件，也不包含权重的许可证文本。下表只列出权重的挂载位置和上游文档中可确认的说明；每组权重的来源、许可证和商业使用条件需部署方逐项确认并留存记录。

| 使用方 | 宿主机目录变量 | 容器内路径 | 代码中引用的权重 | 上游文档中的说明 |
| --- | --- | --- | --- | --- |
| LiveTalking（`--model musetalk`） | `MODEL_VOLUME_PATH` | `/app/models`（只读） | `musetalkV15/unet.pth` 与 `musetalkV15/musetalk.json`（`avatars/musetalk/utils/utils.py`）、`sd-vae-ft-mse/`（`avatars/musetalk/models/vae.py`）、`whisper`（`avatars/musetalk_avatar.py`）、`face-parse-bisent/resnet18-5c106cde.pth` 与 `face-parse-bisent/79999_iter.pth`（`avatars/musetalk/utils/face_parsing/__init__.py`） | `vendor/MuseTalk/README.md` 的 "Disclaimer/License" 一节称 MuseTalk 训练得到的模型可用于任何目的（含商业），其他开源模型（whisper、ft-mse-vae、dwpose、S3FD 等）须遵守各自许可证，测试数据仅限非商业研究。`vendor/LiveTalking/README.md` 第 2.1 节给出的网盘下载链接没有附带许可证说明 |
| CosyVoice | `COSYVOICE_MODEL_PATH` | `/opt/CosyVoice/CosyVoice/pretrained_models`（只读） | 模板 `COSYVOICE_MODEL_DIR` 指向 `Fun-CosyVoice3-0.5B-2512` | `vendor/CosyVoice/README.md` 给出 ModelScope 与 Hugging Face 的 `FunAudioLLM/Fun-CosyVoice3-0.5B-2512` 下载地址，未写明权重许可证；其 Disclaimer 一节称上文内容仅用于学术目的。权重许可证以下载来源的模型卡为准，需部署方确认 |

## 4. 肖像与声线素材

- **数字人形象**：LiveTalking 从 `AVATAR_VOLUME_PATH`（容器内 `/app/data/avatars`，只读）加载 `LIVETALKING_AVATAR_ID` 指定的 Avatar 数据。其中人物的肖像使用需取得本人书面授权。
- **声线**：节目脚本和每条播报都由 Runtime Gateway 交给 CosyVoice 合成（`runtime/gateway/app.py` 的 `cosyvoice_chunk`、`cosyvoice_synthesize`），所用声线是命令中冻结的已批准 `runtime_voice_id`。声线来源取决于 Gateway 环境的 `COSYVOICE_MODEL_KIND`：
  - `sft`：调用 `/inference_sft`，以 `runtime_voice_id` 作为 `spk_id`，使用所加载模型目录中自带的说话人。模型自带说话人的使用条件以权重许可证为准；若该说话人由真人录音训练而来，还需取得声音本人的书面授权。锁定的 `Fun-CosyVoice3-0.5B-2512` 没有自带的 SFT 说话人。
  - `zero_shot`（模板默认）：调用 `/inference_zero_shot`，上传只读声线库（宿主机 `COSYVOICE_VOICE_LIBRARY_PATH`，容器内 `/run/shuzhiren/voices`）中 `<runtime_voice_id>/prompt.wav` 的参考音频和 `prompt.txt` 的文本，合成出与参考音频相同的声音。Gateway 只在 `prompt.wav` 的 SHA-256 等于命令携带的已批准声音素材校验和时才合成。参考音频是真人录音，使用前必须取得声音本人的书面授权，授权范围需覆盖以该录音合成直播语音的用途、平台和期限。
  - 声线库、参考音频和授权文件都不在仓库中，由部署方准备和留存。

## 5. 在线语音合成服务（edge-tts）

- edge-tts 已不在运行路径上。`infra/compose/docker-compose.runtime.yml` 以 `--tts none` 启动 LiveTalking，补丁 3 的 `none` 插件不做任何合成；Runtime Gateway 只向 LiveTalking 发送 `/interrupt_talk`、`/set_audiotype`、`/record` 和 `/humanaudio`（`runtime/gateway/app.py` 的 `LIVETALKING_POST_PATHS` 与 `/humanaudio` 上传），不再调用 `/human`。`npm run deploy:check` 与 `runtime:compose:check` 拒绝其他 `--tts` 取值。
- `edge_tts` 包仍随镜像安装：`vendor/LiveTalking/requirements.txt` 包含 `edge_tts`，`runtime/livetalking/Dockerfile` 按该文件安装依赖，`vendor/LiveTalking/tts/edge.py` 也仍在镜像中。它会出现在 LiveTalking 镜像的 SBOM 中；`edge_tts` 包本身的许可证按 SBOM 依赖一并审查。
- 若部署方改动 Compose 或补丁、重新启用 `edgetts`，节目文本会发往外部在线语音服务，需另行评估该服务条款；当前仓库配置不会这样做。

## 6. 部署方需要自行取得并留存的授权

1. 第 3 节每组模型权重的来源记录、许可证文本和商业使用确认。
2. 第 4 节数字人形象的本人书面授权；`zero_shot` 声线库中每段参考音频的声音本人书面授权；以及授权范围（平台、期限、用途）。
3. 确认实际部署的 LiveTalking 以 `--tts none` 运行（第 5 节）；若改用在线语音服务，需另行取得其使用许可。
4. 直播中使用的商品图片、音乐和脚本的授权（见 `docs/DEPLOYMENT_RUNBOOK.md` 开头的部署前提）。
5. 第 1 节源码组件与 SBOM 所列依赖的许可证审查结论；第 7 节系统软件包（AIGC 标识所用字体）的许可证审查结论。

这些授权和审查结论由部署方在仓库之外取得，不写入本仓库。
## 7. 镜像安装的系统软件包（按内容使用）
下表列出运行时镜像以 `apt-get install` 安装、并以其内容（而不是作为构建或运行工具）进入直播画面的发行版软件包。其余系统软件包（`python3`、`ffmpeg`、`git` 等）按 SBOM 审查。`npm run runtime:images:licenses:check` 核对下表中的软件包确实由对应 Dockerfile 安装、本节写明其许可证，并拒绝未登记的 `fonts-*` 字体包；CI 的 `docker-build` job 运行 `scripts/check-runtime-image-licenses.mjs --livetalking-image` 时检查镜像中保留了该软件包的 Debian 版权文件且其中写明该许可证。
| 软件包 | 镜像 | 许可证 | 用途 | 镜像内许可证文本 |
| --- | --- | --- | --- | --- |
| `fonts-noto-cjk`（Ubuntu 24.04 发行版软件包，Noto Sans CJK） | livetalking | SIL Open Font License 1.1 | AIGC 显式标识的中文字形：`runtime/livetalking/shuzhiren_aigc_label.py` 读取 `/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc`（缺失时 `NotoSansCJK-Regular.ttc`），用 Pillow 把标识文字绘制到每一帧 | `/usr/share/doc/fonts-noto-cjk/copyright` |
说明：OFL 1.1 允许字体随软件捆绑分发和用于商业用途，不允许单独出售字体文件；用该字体渲染进视频画面的文字不受该许可证约束。镜像不修改字体文件。上述理解不是许可证审查结论，需部署方确认。Pillow 不是直接安装的依赖：它随 `torchvision` 安装进镜像，按 SBOM 审查。

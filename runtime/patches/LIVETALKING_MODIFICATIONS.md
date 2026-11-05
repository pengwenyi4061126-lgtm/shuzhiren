# LiveTalking 修改声明
- 上游仓库：https://github.com/lipku/LiveTalking.git
- 被修改的锁定提交：c7269433a2b6ecebcd9342445d2ecc882c98b0da
- NOTICE：该锁定提交的根目录没有 NOTICE 文件。
- 下列修改由 Shuzhiren 仓库（github.com/pengwenyi4061126-lgtm/shuzhiren）作出，不属于上游项目，按 Apache-2.0 第 4(b) 条在此声明。

LiveTalking 以 Apache License 2.0 发布，许可证全文随镜像位于 `/app/LICENSE`。构建 LiveTalking 镜像时，下列补丁按 `runtime/patches/livetalking.series` 的顺序以 `git apply` 应用到锁定提交；`vendor/LiveTalking` 子模块本身不被修改。本文件在仓库中位于 `runtime/patches/LIVETALKING_MODIFICATIONS.md`，在镜像中位于 `/app/LIVETALKING_MODIFICATIONS.md`。

每个被修改或新增的文件在前 10 行内带有注释 `# Modified by the Shuzhiren project; see /app/LIVETALKING_MODIFICATIONS.md`，由序列中第一个改动该文件的补丁加入；新增的文件另有一行 `# Added by the Shuzhiren project: this file is new and is not part of upstream LiveTalking.`。

## runtime/patches/livetalking-observability.patch
摘要：记录进程内推理 FPS、输出 FPS、RTMP 输出连接状态、配置码率、最后输出时间和最后输出错误类型，并新增只读接口 `GET /api/admin/runtime-metrics`，返回各会话的说话状态、录制状态和这些指标。

| 文件 | 操作 |
| --- | --- |
| avatars/base_avatar.py | 修改 |
| server/routes.py | 修改 |
| streamout/rtmp.py | 修改 |

## runtime/patches/livetalking-stream-secret.patch
摘要：增加 `--stream_key_file`，推流密钥从只读文件读取后在内存中拼接到 `--push_url`；选项日志、RTMP 日志、错误信息和 HTTP 响应中的推流地址与密钥被脱敏，脱敏函数来自镜像中的 `/opt/shuzhiren/shuzhiren_secrets.py`。

| 文件 | 操作 |
| --- | --- |
| app.py | 修改 |
| config.py | 修改 |
| server/routes.py | 修改 |
| streamout/rtmp.py | 修改 |

## runtime/patches/livetalking-local-tts.patch
摘要：注册不做任何合成的 `--tts none` 插件，发到 `/human` 的文本被丢弃，不会到达在线语音服务；`--tts` 取未知值时启动失败；`config.yaml` 的 `tts` 默认值改为 `none`。语音只以 CosyVoice 合成的音频经 `/humanaudio` 注入。

| 文件 | 操作 |
| --- | --- |
| avatars/base_avatar.py | 修改 |
| config.yaml | 修改 |
| tts/none_tts.py | 新增 |

## runtime/patches/livetalking-aigc-label.patch
摘要：按《人工智能生成合成内容标识办法》在每一帧推流和录制画面上叠加 AIGC 显式标识（默认文字「本直播由AI数字人生成」，文字与角落位置由 `AIGC_LABEL_TEXT`、`AIGC_LABEL_POSITION` 配置，没有关闭开关）。绘制函数来自镜像中的 `/opt/shuzhiren/shuzhiren_aigc_label.py`；会话初始化时标识配置、中文字体或绘制依赖不可用则会话无法创建，单帧绘制失败时该帧被丢弃而不是无标识推出。新增只读接口 `GET /api/admin/aigc-label`，`GET /api/admin/runtime-metrics` 另返回 `aigc_label`（启用状态、文字、位置、已标识帧数、丢弃帧数、最后错误类别）。

| 文件 | 操作 |
| --- | --- |
| avatars/base_avatar.py | 修改 |
| server/routes.py | 修改 |

# 远端 GPU 部署状态

最后核验：2026-11-11（Asia/Shanghai）

本页记录远端 Ubuntu 24.04 GPU 主机的实际状态，避免把源码、镜像构建和真实开播混为一谈。

Git 对接说明：本地当前提交为 `803e03f3548132b8a80ddc732bdb4a01931ec816`；下表中的远端提交是上一次实际部署观察值，不应自动视为当前提交已部署。本轮对 `gpu-mirror` 的实时只读核对因 SSH 认证失败未完成。

## 本轮实测观察（治理状态：未验证）

| 项目 | 结果 |
| --- | --- |
| 源码镜像 | `/home/wuyou/shuzizhibo-git`，上次实际观察到工作树干净，HEAD `78ae0258b830c77681ca4768ad5fdbe8400b8b49`；当前 `803e03f` 是否已同步未验证 |
| 控制面镜像 | `shuzhiren/control-plane:78ae0258-dev`，从上述 Git 镜像重新构建并替换运行 |
| 控制面健康 | 远端回环 `http://127.0.0.1:3001/api/health` 返回 HTTP 200 |
| Studio 页面 | 远端回环 `http://127.0.0.1:3001/studio` 返回 HTTP 200，并包含“一个内容项目”“两个输出” |
| Gateway | `http://127.0.0.1:8090/healthz` 返回 `status=ok` |
| 媒体依赖 | Gateway 容器内访问 LiveTalking `/api/admin/sessions` 与 CosyVoice `/openapi.json` 均返回 HTTP 200 |
| AIGC 标识 | Gateway 报告已启用，文字为“本直播由AI数字人生成”，位置为 `top-right` |
| 网络隔离 | `runtime-media` 为 internal，仅包含 Gateway、LiveTalking、CosyVoice；LiveTalking/CosyVoice 未发布宿主端口；RTMP sink 位于独立 egress 网络 |
| GPU | RTX 4090，24,564 MiB 总显存，驱动 `595.99.02` |

## 尚未满足生产放行

- 根分区可用空间约 77 GiB，低于项目要求的 150 GiB。
- 运行中的媒体镜像仍是既有 `00350f2`、`c1bed0a-cvfix5`、`rtmp-c1` 标签；本次只更新了控制面，未重复构建大模型镜像。
- `deploy:check` 仍会因真实生产环境变量、镜像 digest、RTMP 地址、stream-key 和服务令牌缺失而失败。
- 没有活动 LiveTalking 会话，因此本次没有伪造帧率、码率、音画同步或平台端输出证据。
- 真实抖音权限、正式 RTMP、动态口型录播、4090 画面观感和长时开播仍需外部验收。

## 下一次部署顺序

1. 扩容磁盘至至少 150 GiB 可用，或由运维明确清理历史 Docker 数据后重新运行主机预检。
2. 准备生产 env、镜像 RepoDigest、stream-key 和独立服务令牌。
3. 在 `/home/wuyou/shuzizhibo-git` 运行 `npm run deploy:check`、`npm run runtime:compose:check` 和 `npm run runtime:images:check`。
4. 只在配置门禁通过后发布媒体镜像，运行 `scripts/acceptance/runtime-network-isolation.sh` 与 `scripts/acceptance/livetalking-session-zero.sh`，再做目标端输出和 4 小时验收。


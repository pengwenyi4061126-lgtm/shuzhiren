# 远端 GPU 部署状态

最后核验：2026-11-11（Asia/Shanghai）

本页只记录已实际执行的结果。源码、控制面部署、媒体运行链路和真实平台开播验收分开统计。

## 已完成

| 项目 | 实际结果 |
| --- | --- |
| 本地源码 | `E:\\shuzizhibo`，HEAD `54e8bfd`，工作树已清理 |
| GPU Git 镜像 | `/home/wuyou/shuzizhibo-git`，远端 HEAD `54e8bfd` |
| 控制面镜像 | `shuzhiren/control-plane:54e8bfd-dev`，镜像 ID `d13283d29fe6` |
| 生产容器 | `shuzhiren-p0-control-plane`，host network，端口 `3001`，当前运行新镜像 |
| 控制面健康 | `http://127.0.0.1:3001/api/health` 返回 HTTP 200 |
| Studio 页面 | `http://127.0.0.1:3001/studio` 返回 HTTP 200，响应体 52,465 bytes |
| Demo 隔离 | 生产模式 `POST /api/v1/studio/demo-seed` 返回 HTTP 404，符合门禁设计 |
| 启动日志 | Next.js Ready；健康、Studio、Demo 路由均有实际访问日志 |
| 回滚 | 旧容器保留为 `shuzhiren-p0-control-plane-rollback-78ae0258`，镜像 `78ae0258-dev`，当前停止 |
| 临时验证 | `control-plane-smoke-54e8bfd` 已完成 3002 冒烟并清理 |

健康接口当前返回 `status=ok`；`releaseRevision` 字段仍为 `null`，但运行容器环境已核验为 `RELEASE_REVISION=54e8bfd`。这属于接口字段未透传，不影响本次容器切换结果。

## 远端运行基线

- RTX 4090，显存总量 24,564 MiB。
- Docker 29.1.3，Compose 2.40.3。
- LiveTalking、CosyVoice、Gateway、Worker、Observer 仍为运行/健康状态。
- SRS 当前无推流；本次没有伪造真实平台输出、帧率、码率或音画同步结果。

## 尚未完成的外部验收项

- 主机可用磁盘约 77 GiB，低于项目建议的 150 GiB 门槛。
- 尚未接入真实平台权限、正式 RTMP、stream-key 和生产服务令牌。
- 没有活动 LiveTalking 会话，因此 4090 实时画面观感、动态口型录播、长时开播和平台端输出仍需实机验收。
- 运行中的媒体镜像仍是既有标签；本轮只更新并切换控制面。
- GitHub `origin` 尚未推送：当前环境未检测到可用 SSH/HTTPS 凭据；GPU Git 镜像已同步。

## 回滚命令

```bash
docker stop shuzhiren-p0-control-plane
docker rm shuzhiren-p0-control-plane
docker rename shuzhiren-p0-control-plane-rollback-78ae0258 shuzhiren-p0-control-plane
docker start shuzhiren-p0-control-plane
```

## GitHub 对接的剩余动作

在配置 GitHub SSH key 或 HTTPS token 后执行：

```powershell
Set-Location E:\\shuzizhibo
ssh -T git@github.com
git fetch origin master
git push origin master
```


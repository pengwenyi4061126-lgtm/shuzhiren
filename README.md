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

- Linux 4090 服务器的 SSH 访问；建议 Ubuntu 22.04、NVIDIA 驱动和 Docker 已就绪。
- 目标平台合法推流地址和 Stream Key。
- 对真人肖像、声音、商品图片、音乐和脚本的书面授权。
- SKU 主数据：价格、库存、规格、赠品、资质、售后、禁说项和 FAQ。
- 场控负责人及高风险问题的人工接管规则。

## 下一步

1. 先执行 P0：在 4090 上验证 MuseTalk、CosyVoice、推流和连续运行。
2. 再做 P1：加入商品编排、字幕、录屏、人工切换和故障恢复。
3. 仅在 P1 的真实成交与合规指标合格后，加入实时 RAG 问答。

## 当前实现状态

阶段 1 已完成；阶段 2 至 6 的控制面、治理、Gateway、观测、告警、渠道标准化接入、用量门禁和多租户框架已经落在仓库中。控制台代码位于 `apps/console`，开源运行时入口位于 `runtime/gateway` 与 `infra/compose`。真实 ERP/PIM、平台 OAuth/Webhook、OIDC 成员同步、对象存储、4090 试播和结算对账仍是部署方必须接入并留存证据的外部工作，不能用开发态或模拟服务替代。

完整阶段状态见 [docs/IMPLEMENTATION_ROADMAP.md](docs/IMPLEMENTATION_ROADMAP.md)，代码和外部上线条件见 [docs/DEPLOYMENT_READINESS.md](docs/DEPLOYMENT_READINESS.md)。

本地依赖安装完成后使用：

```powershell
npm install
npm run dev
```

数据库迁移仅在已配置 `DATABASE_URL` 的环境执行：

商品事实以不可变版本管理；节目版本通过 `show_revision_product_versions` 冻结所使用的 SKU 版本。开播预检和 `START` 指令都会验证这些版本仍处于已批准状态。

```powershell
npm run db:migrate
```

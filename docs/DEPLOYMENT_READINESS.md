# 商业部署就绪矩阵

本仓库可以完成控制面、治理、Gateway、观测、部署校验和验收证据门禁；它不能替代租用 GPU、取得平台账号、签署授权或提供生产凭据。只有代码项与外部项同时满足，才可开始对外直播。

| 范围 | 仓库已提供 | 上线前必须由部署方完成 | 验证证据 |
| --- | --- | --- | --- |
| 4090 主机 | Linux 主机只读预检、GPU 容器 smoke 检查、Compose GPU 定义 | 租用单卡 RTX 4090、安装驱动/Docker/NVIDIA Container Toolkit、准备模型与录屏磁盘 | `bash scripts/check-runtime-host.sh`、可选容器 smoke 输出 |
| 开源数字人 | LiveTalking + MuseTalk + CosyVoice 锁定提交、Gateway 音频封装、媒体命令与会话观测 | 下载符合许可证的权重、创建已批准 Avatar 包、实机确认动作槽位和口型/音色质量 | `npm run deploy:check`、发布包验收记录、试听/试播报告 |
| 平台推流 | RTMP/SRT 运行时配置、输出探针、降级和人工接管命令 | 平台账号、私有推流地址/密钥、平台 AI 标识要求、目的端回放或中继探针 | 30 分钟内部试播、目的端输出探针记录 |
| 身份与租户 | OIDC JWT 校验、RBAC、RLS、CSRF Origin 校验、审计哈希链 | OIDC issuer、真实成员/角色同步、生产 PostgreSQL 账号与密钥 | `/api/health`、`npm run db:verify`、租户隔离集成回归 |
| 素材与合规 | 素材/发布包/策略审批、冻结修订、撤销隔离、人工接管 | 肖像、声音、音乐、商品、脚本的书面授权和审核证据 | 场次发布清单、审计导出、授权文件引用 |
| 商品与渠道 | PIM/渠道标准化私网接入、幂等、商品审核、渠道验证证据 | ERP/PIM Adapter、平台 OAuth/Webhook、真实结算和对账数据 | 渠道验证报告、事实来源与时间窗、对账记录 |
| 录制与恢复 | 录制证据登记、数据库备份校验脚本、隔离恢复流程 | 对象存储版本化、站外复制、加密备份、恢复演练负责人 | 对象复制与 SHA-256、隔离恢复演练记录 |

## 发布判定

1. 先运行生产配置检查：`npm run deploy:check -- --control /srv/shuzhiren/control.env --runtime /srv/shuzhiren/runtime.env --gateway /srv/shuzhiren/gateway.env --alert-notifier /srv/shuzhiren/alert-notifier.env`。
2. 主机、权重、账号和密钥就绪后，执行内部试播、故障演练与独立输出探针验证。
3. 只有 `npm run runtime:acceptance:verify -- --evidence /srv/shuzhiren/evidence/runtime-acceptance.json` 通过，且所有外部项有可审计证据，才允许真实小规模开播。

任何缺失的外部项都是上线阻断，不应通过开发态 fixture、Gateway `/healthz`、容器 `running` 状态或口头确认绕过。

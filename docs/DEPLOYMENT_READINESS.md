# 商业部署就绪矩阵

本仓库可以完成控制面、治理、Gateway、观测、部署校验和验收证据门禁；它不能替代租用 GPU、取得平台账号、签署授权或提供生产凭据。只有代码项与外部项同时满足，才可开始对外直播。

| 范围 | 仓库已提供 | 上线前必须由部署方完成 | 验证证据 |
| --- | --- | --- | --- |
| 4090 主机 | Linux 主机只读预检、GPU 容器 smoke 检查、Compose GPU 定义、Gateway 重启后防重放命令日志；CI 渲染全部运行时 profile 并构建 LiveTalking 镜像 | 租用单卡 RTX 4090、安装驱动/Docker/NVIDIA Container Toolkit、准备模型、录屏和 Gateway 状态磁盘；加密备份并演练恢复 `/srv/shuzhiren/runtime-gateway-state` | `bash scripts/check-runtime-host.sh`、可选容器 smoke 输出、Gateway 重启/重复命令恢复记录 |
| 开源数字人 | LiveTalking + MuseTalk + CosyVoice 锁定提交、Gateway 音频封装、媒体命令与会话观测 | 下载符合许可证的权重、创建已批准 Avatar 包、实机确认动作槽位和口型/音色质量 | `npm run deploy:check`、发布包验收记录、试听/试播报告 |
| 节目插播与回退 | 已批准修订中的冻结脚本、受控 `INSERT_PROGRAM`/`ROLLBACK_PROGRAM` 命令、回执绑定、数据库节目游标、幂等回退和审计链；独立输出验证器可通过私网 probe 提交与已送达 outbox、会话、冻结片段、内容 SHA-256 和证据引用绑定的 append-only `live_program.output_observed` 记录。Gateway 回执仍只表示 LiveTalking API 已接受 | 部署水印/指纹或目的端回放验证器，保护其私网凭据，并在同网段输出探针和平台回放/指标中确认段落实际到达视频/音频输出；演练回执丢失、Gateway 重启、多 worker、RTMP 拒绝、黑屏和静音 | Gateway 命令/回执、`live_program.transition_accepted` 与 `live_program.output_observed` 审计、输出探针时间序列、验证器证据引用、平台回放或目的端指标 |
| 平台推流 | 已实现 RTMP 运行时配置、输出探针、降级和人工接管命令；SRT 需先扩展 Gateway 与验收链路 | 平台账号、私有推流地址/密钥、平台 AI 标识要求、目的端回放或中继探针 | 30 分钟内部试播、目的端输出探针记录 |
| 身份与租户 | OIDC JWT 校验、RBAC、RLS、CSRF Origin 校验、审计哈希链、控制台 standalone 容器与私网 Compose | OIDC issuer、真实成员/角色同步、生产 PostgreSQL 账号与密钥、TLS 反向代理 | `/api/health`、`npm run db:verify`、控制台 Compose 健康检查、租户隔离集成回归 |
| 素材与合规 | 素材/发布包/策略审批、冻结修订、撤销隔离、人工接管 | 肖像、声音、音乐、商品、脚本的书面授权和审核证据 | 场次发布清单、审计导出、授权文件引用 |
| 商品与渠道 | PIM/渠道标准化私网接入、幂等、商品审核；渠道连接须由私网 verifier 签发、绑定配置哈希且 24 小时内有效的证据后才能启用；账单批次、不可变账单行、订单级差异和带证据结案已建立 | 平台账号、OAuth/Webhook、应用审核、真实订单/结算数据；部署私网 `CHANNEL_EVIDENCE_VERIFIER_*` 与 `SETTLEMENT_INGEST_TENANT_TOKENS` | verifier 回执、渠道验证报告、事实来源与时间窗、账单原件 SHA-256、对账记录 |
| 录制与恢复 | 录制证据登记、独立 `RECORDING_EVIDENCE_VERIFIER_*` 回执封存、数据库备份校验脚本、Gateway 命令日志与隔离恢复流程 | 对象存储版本化与保留锁、站外复制、独立 verifier、加密备份、恢复演练负责人 | verifier 绑定对象版本/SHA-256/字节/时间窗/留存期的证据、数据库与 Gateway 状态隔离恢复演练记录 |

## 发布判定

1. 在任意开发机先运行 `npm run verify:local`。它执行可在本地完成的配置契约、策略红队、observer/探针/渠道/告警模拟、所有常驻 Node 服务入口解析、控制台类型检查、lint 和生产构建；它不连接 PostgreSQL、不启动 Docker，也不代表 Python 运行时、GPU 或平台验收。
   若本机已用同一解释器安装 `runtime/gateway/requirements.txt`，再运行 `npm run verify:local -- --with-gateway --python /absolute/path/to/python`，将额外编译 Gateway 并执行 PCM/WAV 与并发幂等测试；缺少依赖时该命令会失败，不会静默跳过。
2. 再运行生产配置检查：`npm run deploy:check -- --control /srv/shuzhiren/control.env --control-compose /srv/shuzhiren/control-plane-compose.env --runtime /srv/shuzhiren/runtime.env --gateway /srv/shuzhiren/gateway.env --channel-adapter /srv/shuzhiren/channel-adapter.env --alert-notifier /srv/shuzhiren/alert-notifier.env --require-output-probe --require-cosyvoice`。它会拒绝没有 digest、带 tag 或跨服务复用的生产镜像引用，并验证受信任 Ed25519 签名的部署 release manifest 精确绑定提交、十个服务镜像、SBOM 与 provenance 摘要。该项目的实时问答语音链路依赖 CosyVoice；仅预制内容试播才可省略后一个门禁。
3. 主机、权重、账号和密钥就绪后，执行内部试播、故障演练与独立输出探针验证；至少由水印/指纹、目的端回放或指标验证器产生一条 Ed25519 签名的输出观测，绑定同租户场次、节目命令、冻结段落、内容 SHA-256、受众和短时有效期。控制面只接受专用输出证明凭据，不能复用遥测凭据。
4. 只有 `npm run runtime:acceptance:verify -- --evidence /srv/shuzhiren/evidence/runtime-acceptance.json` 通过，且所有外部项有可审计证据（包括 PostgreSQL 与 Gateway 命令日志的隔离恢复及不重放验证），才允许真实小规模开播。

任何缺失的外部项都是上线阻断，不应通过开发态 fixture、Gateway `/healthz`、容器 `running` 状态或口头确认绕过。

## 尚未完成的仓库工作

- 选定单一目标平台后，仍需实现该平台的 OAuth、Webhook、商品同步和能力映射 Adapter；账号、应用审核、scope 和密钥是外部前置条件，但 Adapter 代码本身不是。
- 平台无关的账单批次、不可变账单行、订单级差异和证据化结案已实现；仍需为选定平台实现账单拉取与映射，并确认佣金、服务费、运费、优惠分摊、税费、保证金、跨期退款和打款周期的真实语义。现有渠道经营事件仍只用于漏斗和运营估算，不能单独作为财务结论。
- `CHANNEL_EVIDENCE_VERIFIER_*` 已有控制面契约和门禁；验证器服务对目标平台实际连通性、回执和证据归档的实现/部署仍须由受控私网完成。
- 仍需将输出探针/平台回放的实际视频与音频观测同节目段落、Gateway 回执和审计时间线关联；当前 Gateway 的 `livetalking_api_accepted` 不可作为已播出、音画同步或平台目的端可用性的证明。

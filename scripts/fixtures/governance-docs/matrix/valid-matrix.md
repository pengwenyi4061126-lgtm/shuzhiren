# 商业部署就绪矩阵（测试样例）

本样例供 scripts/test-governance-docs.mjs 使用：D1 待用户决策，RW-001-01 引用行为验证条目 V-20261106-01。

## 状态定义

- 代码已完成且有验证证据
- 代码已完成但待 CI 或 Linux 验证
- 代码已完成但待外部环境验证
- 代码未完成
- External_Prerequisite
- 待用户决策

## 真实开播放行条件

真实开播须同时满足以下两项，缺任一项即不放行：

1. 以 4090 验收证据文件运行 `npm run runtime:acceptance:verify`，并以退出码 0 结束。
2. 全部 External_Prerequisite 行均标为"已满足"。

## 外部先决条件

| 编号 | 事项 | 状态 | 外部条件 | 证据 | 对应需求 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| EP-01 | 4090 GPU 主机及端到端推流试播（至少 30 分钟的内部试播） | External_Prerequisite | 未满足 | — | 6 | 验证方式：bash scripts/check-runtime-host.sh |
| EP-02 | 平台账号、应用审核、OAuth scope、RTMP 推流地址与 Stream_Secret | External_Prerequisite | 未满足 | — | 6 | — |
| EP-03 | OIDC 提供商 | External_Prerequisite | 未满足 | — | 6 | — |
| EP-04 | TLS 证书与反向代理 | External_Prerequisite | 未满足 | — | 6 | — |
| EP-05 | KMS 或 HSM 与签名私钥 | External_Prerequisite | 未满足 | — | 6 | — |
| EP-06 | 对象存储版本化与保留锁 | External_Prerequisite | 未满足 | — | 6 | — |
| EP-07 | 受许可的模型权重 | External_Prerequisite | 未满足 | — | 6 | — |
| EP-08 | 授权素材（肖像、声音、音乐、商品、脚本） | External_Prerequisite | 未满足 | — | 6 | — |
| EP-09 | 输出、素材、录制和渠道证据 verifier 的部署 | External_Prerequisite | 未满足 | — | 6 | — |
| EP-10 | OCI registry 与受信签名 runner | External_Prerequisite | 未满足 | — | 6 | — |
| EP-11 | 4 小时单路验收证据（试播时长至少 240 分钟，同时运行的数字人数为 1） | External_Prerequisite | 未满足 | — | 6 | — |
| EP-12 | `release-production` environment 的 GitHub 设置：部署分支仅限受保护分支；至少一名必需审核人；`REGISTRY_USERNAME`、`REGISTRY_PASSWORD` 和五个签名与构建变量只定义在该 environment（Requirement 13.9） | External_Prerequisite | 已满足 | 位置=GitHub 仓库设置（样例），日期=2026-11-05，提供方=仓库所有者 | 13 | — |
| EP-13 | 模型权重许可证审查：LiveTalking_Runtime `--model musetalk` 从 `MODEL_VOLUME_PATH` 加载的权重（Requirement 39.16） | External_Prerequisite | 未满足 | — | 39 | — |
| EP-14 | 模型权重许可证审查：CosyVoice_Service 从 `COSYVOICE_MODEL_PATH` 加载的模型（当前模板为 Fun-CosyVoice3-0.5B-2512）（Requirement 39.16） | External_Prerequisite | 未满足 | — | 39 | — |

## 仓库交付项

| 编号 | 事项 | 状态 | 证据 | 对应需求 | 说明 |
| --- | --- | --- | --- | --- | --- |
| RW-001-01 | CI 六个 job 全部通过且 skipped 为 0 | 代码已完成且有验证证据 | V-20261106-01 | 1, 2 | 样例 |
| RW-002-01 | 失败隔离 | 代码已完成但待 CI 或 Linux 验证 | — | 2 | 样例 |
| RW-013-02 | 13.7：清空 environment 变量后 release job 失败 | 代码已完成但待外部环境验证 | — | 13 | 环境：release-production environment |
| RW-014-02 | 14.1：推流密钥不进入命令行参数 | 代码已完成但待外部环境验证 | — | 14 | 环境：4090 |
| RW-014-03 | 14.6：运行参数日志脱敏 | 代码已完成但待外部环境验证 | — | 14 | 环境：4090 |
| RW-014-04 | 14.7：推流开始日志脱敏 | 代码已完成但待外部环境验证 | — | 14 | 环境：4090 |
| RW-014-05 | 14.8：标准输出与标准错误不含推流密钥 | 代码已完成但待外部环境验证 | — | 14 | 环境：4090 |
| RW-015-02 | 15.14(a)：试听验收结论 | 代码已完成但待外部环境验证 | — | 15 | 环境：4090 |
| RW-015-03 | 15.14(b)：首段音频延迟 | 代码已完成但待外部环境验证 | — | 15 | 环境：4090 |
| RW-015-04 | 15.14(c)：800 字符脚本合成耗时 | 代码已完成但待外部环境验证 | — | 15 | 环境：4090 |
| RW-015-05 | 15.14(d)：SFT 预置说话人 | 代码已完成但待外部环境验证 | — | 15 | 环境：4090 |
| RW-031-02 | 31.4：Gateway 能访问 LiveTalking 与 CosyVoice | 代码已完成但待外部环境验证 | — | 31 | 环境：4090 |
| RW-031-03 | 31.5：其他服务无法连接 LiveTalking 与 CosyVoice | 代码已完成但待外部环境验证 | — | 31 | 环境：4090 |
| RW-031-04 | 31.6：LiveTalking 推流成功 | 代码已完成但待外部环境验证 | — | 31 | 环境：4090 |
| RW-032-02 | 32.7：RTMP 模式下会话 ID 为 "0" | 代码已完成但待外部环境验证 | — | 32 | 环境：4090 |
| RW-032-03 | 32.8：start_program 回执 | 代码已完成但待外部环境验证 | — | 32 | 环境：4090 |
| RW-032-04 | 32.1：Gateway 无日志连接时备份 | 代码已完成但待 CI 或 Linux 验证 | — | 32 | 环境：Linux |
| RW-040-01 | 目标平台 OAuth Adapter | 待用户决策 | — | 40 | D1 暂缓 |
| RW-040-02 | 目标平台 Webhook Adapter | 待用户决策 | — | 40 | D1 暂缓 |
| RW-040-03 | 目标平台商品同步 Adapter | 待用户决策 | — | 40 | D1 暂缓 |
| RW-040-04 | 目标平台账单 Adapter | 待用户决策 | — | 40 | D1 暂缓 |
| RW-000-01 | Linux 主机只读预检 | 代码已完成但待 CI 或 Linux 验证 | — | 无 | 样例 |

## 待决策事项

| 编号 | 事项 | 决定 | 所选平台 | 决策日期 | 覆盖规格 |
| --- | --- | --- | --- | --- | --- |
| D1 | 首个目标直播平台 | 待用户决策 | — | — | — |

## 发布判定

1. 样例。

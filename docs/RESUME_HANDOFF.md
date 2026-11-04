# 系统迁移恢复交接

更新日期：2026-11-04（Asia/Shanghai）

## 当前检查点

- 仓库：`git@github.com:pengwenyi4061126-lgtm/shuzhiren.git`
- 分支：`master`
- 远端检查点：`a42b6c4 docs: add system migration resume handoff`
- 本地检查点：`master` 当前领先远端；恢复 SSH 凭据后用 `git log origin/master..HEAD --oneline` 核对并推送全部本地提交。
- 工作区状态：干净；没有未提交的代码、配置或密钥文件。
- 本文件不保存任何平台密钥、SSH 私钥、GPU 租机凭据、OIDC 凭据或数据库口令。

最近的运行可靠性与部署安全改进：

1. `078ecf7`：Gateway 在启动前校验上游 URL、CosyVoice 采样率、请求超时、命令缓存和三类动作槽位。
2. `e49601a`：部署预检拒绝重复或超出 `0..255` 的节目、备用、人工接管动作槽位。
3. `87a1922`：渠道 Webhook 对外使用稳定错误码，内部异常仅写服务日志。
4. `8514765`：runtime-observer 在首次遥测成功前明确报告 `lastSuccessfulCycleAt: null`。
5. `fc43a91`：渠道适配器与部署预检拒绝包含嵌入凭据或非 HTTP(S) 的 `CONTROL_PLANE_URL`；渠道和部署测试均已覆盖。

## 新系统恢复步骤

1. Windows 控制面开发机至少恢复 Git 和 Node.js 20+。Docker、临时 PostgreSQL 与 Python 3.11+ 只在完整 CI、Gateway 本地测试或 Linux 4090 运行机部署时需要；4090 运行机还需要 NVIDIA 驱动、NVIDIA Container Toolkit 和受许可的模型权重。
2. 配置能访问 GitHub 仓库的 SSH 私钥，再验证：

```powershell
ssh -T git@github.com
```

3. 克隆并恢复锁定的开源源码：

```powershell
git clone --recurse-submodules git@github.com:pengwenyi4061126-lgtm/shuzhiren.git E:\shuzizhibo
Set-Location E:\shuzizhibo
git checkout master
git pull --ff-only
git submodule update --init --recursive
npm ci
```

4. 不要从旧电脑复制 `.env`、SSH 私钥或模型权重到仓库。应从受控密钥管理和加密备份分别恢复生产配置。以 `config/*.example.env` 为模板，补齐真实值后运行：

```powershell
npm run deploy:check
```

5. 在 Windows 本地、Python 没有正确关联到 `python` 命令时，为 Gateway 测试显式设置解释器路径：

```powershell
$env:PYTHON = "C:\path\to\python.exe"
npm run runtime:gateway:config:test
```

6. 恢复完整开发验证时优先执行：

```powershell
npm run deploy:check:test
npm run channel-adapter:test
npm run observer:runtime:test
npm run lint
npm run build
```

完整 CI 还需要 Docker、临时 PostgreSQL 与 Python Gateway 依赖，定义在 `.github/workflows/ci.yml`。

## 未完成边界

代码框架、控制面、治理、审计、运行时 Gateway、observer、输出探针、渠道桥、部署门禁和 CI 已持续实现并推送；但以下事项必须在真实受控环境完成，不能用本地 fixture 声称完成：

- 4090 租机上的 LiveTalking + MuseTalk + CosyVoice 端到端推流、显存、首帧、长时稳定性与故障演练。
- 平台账号、RTMP 推流地址/密钥、OAuth/Webhook、商品与订单真实对接。
- OIDC、TLS、私网 PostgreSQL、KMS/密钥管理、对象存储、告警 Webhook、录播归档与隔离恢复演练。
- 真实授权素材、声线/肖像授权、模型许可证和发布包验收证据。
- 4 小时单路验收和 `npm run runtime:acceptance:verify` 所需的真实验收证据。

## 代码审计结果与下一步

- 渠道适配器出站控制面 URL 的安全约束已在 `fc43a91` 完成并由 `npm run channel-adapter:test`、`npm run deploy:check:test` 验证。
- 已执行 `npm run verify:local`：本机配置契约、策略、权限、运行时可靠性、observer、输出探针、渠道、告警、类型检查、lint 与生产构建均通过。该命令不连接 PostgreSQL、不启动 Docker，也不能证明 Python Gateway、GPU 或平台验收。
- 逐项审计仍在进行，不能以没有 `TODO` 或本地门禁通过替代完成判定。已修复渠道出站 URL、运行时 Compose CI 渲染/LiveTalking 构建门禁，以及商品版本、节目修订、策略、模型发布和直播命令的数据库级不可变性；节目修订已补齐 `DRAFT` 全量编辑、送审冻结、审批人/时间证据、同事务生命周期审计和控制台工作区。CI 的 PostgreSQL 架构与控制面集成测试覆盖草稿改写、送审后拒绝改写及批准状态；本机不启动 PostgreSQL，因此这部分实际数据库执行仍由 CI 负责。
- 本轮补齐开播前节目修订闭环：`055_governed_show_program_revisions.sql` 建立候选修订请求、RLS、单场次活动请求唯一约束、创建人不得自审、候选依赖绑定封存与场次重绑触发器；服务/API/工作台克隆已批准版本，运营编辑和送审候选段落，独立审核人批准后在同一事务重绑场次、重建发布清单并要求重新预检。`ARMED`、`LIVE`、`DEGRADED` 场次一律拒绝创建或应用候选修订；这不是实时插播功能。`npm run program:revisions:check`、`db:verify` 与 PostgreSQL 控制面集成测试覆盖状态机、封存、独立审批、重绑和重新预检边界。
- 本轮已补齐渠道人工回复的仓库内闭环：`053_channel_reply_workflow.sql`、控制台草稿/送审/审批/拒绝/投递/失败重试界面与 API、来源渠道绑定、不可变证据快照、独立渠道 outbox、worker -> 私网 adapter -> provider bridge 回执，以及“只有 `sent` 才关闭互动”的约束。CI PostgreSQL 集成测试新增该闭环的角色、状态、outbox 和回执断言。本机不启动 PostgreSQL，因此最终迁移/集成执行仍由 CI 或 Linux 数据库环境负责。
- 本轮继续完成成员授权第一层：`054_governed_membership_authorization.sql`、管理员成员 API、首位管理员受审计引导脚本、数据库成员状态/RLS/最后管理员保护，以及所有人工 API 的服务端角色门禁。生产 OIDC 仅确认主体与租户，角色由有效数据库成员关系决定；旧 JWT 角色无法恢复已暂停/撤销成员或覆盖降权。`npm run membership:authz:check`、类型检查与 lint 已覆盖静态授权边界；CI PostgreSQL 集成测试覆盖伪造角色 claim、暂停成员和最后管理员约束。
- 仍待完成的仓库内工作包括：受控直播预览、成员资源范围与服务主体最小权限、对象/镜像证据的实际内容校验，以及选定平台的具体 OAuth/Webhook/商品/结算 Adapter。实时插播不属于当前已支持能力，必须另行完成运行时安全切换、回滚与平台时序审计后才能列为可交付功能；它不能误列为 GPU 或账号外部前置条件。
- 渠道回复的 `providerReplyEndpoint` 只是受控标准化桥接契约；抖音、淘宝、视频号等实际 API、OAuth scope、应用审核和商家账号权限仍是外部平台前置条件。缺少回执时 worker 保持失败/可重试状态，不会把互动伪装成已处理。
- 恢复受控 SSH 凭据后推送全部本地提交；继续按上述代码审计项实现，再按部署就绪矩阵在受控环境收集外部证据，并以 `npm run runtime:acceptance:verify` 作为真实开播门禁。

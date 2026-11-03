# 系统迁移恢复交接

更新日期：2026-11-03（Asia/Shanghai）

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
- 已执行 `npm run verify:local`：44 项本机配置契约、策略、权限、运行时可靠性、observer、输出探针、渠道、告警、类型检查、lint 与生产构建均通过。该命令不连接 PostgreSQL、不启动 Docker，也不能证明 Python Gateway、GPU 或平台验收。
- 逐项审计仍在进行，不能以没有 `TODO` 或本地门禁通过替代完成判定。已修复渠道出站 URL、运行时 Compose CI 渲染/LiveTalking 构建门禁，以及商品版本、节目修订、策略、模型发布和直播命令的数据库级不可变性；后者由 CI 的 PostgreSQL 架构验证在回滚事务中实际篡改测试。
- 仍待完成的仓库内工作包括：可编辑且可审批的节目版本/插播流程、受控直播预览与人工回复闭环、OIDC 身份声明之外的成员授权与资源范围、对象/镜像证据的实际内容校验，以及选定平台的具体 OAuth/Webhook/商品/结算 Adapter。它们不能误列为 GPU 或账号外部前置条件。
- 恢复受控 SSH 凭据后推送全部本地提交；继续按上述代码审计项实现，再按部署就绪矩阵在受控环境收集外部证据，并以 `npm run runtime:acceptance:verify` 作为真实开播门禁。

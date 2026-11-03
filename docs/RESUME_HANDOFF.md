# 系统迁移恢复交接

更新日期：2026-11-03（Asia/Shanghai）

## 当前检查点

- 仓库：`git@github.com:pengwenyi4061126-lgtm/shuzhiren.git`
- 分支：`master`
- 已推送检查点：`8514765 fix: report observer startup health accurately`
- 工作区状态：干净；没有未提交的代码、配置或密钥文件。
- 本文件不保存任何平台密钥、SSH 私钥、GPU 租机凭据、OIDC 凭据或数据库口令。

最近已推送的运行可靠性改进：

1. `078ecf7`：Gateway 在启动前校验上游 URL、CosyVoice 采样率、请求超时、命令缓存和三类动作槽位。
2. `e49601a`：部署预检拒绝重复或超出 `0..255` 的节目、备用、人工接管动作槽位。
3. `87a1922`：渠道 Webhook 对外使用稳定错误码，内部异常仅写服务日志。
4. `8514765`：runtime-observer 在首次遥测成功前明确报告 `lastSuccessfulCycleAt: null`。

## 新系统恢复步骤

1. 安装 Git、Node.js 20+、Docker Desktop/Engine、可用于 Gateway 测试的 Python 3.11+；4090 运行机还需要 NVIDIA 驱动、NVIDIA Container Toolkit 和受许可的模型权重。
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

## 下一步代码工作

下一轮应从渠道适配器的出站控制面 URL 继续：限制 `CONTROL_PLANE_URL` 为无嵌入凭据的 HTTP(S) 地址，并在 `scripts/check-deployment-config.mjs` 与 `scripts/test-deployment-config.mjs` 中加入同一部署预检。上一轮对此的补丁未应用成功，且已确认工作区干净，所以不存在半完成修改。

随后做一次按 `docs/FRAMEWORK_STATUS.md` 的逐项完成审计：用真实运行证据区分“代码已完成”和“等待 GPU/平台/账号”的外部前置条件。

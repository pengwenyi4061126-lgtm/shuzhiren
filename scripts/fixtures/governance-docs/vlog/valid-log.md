# 样例：合格的验证记录

scripts/test-governance-docs.mjs 用本文件检查 `docs:governance:check --log`：每种条目类型各一条，全部合格。提交 SHA 是虚构的，不在 git 历史中，门禁对它们的静态门禁覆盖只输出 NOTE。

```text
## V-20990101-99 代码块中的标题不是条目
```

## V-20261106-01 ci:workflow:check 在本机通过

```yaml
编号: V-20261106-01
类型: 结论
结论: ci:workflow:check 在本机以退出码 0 结束
判定: 静态检查
依据来源:
  - 类别: 本机运行
    命令: npm run ci:workflow:check
    日期: 2026-11-06
    退出码: "0"
    操作系统: Windows 11 专业版 10.0.22631.7376
    提交: 0123456789abcdef0123456789abcdef01234567
    检查:
      - { 名称: "ci:workflow:check", 标签: static }
    未执行的 CI 检查:
      - { job: postgres-integration, 名称: "npm run db:migrate", 原因: 本机缺少 PostgreSQL }
静态门禁覆盖:
  - { 门禁: "ci:workflow:check", 行为测试: [无] }
```

## V-20261106-02 ci:gates:test 在 GitHub Actions 中通过

```yaml
编号: V-20261106-02
类型: 结论
结论: node-unit 中的 ci:gates:test 通过
判定: 行为验证
依据来源:
  - 类别: CI 或 Linux 运行
    平台: GitHub Actions
    run id: "41900000002"
    提交: 0123456789abcdef0123456789abcdef01234567
    运行结论: success
    runner 镜像:
      - { job: node-unit, 镜像: ubuntu-24.04, 版本: 20261020.1.0 }
    步骤:
      - { job: node-unit, 序号: "1", 步骤: Set up job, 结论: success }
      - { job: node-unit, 序号: "5", 步骤: "Run npm run ci:gates:test", 结论: success, 标签: behavioral }
    skipped 步骤数: "0"
    node20 弃用告警数: "0"
```

## V-20261106-03 第 31 步失败的根因已由日志证实

```yaml
编号: V-20261106-03
类型: CI 根因
结论: compose 按 infra/compose/ 解析 env_file，第 31 步因 env 文件不存在而失败
判定: 未验证
根因: step env CONTROL_PLANE_ENV_FILE 的相对路径按 compose 文件所在目录解析，指向不存在的文件
确认方式: CI 日志摘录
日志或命令输出: |
  env file /home/runner/work/shuzhiren/shuzhiren/infra/compose/config/control-plane.example.env not found
修复提交: 371a2032773b7a691ae59261af77d828ae9afaaa
候选根因: 证实
依据来源:
  - 类别: CI 或 Linux 运行
    平台: GitHub Actions
    run id: "41869137741"
    提交: dc2916eef45f2aebacde24598723468f23ee61a6
    运行结论: failure
    runner 镜像:
      - { job: console, 镜像: ubuntu-26.04, 版本: 20261101.1.0 }
    步骤:
      - { job: console, 序号: "31", 步骤: "Run docker compose --env-file config/control-plane-compose.example.env -f infra/compose/docker-compose.control-plane.yml config", 结论: failure, 标签: static }
```

## V-20261106-04 py_compile 步骤被加强

```yaml
编号: V-20261106-04
类型: CI 步骤变更
结论: py_compile 的文件集合扩大为超集
判定: 未验证
基线提交: dc2916eef45f2aebacde24598723468f23ee61a6
变更提交: 371a2032773b7a691ae59261af77d828ae9afaaa
变更:
  - 原命令: python3 -m py_compile runtime/gateway/app.py runtime/gateway/audio.py
    原 job: console
    变更方式: 加强
    替代命令: python3 -m py_compile runtime/gateway/*.py scripts/test-runtime-gateway-config.py
    替代 job: python-gateway
    理由: 新文件集合是原集合的超集
依据来源:
  - 类别: 需外部环境
    环境: GitHub Actions 的 python-gateway job
    命令或验收步骤: 推送后在运行页面核对 python-gateway 的 py_compile 步骤结论
```

## V-20261106-05 首次绿色 CI

```yaml
编号: V-20261106-05
类型: 首次绿色 CI
结论: '#491 之后首次以 success 结束的 master 推送运行'
判定: 静态检查
run id: "41900000005"
提交: 0123456789abcdef0123456789abcdef01234567
skipped 步骤数: "0"
依据来源:
  - 类别: CI 或 Linux 运行
    平台: GitHub Actions
    run id: "41900000005"
    提交: 0123456789abcdef0123456789abcdef01234567
    运行结论: success
    runner 镜像:
      - { job: static-gates, 镜像: ubuntu-24.04, 版本: 20261020.1.0 }
    步骤:
      - { job: static-gates, 步骤: "Run npm run lint", 结论: success, 标签: static }
    skipped 步骤数: "0"
```

## V-20261106-06 4090 验收只能在外部环境运行

```yaml
编号: V-20261106-06
类型: 结论
结论: 4090 单路验收证据尚待外部环境提供
判定: 未验证
依据来源:
  - 类别: 需外部环境
    环境: 4090 GPU 主机（Readiness_Matrix EP-01）
    命令或验收步骤: npm run runtime:acceptance:verify -- --evidence /srv/shuzhiren/evidence/runtime-acceptance.json
```

# 验证记录（Verification_Report）

本文件是 Requirement 4 所说 Verification_Report 的主记录。每条记录写明一项验证结论、它的依据来源、程序复核过的判定，以及依据中各项检查的标签。`npm run docs:governance:check`（`scripts/check-governance-docs.mjs`，规则在 `scripts/lib/verification-log.mjs`）在 Local_Verification 与 CI 的 `static-gates` 中校验本文件；行为测试为 `npm run docs:governance:test`。

## 填写流程

1. **先运行，后登记。** 被验证的提交 X 的 SHA 在提交之后才能确定，所以条目一般写在后续提交 X+1 中，引用 X。GitHub Actions 运行等结束后再登记，`依据来源` 用 `npm run ci:evidence:collect -- --repo pengwenyi4061126-lgtm/shuzhiren --run-id <id>` 生成草稿；本机运行条目的 `检查` 与 `未执行的 CI 检查` 直接取 `npm run verify:local` 的 `RUN` 行与末尾的 `NOT RUN` 行。
2. **提交说明中的验证结论。** 写一行 trailer `Verification-Log: V-YYYYMMDD-NN`（指向本文件中已有且通过校验的条目），或者内嵌一个与条目结构相同的 yaml 代码块。只有提交说明中可以写 `提交: 本提交`，本文件中必须写 SHA。每次提交前运行 `npm run docs:governance:check -- --commit-msg <提交说明文件>`（写 `-` 时从标准输入读取）。
3. **其他文档引用本文件。** Handoff_Doc 与 `docs/` 中的文档声明"已验证""已覆盖""已通过"时，在同一句话、列表项或表格单元格内链接 `VERIFICATION_LOG.md#v-yyyymmdd-nn`，或者直接标"未验证"。CI 结论只能写"未验证"或引用真实的 run id。
4. **Requirement 5.2 的流程规则。** CI_Pipeline 的某次运行符合 Requirement 5.6（结论为 success；相关步骤实际执行并通过，不是 skipped；所测提交就是引入所述行为的提交或其后续提交），并登记到本文件之后，该运行完成后第一个修改 Handoff_Doc 的提交，必须把与该运行实际执行并通过的步骤对应的"未验证"标注替换为运行引用 `[run <id> @ <sha>](VERIFICATION_LOG.md#v-…)`。门禁无法判断哪个提交是"第一个修改 Handoff_Doc 的提交"，这一条由提交者执行、由评审者核对。
5. **不写机密值。** 证据只写引用（文件位置、记录编号或运行 ID），不写推流密钥、签名私钥、OAuth 应用密钥、registry 凭据或 GitHub token 的值。门禁按 `scripts/lib/verification-log.mjs` 的 `SECRET_PATTERNS`（设计第 1 部分 §6.1）逐行扫描本文件，命中时报 `SECRET <文件>:<行>`，只报出模式名，不回显内容。

## 条目格式

每条记录由一个二级标题 `## V-YYYYMMDD-NN <结论摘要>` 和紧跟其后的一个 yaml 代码块组成（中间只允许空行）。YAML 用 js-yaml 的 `FAILSAFE_SCHEMA` 解析，所有值都按字符串读取。本文件只有条目使用 yaml 代码块，下面的示例用 text 代码块。编号中的日期是被记录事件的日期，同一天的序号从 01 起递增，编号不得重复。标题与代码块不配对、YAML 解析失败、编号重复或不符合 `V-YYYYMMDD-NN` 时，门禁报 `VLOG <编号或行号> <原因>`。

```text
编号: V-YYYYMMDD-NN          # 与标题中的编号相同
类型: 结论                    # 结论 | CI 根因 | CI 步骤变更 | 首次绿色 CI（ENTRY_TYPES 中登记的类型）
结论: <一句话结论>
判定: 未验证                  # 行为验证 | 静态检查 | 未验证，必须与门禁复核的结果相同
依据来源:                     # 至少一项；每项只有一个 类别
  - 类别: 本机运行
    命令: <完整命令与参数>
    日期: YYYY-MM-DD
    退出码: "0"
    操作系统: <名称与版本>
    提交: <7 至 40 位小写十六进制 SHA>
    检查:                      # 至少一项
      - { 名称: <检查 id 或 RUN 行命令>, 标签: static }
    未执行的 CI 检查:           # 本机运行必填；没有时写 [无]
      - { job: <job>, 名称: <npm 脚本名或 CI 步骤命令>, 原因: <本机缺少的组件或未启用的选项> }
  - 类别: CI 或 Linux 运行
    平台: GitHub Actions
    run id: "<运行页面 URL 中的数字 ID>"
    提交: <SHA>
    运行结论: success
    runner 镜像:               # 步骤中出现的每个 job 一项
      - { job: <job>, 镜像: <Image>, 版本: <Version> }
    步骤:                      # 至少一项
      - { job: <job>, 序号: "<可选>", 步骤: <运行页面显示的步骤名称>, 结论: success, 标签: static }
    skipped 步骤数: "<可选>"
    node20 弃用告警数: "<可选>"
  - 类别: CI 或 Linux 运行
    平台: Linux                # 其余字段与本机运行相同，未执行的 CI 检查 可选
  - 类别: 需外部环境
    环境: <例如 4090 GPU 主机（Readiness_Matrix EP-01）>
    命令或验收步骤: <在该环境中执行的命令或验收步骤>
静态门禁覆盖:                  # 依据中列出 Static_Gate 时必填
  - { 门禁: <Static_Gate 的检查 id>, 行为测试: [无] }
说明: <可选：补充事实、限制与待办>
```

字段规则：

- `提交` 为 7 至 40 位小写十六进制 SHA；标明 40 位的字段必须写完整 SHA。`日期` 是合法的 YYYY-MM-DD 日期，`run id`、`序号`、`skipped 步骤数`、`node20 弃用告警数` 是非负整数，`退出码` 是整数。
- `运行结论` 与步骤的 `结论` 照录 GitHub jobs API 的 `conclusion` 原值（success、failure、skipped、cancelled 等）。只写 job 或运行的整体结论不满足 Requirement 4.3。
- `ci:evidence:collect` 的输出可以原样放进 `依据来源`：`序号`、`skipped 步骤数`、`node20 弃用告警数` 是 GitHub Actions 来源的可选字段。没有 `GITHUB_TOKEN` 时它为 runner 镜像写的"待抄录"不是证据：门禁接受这个值，但含"待抄录"的来源不算字段齐全（Requirement 3.3、4.7），镜像名与版本要从运行页面 `Set up job` 步骤的 Runner Image 组抄录。采集器不写 `标签`：对应登记检查的步骤要按清单补上标签，准备步骤（Set up job、Checkout、npm ci、Post、Complete job 等）不写标签。
- 其他键（如 `说明`、`风险`）可以按需添加，门禁不解释它们的内容。

各类型在通用字段之外的字段：

- `CI 根因`（Requirement 1.12）：`根因`；`确认方式`（CI 日志摘录 或 Linux 复现）；`日志或命令输出`（YAML 块标量，原样粘贴）；`复现命令`（Linux 复现时必填）；`修复提交`（40 位）；`候选根因`（证实 或 否定）。
- `CI 步骤变更`（Requirement 1.13、1.14）：`基线提交`、`变更提交`（均为 40 位）；`变更` 是列表，每项包含 `原命令`、`原 job`、`变更方式`（删除、跳过、放宽、加强、移动 之一）、`替代命令`、`替代 job`、`理由`。`npm run ci:steps:diff -- <base> <head>` 生成草稿，草稿中的"待定"与"待填写"必须改掉。命令、参数、step env 与条件都不变、只换了 job 的步骤属于"移动"，可以在 `说明` 中汇总，不必逐条列出；其余每个变化的步骤逐项列出。
- `首次绿色 CI`（Requirement 1.15）：`run id`；`提交`（40 位）；`skipped 步骤数`（必须为 "0"）。`依据来源` 中必须有该 run 的 GitHub Actions 来源，运行结论为 success。

## 判定复核

`判定` 由人填写，门禁用 `classifyConclusion` 重新计算，两者不同时报错。计算按 Requirement 4.6、4.7、4.8 的顺序：

1. 任一"本机运行"或"CI 或 Linux 运行"来源没有成功执行，即运行结论或任一列出步骤的结论不是 success，或退出码不是 0，结果为"未验证"。
2. 否则，如果没有一个字段齐全的此类来源，结果为"未验证"。字段齐全指 Requirement 4.2 或 4.3 要求的字段都有且合法，runner 镜像不是"待抄录"，并且至少列出一项登记的检查（本机或 Linux 来源）或一个带标签的步骤（GitHub Actions 来源）。只有"需外部环境"来源的结论因此是"未验证"。
3. 否则，如果字段齐全的来源中全部标签都是 static，结果为"静态检查"。
4. 其余情况为"行为验证"。

## 标签与静态门禁覆盖

- **标签**（Requirement 36.13）：`检查` 与 `步骤` 的 `标签` 必须与 `scripts/verify-local-checks.mjs` 的 `LOCAL_CHECKS` 或 `scripts/ci-required-steps.mjs` 的 `CI_ONLY_STEPS` 中登记的标签相同。检查的 `名称` 写清单中的 id（如 `ci:workflow:check`）、`RUN` 行中的命令或 `CI_ONLY_STEPS` 的命令；步骤按 `Run <命令>` 或 ci.yml 中同一 job 的步骤 `name` 找到命令。名称不在这两份清单中时报 `VLOG-LABEL-UNKNOWN`。唯一例外：本机或 Linux 来源可以把自己的 `命令` 原样写成一项 `标签: static` 的检查，用来记录不在任何清单中的临时命令。这种检查不满足 Requirement 4.2"以 npm 脚本名或测试文件名标识"的要求，只含这种检查的来源不算字段齐全，结论只能是"未验证"。
- **静态门禁覆盖**（Requirement 36.14）：Static_Gate 指 `LOCAL_CHECKS` 中标为 static、且 npm 脚本执行 `scripts/check-*.mjs` 的检查。依据中列出 Static_Gate 时，`静态门禁覆盖` 必须逐个列出它们；每项的 `行为测试` 必须与条目所基于提交中 `scripts/static-gate-coverage.mjs` 的 `STATIC_GATE_COVERAGE[门禁]` 相同，映射为空或该提交中还没有这个文件时写 `[无]`。门禁用 git 读取该提交中的映射文件；提交不在本地 git 历史中（例如 CI 的浅克隆）时输出 `NOTE VLOG-COVERAGE` 并跳过这一项核对。本机有完整历史，Local_Verification 会核对。`[无]` 只表示映射中没有登记覆盖它的行为测试。

## 条目

## V-20261104-01 CI #491 在 console 第 31 步失败，其后步骤全部跳过（失败基线）

```yaml
编号: V-20261104-01
类型: 结论
结论: CI #491（run 41869137741，提交 dc2916e）的结论为 failure；console job 第 31 步渲染 control-plane compose 失败，其后 71 个验证步骤与 1 个 Post 步骤为 skipped
判定: 未验证
依据来源:
  - 类别: CI 或 Linux 运行
    平台: GitHub Actions
    run id: "41869137741"
    提交: dc2916eef45f2aebacde24598723468f23ee61a6
    运行结论: failure
    runner 镜像:
      - { job: console, 镜像: ubuntu-26.04, 版本: "20261025.179.1" }
    步骤:
      - { job: console, 序号: "31", 步骤: "Run docker compose --env-file config/control-plane-compose.example.env -f infra/compose/docker-compose.control-plane.yml config", 结论: failure, 标签: static }
    skipped 步骤数: "72"
    node20 弃用告警数: "1"
说明: >-
  依据由 npm run ci:evidence:collect -- --repo pengwenyi4061126-lgtm/shuzhiren --run-id 41869137741
  于 2026-11-05 在本机生成（未设置 GITHUB_TOKEN，退出码 0）。job console 的 id 为 126711085025，
  于 2026-11-04（UTC）运行，共 106 个步骤；失败步骤只有第 31 步。annotations 共 3 条：1 条 warning
  说明 actions/checkout@v4、actions/setup-node@v4 以 Node.js 20 为目标、被强制运行在 Node.js 24 上；
  1 条 notice 说明 ubuntu-latest 将迁移到 Ubuntu 26；1 条 failure 为 Process completed with exit code 1.。
  公开 API 不提供 job 日志。2026-11-05 用户授权读取 CI 后，以 GITHUB_TOKEN 重新运行同一采集命令（退出码 0；token
  只放在子进程环境中，没有打印或写入文件），从 job 日志 Set up job 步骤的 Runner Image 组读到镜像 ubuntu-26.04、
  版本 20261025.179.1，替换了原来的"待抄录"；运行结论为 failure，所以判定仍为未验证。第 31 步的错误行与根因见
  V-20261105-11。本条是 Readiness_Matrix 与交接文档引用的失败基线。
```

## V-20261105-01 任务 1.2 拆分 CI 为六个 job：无删除、跳过或放宽

```yaml
编号: V-20261105-01
类型: CI 步骤变更
结论: 提交 371a203 把 dc2916e 的 97 个 CI 验证步骤分到六个 job；没有步骤被删除、跳过或放宽；3 个步骤的命令或 step env 改变（1 个加强、2 个移动），其余 94 个原样移动
判定: 未验证
基线提交: dc2916eef45f2aebacde24598723468f23ee61a6
变更提交: 371a2032773b7a691ae59261af77d828ae9afaaa
依据来源:
  - 类别: 本机运行
    命令: npm run --silent ci:steps:diff -- dc2916e 371a2032773b7a691ae59261af77d828ae9afaaa
    日期: 2026-11-05
    退出码: "0"
    操作系统: Windows 11 专业版 10.0.22631.7376（23H2）
    提交: ae6e0ea5a0419ad238a13ea39e49cc22e2b0577c
    检查:
      - { 名称: "npm run --silent ci:steps:diff -- dc2916e 371a2032773b7a691ae59261af77d828ae9afaaa", 标签: static }
    未执行的 CI 检查:
      - { 名称: CI_Pipeline 六个验证组的全部验证步骤, 原因: 本次本机运行只执行 ci:steps:diff（只读取 git 对象），没有运行 Local_Verification；Local_Verification 在本机未执行的 CI 步骤及原因见 V-20261105-03 }
变更:
  - 原命令: python3 -m py_compile runtime/gateway/app.py runtime/gateway/audio.py
    原 job: console
    变更方式: 加强
    替代命令: python3 -m py_compile runtime/gateway/*.py scripts/test-runtime-gateway-config.py
    替代 job: python-gateway
    理由: >-
      新文件集合 runtime/gateway/app.py、runtime/gateway/audio.py、scripts/test-runtime-gateway-config.py
      是原集合 runtime/gateway/app.py、runtime/gateway/audio.py 的超集（ci:steps:diff 按两个提交的文件树展开 *），
      原有的编译检查全部保留，并覆盖 Local_Verification 的 py_compile 检查（设计第 1 部分 §1.3.2 第 1 项，Requirement 1.6）。
  - 原命令: docker compose --env-file config/control-plane-compose.example.env -f infra/compose/docker-compose.control-plane.yml config
    原 job: console
    变更方式: 移动
    替代命令: docker compose --env-file config/control-plane-compose.example.env -f infra/compose/docker-compose.control-plane.yml config
    替代 job: compose-render
    理由: >-
      docker compose 命令与参数不变，步骤从 console 移到 compose-render。唯一的差异是 step env
      CONTROL_PLANE_ENV_FILE 由 config/control-plane.example.env 改为 ../../config/control-plane.example.env：
      compose 按 compose 文件所在的 infra/compose/ 解析 env_file，原值指向不存在的
      infra/compose/config/control-plane.example.env（#491 第 31 步失败的候选根因，见 V-20261104-01），
      新值指向仓库中的 config/control-plane.example.env（Requirement 1.10）。步骤没有被删除，
      没有新增 if:、continue-on-error 或忽略退出码的写法，渲染仍须以退出码 0 结束，所以不是删除、跳过或放宽。
      §1.3.4 的五个取值中没有"改正 env 路径"这一类；按 Requirement 1.13"命令与参数不变地移动到另一个 job"
      记为移动，不记为加强，以免把路径改正写成增加了断言。
  - 原命令: docker build --file runtime/livetalking/Dockerfile --tag shuzhiren-livetalking-ci .
    原 job: console
    变更方式: 移动
    替代命令: docker build --load --file runtime/livetalking/Dockerfile --tag shuzhiren/livetalking:ci .
    替代 job: docker-build
    理由: >-
      步骤从 console 移到 docker-build。参数有两处变化：增加 --load；tag 由 shuzhiren-livetalking-ci
      改为 shuzhiren/livetalking:ci（跨部分裁决 5）。Dockerfile（runtime/livetalking/Dockerfile）与构建上下文（.）
      不变，没有 --target 或 --build-arg 的变化，构建内容和"构建以退出码 0 结束"这一断言不变；--load
      只要求把构建结果载入本地镜像库，供同一 job 的后续步骤按 tag 使用。步骤没有被删除、跳过或放宽。
      设计第 1 部分 §1.3.2 第 3 项称之为"等价改写"，它不是 §1.3.4 的五个取值之一；这里按最保守的解释记为移动
      （不声称加强），并逐项写明参数差异。
说明: >-
  ci:steps:diff 草稿的统计为：未变 0，移动 94，加强 1，待定 2，放宽 0，跳过 0，删除 0，新增 6。
  上面 3 项是草稿中的 1 个加强与 2 个待定（已定为移动）；其余 94 个步骤的命令、参数、step env 与条件都不变，
  只从 console 移到 static-gates、node-unit、python-gateway、postgres-integration、compose-render、docker-build 之一，
  按 Requirement 1.13 不视为删除，这里不逐条列出（完整草稿可用上面的命令重新生成）。job 级 env
  DATABASE_URL 只保留在 postgres-integration；2026-11-05 在本机用 Select-String 检索，移到其他 job
  的步骤所执行的脚本都不读取继承的 DATABASE_URL（需要时在子进程环境或测试替身中自行设置），所以这一差异
  不放宽这些步骤。新增的 6 个验证步骤为 ci:coverage:check、membership:scopes:check、
  governance:tenant-scope:check、ci:gates:test、ci:db-fail-closed:test 与 CosyVoice 镜像构建，
  不属于 Requirement 1.14 的记录范围。CI 尚未在 371a203 或其后的提交上运行，变更后的步骤没有运行结果，
  所以判定为未验证。
```

## V-20261105-02 Miniforge 安装脚本的 SHA-256 与发布方公布值一致（本机复算）

```yaml
编号: V-20261105-02
类型: 结论
结论: runtime/cosyvoice/miniforge.json 固定的 Miniforge3-26.9.4-1-Linux-x86_64.sh 的 SHA-256 与发布方 .sha256 文件中的值相同，并与本机下载文件的 Get-FileHash 复算结果相同
判定: 未验证
依据来源:
  - 类别: 本机运行
    命令: pwsh -NoProfile -Command "(Get-FileHash -Algorithm SHA256 -LiteralPath <tmp>\Miniforge3-26.9.4-1-Linux-x86_64.sh).Hash"
    日期: 2026-11-05
    退出码: "0"
    操作系统: Windows 11 专业版 10.0.22631.7376（23H2），PowerShell 7.6.9
    提交: 371a2032773b7a691ae59261af77d828ae9afaaa
    检查:
      - { 名称: "pwsh -NoProfile -Command \"(Get-FileHash -Algorithm SHA256 -LiteralPath <tmp>\\Miniforge3-26.9.4-1-Linux-x86_64.sh).Hash\"", 标签: static }
    未执行的 CI 检查:
      - { job: docker-build, 名称: "docker build --file runtime/cosyvoice/Dockerfile --build-arg MINIFORGE_URL=\"$url\" --build-arg MINIFORGE_SHA256=\"$sha\" --tag shuzhiren-cosyvoice-ci .", 原因: 本机缺少 Docker }
      - { 名称: CI_Pipeline 其余验证步骤, 原因: 本次本机运行只执行上面的哈希命令，没有运行 Local_Verification；Local_Verification 在本机未执行的 CI 步骤及原因见 V-20261105-03 }
说明: >-
  转录自任务 1.2 的提交 371a2032773b7a691ae59261af77d828ae9afaaa 的提交说明（Miniforge review 一节），
  本次没有重新下载。命令中的 <tmp> 是 %TEMP%\miniforge-review（仓库外的临时目录，核对后已删除）。
  发布方值取自 https://github.com/conda-forge/miniforge/releases/download/26.9.4-1/Miniforge3-26.9.4-1-Linux-x86_64.sh.sha256，
  为 571b410272cc434f28bc6c5c49ca8ffd4a4d1bcba9f57f1b6baccdb46446cfcc，release API 的 asset digest 与之相同；
  本机输出 571B410272CC434F28BC6C5C49CA8FFD4A4D1BCBA9F57F1B6BACCDB46446CFCC，转为小写后与发布方值及
  miniforge.json 的 sha256 相同。两个文件用 curl.exe -sS -L --fail --retry 3 下载，均以退出码 0 结束，
  安装脚本为 128128881 字节；26.9.4-1 是 GitHub 上标为 latest 的正式版本（2026-10-26 发布）。
  判定为未验证：Get-FileHash 不是 LOCAL_CHECKS 或 CI_ONLY_STEPS 中登记的检查，不满足 Requirement 4.2
  以 npm 脚本名或测试文件名标识检查的要求。这个值在 CI 中由 docker-build 的 CosyVoice 镜像构建验证
  （runtime/cosyvoice/Dockerfile 用 sha256sum -c 校验下载文件），该步骤尚无运行结果。
```

## V-20261105-03 提交 ae6e0ea 上 npm run verify:local 以退出码 0 结束

```yaml
编号: V-20261105-03
类型: 结论
结论: 在提交 ae6e0ea（阶段 1 任务 1.1 至 1.5 完成后）的干净工作树上，npm run verify:local（不带 --with-gateway）以退出码 0 结束，69 项检查全部通过；CI_Pipeline 中有 38 个验证步骤本机未执行
判定: 行为验证
依据来源:
  - 类别: 本机运行
    命令: npm run verify:local
    日期: 2026-11-05
    退出码: "0"
    操作系统: Windows 11 专业版 10.0.22631.7376（23H2）
    提交: ae6e0ea5a0419ad238a13ea39e49cc22e2b0577c
    检查:
      - { 名称: "deploy:check", 标签: static }
      - { 名称: "deploy:check:test", 标签: behavioral }
      - { 名称: "deploy:manifest:test", 标签: behavioral }
      - { 名称: "deploy:images:test", 标签: behavioral }
      - { 名称: "release:evidence:test", 标签: behavioral }
      - { 名称: "release:workflow:check", 标签: static }
      - { 名称: "release:workflow:gate:test", 标签: behavioral }
      - { 名称: "backup:automation:check", 标签: static }
      - { 名称: "backup:restore:drill:test", 标签: behavioral }
      - { 名称: "control-plane:compose:check", 标签: static }
      - { 名称: "runtime:compose:check", 标签: static }
      - { 名称: "console:page-auth:check", 标签: static }
      - { 名称: "console:security-headers:check", 标签: static }
      - { 名称: "console:client-requests:check", 标签: static }
      - { 名称: "membership:authz:check", 标签: static }
      - { 名称: "membership:scopes:check", 标签: static }
      - { 名称: "governance:tenant-scope:check", 标签: static }
      - { 名称: "policy:red-team", 标签: behavioral }
      - { 名称: "governance:immutability:check", 标签: static }
      - { 名称: "program:revisions:check", 标签: static }
      - { 名称: "program:runtime-scripts:check", 标签: static }
      - { 名称: "runtime:program-transition:check", 标签: static }
      - { 名称: "control-room:program-transition:check", 标签: static }
      - { 名称: "runtime:program-output:check", 标签: static }
      - { 名称: "preflight:check", 标签: static }
      - { 名称: "lifecycle:authz:check", 标签: static }
      - { 名称: "command:confirmation:check", 标签: static }
      - { 名称: "service-ingest:auth:check", 标签: static }
      - { 名称: "service-principals:check", 标签: static }
      - { 名称: "start:ack:check", 标签: static }
      - { 名称: "runtime:watchdog:check", 标签: static }
      - { 名称: "runtime:outbox:check", 标签: static }
      - { 名称: "runtime:telemetry-alerts:check", 标签: static }
      - { 名称: "entitlement:check", 标签: static }
      - { 名称: "runtime:media:check", 标签: static }
      - { 名称: "runtime:voice:check", 标签: static }
      - { 名称: "runtime:journal:check", 标签: static }
      - { 名称: "runtime:preview:check", 标签: static }
      - { 名称: "media:evidence:check", 标签: static }
      - { 名称: "recording:evidence:check", 标签: static }
      - { 名称: "runtime:images:check", 标签: static }
      - { 名称: "runtime:worker:config:test", 标签: static }
      - { 名称: "runtime:worker:health:test", 标签: behavioral }
      - { 名称: "runtime:acceptance:test", 标签: behavioral }
      - { 名称: "observer:runtime:test", 标签: behavioral }
      - { 名称: "observer:targets:test", 标签: behavioral }
      - { 名称: "observer:targets:apply:test", 标签: behavioral }
      - { 名称: "output-probe:test", 标签: behavioral }
      - { 名称: "output-probe:config:test", 标签: behavioral }
      - { 名称: "output-probe:response:check", 标签: static }
      - { 名称: "channel-adapter:test", 标签: behavioral }
      - { 名称: "channel:verification:check", 标签: static }
      - { 名称: "settlement:reconciliation:check", 标签: static }
      - { 名称: "alert-notifier:test", 标签: behavioral }
      - { 名称: "alert-notifier:health:check", 标签: static }
      - { 名称: "ci:gates:test", 标签: behavioral }
      - { 名称: "ci:coverage:check", 标签: static }
      - { 名称: "ci:workflow:check", 标签: static }
      - { 名称: "ci:db-fail-closed:test", 标签: behavioral }
      - { 名称: "ci:evidence:test", 标签: behavioral }
      - { 名称: typecheck, 标签: static }
      - { 名称: lint, 标签: static }
      - { 名称: build, 标签: static }
      - { 名称: node --check apps/runtime-worker/index.mjs, 标签: static }
      - { 名称: node --check apps/runtime-observer/index.mjs, 标签: static }
      - { 名称: node --check apps/runtime-observer/targets.mjs, 标签: static }
      - { 名称: node --check apps/output-probe/index.mjs, 标签: static }
      - { 名称: node --check apps/channel-adapter/index.mjs, 标签: static }
      - { 名称: node --check apps/alert-notifier/index.mjs, 标签: static }
    未执行的 CI 检查:
      - { job: static-gates, 名称: "npm run ci:action-pins:verify", 原因: 需要访问 github.com 的网络（Local_Verification 不访问网络） }
      - { job: static-gates, 名称: bash -n scripts/check-runtime-host.sh, 原因: Local_Verification 只收录 Requirement 2.2 定义了覆盖判定的 npm、node --check、Python 与 py_compile 检查，不含 bash 检查 }
      - { job: static-gates, 名称: bash -n scripts/backup-postgres.sh, 原因: Local_Verification 只收录 Requirement 2.2 定义了覆盖判定的 npm、node --check、Python 与 py_compile 检查，不含 bash 检查 }
      - { job: static-gates, 名称: bash -n scripts/test-postgres-backup-direct.sh, 原因: Local_Verification 只收录 Requirement 2.2 定义了覆盖判定的 npm、node --check、Python 与 py_compile 检查，不含 bash 检查 }
      - { job: static-gates, 名称: bash -n scripts/restore-postgres-drill.sh, 原因: Local_Verification 只收录 Requirement 2.2 定义了覆盖判定的 npm、node --check、Python 与 py_compile 检查，不含 bash 检查 }
      - { job: static-gates, 名称: bash -n scripts/test-postgres-restore-drill.sh, 原因: Local_Verification 只收录 Requirement 2.2 定义了覆盖判定的 npm、node --check、Python 与 py_compile 检查，不含 bash 检查 }
      - { job: static-gates, 名称: bash -n scripts/backup-runtime-gateway-state.sh, 原因: Local_Verification 只收录 Requirement 2.2 定义了覆盖判定的 npm、node --check、Python 与 py_compile 检查，不含 bash 检查 }
      - { job: static-gates, 名称: bash -n scripts/restore-runtime-gateway-state-drill.sh, 原因: Local_Verification 只收录 Requirement 2.2 定义了覆盖判定的 npm、node --check、Python 与 py_compile 检查，不含 bash 检查 }
      - { job: static-gates, 名称: bash -n scripts/verify-postgres-backup.sh, 原因: Local_Verification 只收录 Requirement 2.2 定义了覆盖判定的 npm、node --check、Python 与 py_compile 检查，不含 bash 检查 }
      - { job: static-gates, 名称: bash -n scripts/verify-runtime-gateway-state-backup.sh, 原因: Local_Verification 只收录 Requirement 2.2 定义了覆盖判定的 npm、node --check、Python 与 py_compile 检查，不含 bash 检查 }
      - { job: static-gates, 名称: bash scripts/check-runtime-host.sh --help, 原因: Local_Verification 只收录 Requirement 2.2 定义了覆盖判定的 npm、node --check、Python 与 py_compile 检查，不含 bash 检查 }
      - { job: node-unit, 名称: bash scripts/test-postgres-backup-direct.sh, 原因: 本机缺少 Linux shell 环境（flock） }
      - { job: python-gateway, 名称: python3 -m pip install --disable-pip-version-check --no-cache-dir -r runtime/gateway/requirements.txt, 原因: 本机缺少 Python 3 }
      - { job: python-gateway, 名称: "npm run runtime:gateway:config:test", 原因: 未启用 --with-gateway }
      - { job: python-gateway, 名称: "npm run runtime:gateway:errors:test", 原因: 未启用 --with-gateway }
      - { job: python-gateway, 名称: "python3 -m py_compile runtime/gateway/*.py scripts/test-runtime-gateway-config.py", 原因: 未启用 --with-gateway }
      - { job: python-gateway, 名称: python3 scripts/test-runtime-gateway-audio.py, 原因: 未启用 --with-gateway }
      - { job: python-gateway, 名称: python3 scripts/test-runtime-gateway-concurrency.py, 原因: 未启用 --with-gateway }
      - { job: python-gateway, 名称: python3 scripts/test-runtime-gateway-state-backup.py, 原因: 未启用 --with-gateway }
      - { job: python-gateway, 名称: python3 scripts/test-runtime-gateway-state-restore-drill.py, 原因: 未启用 --with-gateway }
      - { job: postgres-integration, 名称: "npm run db:migrate", 原因: 本机缺少 PostgreSQL }
      - { job: postgres-integration, 名称: "npm run db:migrate:integrity:test", 原因: 本机缺少 PostgreSQL }
      - { job: postgres-integration, 名称: "npm run service-principals:integration", 原因: 本机缺少 PostgreSQL }
      - { job: postgres-integration, 名称: "npm run db:migrate:lock:test", 原因: 本机缺少 PostgreSQL }
      - { job: postgres-integration, 名称: "npm run db:verify -- --allow-privileged", 原因: 本机缺少 PostgreSQL }
      - { job: postgres-integration, 名称: "npm run control-plane:integration", 原因: 本机缺少 PostgreSQL }
      - { job: compose-render, 名称: docker compose --env-file config/control-plane-compose.example.env -f infra/compose/docker-compose.control-plane.yml config, 原因: 本机缺少 Docker }
      - { job: compose-render, 名称: docker compose --env-file config/runtime.example.env --env-file config/runtime-gateway.example.env --env-file config/channel-adapter.example.env --env-file config/alert-notifier.example.env --profile output-probe --profile channel-adapter --profile alert-notifier --profile cosyvoice -f infra/compose/docker-compose.runtime.yml config, 原因: 本机缺少 Docker }
      - { job: docker-build, 名称: docker build --file apps/console/Dockerfile --tag shuzhiren-control-plane-ci ., 原因: 本机缺少 Docker }
      - { job: docker-build, 名称: docker build --file apps/console/Dockerfile --target migrator --tag shuzhiren-control-plane-migrator-ci ., 原因: 本机缺少 Docker }
      - { job: docker-build, 名称: docker build --file apps/runtime-worker/Dockerfile --tag shuzhiren-runtime-worker-ci ., 原因: 本机缺少 Docker }
      - { job: docker-build, 名称: docker build --file apps/runtime-observer/Dockerfile --tag shuzhiren-runtime-observer-ci ., 原因: 本机缺少 Docker }
      - { job: docker-build, 名称: docker build --file apps/output-probe/Dockerfile --tag shuzhiren-output-probe-ci ., 原因: 本机缺少 Docker }
      - { job: docker-build, 名称: docker build --file apps/channel-adapter/Dockerfile --tag shuzhiren-channel-adapter-ci ., 原因: 本机缺少 Docker }
      - { job: docker-build, 名称: docker build --file apps/alert-notifier/Dockerfile --tag shuzhiren-alert-notifier-ci ., 原因: 本机缺少 Docker }
      - { job: docker-build, 名称: docker build --file runtime/gateway/Dockerfile --tag shuzhiren-runtime-gateway-ci runtime/gateway, 原因: 本机缺少 Docker }
      - { job: docker-build, 名称: "docker build --load --file runtime/livetalking/Dockerfile --tag shuzhiren/livetalking:ci .", 原因: 本机缺少 Docker }
      - { job: docker-build, 名称: "docker build --file runtime/cosyvoice/Dockerfile --build-arg MINIFORGE_URL=\"$url\" --build-arg MINIFORGE_SHA256=\"$sha\" --tag shuzhiren-cosyvoice-ci .", 原因: 本机缺少 Docker }
静态门禁覆盖:
  - { 门禁: "deploy:check", 行为测试: [无] }
  - { 门禁: "release:workflow:check", 行为测试: [无] }
  - { 门禁: "backup:automation:check", 行为测试: [无] }
  - { 门禁: "control-plane:compose:check", 行为测试: [无] }
  - { 门禁: "runtime:compose:check", 行为测试: [无] }
  - { 门禁: "console:page-auth:check", 行为测试: [无] }
  - { 门禁: "console:security-headers:check", 行为测试: [无] }
  - { 门禁: "console:client-requests:check", 行为测试: [无] }
  - { 门禁: "membership:authz:check", 行为测试: [无] }
  - { 门禁: "membership:scopes:check", 行为测试: [无] }
  - { 门禁: "governance:tenant-scope:check", 行为测试: [无] }
  - { 门禁: "governance:immutability:check", 行为测试: [无] }
  - { 门禁: "program:revisions:check", 行为测试: [无] }
  - { 门禁: "program:runtime-scripts:check", 行为测试: [无] }
  - { 门禁: "runtime:program-transition:check", 行为测试: [无] }
  - { 门禁: "control-room:program-transition:check", 行为测试: [无] }
  - { 门禁: "runtime:program-output:check", 行为测试: [无] }
  - { 门禁: "preflight:check", 行为测试: [无] }
  - { 门禁: "lifecycle:authz:check", 行为测试: [无] }
  - { 门禁: "command:confirmation:check", 行为测试: [无] }
  - { 门禁: "service-ingest:auth:check", 行为测试: [无] }
  - { 门禁: "service-principals:check", 行为测试: [无] }
  - { 门禁: "start:ack:check", 行为测试: [无] }
  - { 门禁: "runtime:watchdog:check", 行为测试: [无] }
  - { 门禁: "runtime:outbox:check", 行为测试: [无] }
  - { 门禁: "runtime:telemetry-alerts:check", 行为测试: [无] }
  - { 门禁: "entitlement:check", 行为测试: [无] }
  - { 门禁: "runtime:media:check", 行为测试: [无] }
  - { 门禁: "runtime:voice:check", 行为测试: [无] }
  - { 门禁: "runtime:journal:check", 行为测试: [无] }
  - { 门禁: "runtime:preview:check", 行为测试: [无] }
  - { 门禁: "media:evidence:check", 行为测试: [无] }
  - { 门禁: "recording:evidence:check", 行为测试: [无] }
  - { 门禁: "runtime:images:check", 行为测试: [无] }
  - { 门禁: "output-probe:response:check", 行为测试: [无] }
  - { 门禁: "channel:verification:check", 行为测试: [无] }
  - { 门禁: "settlement:reconciliation:check", 行为测试: [无] }
  - { 门禁: "alert-notifier:health:check", 行为测试: [无] }
  - { 门禁: "ci:coverage:check", 行为测试: [无] }
  - { 门禁: "ci:workflow:check", 行为测试: [无] }
说明: >-
  Node.js v20.19.2，npm 10.8.2，PowerShell 7.6.9；运行于 2026-11-05 09:21:03 至 09:22:24（UTC+08:00），
  运行前 git status --porcelain 为空，HEAD 为 ae6e0ea5a0419ad238a13ea39e49cc22e2b0577c。本条记录的是本提交（任务 2.1）的
  父提交；任务 2.1 自身工作树上的运行结果写在其提交说明的内嵌块中。检查与未执行的 CI 检查逐行取自该次运行的
  RUN 行与 NOT RUN 行，原因文字照录 CI_ONLY_STEPS.localReason。本机没有 Python，所以没有使用 --with-gateway：
  python-gateway 的 7 个步骤原因为"未启用 --with-gateway"，pip 安装的原因为"本机缺少 Python 3"。
  static-gates 中 10 个 bash 步骤的原因说明的是 Local_Verification 不含 bash 检查；本机实际装有 bash
  （Git for Windows），这一原因不属于 Requirement 4.5 列举的"本机缺少的组件"或"未启用的运行选项"，
  需要后续任务改写原因或把这些检查纳入 Local_Verification。静态门禁覆盖全部为 [无]，因为 ae6e0ea 中还没有
  scripts/static-gate-coverage.mjs（任务 7.3 建立）；[无] 只表示映射尚未登记覆盖测试。判定为行为验证只说明
  Local_Verification 中标为 behavioral 的检查在本机执行并通过；上面 38 个 CI 步骤既没有本机结果，也还没有 CI 结果。
```

## V-20261105-04 提交 13f9212（任务 2.1）的工作树上 npm run verify:local 以退出码 0 结束

```yaml
编号: V-20261105-04
类型: 结论
结论: 提交 13f9212（任务 2.1）的工作树上 npm run verify:local（不带 --with-gateway）以退出码 0 结束，71 项检查全部通过；新增的 docs:governance:check、docs:governance:test 与受 ci.yml、LOCAL_CHECKS 改动影响的 ci:coverage:check、ci:workflow:check、ci:gates:test 都在其中
判定: 行为验证
依据来源:
  - 类别: 本机运行
    命令: npm run verify:local
    日期: 2026-11-05
    退出码: "0"
    操作系统: Windows 11 专业版 10.0.22631.7376（23H2）
    提交: 13f9212b6daba87b194a7c5f4212ab7f3af39bab
    检查:
      - { 名称: "docs:governance:check", 标签: static }
      - { 名称: "docs:governance:test", 标签: behavioral }
      - { 名称: "ci:coverage:check", 标签: static }
      - { 名称: "ci:workflow:check", 标签: static }
      - { 名称: "ci:gates:test", 标签: behavioral }
    未执行的 CI 检查:
      - { job: static-gates, 名称: "npm run ci:action-pins:verify", 原因: 需要访问 github.com 的网络（Local_Verification 不访问网络） }
      - { job: static-gates, 名称: bash -n scripts/check-runtime-host.sh, 原因: Local_Verification 只收录 Requirement 2.2 定义了覆盖判定的 npm、node --check、Python 与 py_compile 检查，不含 bash 检查 }
      - { job: static-gates, 名称: bash -n scripts/backup-postgres.sh, 原因: Local_Verification 只收录 Requirement 2.2 定义了覆盖判定的 npm、node --check、Python 与 py_compile 检查，不含 bash 检查 }
      - { job: static-gates, 名称: bash -n scripts/test-postgres-backup-direct.sh, 原因: Local_Verification 只收录 Requirement 2.2 定义了覆盖判定的 npm、node --check、Python 与 py_compile 检查，不含 bash 检查 }
      - { job: static-gates, 名称: bash -n scripts/restore-postgres-drill.sh, 原因: Local_Verification 只收录 Requirement 2.2 定义了覆盖判定的 npm、node --check、Python 与 py_compile 检查，不含 bash 检查 }
      - { job: static-gates, 名称: bash -n scripts/test-postgres-restore-drill.sh, 原因: Local_Verification 只收录 Requirement 2.2 定义了覆盖判定的 npm、node --check、Python 与 py_compile 检查，不含 bash 检查 }
      - { job: static-gates, 名称: bash -n scripts/backup-runtime-gateway-state.sh, 原因: Local_Verification 只收录 Requirement 2.2 定义了覆盖判定的 npm、node --check、Python 与 py_compile 检查，不含 bash 检查 }
      - { job: static-gates, 名称: bash -n scripts/restore-runtime-gateway-state-drill.sh, 原因: Local_Verification 只收录 Requirement 2.2 定义了覆盖判定的 npm、node --check、Python 与 py_compile 检查，不含 bash 检查 }
      - { job: static-gates, 名称: bash -n scripts/verify-postgres-backup.sh, 原因: Local_Verification 只收录 Requirement 2.2 定义了覆盖判定的 npm、node --check、Python 与 py_compile 检查，不含 bash 检查 }
      - { job: static-gates, 名称: bash -n scripts/verify-runtime-gateway-state-backup.sh, 原因: Local_Verification 只收录 Requirement 2.2 定义了覆盖判定的 npm、node --check、Python 与 py_compile 检查，不含 bash 检查 }
      - { job: static-gates, 名称: bash scripts/check-runtime-host.sh --help, 原因: Local_Verification 只收录 Requirement 2.2 定义了覆盖判定的 npm、node --check、Python 与 py_compile 检查，不含 bash 检查 }
      - { job: node-unit, 名称: bash scripts/test-postgres-backup-direct.sh, 原因: 本机缺少 Linux shell 环境（flock） }
      - { job: python-gateway, 名称: python3 -m pip install --disable-pip-version-check --no-cache-dir -r runtime/gateway/requirements.txt, 原因: 本机缺少 Python 3 }
      - { job: python-gateway, 名称: "npm run runtime:gateway:config:test", 原因: 未启用 --with-gateway }
      - { job: python-gateway, 名称: "npm run runtime:gateway:errors:test", 原因: 未启用 --with-gateway }
      - { job: python-gateway, 名称: "python3 -m py_compile runtime/gateway/*.py scripts/test-runtime-gateway-config.py", 原因: 未启用 --with-gateway }
      - { job: python-gateway, 名称: python3 scripts/test-runtime-gateway-audio.py, 原因: 未启用 --with-gateway }
      - { job: python-gateway, 名称: python3 scripts/test-runtime-gateway-concurrency.py, 原因: 未启用 --with-gateway }
      - { job: python-gateway, 名称: python3 scripts/test-runtime-gateway-state-backup.py, 原因: 未启用 --with-gateway }
      - { job: python-gateway, 名称: python3 scripts/test-runtime-gateway-state-restore-drill.py, 原因: 未启用 --with-gateway }
      - { job: postgres-integration, 名称: "npm run db:migrate", 原因: 本机缺少 PostgreSQL }
      - { job: postgres-integration, 名称: "npm run db:migrate:integrity:test", 原因: 本机缺少 PostgreSQL }
      - { job: postgres-integration, 名称: "npm run service-principals:integration", 原因: 本机缺少 PostgreSQL }
      - { job: postgres-integration, 名称: "npm run db:migrate:lock:test", 原因: 本机缺少 PostgreSQL }
      - { job: postgres-integration, 名称: "npm run db:verify -- --allow-privileged", 原因: 本机缺少 PostgreSQL }
      - { job: postgres-integration, 名称: "npm run control-plane:integration", 原因: 本机缺少 PostgreSQL }
      - { job: compose-render, 名称: docker compose --env-file config/control-plane-compose.example.env -f infra/compose/docker-compose.control-plane.yml config, 原因: 本机缺少 Docker }
      - { job: compose-render, 名称: docker compose --env-file config/runtime.example.env --env-file config/runtime-gateway.example.env --env-file config/channel-adapter.example.env --env-file config/alert-notifier.example.env --profile output-probe --profile channel-adapter --profile alert-notifier --profile cosyvoice -f infra/compose/docker-compose.runtime.yml config, 原因: 本机缺少 Docker }
      - { job: docker-build, 名称: docker build --file apps/console/Dockerfile --tag shuzhiren-control-plane-ci ., 原因: 本机缺少 Docker }
      - { job: docker-build, 名称: docker build --file apps/console/Dockerfile --target migrator --tag shuzhiren-control-plane-migrator-ci ., 原因: 本机缺少 Docker }
      - { job: docker-build, 名称: docker build --file apps/runtime-worker/Dockerfile --tag shuzhiren-runtime-worker-ci ., 原因: 本机缺少 Docker }
      - { job: docker-build, 名称: docker build --file apps/runtime-observer/Dockerfile --tag shuzhiren-runtime-observer-ci ., 原因: 本机缺少 Docker }
      - { job: docker-build, 名称: docker build --file apps/output-probe/Dockerfile --tag shuzhiren-output-probe-ci ., 原因: 本机缺少 Docker }
      - { job: docker-build, 名称: docker build --file apps/channel-adapter/Dockerfile --tag shuzhiren-channel-adapter-ci ., 原因: 本机缺少 Docker }
      - { job: docker-build, 名称: docker build --file apps/alert-notifier/Dockerfile --tag shuzhiren-alert-notifier-ci ., 原因: 本机缺少 Docker }
      - { job: docker-build, 名称: docker build --file runtime/gateway/Dockerfile --tag shuzhiren-runtime-gateway-ci runtime/gateway, 原因: 本机缺少 Docker }
      - { job: docker-build, 名称: "docker build --load --file runtime/livetalking/Dockerfile --tag shuzhiren/livetalking:ci .", 原因: 本机缺少 Docker }
      - { job: docker-build, 名称: "docker build --file runtime/cosyvoice/Dockerfile --build-arg MINIFORGE_URL=\"$url\" --build-arg MINIFORGE_SHA256=\"$sha\" --tag shuzhiren-cosyvoice-ci .", 原因: 本机缺少 Docker }
静态门禁覆盖:
  - { 门禁: "docs:governance:check", 行为测试: [无] }
  - { 门禁: "ci:coverage:check", 行为测试: [无] }
  - { 门禁: "ci:workflow:check", 行为测试: [无] }
说明: >-
  转录自任务 2.1 的提交 13f9212b6daba87b194a7c5f4212ab7f3af39bab 的提交说明中的内嵌块（git show -s --format=%B 13f9212），本次没有重新运行。
  按"先运行，后登记"的规则在后续提交中登记：提交 由"本提交"改为该 SHA，结论中的"本提交"改为"提交 13f9212（任务 2.1）"，
  其余字段照录。原说明：Node.js v20.19.2，npm 10.8.2，PowerShell 7.6.9；2026-11-05 09:39:08 至 09:40:35（UTC+08:00）；
  运行时的工作树是父提交 ae6e0ea 加任务 2.1 的改动（当时尚未提交），内容与 13f9212 相同。检查只列出了 71 项中
  受任务 2.1 改动影响的 5 项；未执行的 CI 检查与 V-20261105-03 完全相同（38 项）。
```

## V-20261105-05 首轮登记 Audit_Register 时读取的审计报告文件的 SHA-256（本机计算）

```yaml
编号: V-20261105-05
类型: 结论
结论: docs/AUDIT_REGISTER.md 首轮登记所依据的审计报告 f9d9e2ed-88ca-4736-978b-9c1242d28819.md（2026-11-04，25707 字节）的 SHA-256 为 9021ab946370f41adc3b25e386d16eb8b19a69dbd4d95a2dd1fd410204d940c3
判定: 未验证
依据来源:
  - 类别: 本机运行
    命令: "pwsh -NoProfile -Command \"(Get-FileHash -Algorithm SHA256 -LiteralPath '<报告目录>\\f9d9e2ed-88ca-4736-978b-9c1242d28819.md').Hash\""
    日期: 2026-11-05
    退出码: "0"
    操作系统: Windows 11 专业版 10.0.22631.7376（23H2），PowerShell 7.6.9
    提交: 13f9212b6daba87b194a7c5f4212ab7f3af39bab
    检查:
      - { 名称: "pwsh -NoProfile -Command \"(Get-FileHash -Algorithm SHA256 -LiteralPath '<报告目录>\\f9d9e2ed-88ca-4736-978b-9c1242d28819.md').Hash\"", 标签: static }
    未执行的 CI 检查:
      - { 名称: CI_Pipeline 六个 job 的全部验证步骤, 原因: 本次本机运行只执行上面的哈希命令，没有运行 Local_Verification；本提交工作树上的 Local_Verification 结果写在其提交说明的内嵌块中 }
风险: >-
  审计报告不在仓库内（设计"风险"一节）。Audit_Register 只按"审计报告 §<章节> <编号>"引用报告，不复制全文；
  本条记录登记时读取的文件的 SHA-256，之后若报告文件被改动或替换，可以据此发现，并据此判断哪些记录需要按新文本复核。
说明: >-
  <报告目录> 是仓库外的 %APPDATA%\Kiro\User\globalStorage\kiro.kiroagent\artifacts\sess_2931bc78-595e-4291-947d-8fa9fd1e8357-d3ed5214，
  按设计第 1 部分 §7.1 以文件名定位。命令于 2026-11-05 在 HEAD 为 13f9212、工作区干净时运行，输出
  9021AB946370F41ADC3B25E386D16EB8B19A69DBD4D95A2DD1FD410204D940C3，转为小写后即上面的值，与
  scripts/lib/audit-register.mjs 的 AUDIT_REPORT.sha256 相同；Get-Item 读出的文件长度为 25707 字节，与设计第 1 部分 §0.1
  记录的大小一致。判定为未验证：Get-FileHash 不是 LOCAL_CHECKS 或 CI_ONLY_STEPS 中登记的检查，不满足 Requirement 4.2
  以 npm 脚本名或测试文件名标识检查的要求。本条只证明登记所依据的文件内容，不证明报告中任何问题的真伪。
```

## V-20261105-06 提交 8226fa3（任务 2.2）的工作树上 npm run verify:local 以退出码 0 结束

```yaml
编号: V-20261105-06
类型: 结论
结论: 提交 8226fa3（任务 2.2）的工作树上 npm run verify:local（不带 --with-gateway）以退出码 0 结束，71 项检查全部通过；改动的 docs:governance:check 与 docs:governance:test 都在其中，docs:governance:test 共 29 个用例全部通过
判定: 行为验证
依据来源:
  - 类别: 本机运行
    命令: npm run verify:local
    日期: 2026-11-05
    退出码: "0"
    操作系统: Windows 11 专业版 10.0.22631.7376（23H2）
    提交: 8226fa38502dbcfa068fa8940fb1850805962734
    检查:
      - { 名称: "docs:governance:check", 标签: static }
      - { 名称: "docs:governance:test", 标签: behavioral }
    未执行的 CI 检查:
      - { job: static-gates, 名称: "npm run ci:action-pins:verify", 原因: 需要访问 github.com 的网络（Local_Verification 不访问网络） }
      - { job: static-gates, 名称: bash -n scripts/check-runtime-host.sh, 原因: Local_Verification 只收录 Requirement 2.2 定义了覆盖判定的 npm、node --check、Python 与 py_compile 检查，不含 bash 检查 }
      - { job: static-gates, 名称: bash -n scripts/backup-postgres.sh, 原因: Local_Verification 只收录 Requirement 2.2 定义了覆盖判定的 npm、node --check、Python 与 py_compile 检查，不含 bash 检查 }
      - { job: static-gates, 名称: bash -n scripts/test-postgres-backup-direct.sh, 原因: Local_Verification 只收录 Requirement 2.2 定义了覆盖判定的 npm、node --check、Python 与 py_compile 检查，不含 bash 检查 }
      - { job: static-gates, 名称: bash -n scripts/restore-postgres-drill.sh, 原因: Local_Verification 只收录 Requirement 2.2 定义了覆盖判定的 npm、node --check、Python 与 py_compile 检查，不含 bash 检查 }
      - { job: static-gates, 名称: bash -n scripts/test-postgres-restore-drill.sh, 原因: Local_Verification 只收录 Requirement 2.2 定义了覆盖判定的 npm、node --check、Python 与 py_compile 检查，不含 bash 检查 }
      - { job: static-gates, 名称: bash -n scripts/backup-runtime-gateway-state.sh, 原因: Local_Verification 只收录 Requirement 2.2 定义了覆盖判定的 npm、node --check、Python 与 py_compile 检查，不含 bash 检查 }
      - { job: static-gates, 名称: bash -n scripts/restore-runtime-gateway-state-drill.sh, 原因: Local_Verification 只收录 Requirement 2.2 定义了覆盖判定的 npm、node --check、Python 与 py_compile 检查，不含 bash 检查 }
      - { job: static-gates, 名称: bash -n scripts/verify-postgres-backup.sh, 原因: Local_Verification 只收录 Requirement 2.2 定义了覆盖判定的 npm、node --check、Python 与 py_compile 检查，不含 bash 检查 }
      - { job: static-gates, 名称: bash -n scripts/verify-runtime-gateway-state-backup.sh, 原因: Local_Verification 只收录 Requirement 2.2 定义了覆盖判定的 npm、node --check、Python 与 py_compile 检查，不含 bash 检查 }
      - { job: static-gates, 名称: bash scripts/check-runtime-host.sh --help, 原因: Local_Verification 只收录 Requirement 2.2 定义了覆盖判定的 npm、node --check、Python 与 py_compile 检查，不含 bash 检查 }
      - { job: node-unit, 名称: bash scripts/test-postgres-backup-direct.sh, 原因: 本机缺少 Linux shell 环境（flock） }
      - { job: python-gateway, 名称: python3 -m pip install --disable-pip-version-check --no-cache-dir -r runtime/gateway/requirements.txt, 原因: 本机缺少 Python 3 }
      - { job: python-gateway, 名称: "npm run runtime:gateway:config:test", 原因: 未启用 --with-gateway }
      - { job: python-gateway, 名称: "npm run runtime:gateway:errors:test", 原因: 未启用 --with-gateway }
      - { job: python-gateway, 名称: "python3 -m py_compile runtime/gateway/*.py scripts/test-runtime-gateway-config.py", 原因: 未启用 --with-gateway }
      - { job: python-gateway, 名称: python3 scripts/test-runtime-gateway-audio.py, 原因: 未启用 --with-gateway }
      - { job: python-gateway, 名称: python3 scripts/test-runtime-gateway-concurrency.py, 原因: 未启用 --with-gateway }
      - { job: python-gateway, 名称: python3 scripts/test-runtime-gateway-state-backup.py, 原因: 未启用 --with-gateway }
      - { job: python-gateway, 名称: python3 scripts/test-runtime-gateway-state-restore-drill.py, 原因: 未启用 --with-gateway }
      - { job: postgres-integration, 名称: "npm run db:migrate", 原因: 本机缺少 PostgreSQL }
      - { job: postgres-integration, 名称: "npm run db:migrate:integrity:test", 原因: 本机缺少 PostgreSQL }
      - { job: postgres-integration, 名称: "npm run service-principals:integration", 原因: 本机缺少 PostgreSQL }
      - { job: postgres-integration, 名称: "npm run db:migrate:lock:test", 原因: 本机缺少 PostgreSQL }
      - { job: postgres-integration, 名称: "npm run db:verify -- --allow-privileged", 原因: 本机缺少 PostgreSQL }
      - { job: postgres-integration, 名称: "npm run control-plane:integration", 原因: 本机缺少 PostgreSQL }
      - { job: compose-render, 名称: docker compose --env-file config/control-plane-compose.example.env -f infra/compose/docker-compose.control-plane.yml config, 原因: 本机缺少 Docker }
      - { job: compose-render, 名称: docker compose --env-file config/runtime.example.env --env-file config/runtime-gateway.example.env --env-file config/channel-adapter.example.env --env-file config/alert-notifier.example.env --profile output-probe --profile channel-adapter --profile alert-notifier --profile cosyvoice -f infra/compose/docker-compose.runtime.yml config, 原因: 本机缺少 Docker }
      - { job: docker-build, 名称: docker build --file apps/console/Dockerfile --tag shuzhiren-control-plane-ci ., 原因: 本机缺少 Docker }
      - { job: docker-build, 名称: docker build --file apps/console/Dockerfile --target migrator --tag shuzhiren-control-plane-migrator-ci ., 原因: 本机缺少 Docker }
      - { job: docker-build, 名称: docker build --file apps/runtime-worker/Dockerfile --tag shuzhiren-runtime-worker-ci ., 原因: 本机缺少 Docker }
      - { job: docker-build, 名称: docker build --file apps/runtime-observer/Dockerfile --tag shuzhiren-runtime-observer-ci ., 原因: 本机缺少 Docker }
      - { job: docker-build, 名称: docker build --file apps/output-probe/Dockerfile --tag shuzhiren-output-probe-ci ., 原因: 本机缺少 Docker }
      - { job: docker-build, 名称: docker build --file apps/channel-adapter/Dockerfile --tag shuzhiren-channel-adapter-ci ., 原因: 本机缺少 Docker }
      - { job: docker-build, 名称: docker build --file apps/alert-notifier/Dockerfile --tag shuzhiren-alert-notifier-ci ., 原因: 本机缺少 Docker }
      - { job: docker-build, 名称: docker build --file runtime/gateway/Dockerfile --tag shuzhiren-runtime-gateway-ci runtime/gateway, 原因: 本机缺少 Docker }
      - { job: docker-build, 名称: "docker build --load --file runtime/livetalking/Dockerfile --tag shuzhiren/livetalking:ci .", 原因: 本机缺少 Docker }
      - { job: docker-build, 名称: "docker build --file runtime/cosyvoice/Dockerfile --build-arg MINIFORGE_URL=\"$url\" --build-arg MINIFORGE_SHA256=\"$sha\" --tag shuzhiren-cosyvoice-ci .", 原因: 本机缺少 Docker }
静态门禁覆盖:
  - { 门禁: "docs:governance:check", 行为测试: [无] }
说明: >-
  转录自任务 2.2 的提交 8226fa38502dbcfa068fa8940fb1850805962734 的提交说明中的内嵌块（git show -s --format=%B 8226fa3），本次没有重新运行。
  按"先运行，后登记"的规则在后续提交中登记：提交 由"本提交"改为该 SHA，结论与说明中的"本提交"改为"提交 8226fa3（任务 2.2）"或"该提交"，其余字段照录。
  检查只列出了 71 项中受任务 2.2 改动影响的 2 项。 原说明：Node.js v20.19.2，npm 10.8.2，PowerShell 7.6.9；
  2026-11-05 10:10:24 至 10:11:52（UTC+08:00）；父提交 13f9212 加该提交的改动，未提交的工作树与该提交内容相同。RUN 71 项，NOT RUN 38 项，
  未执行的 CI 检查与 V-20261105-04 完全相同。
```

## V-20261105-07 提交 43718f8（任务 4.1，N6 修复）的工作树上 npm run verify:local 以退出码 0 结束

```yaml
编号: V-20261105-07
类型: 结论
结论: 提交 43718f8（任务 4.1，N6 修复）的工作树上 npm run verify:local（不带 --with-gateway）以退出码 0 结束，71 项检查全部通过；读取 LiveTalking dockerignore 的 deploy:check 与改动的 docs:governance:check、docs:governance:test 都在其中
判定: 行为验证
依据来源:
  - 类别: 本机运行
    命令: npm run verify:local
    日期: 2026-11-05
    退出码: "0"
    操作系统: Windows 11 专业版 10.0.22631.7376（23H2）
    提交: 43718f8a1b05027de98316d94394d199e86edf39
    检查:
      - { 名称: "deploy:check", 标签: static }
      - { 名称: "docs:governance:check", 标签: static }
      - { 名称: "docs:governance:test", 标签: behavioral }
    未执行的 CI 检查:
      - { job: static-gates, 名称: "npm run ci:action-pins:verify", 原因: 需要访问 github.com 的网络（Local_Verification 不访问网络） }
      - { job: static-gates, 名称: bash -n scripts/check-runtime-host.sh, 原因: Local_Verification 只收录 Requirement 2.2 定义了覆盖判定的 npm、node --check、Python 与 py_compile 检查，不含 bash 检查 }
      - { job: static-gates, 名称: bash -n scripts/backup-postgres.sh, 原因: Local_Verification 只收录 Requirement 2.2 定义了覆盖判定的 npm、node --check、Python 与 py_compile 检查，不含 bash 检查 }
      - { job: static-gates, 名称: bash -n scripts/test-postgres-backup-direct.sh, 原因: Local_Verification 只收录 Requirement 2.2 定义了覆盖判定的 npm、node --check、Python 与 py_compile 检查，不含 bash 检查 }
      - { job: static-gates, 名称: bash -n scripts/restore-postgres-drill.sh, 原因: Local_Verification 只收录 Requirement 2.2 定义了覆盖判定的 npm、node --check、Python 与 py_compile 检查，不含 bash 检查 }
      - { job: static-gates, 名称: bash -n scripts/test-postgres-restore-drill.sh, 原因: Local_Verification 只收录 Requirement 2.2 定义了覆盖判定的 npm、node --check、Python 与 py_compile 检查，不含 bash 检查 }
      - { job: static-gates, 名称: bash -n scripts/backup-runtime-gateway-state.sh, 原因: Local_Verification 只收录 Requirement 2.2 定义了覆盖判定的 npm、node --check、Python 与 py_compile 检查，不含 bash 检查 }
      - { job: static-gates, 名称: bash -n scripts/restore-runtime-gateway-state-drill.sh, 原因: Local_Verification 只收录 Requirement 2.2 定义了覆盖判定的 npm、node --check、Python 与 py_compile 检查，不含 bash 检查 }
      - { job: static-gates, 名称: bash -n scripts/verify-postgres-backup.sh, 原因: Local_Verification 只收录 Requirement 2.2 定义了覆盖判定的 npm、node --check、Python 与 py_compile 检查，不含 bash 检查 }
      - { job: static-gates, 名称: bash -n scripts/verify-runtime-gateway-state-backup.sh, 原因: Local_Verification 只收录 Requirement 2.2 定义了覆盖判定的 npm、node --check、Python 与 py_compile 检查，不含 bash 检查 }
      - { job: static-gates, 名称: bash scripts/check-runtime-host.sh --help, 原因: Local_Verification 只收录 Requirement 2.2 定义了覆盖判定的 npm、node --check、Python 与 py_compile 检查，不含 bash 检查 }
      - { job: node-unit, 名称: bash scripts/test-postgres-backup-direct.sh, 原因: 本机缺少 Linux shell 环境（flock） }
      - { job: python-gateway, 名称: python3 -m pip install --disable-pip-version-check --no-cache-dir -r runtime/gateway/requirements.txt, 原因: 本机缺少 Python 3 }
      - { job: python-gateway, 名称: "npm run runtime:gateway:config:test", 原因: 未启用 --with-gateway }
      - { job: python-gateway, 名称: "npm run runtime:gateway:errors:test", 原因: 未启用 --with-gateway }
      - { job: python-gateway, 名称: "python3 -m py_compile runtime/gateway/*.py scripts/test-runtime-gateway-config.py", 原因: 未启用 --with-gateway }
      - { job: python-gateway, 名称: python3 scripts/test-runtime-gateway-audio.py, 原因: 未启用 --with-gateway }
      - { job: python-gateway, 名称: python3 scripts/test-runtime-gateway-concurrency.py, 原因: 未启用 --with-gateway }
      - { job: python-gateway, 名称: python3 scripts/test-runtime-gateway-state-backup.py, 原因: 未启用 --with-gateway }
      - { job: python-gateway, 名称: python3 scripts/test-runtime-gateway-state-restore-drill.py, 原因: 未启用 --with-gateway }
      - { job: postgres-integration, 名称: "npm run db:migrate", 原因: 本机缺少 PostgreSQL }
      - { job: postgres-integration, 名称: "npm run db:migrate:integrity:test", 原因: 本机缺少 PostgreSQL }
      - { job: postgres-integration, 名称: "npm run service-principals:integration", 原因: 本机缺少 PostgreSQL }
      - { job: postgres-integration, 名称: "npm run db:migrate:lock:test", 原因: 本机缺少 PostgreSQL }
      - { job: postgres-integration, 名称: "npm run db:verify -- --allow-privileged", 原因: 本机缺少 PostgreSQL }
      - { job: postgres-integration, 名称: "npm run control-plane:integration", 原因: 本机缺少 PostgreSQL }
      - { job: compose-render, 名称: docker compose --env-file config/control-plane-compose.example.env -f infra/compose/docker-compose.control-plane.yml config, 原因: 本机缺少 Docker }
      - { job: compose-render, 名称: docker compose --env-file config/runtime.example.env --env-file config/runtime-gateway.example.env --env-file config/channel-adapter.example.env --env-file config/alert-notifier.example.env --profile output-probe --profile channel-adapter --profile alert-notifier --profile cosyvoice -f infra/compose/docker-compose.runtime.yml config, 原因: 本机缺少 Docker }
      - { job: docker-build, 名称: docker build --file apps/console/Dockerfile --tag shuzhiren-control-plane-ci ., 原因: 本机缺少 Docker }
      - { job: docker-build, 名称: docker build --file apps/console/Dockerfile --target migrator --tag shuzhiren-control-plane-migrator-ci ., 原因: 本机缺少 Docker }
      - { job: docker-build, 名称: docker build --file apps/runtime-worker/Dockerfile --tag shuzhiren-runtime-worker-ci ., 原因: 本机缺少 Docker }
      - { job: docker-build, 名称: docker build --file apps/runtime-observer/Dockerfile --tag shuzhiren-runtime-observer-ci ., 原因: 本机缺少 Docker }
      - { job: docker-build, 名称: docker build --file apps/output-probe/Dockerfile --tag shuzhiren-output-probe-ci ., 原因: 本机缺少 Docker }
      - { job: docker-build, 名称: docker build --file apps/channel-adapter/Dockerfile --tag shuzhiren-channel-adapter-ci ., 原因: 本机缺少 Docker }
      - { job: docker-build, 名称: docker build --file apps/alert-notifier/Dockerfile --tag shuzhiren-alert-notifier-ci ., 原因: 本机缺少 Docker }
      - { job: docker-build, 名称: docker build --file runtime/gateway/Dockerfile --tag shuzhiren-runtime-gateway-ci runtime/gateway, 原因: 本机缺少 Docker }
      - { job: docker-build, 名称: "docker build --load --file runtime/livetalking/Dockerfile --tag shuzhiren/livetalking:ci .", 原因: 本机缺少 Docker }
      - { job: docker-build, 名称: "docker build --file runtime/cosyvoice/Dockerfile --build-arg MINIFORGE_URL=\"$url\" --build-arg MINIFORGE_SHA256=\"$sha\" --tag shuzhiren-cosyvoice-ci .", 原因: 本机缺少 Docker }
静态门禁覆盖:
  - { 门禁: "deploy:check", 行为测试: [无] }
  - { 门禁: "docs:governance:check", 行为测试: [无] }
说明: >-
  转录自任务 4.1 的 N6 修复提交 43718f8a1b05027de98316d94394d199e86edf39 的提交说明中的内嵌块（git show -s --format=%B 43718f8），
  本次没有重新运行。按"先运行，后登记"的规则在后续提交中登记：提交 由"本提交"改为该 SHA，结论与说明中的"本提交"改为"提交 43718f8（任务 4.1，N6 修复）"或"该提交"，其余字段照录。
  检查只列出了 71 项中受该提交改动影响的 3 项。LiveTalking 镜像构建本身是 CI-only 步骤，它的结果见 V-20261105-10。 原说明：Node.js v20.19.2，npm 10.8.2，
  PowerShell 7.6.9；2026-11-05 12:55:16 至 12:56:46（UTC+08:00）；父提交 8226fa3 加该提交的改动，未提交的工作树与该提交内容相同。RUN 71 项，
  NOT RUN 38 项，未执行的 CI 检查与 V-20261105-06 完全相同。
```

## V-20261105-08 提交 1657254（任务 4.1，N7 修复）的工作树上 npm run verify:local 以退出码 0 结束

```yaml
编号: V-20261105-08
类型: 结论
结论: 提交 1657254（任务 4.1，N7 修复）的工作树上 npm run verify:local（不带 --with-gateway）以退出码 0 结束，71 项检查全部通过；改动的 observer:runtime:test 与读取 AUDIT_REGISTER 的 docs:governance:check、docs:governance:test 都在其中
判定: 行为验证
依据来源:
  - 类别: 本机运行
    命令: npm run verify:local
    日期: 2026-11-05
    退出码: "0"
    操作系统: Windows 11 专业版 10.0.22631.7376（23H2）
    提交: 16572549bb72d718ad898248fc27e7b74e284e35
    检查:
      - { 名称: "observer:runtime:test", 标签: behavioral }
      - { 名称: "docs:governance:check", 标签: static }
      - { 名称: "docs:governance:test", 标签: behavioral }
    未执行的 CI 检查:
      - { job: static-gates, 名称: "npm run ci:action-pins:verify", 原因: 需要访问 github.com 的网络（Local_Verification 不访问网络） }
      - { job: static-gates, 名称: bash -n scripts/check-runtime-host.sh, 原因: Local_Verification 只收录 Requirement 2.2 定义了覆盖判定的 npm、node --check、Python 与 py_compile 检查，不含 bash 检查 }
      - { job: static-gates, 名称: bash -n scripts/backup-postgres.sh, 原因: Local_Verification 只收录 Requirement 2.2 定义了覆盖判定的 npm、node --check、Python 与 py_compile 检查，不含 bash 检查 }
      - { job: static-gates, 名称: bash -n scripts/test-postgres-backup-direct.sh, 原因: Local_Verification 只收录 Requirement 2.2 定义了覆盖判定的 npm、node --check、Python 与 py_compile 检查，不含 bash 检查 }
      - { job: static-gates, 名称: bash -n scripts/restore-postgres-drill.sh, 原因: Local_Verification 只收录 Requirement 2.2 定义了覆盖判定的 npm、node --check、Python 与 py_compile 检查，不含 bash 检查 }
      - { job: static-gates, 名称: bash -n scripts/test-postgres-restore-drill.sh, 原因: Local_Verification 只收录 Requirement 2.2 定义了覆盖判定的 npm、node --check、Python 与 py_compile 检查，不含 bash 检查 }
      - { job: static-gates, 名称: bash -n scripts/backup-runtime-gateway-state.sh, 原因: Local_Verification 只收录 Requirement 2.2 定义了覆盖判定的 npm、node --check、Python 与 py_compile 检查，不含 bash 检查 }
      - { job: static-gates, 名称: bash -n scripts/restore-runtime-gateway-state-drill.sh, 原因: Local_Verification 只收录 Requirement 2.2 定义了覆盖判定的 npm、node --check、Python 与 py_compile 检查，不含 bash 检查 }
      - { job: static-gates, 名称: bash -n scripts/verify-postgres-backup.sh, 原因: Local_Verification 只收录 Requirement 2.2 定义了覆盖判定的 npm、node --check、Python 与 py_compile 检查，不含 bash 检查 }
      - { job: static-gates, 名称: bash -n scripts/verify-runtime-gateway-state-backup.sh, 原因: Local_Verification 只收录 Requirement 2.2 定义了覆盖判定的 npm、node --check、Python 与 py_compile 检查，不含 bash 检查 }
      - { job: static-gates, 名称: bash scripts/check-runtime-host.sh --help, 原因: Local_Verification 只收录 Requirement 2.2 定义了覆盖判定的 npm、node --check、Python 与 py_compile 检查，不含 bash 检查 }
      - { job: node-unit, 名称: bash scripts/test-postgres-backup-direct.sh, 原因: 本机缺少 Linux shell 环境（flock） }
      - { job: python-gateway, 名称: python3 -m pip install --disable-pip-version-check --no-cache-dir -r runtime/gateway/requirements.txt, 原因: 本机缺少 Python 3 }
      - { job: python-gateway, 名称: "npm run runtime:gateway:config:test", 原因: 未启用 --with-gateway }
      - { job: python-gateway, 名称: "npm run runtime:gateway:errors:test", 原因: 未启用 --with-gateway }
      - { job: python-gateway, 名称: "python3 -m py_compile runtime/gateway/*.py scripts/test-runtime-gateway-config.py", 原因: 未启用 --with-gateway }
      - { job: python-gateway, 名称: python3 scripts/test-runtime-gateway-audio.py, 原因: 未启用 --with-gateway }
      - { job: python-gateway, 名称: python3 scripts/test-runtime-gateway-concurrency.py, 原因: 未启用 --with-gateway }
      - { job: python-gateway, 名称: python3 scripts/test-runtime-gateway-state-backup.py, 原因: 未启用 --with-gateway }
      - { job: python-gateway, 名称: python3 scripts/test-runtime-gateway-state-restore-drill.py, 原因: 未启用 --with-gateway }
      - { job: postgres-integration, 名称: "npm run db:migrate", 原因: 本机缺少 PostgreSQL }
      - { job: postgres-integration, 名称: "npm run db:migrate:integrity:test", 原因: 本机缺少 PostgreSQL }
      - { job: postgres-integration, 名称: "npm run service-principals:integration", 原因: 本机缺少 PostgreSQL }
      - { job: postgres-integration, 名称: "npm run db:migrate:lock:test", 原因: 本机缺少 PostgreSQL }
      - { job: postgres-integration, 名称: "npm run db:verify -- --allow-privileged", 原因: 本机缺少 PostgreSQL }
      - { job: postgres-integration, 名称: "npm run control-plane:integration", 原因: 本机缺少 PostgreSQL }
      - { job: compose-render, 名称: docker compose --env-file config/control-plane-compose.example.env -f infra/compose/docker-compose.control-plane.yml config, 原因: 本机缺少 Docker }
      - { job: compose-render, 名称: docker compose --env-file config/runtime.example.env --env-file config/runtime-gateway.example.env --env-file config/channel-adapter.example.env --env-file config/alert-notifier.example.env --profile output-probe --profile channel-adapter --profile alert-notifier --profile cosyvoice -f infra/compose/docker-compose.runtime.yml config, 原因: 本机缺少 Docker }
      - { job: docker-build, 名称: docker build --file apps/console/Dockerfile --tag shuzhiren-control-plane-ci ., 原因: 本机缺少 Docker }
      - { job: docker-build, 名称: docker build --file apps/console/Dockerfile --target migrator --tag shuzhiren-control-plane-migrator-ci ., 原因: 本机缺少 Docker }
      - { job: docker-build, 名称: docker build --file apps/runtime-worker/Dockerfile --tag shuzhiren-runtime-worker-ci ., 原因: 本机缺少 Docker }
      - { job: docker-build, 名称: docker build --file apps/runtime-observer/Dockerfile --tag shuzhiren-runtime-observer-ci ., 原因: 本机缺少 Docker }
      - { job: docker-build, 名称: docker build --file apps/output-probe/Dockerfile --tag shuzhiren-output-probe-ci ., 原因: 本机缺少 Docker }
      - { job: docker-build, 名称: docker build --file apps/channel-adapter/Dockerfile --tag shuzhiren-channel-adapter-ci ., 原因: 本机缺少 Docker }
      - { job: docker-build, 名称: docker build --file apps/alert-notifier/Dockerfile --tag shuzhiren-alert-notifier-ci ., 原因: 本机缺少 Docker }
      - { job: docker-build, 名称: docker build --file runtime/gateway/Dockerfile --tag shuzhiren-runtime-gateway-ci runtime/gateway, 原因: 本机缺少 Docker }
      - { job: docker-build, 名称: "docker build --load --file runtime/livetalking/Dockerfile --tag shuzhiren/livetalking:ci .", 原因: 本机缺少 Docker }
      - { job: docker-build, 名称: "docker build --file runtime/cosyvoice/Dockerfile --build-arg MINIFORGE_URL=\"$url\" --build-arg MINIFORGE_SHA256=\"$sha\" --tag shuzhiren-cosyvoice-ci .", 原因: 本机缺少 Docker }
静态门禁覆盖:
  - { 门禁: "docs:governance:check", 行为测试: [无] }
说明: >-
  转录自任务 4.1 的 N7 修复提交 16572549bb72d718ad898248fc27e7b74e284e35 的提交说明中的内嵌块（git show -s --format=%B 1657254），
  本次没有重新运行。按"先运行，后登记"的规则在后续提交中登记：提交 由"本提交"改为该 SHA，结论与说明中的"本提交"改为"提交 1657254（任务 4.1，N7 修复）"或"该提交"，其余字段照录。
  检查只列出了 71 项中受该提交改动影响的 3 项。observer:runtime:test 在 Linux 上的结果见 V-20261105-10。 原说明：Node.js v20.19.2，npm 10.8.2，
  PowerShell 7.6.9；2026-11-05 13:09:55 至 13:11:24（UTC+08:00）；父提交 43718f8 加该提交的改动，未提交的工作树与该提交内容相同。RUN 71 项，
  NOT RUN 38 项，未执行的 CI 检查与 V-20261105-07 完全相同。
```

## V-20261105-09 CI #492（run 41965741382，提交 8226fa3）为 failure：node-unit 因 N7 被取消，postgres-integration 因 C1、docker-build 因 N6 失败

```yaml
编号: V-20261105-09
类型: 结论
结论: 第 492 次 CI 运行（run 41965741382，提交 8226fa3）的结论为 failure；static-gates、python-gateway、compose-render 为 success；node-unit 第 15 步 observer:runtime:test 超过 job 时限被取消（N7）；postgres-integration 第 10 步 db:verify 失败（C1）；docker-build 第 14 步 LiveTalking 镜像构建失败（N6）；共 18 个步骤为 skipped
判定: 未验证
依据来源:
  - 类别: CI 或 Linux 运行
    平台: GitHub Actions
    run id: "41965741382"
    提交: 8226fa38502dbcfa068fa8940fb1850805962734
    运行结论: failure
    runner 镜像:
      - { job: compose-render, 镜像: ubuntu-24.04, 版本: "20261101.360.1" }
      - { job: node-unit, 镜像: ubuntu-24.04, 版本: "20261025.353.1" }
      - { job: postgres-integration, 镜像: ubuntu-24.04, 版本: "20261101.360.1" }
      - { job: static-gates, 镜像: ubuntu-24.04, 版本: "20261025.353.1" }
      - { job: python-gateway, 镜像: ubuntu-24.04, 版本: "20261025.353.1" }
      - { job: docker-build, 镜像: ubuntu-24.04, 版本: "20261025.353.1" }
    步骤:
      - { job: compose-render, 序号: "1", 步骤: "Set up job", 结论: success }
      - { job: compose-render, 序号: "2", 步骤: "Checkout", 结论: success }
      - { job: compose-render, 序号: "3", 步骤: "Set up Node.js", 结论: success }
      - { job: compose-render, 序号: "4", 步骤: "Run npm ci", 结论: success }
      - { job: compose-render, 序号: "5", 步骤: "Run docker compose --env-file config/control-plane-compose.example.env -f infra/compose/docker-compose.control-plane.yml config", 结论: success, 标签: static }
      - { job: compose-render, 序号: "6", 步骤: "Run docker compose --env-file config/runtime.example.env --env-file config/runtime-gateway.example.env --env-file config/channel-adapter.example.env --env-file config/alert-notifier.example.env --profile output-probe --profile channel-adapter --profile alert-notifier --profile cosyvoice -f infra/compose/docker-compose.runtime.yml config", 结论: success, 标签: static }
      - { job: compose-render, 序号: "11", 步骤: "Post Set up Node.js", 结论: success }
      - { job: compose-render, 序号: "12", 步骤: "Post Checkout", 结论: success }
      - { job: compose-render, 序号: "13", 步骤: "Complete job", 结论: success }
      - { job: node-unit, 序号: "1", 步骤: "Set up job", 结论: success }
      - { job: node-unit, 序号: "2", 步骤: "Checkout", 结论: success }
      - { job: node-unit, 序号: "3", 步骤: "Set up Node.js", 结论: success }
      - { job: node-unit, 序号: "4", 步骤: "Run npm ci", 结论: success }
      - { job: node-unit, 序号: "5", 步骤: "Run npm run deploy:check:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "6", 步骤: "Run npm run deploy:manifest:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "7", 步骤: "Run npm run deploy:images:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "8", 步骤: "Run npm run release:evidence:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "9", 步骤: "Run bash scripts/test-postgres-backup-direct.sh", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "10", 步骤: "Run bash scripts/test-postgres-restore-drill.sh", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "11", 步骤: "Run npm run policy:red-team", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "12", 步骤: "Run npm run runtime:worker:config:test", 结论: success, 标签: static }
      - { job: node-unit, 序号: "13", 步骤: "Run npm run runtime:worker:health:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "14", 步骤: "Run npm run runtime:acceptance:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "15", 步骤: "Run npm run observer:runtime:test", 结论: cancelled, 标签: behavioral }
      - { job: node-unit, 序号: "16", 步骤: "Run npm run observer:targets:test", 结论: skipped, 标签: behavioral }
      - { job: node-unit, 序号: "17", 步骤: "Run npm run observer:targets:apply:test", 结论: skipped, 标签: behavioral }
      - { job: node-unit, 序号: "18", 步骤: "Run npm run output-probe:test", 结论: skipped, 标签: behavioral }
      - { job: node-unit, 序号: "19", 步骤: "Run npm run output-probe:config:test", 结论: skipped, 标签: behavioral }
      - { job: node-unit, 序号: "20", 步骤: "Run npm run channel-adapter:test", 结论: skipped, 标签: behavioral }
      - { job: node-unit, 序号: "21", 步骤: "Run npm run alert-notifier:test", 结论: skipped, 标签: behavioral }
      - { job: node-unit, 序号: "22", 步骤: "Run npm run ci:gates:test", 结论: skipped, 标签: behavioral }
      - { job: node-unit, 序号: "23", 步骤: "Run npm run ci:db-fail-closed:test", 结论: skipped, 标签: behavioral }
      - { job: node-unit, 序号: "24", 步骤: "Run npm run ci:evidence:test", 结论: skipped, 标签: behavioral }
      - { job: node-unit, 序号: "25", 步骤: "Run npm run release:workflow:gate:test", 结论: skipped, 标签: behavioral }
      - { job: node-unit, 序号: "26", 步骤: "Run npm run docs:governance:test", 结论: skipped, 标签: behavioral }
      - { job: node-unit, 序号: "51", 步骤: "Post Set up Node.js", 结论: skipped }
      - { job: node-unit, 序号: "52", 步骤: "Post Checkout", 结论: success }
      - { job: node-unit, 序号: "53", 步骤: "Complete job", 结论: success }
      - { job: postgres-integration, 序号: "1", 步骤: "Set up job", 结论: success }
      - { job: postgres-integration, 序号: "2", 步骤: "Initialize containers", 结论: success }
      - { job: postgres-integration, 序号: "3", 步骤: "Checkout", 结论: success }
      - { job: postgres-integration, 序号: "4", 步骤: "Set up Node.js", 结论: success }
      - { job: postgres-integration, 序号: "5", 步骤: "Run npm ci", 结论: success }
      - { job: postgres-integration, 序号: "6", 步骤: "Run npm run db:migrate", 结论: success, 标签: behavioral }
      - { job: postgres-integration, 序号: "7", 步骤: "Run npm run db:migrate:integrity:test", 结论: success, 标签: behavioral }
      - { job: postgres-integration, 序号: "8", 步骤: "Run npm run service-principals:integration", 结论: success, 标签: behavioral }
      - { job: postgres-integration, 序号: "9", 步骤: "Run npm run db:migrate:lock:test", 结论: success, 标签: behavioral }
      - { job: postgres-integration, 序号: "10", 步骤: "Run npm run db:verify -- --allow-privileged", 结论: failure, 标签: behavioral }
      - { job: postgres-integration, 序号: "11", 步骤: "prep: build console for control-plane integration", 结论: skipped }
      - { job: postgres-integration, 序号: "12", 步骤: "Run npm run control-plane:integration", 结论: skipped, 标签: behavioral }
      - { job: postgres-integration, 序号: "22", 步骤: "Post Set up Node.js", 结论: skipped }
      - { job: postgres-integration, 序号: "23", 步骤: "Post Checkout", 结论: success }
      - { job: postgres-integration, 序号: "24", 步骤: "Stop containers", 结论: success }
      - { job: postgres-integration, 序号: "25", 步骤: "Complete job", 结论: success }
      - { job: static-gates, 序号: "1", 步骤: "Set up job", 结论: success }
      - { job: static-gates, 序号: "2", 步骤: "Checkout", 结论: success }
      - { job: static-gates, 序号: "3", 步骤: "Set up Node.js", 结论: success }
      - { job: static-gates, 序号: "4", 步骤: "Run npm ci", 结论: success }
      - { job: static-gates, 序号: "5", 步骤: "Run npm run ci:coverage:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "6", 步骤: "Run npm run ci:workflow:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "7", 步骤: "Run npm run ci:action-pins:verify", 结论: success, 标签: static }
      - { job: static-gates, 序号: "8", 步骤: "Run npm run docs:governance:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "9", 步骤: "Run bash -n scripts/check-runtime-host.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "10", 步骤: "Run bash -n scripts/backup-postgres.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "11", 步骤: "Run bash -n scripts/test-postgres-backup-direct.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "12", 步骤: "Run bash -n scripts/restore-postgres-drill.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "13", 步骤: "Run bash -n scripts/test-postgres-restore-drill.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "14", 步骤: "Run bash -n scripts/backup-runtime-gateway-state.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "15", 步骤: "Run bash -n scripts/restore-runtime-gateway-state-drill.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "16", 步骤: "Run bash -n scripts/verify-postgres-backup.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "17", 步骤: "Run bash -n scripts/verify-runtime-gateway-state-backup.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "18", 步骤: "Run bash scripts/check-runtime-host.sh --help", 结论: success, 标签: static }
      - { job: static-gates, 序号: "19", 步骤: "Run npm run deploy:check -- --allow-placeholders", 结论: success, 标签: static }
      - { job: static-gates, 序号: "20", 步骤: "Run npm run release:workflow:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "21", 步骤: "Run npm run backup:automation:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "22", 步骤: "Run npm run control-plane:compose:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "23", 步骤: "Run npm run runtime:compose:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "24", 步骤: "Run npm run console:page-auth:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "25", 步骤: "Run npm run console:security-headers:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "26", 步骤: "Run npm run console:client-requests:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "27", 步骤: "Run npm run membership:authz:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "28", 步骤: "Run npm run membership:scopes:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "29", 步骤: "Run npm run governance:tenant-scope:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "30", 步骤: "Run npm run governance:immutability:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "31", 步骤: "Run npm run program:revisions:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "32", 步骤: "Run npm run program:runtime-scripts:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "33", 步骤: "Run npm run runtime:program-transition:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "34", 步骤: "Run npm run control-room:program-transition:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "35", 步骤: "Run npm run runtime:program-output:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "36", 步骤: "Run npm run preflight:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "37", 步骤: "Run npm run lifecycle:authz:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "38", 步骤: "Run npm run command:confirmation:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "39", 步骤: "Run npm run service-ingest:auth:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "40", 步骤: "Run npm run service-principals:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "41", 步骤: "Run npm run start:ack:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "42", 步骤: "Run npm run runtime:watchdog:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "43", 步骤: "Run npm run runtime:outbox:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "44", 步骤: "Run npm run runtime:telemetry-alerts:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "45", 步骤: "Run npm run entitlement:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "46", 步骤: "Run npm run runtime:media:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "47", 步骤: "Run npm run runtime:voice:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "48", 步骤: "Run npm run runtime:journal:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "49", 步骤: "Run npm run runtime:preview:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "50", 步骤: "Run npm run media:evidence:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "51", 步骤: "Run npm run recording:evidence:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "52", 步骤: "Run npm run runtime:images:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "53", 步骤: "Run npm run output-probe:response:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "54", 步骤: "Run npm run channel:verification:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "55", 步骤: "Run npm run settlement:reconciliation:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "56", 步骤: "Run npm run alert-notifier:health:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "57", 步骤: "Run node --check apps/runtime-worker/index.mjs", 结论: success, 标签: static }
      - { job: static-gates, 序号: "58", 步骤: "Run node --check apps/runtime-observer/index.mjs", 结论: success, 标签: static }
      - { job: static-gates, 序号: "59", 步骤: "Run node --check apps/runtime-observer/targets.mjs", 结论: success, 标签: static }
      - { job: static-gates, 序号: "60", 步骤: "Run node --check apps/output-probe/index.mjs", 结论: success, 标签: static }
      - { job: static-gates, 序号: "61", 步骤: "Run node --check apps/channel-adapter/index.mjs", 结论: success, 标签: static }
      - { job: static-gates, 序号: "62", 步骤: "Run node --check apps/alert-notifier/index.mjs", 结论: success, 标签: static }
      - { job: static-gates, 序号: "63", 步骤: "Run npm run typecheck", 结论: success, 标签: static }
      - { job: static-gates, 序号: "64", 步骤: "Run npm run lint", 结论: success, 标签: static }
      - { job: static-gates, 序号: "65", 步骤: "Run npm run build", 结论: success, 标签: static }
      - { job: static-gates, 序号: "129", 步骤: "Post Set up Node.js", 结论: success }
      - { job: static-gates, 序号: "130", 步骤: "Post Checkout", 结论: success }
      - { job: static-gates, 序号: "131", 步骤: "Complete job", 结论: success }
      - { job: python-gateway, 序号: "1", 步骤: "Set up job", 结论: success }
      - { job: python-gateway, 序号: "2", 步骤: "Checkout", 结论: success }
      - { job: python-gateway, 序号: "3", 步骤: "Set up Python", 结论: success }
      - { job: python-gateway, 序号: "4", 步骤: "Set up Node.js", 结论: success }
      - { job: python-gateway, 序号: "5", 步骤: "Run python3 -m pip install --disable-pip-version-check --no-cache-dir -r runtime/gateway/requirements.txt", 结论: success }
      - { job: python-gateway, 序号: "6", 步骤: "Run npm run runtime:gateway:config:test", 结论: success, 标签: behavioral }
      - { job: python-gateway, 序号: "7", 步骤: "Run npm run runtime:gateway:errors:test", 结论: success, 标签: behavioral }
      - { job: python-gateway, 序号: "8", 步骤: "Run python3 -m py_compile runtime/gateway/*.py scripts/test-runtime-gateway-config.py", 结论: success, 标签: static }
      - { job: python-gateway, 序号: "9", 步骤: "Run python3 scripts/test-runtime-gateway-audio.py", 结论: success, 标签: behavioral }
      - { job: python-gateway, 序号: "10", 步骤: "Run python3 scripts/test-runtime-gateway-concurrency.py", 结论: success, 标签: behavioral }
      - { job: python-gateway, 序号: "11", 步骤: "Run python3 scripts/test-runtime-gateway-state-backup.py", 结论: success, 标签: behavioral }
      - { job: python-gateway, 序号: "12", 步骤: "Run python3 scripts/test-runtime-gateway-state-restore-drill.py", 结论: success, 标签: behavioral }
      - { job: python-gateway, 序号: "22", 步骤: "Post Set up Node.js", 结论: success }
      - { job: python-gateway, 序号: "23", 步骤: "Post Set up Python", 结论: success }
      - { job: python-gateway, 序号: "24", 步骤: "Post Checkout", 结论: success }
      - { job: python-gateway, 序号: "25", 步骤: "Complete job", 结论: success }
      - { job: docker-build, 序号: "1", 步骤: "Set up job", 结论: success }
      - { job: docker-build, 序号: "2", 步骤: "Checkout", 结论: success }
      - { job: docker-build, 序号: "3", 步骤: "Set up Node.js", 结论: success }
      - { job: docker-build, 序号: "4", 步骤: "Run npm ci", 结论: success }
      - { job: docker-build, 序号: "5", 步骤: "prep: free runner disk", 结论: success }
      - { job: docker-build, 序号: "6", 步骤: "Run docker build --file apps/console/Dockerfile --tag shuzhiren-control-plane-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "7", 步骤: "Run docker build --file apps/console/Dockerfile --target migrator --tag shuzhiren-control-plane-migrator-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "8", 步骤: "Run docker build --file apps/runtime-worker/Dockerfile --tag shuzhiren-runtime-worker-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "9", 步骤: "Run docker build --file apps/runtime-observer/Dockerfile --tag shuzhiren-runtime-observer-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "10", 步骤: "Run docker build --file apps/output-probe/Dockerfile --tag shuzhiren-output-probe-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "11", 步骤: "Run docker build --file apps/channel-adapter/Dockerfile --tag shuzhiren-channel-adapter-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "12", 步骤: "Run docker build --file apps/alert-notifier/Dockerfile --tag shuzhiren-alert-notifier-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "13", 步骤: "Run docker build --file runtime/gateway/Dockerfile --tag shuzhiren-runtime-gateway-ci runtime/gateway", 结论: success, 标签: static }
      - { job: docker-build, 序号: "14", 步骤: "Run docker build --load --file runtime/livetalking/Dockerfile --tag shuzhiren/livetalking:ci .", 结论: failure, 标签: static }
      - { job: docker-build, 序号: "15", 步骤: "prep: reclaim disk before CosyVoice build", 结论: skipped }
      - { job: docker-build, 序号: "16", 步骤: "docker build runtime/cosyvoice (committed Miniforge pin)", 结论: skipped, 标签: static }
      - { job: docker-build, 序号: "31", 步骤: "Post Set up Node.js", 结论: skipped }
      - { job: docker-build, 序号: "32", 步骤: "Post Checkout", 结论: success }
      - { job: docker-build, 序号: "33", 步骤: "Complete job", 结论: success }
    skipped 步骤数: "18"
    node20 弃用告警数: "0"
静态门禁覆盖:
  - { 门禁: "ci:coverage:check", 行为测试: [无] }
  - { 门禁: "ci:workflow:check", 行为测试: [无] }
  - { 门禁: "docs:governance:check", 行为测试: [无] }
  - { 门禁: "deploy:check", 行为测试: [无] }
  - { 门禁: "release:workflow:check", 行为测试: [无] }
  - { 门禁: "backup:automation:check", 行为测试: [无] }
  - { 门禁: "control-plane:compose:check", 行为测试: [无] }
  - { 门禁: "runtime:compose:check", 行为测试: [无] }
  - { 门禁: "console:page-auth:check", 行为测试: [无] }
  - { 门禁: "console:security-headers:check", 行为测试: [无] }
  - { 门禁: "console:client-requests:check", 行为测试: [无] }
  - { 门禁: "membership:authz:check", 行为测试: [无] }
  - { 门禁: "membership:scopes:check", 行为测试: [无] }
  - { 门禁: "governance:tenant-scope:check", 行为测试: [无] }
  - { 门禁: "governance:immutability:check", 行为测试: [无] }
  - { 门禁: "program:revisions:check", 行为测试: [无] }
  - { 门禁: "program:runtime-scripts:check", 行为测试: [无] }
  - { 门禁: "runtime:program-transition:check", 行为测试: [无] }
  - { 门禁: "control-room:program-transition:check", 行为测试: [无] }
  - { 门禁: "runtime:program-output:check", 行为测试: [无] }
  - { 门禁: "preflight:check", 行为测试: [无] }
  - { 门禁: "lifecycle:authz:check", 行为测试: [无] }
  - { 门禁: "command:confirmation:check", 行为测试: [无] }
  - { 门禁: "service-ingest:auth:check", 行为测试: [无] }
  - { 门禁: "service-principals:check", 行为测试: [无] }
  - { 门禁: "start:ack:check", 行为测试: [无] }
  - { 门禁: "runtime:watchdog:check", 行为测试: [无] }
  - { 门禁: "runtime:outbox:check", 行为测试: [无] }
  - { 门禁: "runtime:telemetry-alerts:check", 行为测试: [无] }
  - { 门禁: "entitlement:check", 行为测试: [无] }
  - { 门禁: "runtime:media:check", 行为测试: [无] }
  - { 门禁: "runtime:voice:check", 行为测试: [无] }
  - { 门禁: "runtime:journal:check", 行为测试: [无] }
  - { 门禁: "runtime:preview:check", 行为测试: [无] }
  - { 门禁: "media:evidence:check", 行为测试: [无] }
  - { 门禁: "recording:evidence:check", 行为测试: [无] }
  - { 门禁: "runtime:images:check", 行为测试: [无] }
  - { 门禁: "output-probe:response:check", 行为测试: [无] }
  - { 门禁: "channel:verification:check", 行为测试: [无] }
  - { 门禁: "settlement:reconciliation:check", 行为测试: [无] }
  - { 门禁: "alert-notifier:health:check", 行为测试: [无] }
说明: >-
  依据由 npm run ci:evidence:collect -- --repo pengwenyi4061126-lgtm/shuzhiren --run-id 41965741382 于 2026-11-05 在本机生成
  （设置了用户授权读取 CI 的 GITHUB_TOKEN，退出码 0；token 只放在子进程环境中，没有打印或写入文件），改为本文件的流式写法，
  内容不变；runner 镜像取自各 job 日志 Set up job 步骤的 Runner Image 组。标签由 scripts/lib/verification-log.mjs 的
  createCheckResolver 按当前的 LOCAL_CHECKS、CI_ONLY_STEPS 与 ci.yml 求出后补入，准备步骤（Set up job、Initialize containers、
  Checkout、Set up Node.js、Set up Python、npm ci、prep: 开头的步骤、Post、Stop containers、Complete job）不写标签。
  python-gateway 第 5 步 pip install -r runtime/gateway/requirements.txt 没有写标签：44857e1 把这一步改为按哈希锁文件安装，
  当前的 CI_ONLY_STEPS 中已经没有原命令，门禁无法为它核对标签。
  运行由推送 master 触发，2026-11-05T04:06:46Z 创建，04:37:04Z 结束；六个 job 都在 ubuntu-24.04 上运行，彼此没有 needs。job 结论与 job id：
  static-gates success（127042211904）、python-gateway success（127042211975）、compose-render success（127042211691）、
  node-unit cancelled（127042211852）、postgres-integration failure（127042211878）、docker-build failure（127042212017）。
  18 个 skipped 步骤中 node-unit 12 个、postgres-integration 3 个、docker-build 3 个。失败的归属：
  (1) node-unit 第 15 步 Run npm run observer:runtime:test 运行约 29 分钟后被取消，job 注解为 The job has exceeded the maximum
  execution time of 30m0s 与 The operation was canceled.，其后 11 个验证步骤与 Post Set up Node.js 为 skipped：AUDIT_REGISTER.md 的
  N7，修复提交 1657254，修复后的结果见 V-20261105-10。
  (2) postgres-integration 第 10 步 Run npm run db:verify -- --allow-privileged 失败，其后 prep: build console for control-plane
  integration、Run npm run control-plane:integration 与 Post Set up Node.js 为 skipped；第 6 至 9 步 db:migrate、
  db:migrate:integrity:test、service-principals:integration、db:migrate:lock:test 为 success。job 日志中该步骤的错误行为
  ERROR channel connection configuration is immutable，随后是 ##[error]Process completed with exit code 1.（与用户此前从运行页面
  抄录的一致）：AUDIT_REGISTER.md 的 C1，修复提交 f35eb30，修复后的结果见 V-20261105-12。
  (3) docker-build 第 14 步 LiveTalking 镜像构建失败，其后 prep: reclaim disk before CosyVoice build、CosyVoice 镜像构建与
  Post Set up Node.js 为 skipped；第 6 至 13 步的 8 个镜像构建为 success。job 日志中的错误行为 fatal: not a git repository:
  /app/../../.git/modules/vendor/LiveTalking 与 ERROR: failed to build: failed to solve: process "/bin/sh -c git apply --check
  --recount /tmp/livetalking-observability.patch && git apply --recount /tmp/livetalking-observability.patch && chown -R
  livetalking:livetalking /app" did not complete successfully: exit code: 128：AUDIT_REGISTER.md 的 N6，修复提交 43718f8。
  #491 在 console 第 31 步失败后其余步骤全部为 skipped（V-20261104-01）；拆分为六个 job 并改正 env_file 路径之后，本运行第一次
  执行了这些步骤，上面三处失败都出现在 #491 中被跳过的步骤上。compose-render 第 5 步执行的是 #491 第 31 步的同一条
  docker compose 命令（step env CONTROL_PLANE_ENV_FILE 已改为 ../../config/control-plane.example.env，见 V-20261105-01），
  本运行中为 success；#491 的根因由 job 日志确认，见 V-20261105-11。判定为未验证：运行结论为 failure，且有步骤的结论不是 success。
```

## V-20261105-10 CI #493（run 41972571602，提交 1657254）为 failure：只有 postgres-integration 的 db:verify（C1）与 docker-build 的 CosyVoice 构建（N8）失败

```yaml
编号: V-20261105-10
类型: 结论
结论: 第 493 次 CI 运行（run 41972571602，提交 1657254）的结论为 failure；static-gates、node-unit、python-gateway、compose-render 为 success 且没有 skipped 步骤；postgres-integration 只有第 10 步 db:verify 失败（C1），其后 3 个步骤为 skipped；docker-build 只有第 16 步 CosyVoice 镜像构建失败（N8），其余 9 个镜像构建为 success，Post Set up Node.js 为 skipped
判定: 未验证
依据来源:
  - 类别: CI 或 Linux 运行
    平台: GitHub Actions
    run id: "41972571602"
    提交: 16572549bb72d718ad898248fc27e7b74e284e35
    运行结论: failure
    runner 镜像:
      - { job: static-gates, 镜像: ubuntu-24.04, 版本: "20261101.360.1" }
      - { job: postgres-integration, 镜像: ubuntu-24.04, 版本: "20261101.360.1" }
      - { job: compose-render, 镜像: ubuntu-24.04, 版本: "20261025.353.1" }
      - { job: python-gateway, 镜像: ubuntu-24.04, 版本: "20261101.360.1" }
      - { job: node-unit, 镜像: ubuntu-24.04, 版本: "20261025.353.1" }
      - { job: docker-build, 镜像: ubuntu-24.04, 版本: "20261025.353.1" }
    步骤:
      - { job: static-gates, 序号: "1", 步骤: "Set up job", 结论: success }
      - { job: static-gates, 序号: "2", 步骤: "Checkout", 结论: success }
      - { job: static-gates, 序号: "3", 步骤: "Set up Node.js", 结论: success }
      - { job: static-gates, 序号: "4", 步骤: "Run npm ci", 结论: success }
      - { job: static-gates, 序号: "5", 步骤: "Run npm run ci:coverage:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "6", 步骤: "Run npm run ci:workflow:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "7", 步骤: "Run npm run ci:action-pins:verify", 结论: success, 标签: static }
      - { job: static-gates, 序号: "8", 步骤: "Run npm run docs:governance:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "9", 步骤: "Run bash -n scripts/check-runtime-host.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "10", 步骤: "Run bash -n scripts/backup-postgres.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "11", 步骤: "Run bash -n scripts/test-postgres-backup-direct.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "12", 步骤: "Run bash -n scripts/restore-postgres-drill.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "13", 步骤: "Run bash -n scripts/test-postgres-restore-drill.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "14", 步骤: "Run bash -n scripts/backup-runtime-gateway-state.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "15", 步骤: "Run bash -n scripts/restore-runtime-gateway-state-drill.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "16", 步骤: "Run bash -n scripts/verify-postgres-backup.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "17", 步骤: "Run bash -n scripts/verify-runtime-gateway-state-backup.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "18", 步骤: "Run bash scripts/check-runtime-host.sh --help", 结论: success, 标签: static }
      - { job: static-gates, 序号: "19", 步骤: "Run npm run deploy:check -- --allow-placeholders", 结论: success, 标签: static }
      - { job: static-gates, 序号: "20", 步骤: "Run npm run release:workflow:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "21", 步骤: "Run npm run backup:automation:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "22", 步骤: "Run npm run control-plane:compose:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "23", 步骤: "Run npm run runtime:compose:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "24", 步骤: "Run npm run console:page-auth:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "25", 步骤: "Run npm run console:security-headers:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "26", 步骤: "Run npm run console:client-requests:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "27", 步骤: "Run npm run membership:authz:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "28", 步骤: "Run npm run membership:scopes:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "29", 步骤: "Run npm run governance:tenant-scope:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "30", 步骤: "Run npm run governance:immutability:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "31", 步骤: "Run npm run program:revisions:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "32", 步骤: "Run npm run program:runtime-scripts:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "33", 步骤: "Run npm run runtime:program-transition:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "34", 步骤: "Run npm run control-room:program-transition:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "35", 步骤: "Run npm run runtime:program-output:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "36", 步骤: "Run npm run preflight:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "37", 步骤: "Run npm run lifecycle:authz:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "38", 步骤: "Run npm run command:confirmation:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "39", 步骤: "Run npm run service-ingest:auth:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "40", 步骤: "Run npm run service-principals:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "41", 步骤: "Run npm run start:ack:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "42", 步骤: "Run npm run runtime:watchdog:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "43", 步骤: "Run npm run runtime:outbox:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "44", 步骤: "Run npm run runtime:telemetry-alerts:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "45", 步骤: "Run npm run entitlement:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "46", 步骤: "Run npm run runtime:media:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "47", 步骤: "Run npm run runtime:voice:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "48", 步骤: "Run npm run runtime:journal:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "49", 步骤: "Run npm run runtime:preview:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "50", 步骤: "Run npm run media:evidence:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "51", 步骤: "Run npm run recording:evidence:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "52", 步骤: "Run npm run runtime:images:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "53", 步骤: "Run npm run output-probe:response:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "54", 步骤: "Run npm run channel:verification:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "55", 步骤: "Run npm run settlement:reconciliation:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "56", 步骤: "Run npm run alert-notifier:health:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "57", 步骤: "Run node --check apps/runtime-worker/index.mjs", 结论: success, 标签: static }
      - { job: static-gates, 序号: "58", 步骤: "Run node --check apps/runtime-observer/index.mjs", 结论: success, 标签: static }
      - { job: static-gates, 序号: "59", 步骤: "Run node --check apps/runtime-observer/targets.mjs", 结论: success, 标签: static }
      - { job: static-gates, 序号: "60", 步骤: "Run node --check apps/output-probe/index.mjs", 结论: success, 标签: static }
      - { job: static-gates, 序号: "61", 步骤: "Run node --check apps/channel-adapter/index.mjs", 结论: success, 标签: static }
      - { job: static-gates, 序号: "62", 步骤: "Run node --check apps/alert-notifier/index.mjs", 结论: success, 标签: static }
      - { job: static-gates, 序号: "63", 步骤: "Run npm run typecheck", 结论: success, 标签: static }
      - { job: static-gates, 序号: "64", 步骤: "Run npm run lint", 结论: success, 标签: static }
      - { job: static-gates, 序号: "65", 步骤: "Run npm run build", 结论: success, 标签: static }
      - { job: static-gates, 序号: "129", 步骤: "Post Set up Node.js", 结论: success }
      - { job: static-gates, 序号: "130", 步骤: "Post Checkout", 结论: success }
      - { job: static-gates, 序号: "131", 步骤: "Complete job", 结论: success }
      - { job: postgres-integration, 序号: "1", 步骤: "Set up job", 结论: success }
      - { job: postgres-integration, 序号: "2", 步骤: "Initialize containers", 结论: success }
      - { job: postgres-integration, 序号: "3", 步骤: "Checkout", 结论: success }
      - { job: postgres-integration, 序号: "4", 步骤: "Set up Node.js", 结论: success }
      - { job: postgres-integration, 序号: "5", 步骤: "Run npm ci", 结论: success }
      - { job: postgres-integration, 序号: "6", 步骤: "Run npm run db:migrate", 结论: success, 标签: behavioral }
      - { job: postgres-integration, 序号: "7", 步骤: "Run npm run db:migrate:integrity:test", 结论: success, 标签: behavioral }
      - { job: postgres-integration, 序号: "8", 步骤: "Run npm run service-principals:integration", 结论: success, 标签: behavioral }
      - { job: postgres-integration, 序号: "9", 步骤: "Run npm run db:migrate:lock:test", 结论: success, 标签: behavioral }
      - { job: postgres-integration, 序号: "10", 步骤: "Run npm run db:verify -- --allow-privileged", 结论: failure, 标签: behavioral }
      - { job: postgres-integration, 序号: "11", 步骤: "prep: build console for control-plane integration", 结论: skipped }
      - { job: postgres-integration, 序号: "12", 步骤: "Run npm run control-plane:integration", 结论: skipped, 标签: behavioral }
      - { job: postgres-integration, 序号: "22", 步骤: "Post Set up Node.js", 结论: skipped }
      - { job: postgres-integration, 序号: "23", 步骤: "Post Checkout", 结论: success }
      - { job: postgres-integration, 序号: "24", 步骤: "Stop containers", 结论: success }
      - { job: postgres-integration, 序号: "25", 步骤: "Complete job", 结论: success }
      - { job: compose-render, 序号: "1", 步骤: "Set up job", 结论: success }
      - { job: compose-render, 序号: "2", 步骤: "Checkout", 结论: success }
      - { job: compose-render, 序号: "3", 步骤: "Set up Node.js", 结论: success }
      - { job: compose-render, 序号: "4", 步骤: "Run npm ci", 结论: success }
      - { job: compose-render, 序号: "5", 步骤: "Run docker compose --env-file config/control-plane-compose.example.env -f infra/compose/docker-compose.control-plane.yml config", 结论: success, 标签: static }
      - { job: compose-render, 序号: "6", 步骤: "Run docker compose --env-file config/runtime.example.env --env-file config/runtime-gateway.example.env --env-file config/channel-adapter.example.env --env-file config/alert-notifier.example.env --profile output-probe --profile channel-adapter --profile alert-notifier --profile cosyvoice -f infra/compose/docker-compose.runtime.yml config", 结论: success, 标签: static }
      - { job: compose-render, 序号: "11", 步骤: "Post Set up Node.js", 结论: success }
      - { job: compose-render, 序号: "12", 步骤: "Post Checkout", 结论: success }
      - { job: compose-render, 序号: "13", 步骤: "Complete job", 结论: success }
      - { job: python-gateway, 序号: "1", 步骤: "Set up job", 结论: success }
      - { job: python-gateway, 序号: "2", 步骤: "Checkout", 结论: success }
      - { job: python-gateway, 序号: "3", 步骤: "Set up Python", 结论: success }
      - { job: python-gateway, 序号: "4", 步骤: "Set up Node.js", 结论: success }
      - { job: python-gateway, 序号: "5", 步骤: "Run python3 -m pip install --disable-pip-version-check --no-cache-dir -r runtime/gateway/requirements.txt", 结论: success }
      - { job: python-gateway, 序号: "6", 步骤: "Run npm run runtime:gateway:config:test", 结论: success, 标签: behavioral }
      - { job: python-gateway, 序号: "7", 步骤: "Run npm run runtime:gateway:errors:test", 结论: success, 标签: behavioral }
      - { job: python-gateway, 序号: "8", 步骤: "Run python3 -m py_compile runtime/gateway/*.py scripts/test-runtime-gateway-config.py", 结论: success, 标签: static }
      - { job: python-gateway, 序号: "9", 步骤: "Run python3 scripts/test-runtime-gateway-audio.py", 结论: success, 标签: behavioral }
      - { job: python-gateway, 序号: "10", 步骤: "Run python3 scripts/test-runtime-gateway-concurrency.py", 结论: success, 标签: behavioral }
      - { job: python-gateway, 序号: "11", 步骤: "Run python3 scripts/test-runtime-gateway-state-backup.py", 结论: success, 标签: behavioral }
      - { job: python-gateway, 序号: "12", 步骤: "Run python3 scripts/test-runtime-gateway-state-restore-drill.py", 结论: success, 标签: behavioral }
      - { job: python-gateway, 序号: "22", 步骤: "Post Set up Node.js", 结论: success }
      - { job: python-gateway, 序号: "23", 步骤: "Post Set up Python", 结论: success }
      - { job: python-gateway, 序号: "24", 步骤: "Post Checkout", 结论: success }
      - { job: python-gateway, 序号: "25", 步骤: "Complete job", 结论: success }
      - { job: node-unit, 序号: "1", 步骤: "Set up job", 结论: success }
      - { job: node-unit, 序号: "2", 步骤: "Checkout", 结论: success }
      - { job: node-unit, 序号: "3", 步骤: "Set up Node.js", 结论: success }
      - { job: node-unit, 序号: "4", 步骤: "Run npm ci", 结论: success }
      - { job: node-unit, 序号: "5", 步骤: "Run npm run deploy:check:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "6", 步骤: "Run npm run deploy:manifest:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "7", 步骤: "Run npm run deploy:images:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "8", 步骤: "Run npm run release:evidence:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "9", 步骤: "Run bash scripts/test-postgres-backup-direct.sh", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "10", 步骤: "Run bash scripts/test-postgres-restore-drill.sh", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "11", 步骤: "Run npm run policy:red-team", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "12", 步骤: "Run npm run runtime:worker:config:test", 结论: success, 标签: static }
      - { job: node-unit, 序号: "13", 步骤: "Run npm run runtime:worker:health:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "14", 步骤: "Run npm run runtime:acceptance:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "15", 步骤: "Run npm run observer:runtime:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "16", 步骤: "Run npm run observer:targets:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "17", 步骤: "Run npm run observer:targets:apply:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "18", 步骤: "Run npm run output-probe:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "19", 步骤: "Run npm run output-probe:config:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "20", 步骤: "Run npm run channel-adapter:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "21", 步骤: "Run npm run alert-notifier:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "22", 步骤: "Run npm run ci:gates:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "23", 步骤: "Run npm run ci:db-fail-closed:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "24", 步骤: "Run npm run ci:evidence:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "25", 步骤: "Run npm run release:workflow:gate:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "26", 步骤: "Run npm run docs:governance:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "51", 步骤: "Post Set up Node.js", 结论: success }
      - { job: node-unit, 序号: "52", 步骤: "Post Checkout", 结论: success }
      - { job: node-unit, 序号: "53", 步骤: "Complete job", 结论: success }
      - { job: docker-build, 序号: "1", 步骤: "Set up job", 结论: success }
      - { job: docker-build, 序号: "2", 步骤: "Checkout", 结论: success }
      - { job: docker-build, 序号: "3", 步骤: "Set up Node.js", 结论: success }
      - { job: docker-build, 序号: "4", 步骤: "Run npm ci", 结论: success }
      - { job: docker-build, 序号: "5", 步骤: "prep: free runner disk", 结论: success }
      - { job: docker-build, 序号: "6", 步骤: "Run docker build --file apps/console/Dockerfile --tag shuzhiren-control-plane-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "7", 步骤: "Run docker build --file apps/console/Dockerfile --target migrator --tag shuzhiren-control-plane-migrator-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "8", 步骤: "Run docker build --file apps/runtime-worker/Dockerfile --tag shuzhiren-runtime-worker-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "9", 步骤: "Run docker build --file apps/runtime-observer/Dockerfile --tag shuzhiren-runtime-observer-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "10", 步骤: "Run docker build --file apps/output-probe/Dockerfile --tag shuzhiren-output-probe-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "11", 步骤: "Run docker build --file apps/channel-adapter/Dockerfile --tag shuzhiren-channel-adapter-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "12", 步骤: "Run docker build --file apps/alert-notifier/Dockerfile --tag shuzhiren-alert-notifier-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "13", 步骤: "Run docker build --file runtime/gateway/Dockerfile --tag shuzhiren-runtime-gateway-ci runtime/gateway", 结论: success, 标签: static }
      - { job: docker-build, 序号: "14", 步骤: "Run docker build --load --file runtime/livetalking/Dockerfile --tag shuzhiren/livetalking:ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "15", 步骤: "prep: reclaim disk before CosyVoice build", 结论: success }
      - { job: docker-build, 序号: "16", 步骤: "docker build runtime/cosyvoice (committed Miniforge pin)", 结论: failure, 标签: static }
      - { job: docker-build, 序号: "31", 步骤: "Post Set up Node.js", 结论: skipped }
      - { job: docker-build, 序号: "32", 步骤: "Post Checkout", 结论: success }
      - { job: docker-build, 序号: "33", 步骤: "Complete job", 结论: success }
    skipped 步骤数: "4"
    node20 弃用告警数: "0"
静态门禁覆盖:
  - { 门禁: "ci:coverage:check", 行为测试: [无] }
  - { 门禁: "ci:workflow:check", 行为测试: [无] }
  - { 门禁: "docs:governance:check", 行为测试: [无] }
  - { 门禁: "deploy:check", 行为测试: [无] }
  - { 门禁: "release:workflow:check", 行为测试: [无] }
  - { 门禁: "backup:automation:check", 行为测试: [无] }
  - { 门禁: "control-plane:compose:check", 行为测试: [无] }
  - { 门禁: "runtime:compose:check", 行为测试: [无] }
  - { 门禁: "console:page-auth:check", 行为测试: [无] }
  - { 门禁: "console:security-headers:check", 行为测试: [无] }
  - { 门禁: "console:client-requests:check", 行为测试: [无] }
  - { 门禁: "membership:authz:check", 行为测试: [无] }
  - { 门禁: "membership:scopes:check", 行为测试: [无] }
  - { 门禁: "governance:tenant-scope:check", 行为测试: [无] }
  - { 门禁: "governance:immutability:check", 行为测试: [无] }
  - { 门禁: "program:revisions:check", 行为测试: [无] }
  - { 门禁: "program:runtime-scripts:check", 行为测试: [无] }
  - { 门禁: "runtime:program-transition:check", 行为测试: [无] }
  - { 门禁: "control-room:program-transition:check", 行为测试: [无] }
  - { 门禁: "runtime:program-output:check", 行为测试: [无] }
  - { 门禁: "preflight:check", 行为测试: [无] }
  - { 门禁: "lifecycle:authz:check", 行为测试: [无] }
  - { 门禁: "command:confirmation:check", 行为测试: [无] }
  - { 门禁: "service-ingest:auth:check", 行为测试: [无] }
  - { 门禁: "service-principals:check", 行为测试: [无] }
  - { 门禁: "start:ack:check", 行为测试: [无] }
  - { 门禁: "runtime:watchdog:check", 行为测试: [无] }
  - { 门禁: "runtime:outbox:check", 行为测试: [无] }
  - { 门禁: "runtime:telemetry-alerts:check", 行为测试: [无] }
  - { 门禁: "entitlement:check", 行为测试: [无] }
  - { 门禁: "runtime:media:check", 行为测试: [无] }
  - { 门禁: "runtime:voice:check", 行为测试: [无] }
  - { 门禁: "runtime:journal:check", 行为测试: [无] }
  - { 门禁: "runtime:preview:check", 行为测试: [无] }
  - { 门禁: "media:evidence:check", 行为测试: [无] }
  - { 门禁: "recording:evidence:check", 行为测试: [无] }
  - { 门禁: "runtime:images:check", 行为测试: [无] }
  - { 门禁: "output-probe:response:check", 行为测试: [无] }
  - { 门禁: "channel:verification:check", 行为测试: [无] }
  - { 门禁: "settlement:reconciliation:check", 行为测试: [无] }
  - { 门禁: "alert-notifier:health:check", 行为测试: [无] }
说明: >-
  依据由 npm run ci:evidence:collect -- --repo pengwenyi4061126-lgtm/shuzhiren --run-id 41972571602 于 2026-11-05 在本机生成
  （设置了用户授权读取 CI 的 GITHUB_TOKEN，退出码 0；token 只放在子进程环境中，没有打印或写入文件），改为本文件的流式写法，
  内容不变；runner 镜像取自各 job 日志 Set up job 步骤的 Runner Image 组。标签由 scripts/lib/verification-log.mjs 的
  createCheckResolver 按当前的 LOCAL_CHECKS、CI_ONLY_STEPS 与 ci.yml 求出后补入，准备步骤（Set up job、Initialize containers、
  Checkout、Set up Node.js、Set up Python、npm ci、prep: 开头的步骤、Post、Stop containers、Complete job）不写标签。
  python-gateway 第 5 步 pip install -r runtime/gateway/requirements.txt 没有写标签：44857e1 把这一步改为按哈希锁文件安装，
  当前的 CI_ONLY_STEPS 中已经没有原命令，门禁无法为它核对标签。
  运行由推送 master 触发，2026-11-05T05:12:50Z 创建，05:23:53Z 结束。job 结论与 job id：static-gates success（127063954050）、
  node-unit success（127063954459）、python-gateway success（127063954419）、compose-render success（127063954333）、
  postgres-integration failure（127063954324）、docker-build failure（127063954495）。4 个 skipped 步骤中 postgres-integration 3 个、
  docker-build 1 个。
  (1) postgres-integration 第 10 步 Run npm run db:verify -- --allow-privileged 失败，其后 3 个步骤为 skipped，第 6 至 9 步为 success；
  job 日志中的错误行与 #492 相同（ERROR channel connection configuration is immutable）：AUDIT_REGISTER.md 的 C1。提交 1657254 是
  C1 修复提交 f35eb30 的父提交，本运行即 C1 修复前失败的证据；修复后的结果见 V-20261105-12。
  (2) docker-build 第 16 步 docker build runtime/cosyvoice (committed Miniforge pin) 从 05:21:32Z 运行到 05:23:49Z 后失败。job 日志显示
  pip 为 openai-whisper==20231117（来自 /opt/CosyVoice/CosyVoice/requirements.txt 第 25 行）执行 Getting requirements to build wheel
  时出错：ModuleNotFoundError: No module named 'pkg_resources'，随后 ERROR: Failed to build 'openai-whisper' when getting requirements
  to build wheel；同一 RUN 中 conda 安装的 setuptools 为 84.x。这是 AUDIT_REGISTER.md 的 N8，修复提交 2672612，修复后的结果见
  V-20261105-13。第 6 至 14 步的 9 个镜像构建为 success。
  (3) N6 的回归测试 docker-build 第 14 步 LiveTalking 镜像构建为 success（05:16:54Z 至 05:21:19Z）。
  (4) N7 的回归测试 node-unit 第 15 步 observer:runtime:test 为 success（05:13:26Z 至 05:13:28Z），其后 11 个验证步骤都执行并为 success。
  提交 1657254 的父提交是 43718f8（N6 修复），两者的改动都在本运行中。本运行的结论不是 success，不写首次绿色 CI 条目。
  判定为未验证：运行结论为 failure，且有步骤的结论不是 success。
```

## V-20261105-11 CI #491 第 31 步失败的根因：compose 按 infra/compose/ 解析 env_file，CONTROL_PLANE_ENV_FILE 指向不存在的文件（日志证实）

```yaml
编号: V-20261105-11
类型: CI 根因
结论: CI #491（run 41869137741，提交 dc2916e）console 第 31 步渲染 control-plane compose 失败的根因，是 compose 按 compose 文件所在的 infra/compose/ 解析 env_file，step env CONTROL_PLANE_ENV_FILE=config/control-plane.example.env 因此指向不存在的 infra/compose/config/control-plane.example.env；job 日志证实了这一候选根因，修复提交为 371a203
判定: 未验证
根因: >-
  infra/compose/docker-compose.control-plane.yml 中的 env_file 取 CONTROL_PLANE_ENV_FILE 的值。docker compose 把 env_file 的相对路径
  按 compose 文件所在目录解析，dc2916e 的 ci.yml 把它设为 config/control-plane.example.env，实际查找的是
  /home/runner/work/shuzhiren/shuzhiren/infra/compose/config/control-plane.example.env，该文件不存在，docker compose config 以退出码 1 结束。
确认方式: CI 日志摘录
日志或命令输出: |
  2026-11-04T16:38:50.6169891Z ##[group]Run docker compose --env-file config/control-plane-compose.example.env -f infra/compose/docker-compose.control-plane.yml config
  2026-11-04T16:38:50.6170651Z docker compose --env-file config/control-plane-compose.example.env -f infra/compose/docker-compose.control-plane.yml config
  2026-11-04T16:38:50.6198752Z   CONTROL_PLANE_ENV_FILE: config/control-plane.example.env
  2026-11-04T16:38:52.3735025Z env file /home/runner/work/shuzhiren/shuzhiren/infra/compose/config/control-plane.example.env not found: stat /home/runner/work/shuzhiren/shuzhiren/infra/compose/config/control-plane.example.env: no such file or directory
  2026-11-04T16:38:52.3782936Z ##[error]Process completed with exit code 1.
修复提交: 371a2032773b7a691ae59261af77d828ae9afaaa
候选根因: 证实
依据来源:
  - 类别: CI 或 Linux 运行
    平台: GitHub Actions
    run id: "41869137741"
    提交: dc2916eef45f2aebacde24598723468f23ee61a6
    运行结论: failure
    runner 镜像:
      - { job: console, 镜像: ubuntu-26.04, 版本: "20261025.179.1" }
    步骤:
      - { job: console, 序号: "31", 步骤: "Run docker compose --env-file config/control-plane-compose.example.env -f infra/compose/docker-compose.control-plane.yml config", 结论: failure, 标签: static }
    skipped 步骤数: "72"
    node20 弃用告警数: "1"
说明: >-
  日志摘录取自 job 126711085025（console）的日志，2026-11-05 以用户授权读取 CI 的 GITHUB_TOKEN 通过 GitHub API 下载（token 只在内存中使用，
  日志文件放在仓库之外的临时目录，摘录后删除）。摘录是第 31 步日志中连续的行，只省略了 shell 行与 env 中的 DATABASE_URL 行（其值在日志中已被
  GitHub 屏蔽为 ***，此处不转录）。错误行与 V-20261105-01 中记录的候选根因一致，候选根因为证实。修复提交 371a203 只把 step env
  CONTROL_PLANE_ENV_FILE 改为 ../../config/control-plane.example.env，docker compose 命令与参数不变（V-20261105-01）。修复之后，
  compose-render 第 5 步执行同一条命令，在 run 41965741382（V-20261105-09）及其后的每次运行中都为 success，首次全绿运行为
  run 41993338992（V-20261105-16）。依据来源只列 #491 本身，运行结论为 failure，所以判定为未验证。
```

## V-20261105-12 CI #494（run 41978941738，提交 734ee8e）为 failure：db:verify 通过（C1 已修复），control-plane:integration 因测试夹具 23505 失败，CosyVoice 构建仍因 N8 失败

```yaml
编号: V-20261105-12
类型: 结论
结论: 第 494 次 CI 运行（run 41978941738，提交 734ee8e）的结论为 failure；static-gates、node-unit、python-gateway、compose-render 为 success；postgres-integration 第 10 步 db:verify 为 success，第 12 步 control-plane:integration 失败；docker-build 只有第 16 步 CosyVoice 镜像构建失败（N8）；共 2 个步骤为 skipped
判定: 未验证
依据来源:
  - 类别: CI 或 Linux 运行
    平台: GitHub Actions
    run id: "41978941738"
    提交: 734ee8e877723f4042d3a6e1b45ce7548c578671
    运行结论: failure
    runner 镜像:
      - { job: python-gateway, 镜像: ubuntu-24.04, 版本: "20261101.114.1" }
      - { job: compose-render, 镜像: ubuntu-24.04, 版本: "20261101.360.1" }
      - { job: static-gates, 镜像: ubuntu-24.04, 版本: "20261101.360.1" }
      - { job: node-unit, 镜像: ubuntu-24.04, 版本: "20261025.353.1" }
      - { job: postgres-integration, 镜像: ubuntu-24.04, 版本: "20261101.360.1" }
      - { job: docker-build, 镜像: ubuntu-24.04, 版本: "20261101.360.1" }
    步骤:
      - { job: python-gateway, 序号: "1", 步骤: "Set up job", 结论: success }
      - { job: python-gateway, 序号: "2", 步骤: "Checkout", 结论: success }
      - { job: python-gateway, 序号: "3", 步骤: "Set up Python", 结论: success }
      - { job: python-gateway, 序号: "4", 步骤: "Set up Node.js", 结论: success }
      - { job: python-gateway, 序号: "5", 步骤: "Run python3 -m pip install --disable-pip-version-check --no-cache-dir -r runtime/gateway/requirements.txt", 结论: success }
      - { job: python-gateway, 序号: "6", 步骤: "Run npm run runtime:gateway:config:test", 结论: success, 标签: behavioral }
      - { job: python-gateway, 序号: "7", 步骤: "Run npm run runtime:gateway:errors:test", 结论: success, 标签: behavioral }
      - { job: python-gateway, 序号: "8", 步骤: "Run python3 -m py_compile runtime/gateway/*.py scripts/test-runtime-gateway-config.py", 结论: success, 标签: static }
      - { job: python-gateway, 序号: "9", 步骤: "Run python3 scripts/test-runtime-gateway-audio.py", 结论: success, 标签: behavioral }
      - { job: python-gateway, 序号: "10", 步骤: "Run python3 scripts/test-runtime-gateway-concurrency.py", 结论: success, 标签: behavioral }
      - { job: python-gateway, 序号: "11", 步骤: "Run python3 scripts/test-runtime-gateway-state-backup.py", 结论: success, 标签: behavioral }
      - { job: python-gateway, 序号: "12", 步骤: "Run python3 scripts/test-runtime-gateway-state-restore-drill.py", 结论: success, 标签: behavioral }
      - { job: python-gateway, 序号: "22", 步骤: "Post Set up Node.js", 结论: success }
      - { job: python-gateway, 序号: "23", 步骤: "Post Set up Python", 结论: success }
      - { job: python-gateway, 序号: "24", 步骤: "Post Checkout", 结论: success }
      - { job: python-gateway, 序号: "25", 步骤: "Complete job", 结论: success }
      - { job: compose-render, 序号: "1", 步骤: "Set up job", 结论: success }
      - { job: compose-render, 序号: "2", 步骤: "Checkout", 结论: success }
      - { job: compose-render, 序号: "3", 步骤: "Set up Node.js", 结论: success }
      - { job: compose-render, 序号: "4", 步骤: "Run npm ci", 结论: success }
      - { job: compose-render, 序号: "5", 步骤: "Run docker compose --env-file config/control-plane-compose.example.env -f infra/compose/docker-compose.control-plane.yml config", 结论: success, 标签: static }
      - { job: compose-render, 序号: "6", 步骤: "Run docker compose --env-file config/runtime.example.env --env-file config/runtime-gateway.example.env --env-file config/channel-adapter.example.env --env-file config/alert-notifier.example.env --profile output-probe --profile channel-adapter --profile alert-notifier --profile cosyvoice -f infra/compose/docker-compose.runtime.yml config", 结论: success, 标签: static }
      - { job: compose-render, 序号: "11", 步骤: "Post Set up Node.js", 结论: success }
      - { job: compose-render, 序号: "12", 步骤: "Post Checkout", 结论: success }
      - { job: compose-render, 序号: "13", 步骤: "Complete job", 结论: success }
      - { job: static-gates, 序号: "1", 步骤: "Set up job", 结论: success }
      - { job: static-gates, 序号: "2", 步骤: "Checkout", 结论: success }
      - { job: static-gates, 序号: "3", 步骤: "Set up Node.js", 结论: success }
      - { job: static-gates, 序号: "4", 步骤: "Run npm ci", 结论: success }
      - { job: static-gates, 序号: "5", 步骤: "Run npm run ci:coverage:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "6", 步骤: "Run npm run ci:workflow:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "7", 步骤: "Run npm run ci:action-pins:verify", 结论: success, 标签: static }
      - { job: static-gates, 序号: "8", 步骤: "Run npm run docs:governance:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "9", 步骤: "Run bash -n scripts/check-runtime-host.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "10", 步骤: "Run bash -n scripts/backup-postgres.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "11", 步骤: "Run bash -n scripts/test-postgres-backup-direct.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "12", 步骤: "Run bash -n scripts/restore-postgres-drill.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "13", 步骤: "Run bash -n scripts/test-postgres-restore-drill.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "14", 步骤: "Run bash -n scripts/backup-runtime-gateway-state.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "15", 步骤: "Run bash -n scripts/restore-runtime-gateway-state-drill.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "16", 步骤: "Run bash -n scripts/verify-postgres-backup.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "17", 步骤: "Run bash -n scripts/verify-runtime-gateway-state-backup.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "18", 步骤: "Run bash scripts/check-runtime-host.sh --help", 结论: success, 标签: static }
      - { job: static-gates, 序号: "19", 步骤: "Run npm run deploy:check -- --allow-placeholders", 结论: success, 标签: static }
      - { job: static-gates, 序号: "20", 步骤: "Run npm run release:workflow:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "21", 步骤: "Run npm run backup:automation:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "22", 步骤: "Run npm run control-plane:compose:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "23", 步骤: "Run npm run runtime:compose:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "24", 步骤: "Run npm run console:page-auth:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "25", 步骤: "Run npm run console:security-headers:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "26", 步骤: "Run npm run console:client-requests:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "27", 步骤: "Run npm run membership:authz:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "28", 步骤: "Run npm run membership:scopes:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "29", 步骤: "Run npm run governance:tenant-scope:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "30", 步骤: "Run npm run governance:immutability:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "31", 步骤: "Run npm run program:revisions:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "32", 步骤: "Run npm run program:runtime-scripts:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "33", 步骤: "Run npm run runtime:program-transition:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "34", 步骤: "Run npm run control-room:program-transition:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "35", 步骤: "Run npm run runtime:program-output:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "36", 步骤: "Run npm run preflight:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "37", 步骤: "Run npm run lifecycle:authz:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "38", 步骤: "Run npm run command:confirmation:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "39", 步骤: "Run npm run service-ingest:auth:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "40", 步骤: "Run npm run service-principals:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "41", 步骤: "Run npm run start:ack:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "42", 步骤: "Run npm run runtime:watchdog:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "43", 步骤: "Run npm run runtime:outbox:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "44", 步骤: "Run npm run runtime:telemetry-alerts:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "45", 步骤: "Run npm run entitlement:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "46", 步骤: "Run npm run runtime:media:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "47", 步骤: "Run npm run runtime:voice:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "48", 步骤: "Run npm run runtime:journal:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "49", 步骤: "Run npm run runtime:preview:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "50", 步骤: "Run npm run media:evidence:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "51", 步骤: "Run npm run recording:evidence:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "52", 步骤: "Run npm run runtime:images:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "53", 步骤: "Run npm run output-probe:response:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "54", 步骤: "Run npm run channel:verification:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "55", 步骤: "Run npm run settlement:reconciliation:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "56", 步骤: "Run npm run alert-notifier:health:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "57", 步骤: "Run node --check apps/runtime-worker/index.mjs", 结论: success, 标签: static }
      - { job: static-gates, 序号: "58", 步骤: "Run node --check apps/runtime-observer/index.mjs", 结论: success, 标签: static }
      - { job: static-gates, 序号: "59", 步骤: "Run node --check apps/runtime-observer/targets.mjs", 结论: success, 标签: static }
      - { job: static-gates, 序号: "60", 步骤: "Run node --check apps/output-probe/index.mjs", 结论: success, 标签: static }
      - { job: static-gates, 序号: "61", 步骤: "Run node --check apps/channel-adapter/index.mjs", 结论: success, 标签: static }
      - { job: static-gates, 序号: "62", 步骤: "Run node --check apps/alert-notifier/index.mjs", 结论: success, 标签: static }
      - { job: static-gates, 序号: "63", 步骤: "Run npm run typecheck", 结论: success, 标签: static }
      - { job: static-gates, 序号: "64", 步骤: "Run npm run lint", 结论: success, 标签: static }
      - { job: static-gates, 序号: "65", 步骤: "Run npm run build", 结论: success, 标签: static }
      - { job: static-gates, 序号: "129", 步骤: "Post Set up Node.js", 结论: success }
      - { job: static-gates, 序号: "130", 步骤: "Post Checkout", 结论: success }
      - { job: static-gates, 序号: "131", 步骤: "Complete job", 结论: success }
      - { job: node-unit, 序号: "1", 步骤: "Set up job", 结论: success }
      - { job: node-unit, 序号: "2", 步骤: "Checkout", 结论: success }
      - { job: node-unit, 序号: "3", 步骤: "Set up Node.js", 结论: success }
      - { job: node-unit, 序号: "4", 步骤: "Run npm ci", 结论: success }
      - { job: node-unit, 序号: "5", 步骤: "Run npm run deploy:check:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "6", 步骤: "Run npm run deploy:manifest:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "7", 步骤: "Run npm run deploy:images:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "8", 步骤: "Run npm run release:evidence:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "9", 步骤: "Run bash scripts/test-postgres-backup-direct.sh", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "10", 步骤: "Run bash scripts/test-postgres-restore-drill.sh", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "11", 步骤: "Run npm run policy:red-team", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "12", 步骤: "Run npm run runtime:worker:config:test", 结论: success, 标签: static }
      - { job: node-unit, 序号: "13", 步骤: "Run npm run runtime:worker:health:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "14", 步骤: "Run npm run runtime:acceptance:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "15", 步骤: "Run npm run observer:runtime:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "16", 步骤: "Run npm run observer:targets:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "17", 步骤: "Run npm run observer:targets:apply:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "18", 步骤: "Run npm run output-probe:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "19", 步骤: "Run npm run output-probe:config:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "20", 步骤: "Run npm run channel-adapter:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "21", 步骤: "Run npm run alert-notifier:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "22", 步骤: "Run npm run ci:gates:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "23", 步骤: "Run npm run ci:db-fail-closed:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "24", 步骤: "Run npm run ci:evidence:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "25", 步骤: "Run npm run release:workflow:gate:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "26", 步骤: "Run npm run docs:governance:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "51", 步骤: "Post Set up Node.js", 结论: success }
      - { job: node-unit, 序号: "52", 步骤: "Post Checkout", 结论: success }
      - { job: node-unit, 序号: "53", 步骤: "Complete job", 结论: success }
      - { job: postgres-integration, 序号: "1", 步骤: "Set up job", 结论: success }
      - { job: postgres-integration, 序号: "2", 步骤: "Initialize containers", 结论: success }
      - { job: postgres-integration, 序号: "3", 步骤: "Checkout", 结论: success }
      - { job: postgres-integration, 序号: "4", 步骤: "Set up Node.js", 结论: success }
      - { job: postgres-integration, 序号: "5", 步骤: "Run npm ci", 结论: success }
      - { job: postgres-integration, 序号: "6", 步骤: "Run npm run db:migrate", 结论: success, 标签: behavioral }
      - { job: postgres-integration, 序号: "7", 步骤: "Run npm run db:migrate:integrity:test", 结论: success, 标签: behavioral }
      - { job: postgres-integration, 序号: "8", 步骤: "Run npm run service-principals:integration", 结论: success, 标签: behavioral }
      - { job: postgres-integration, 序号: "9", 步骤: "Run npm run db:migrate:lock:test", 结论: success, 标签: behavioral }
      - { job: postgres-integration, 序号: "10", 步骤: "Run npm run db:verify -- --allow-privileged", 结论: success, 标签: behavioral }
      - { job: postgres-integration, 序号: "11", 步骤: "prep: build console for control-plane integration", 结论: success }
      - { job: postgres-integration, 序号: "12", 步骤: "Run npm run control-plane:integration", 结论: failure, 标签: behavioral }
      - { job: postgres-integration, 序号: "22", 步骤: "Post Set up Node.js", 结论: skipped }
      - { job: postgres-integration, 序号: "23", 步骤: "Post Checkout", 结论: success }
      - { job: postgres-integration, 序号: "24", 步骤: "Stop containers", 结论: success }
      - { job: postgres-integration, 序号: "25", 步骤: "Complete job", 结论: success }
      - { job: docker-build, 序号: "1", 步骤: "Set up job", 结论: success }
      - { job: docker-build, 序号: "2", 步骤: "Checkout", 结论: success }
      - { job: docker-build, 序号: "3", 步骤: "Set up Node.js", 结论: success }
      - { job: docker-build, 序号: "4", 步骤: "Run npm ci", 结论: success }
      - { job: docker-build, 序号: "5", 步骤: "prep: free runner disk", 结论: success }
      - { job: docker-build, 序号: "6", 步骤: "Run docker build --file apps/console/Dockerfile --tag shuzhiren-control-plane-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "7", 步骤: "Run docker build --file apps/console/Dockerfile --target migrator --tag shuzhiren-control-plane-migrator-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "8", 步骤: "Run docker build --file apps/runtime-worker/Dockerfile --tag shuzhiren-runtime-worker-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "9", 步骤: "Run docker build --file apps/runtime-observer/Dockerfile --tag shuzhiren-runtime-observer-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "10", 步骤: "Run docker build --file apps/output-probe/Dockerfile --tag shuzhiren-output-probe-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "11", 步骤: "Run docker build --file apps/channel-adapter/Dockerfile --tag shuzhiren-channel-adapter-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "12", 步骤: "Run docker build --file apps/alert-notifier/Dockerfile --tag shuzhiren-alert-notifier-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "13", 步骤: "Run docker build --file runtime/gateway/Dockerfile --tag shuzhiren-runtime-gateway-ci runtime/gateway", 结论: success, 标签: static }
      - { job: docker-build, 序号: "14", 步骤: "Run docker build --load --file runtime/livetalking/Dockerfile --tag shuzhiren/livetalking:ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "15", 步骤: "prep: reclaim disk before CosyVoice build", 结论: success }
      - { job: docker-build, 序号: "16", 步骤: "docker build runtime/cosyvoice (committed Miniforge pin)", 结论: failure, 标签: static }
      - { job: docker-build, 序号: "31", 步骤: "Post Set up Node.js", 结论: skipped }
      - { job: docker-build, 序号: "32", 步骤: "Post Checkout", 结论: success }
      - { job: docker-build, 序号: "33", 步骤: "Complete job", 结论: success }
    skipped 步骤数: "2"
    node20 弃用告警数: "0"
静态门禁覆盖:
  - { 门禁: "ci:coverage:check", 行为测试: [无] }
  - { 门禁: "ci:workflow:check", 行为测试: [无] }
  - { 门禁: "docs:governance:check", 行为测试: [无] }
  - { 门禁: "deploy:check", 行为测试: [无] }
  - { 门禁: "release:workflow:check", 行为测试: [无] }
  - { 门禁: "backup:automation:check", 行为测试: [无] }
  - { 门禁: "control-plane:compose:check", 行为测试: [无] }
  - { 门禁: "runtime:compose:check", 行为测试: [无] }
  - { 门禁: "console:page-auth:check", 行为测试: [无] }
  - { 门禁: "console:security-headers:check", 行为测试: [无] }
  - { 门禁: "console:client-requests:check", 行为测试: [无] }
  - { 门禁: "membership:authz:check", 行为测试: [无] }
  - { 门禁: "membership:scopes:check", 行为测试: [无] }
  - { 门禁: "governance:tenant-scope:check", 行为测试: [无] }
  - { 门禁: "governance:immutability:check", 行为测试: [无] }
  - { 门禁: "program:revisions:check", 行为测试: [无] }
  - { 门禁: "program:runtime-scripts:check", 行为测试: [无] }
  - { 门禁: "runtime:program-transition:check", 行为测试: [无] }
  - { 门禁: "control-room:program-transition:check", 行为测试: [无] }
  - { 门禁: "runtime:program-output:check", 行为测试: [无] }
  - { 门禁: "preflight:check", 行为测试: [无] }
  - { 门禁: "lifecycle:authz:check", 行为测试: [无] }
  - { 门禁: "command:confirmation:check", 行为测试: [无] }
  - { 门禁: "service-ingest:auth:check", 行为测试: [无] }
  - { 门禁: "service-principals:check", 行为测试: [无] }
  - { 门禁: "start:ack:check", 行为测试: [无] }
  - { 门禁: "runtime:watchdog:check", 行为测试: [无] }
  - { 门禁: "runtime:outbox:check", 行为测试: [无] }
  - { 门禁: "runtime:telemetry-alerts:check", 行为测试: [无] }
  - { 门禁: "entitlement:check", 行为测试: [无] }
  - { 门禁: "runtime:media:check", 行为测试: [无] }
  - { 门禁: "runtime:voice:check", 行为测试: [无] }
  - { 门禁: "runtime:journal:check", 行为测试: [无] }
  - { 门禁: "runtime:preview:check", 行为测试: [无] }
  - { 门禁: "media:evidence:check", 行为测试: [无] }
  - { 门禁: "recording:evidence:check", 行为测试: [无] }
  - { 门禁: "runtime:images:check", 行为测试: [无] }
  - { 门禁: "output-probe:response:check", 行为测试: [无] }
  - { 门禁: "channel:verification:check", 行为测试: [无] }
  - { 门禁: "settlement:reconciliation:check", 行为测试: [无] }
  - { 门禁: "alert-notifier:health:check", 行为测试: [无] }
说明: >-
  依据由 npm run ci:evidence:collect -- --repo pengwenyi4061126-lgtm/shuzhiren --run-id 41978941738 于 2026-11-05 在本机生成
  （设置了用户授权读取 CI 的 GITHUB_TOKEN，退出码 0；token 只放在子进程环境中，没有打印或写入文件），改为本文件的流式写法，
  内容不变；runner 镜像取自各 job 日志 Set up job 步骤的 Runner Image 组。标签由 scripts/lib/verification-log.mjs 的
  createCheckResolver 按当前的 LOCAL_CHECKS、CI_ONLY_STEPS 与 ci.yml 求出后补入，准备步骤（Set up job、Initialize containers、
  Checkout、Set up Node.js、Set up Python、npm ci、prep: 开头的步骤、Post、Stop containers、Complete job）不写标签。
  python-gateway 第 5 步 pip install -r runtime/gateway/requirements.txt 没有写标签：44857e1 把这一步改为按哈希锁文件安装，
  当前的 CI_ONLY_STEPS 中已经没有原命令，门禁无法为它核对标签。
  运行由推送 master 触发，2026-11-05T06:13:06Z 创建，06:23:05Z 结束。job 结论与 job id：python-gateway success（127084279429）、
  compose-render success（127084279600）、static-gates success（127084279654）、node-unit success（127084279685）、
  postgres-integration failure（127084279789）、docker-build failure（127084279924）。2 个 skipped 步骤是 postgres-integration 与
  docker-build 的 Post Set up Node.js。本运行覆盖 1657254 之后的 f35eb30、416df39、cf05466、2e010f0、39ebbc0、1f1846f、9be485d、
  50a36ff、4a94e72、734ee8e。
  (1) postgres-integration 第 10 步 db:verify 为 success：它在 #492、#493 中报 C1 的错误，本运行中执行完毕，包括其中的结算批次、行与差异的
  不可变检查（C2）；这是 C1 修复后通过的证据（AUDIT_REGISTER.md 的 C1）。第 12 步 control-plane:integration 失败，job 日志中的错误为
  duplicate key value violates unique constraint "model_releases_tenant_id_component_name_version_key"（code 23505）：测试的 seedRun
  每次调用都用同一租户与同一模型发布版本，由测试修复 779bcdb 改正，不是产品缺陷，不登记。
  (2) docker-build 第 16 步 CosyVoice 镜像构建失败，job 日志中的错误与 #493 相同（openai-whisper 构建时 ModuleNotFoundError: No module
  named 'pkg_resources'）：N8。本运行的提交 734ee8e 不含 N8 的修复 2672612，作为 N8 修复前失败的证据。
  (3) node-unit 中 alert-notifier:test、output-probe:test、output-probe:config:test、channel-adapter:test、release:workflow:gate:test
  为 success，它们是 C3、N3、N4、H5、H6、H1 与 734ee8e（渠道适配器 /v1/replies）修复提交新增或修改的回归测试，见 AUDIT_REGISTER.md。
  判定为未验证：运行结论为 failure，且有步骤的结论不是 success。
```

## V-20261105-13 CI #495（run 41986504433，提交 2672612）为 failure：CosyVoice 镜像构建通过（N8 已修复），control-plane:integration 因测试 42703 失败

```yaml
编号: V-20261105-13
类型: 结论
结论: 第 495 次 CI 运行（run 41986504433，提交 2672612）的结论为 failure；static-gates、node-unit、python-gateway、compose-render、docker-build 为 success，docker-build 第 16 步 CosyVoice 镜像构建为 success；postgres-integration 第 12 步 control-plane:integration 失败；共 1 个步骤为 skipped
判定: 未验证
依据来源:
  - 类别: CI 或 Linux 运行
    平台: GitHub Actions
    run id: "41986504433"
    提交: 26726126774bde14bedd9f0eee5778b6456cca2b
    运行结论: failure
    runner 镜像:
      - { job: python-gateway, 镜像: ubuntu-24.04, 版本: "20261025.353.1" }
      - { job: postgres-integration, 镜像: ubuntu-24.04, 版本: "20261025.353.1" }
      - { job: node-unit, 镜像: ubuntu-24.04, 版本: "20261101.360.1" }
      - { job: compose-render, 镜像: ubuntu-24.04, 版本: "20261025.353.1" }
      - { job: docker-build, 镜像: ubuntu-24.04, 版本: "20261025.353.1" }
      - { job: static-gates, 镜像: ubuntu-24.04, 版本: "20261101.360.1" }
    步骤:
      - { job: python-gateway, 序号: "1", 步骤: "Set up job", 结论: success }
      - { job: python-gateway, 序号: "2", 步骤: "Checkout", 结论: success }
      - { job: python-gateway, 序号: "3", 步骤: "Set up Python", 结论: success }
      - { job: python-gateway, 序号: "4", 步骤: "Set up Node.js", 结论: success }
      - { job: python-gateway, 序号: "5", 步骤: "Run python3 -m pip install --disable-pip-version-check --no-cache-dir -r runtime/gateway/requirements.txt", 结论: success }
      - { job: python-gateway, 序号: "6", 步骤: "Run npm run runtime:gateway:config:test", 结论: success, 标签: behavioral }
      - { job: python-gateway, 序号: "7", 步骤: "Run npm run runtime:gateway:errors:test", 结论: success, 标签: behavioral }
      - { job: python-gateway, 序号: "8", 步骤: "Run python3 -m py_compile runtime/gateway/*.py scripts/test-runtime-gateway-config.py", 结论: success, 标签: static }
      - { job: python-gateway, 序号: "9", 步骤: "Run python3 scripts/test-runtime-gateway-audio.py", 结论: success, 标签: behavioral }
      - { job: python-gateway, 序号: "10", 步骤: "Run python3 scripts/test-runtime-gateway-concurrency.py", 结论: success, 标签: behavioral }
      - { job: python-gateway, 序号: "11", 步骤: "Run python3 scripts/test-runtime-gateway-state-backup.py", 结论: success, 标签: behavioral }
      - { job: python-gateway, 序号: "12", 步骤: "Run python3 scripts/test-runtime-gateway-state-restore-drill.py", 结论: success, 标签: behavioral }
      - { job: python-gateway, 序号: "22", 步骤: "Post Set up Node.js", 结论: success }
      - { job: python-gateway, 序号: "23", 步骤: "Post Set up Python", 结论: success }
      - { job: python-gateway, 序号: "24", 步骤: "Post Checkout", 结论: success }
      - { job: python-gateway, 序号: "25", 步骤: "Complete job", 结论: success }
      - { job: postgres-integration, 序号: "1", 步骤: "Set up job", 结论: success }
      - { job: postgres-integration, 序号: "2", 步骤: "Initialize containers", 结论: success }
      - { job: postgres-integration, 序号: "3", 步骤: "Checkout", 结论: success }
      - { job: postgres-integration, 序号: "4", 步骤: "Set up Node.js", 结论: success }
      - { job: postgres-integration, 序号: "5", 步骤: "Run npm ci", 结论: success }
      - { job: postgres-integration, 序号: "6", 步骤: "Run npm run db:migrate", 结论: success, 标签: behavioral }
      - { job: postgres-integration, 序号: "7", 步骤: "Run npm run db:migrate:integrity:test", 结论: success, 标签: behavioral }
      - { job: postgres-integration, 序号: "8", 步骤: "Run npm run service-principals:integration", 结论: success, 标签: behavioral }
      - { job: postgres-integration, 序号: "9", 步骤: "Run npm run db:migrate:lock:test", 结论: success, 标签: behavioral }
      - { job: postgres-integration, 序号: "10", 步骤: "Run npm run db:verify -- --allow-privileged", 结论: success, 标签: behavioral }
      - { job: postgres-integration, 序号: "11", 步骤: "prep: build console for control-plane integration", 结论: success }
      - { job: postgres-integration, 序号: "12", 步骤: "Run npm run control-plane:integration", 结论: failure, 标签: behavioral }
      - { job: postgres-integration, 序号: "22", 步骤: "Post Set up Node.js", 结论: skipped }
      - { job: postgres-integration, 序号: "23", 步骤: "Post Checkout", 结论: success }
      - { job: postgres-integration, 序号: "24", 步骤: "Stop containers", 结论: success }
      - { job: postgres-integration, 序号: "25", 步骤: "Complete job", 结论: success }
      - { job: node-unit, 序号: "1", 步骤: "Set up job", 结论: success }
      - { job: node-unit, 序号: "2", 步骤: "Checkout", 结论: success }
      - { job: node-unit, 序号: "3", 步骤: "Set up Node.js", 结论: success }
      - { job: node-unit, 序号: "4", 步骤: "Run npm ci", 结论: success }
      - { job: node-unit, 序号: "5", 步骤: "Run npm run deploy:check:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "6", 步骤: "Run npm run deploy:manifest:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "7", 步骤: "Run npm run deploy:images:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "8", 步骤: "Run npm run release:evidence:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "9", 步骤: "Run bash scripts/test-postgres-backup-direct.sh", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "10", 步骤: "Run bash scripts/test-postgres-restore-drill.sh", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "11", 步骤: "Run npm run policy:red-team", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "12", 步骤: "Run npm run runtime:worker:config:test", 结论: success, 标签: static }
      - { job: node-unit, 序号: "13", 步骤: "Run npm run runtime:worker:health:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "14", 步骤: "Run npm run runtime:acceptance:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "15", 步骤: "Run npm run observer:runtime:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "16", 步骤: "Run npm run observer:targets:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "17", 步骤: "Run npm run observer:targets:apply:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "18", 步骤: "Run npm run output-probe:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "19", 步骤: "Run npm run output-probe:config:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "20", 步骤: "Run npm run channel-adapter:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "21", 步骤: "Run npm run alert-notifier:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "22", 步骤: "Run npm run ci:gates:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "23", 步骤: "Run npm run ci:db-fail-closed:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "24", 步骤: "Run npm run ci:evidence:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "25", 步骤: "Run npm run release:workflow:gate:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "26", 步骤: "Run npm run docs:governance:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "51", 步骤: "Post Set up Node.js", 结论: success }
      - { job: node-unit, 序号: "52", 步骤: "Post Checkout", 结论: success }
      - { job: node-unit, 序号: "53", 步骤: "Complete job", 结论: success }
      - { job: compose-render, 序号: "1", 步骤: "Set up job", 结论: success }
      - { job: compose-render, 序号: "2", 步骤: "Checkout", 结论: success }
      - { job: compose-render, 序号: "3", 步骤: "Set up Node.js", 结论: success }
      - { job: compose-render, 序号: "4", 步骤: "Run npm ci", 结论: success }
      - { job: compose-render, 序号: "5", 步骤: "Run docker compose --env-file config/control-plane-compose.example.env -f infra/compose/docker-compose.control-plane.yml config", 结论: success, 标签: static }
      - { job: compose-render, 序号: "6", 步骤: "Run docker compose --env-file config/runtime.example.env --env-file config/runtime-gateway.example.env --env-file config/channel-adapter.example.env --env-file config/alert-notifier.example.env --profile output-probe --profile channel-adapter --profile alert-notifier --profile cosyvoice -f infra/compose/docker-compose.runtime.yml config", 结论: success, 标签: static }
      - { job: compose-render, 序号: "11", 步骤: "Post Set up Node.js", 结论: success }
      - { job: compose-render, 序号: "12", 步骤: "Post Checkout", 结论: success }
      - { job: compose-render, 序号: "13", 步骤: "Complete job", 结论: success }
      - { job: docker-build, 序号: "1", 步骤: "Set up job", 结论: success }
      - { job: docker-build, 序号: "2", 步骤: "Checkout", 结论: success }
      - { job: docker-build, 序号: "3", 步骤: "Set up Node.js", 结论: success }
      - { job: docker-build, 序号: "4", 步骤: "Run npm ci", 结论: success }
      - { job: docker-build, 序号: "5", 步骤: "prep: free runner disk", 结论: success }
      - { job: docker-build, 序号: "6", 步骤: "Run docker build --file apps/console/Dockerfile --tag shuzhiren-control-plane-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "7", 步骤: "Run docker build --file apps/console/Dockerfile --target migrator --tag shuzhiren-control-plane-migrator-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "8", 步骤: "Run docker build --file apps/runtime-worker/Dockerfile --tag shuzhiren-runtime-worker-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "9", 步骤: "Run docker build --file apps/runtime-observer/Dockerfile --tag shuzhiren-runtime-observer-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "10", 步骤: "Run docker build --file apps/output-probe/Dockerfile --tag shuzhiren-output-probe-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "11", 步骤: "Run docker build --file apps/channel-adapter/Dockerfile --tag shuzhiren-channel-adapter-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "12", 步骤: "Run docker build --file apps/alert-notifier/Dockerfile --tag shuzhiren-alert-notifier-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "13", 步骤: "Run docker build --file runtime/gateway/Dockerfile --tag shuzhiren-runtime-gateway-ci runtime/gateway", 结论: success, 标签: static }
      - { job: docker-build, 序号: "14", 步骤: "Run docker build --load --file runtime/livetalking/Dockerfile --tag shuzhiren/livetalking:ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "15", 步骤: "prep: reclaim disk before CosyVoice build", 结论: success }
      - { job: docker-build, 序号: "16", 步骤: "docker build runtime/cosyvoice (committed Miniforge pin)", 结论: success, 标签: static }
      - { job: docker-build, 序号: "31", 步骤: "Post Set up Node.js", 结论: success }
      - { job: docker-build, 序号: "32", 步骤: "Post Checkout", 结论: success }
      - { job: docker-build, 序号: "33", 步骤: "Complete job", 结论: success }
      - { job: static-gates, 序号: "1", 步骤: "Set up job", 结论: success }
      - { job: static-gates, 序号: "2", 步骤: "Checkout", 结论: success }
      - { job: static-gates, 序号: "3", 步骤: "Set up Node.js", 结论: success }
      - { job: static-gates, 序号: "4", 步骤: "Run npm ci", 结论: success }
      - { job: static-gates, 序号: "5", 步骤: "Run npm run ci:coverage:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "6", 步骤: "Run npm run ci:workflow:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "7", 步骤: "Run npm run ci:action-pins:verify", 结论: success, 标签: static }
      - { job: static-gates, 序号: "8", 步骤: "Run npm run docs:governance:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "9", 步骤: "Run bash -n scripts/check-runtime-host.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "10", 步骤: "Run bash -n scripts/backup-postgres.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "11", 步骤: "Run bash -n scripts/test-postgres-backup-direct.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "12", 步骤: "Run bash -n scripts/restore-postgres-drill.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "13", 步骤: "Run bash -n scripts/test-postgres-restore-drill.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "14", 步骤: "Run bash -n scripts/backup-runtime-gateway-state.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "15", 步骤: "Run bash -n scripts/restore-runtime-gateway-state-drill.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "16", 步骤: "Run bash -n scripts/verify-postgres-backup.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "17", 步骤: "Run bash -n scripts/verify-runtime-gateway-state-backup.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "18", 步骤: "Run bash scripts/check-runtime-host.sh --help", 结论: success, 标签: static }
      - { job: static-gates, 序号: "19", 步骤: "Run npm run deploy:check -- --allow-placeholders", 结论: success, 标签: static }
      - { job: static-gates, 序号: "20", 步骤: "Run npm run release:workflow:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "21", 步骤: "Run npm run backup:automation:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "22", 步骤: "Run npm run control-plane:compose:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "23", 步骤: "Run npm run runtime:compose:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "24", 步骤: "Run npm run console:page-auth:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "25", 步骤: "Run npm run console:security-headers:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "26", 步骤: "Run npm run console:client-requests:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "27", 步骤: "Run npm run membership:authz:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "28", 步骤: "Run npm run membership:scopes:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "29", 步骤: "Run npm run governance:tenant-scope:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "30", 步骤: "Run npm run governance:immutability:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "31", 步骤: "Run npm run program:revisions:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "32", 步骤: "Run npm run program:runtime-scripts:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "33", 步骤: "Run npm run runtime:program-transition:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "34", 步骤: "Run npm run control-room:program-transition:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "35", 步骤: "Run npm run runtime:program-output:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "36", 步骤: "Run npm run preflight:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "37", 步骤: "Run npm run lifecycle:authz:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "38", 步骤: "Run npm run command:confirmation:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "39", 步骤: "Run npm run service-ingest:auth:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "40", 步骤: "Run npm run service-principals:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "41", 步骤: "Run npm run start:ack:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "42", 步骤: "Run npm run runtime:watchdog:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "43", 步骤: "Run npm run runtime:outbox:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "44", 步骤: "Run npm run runtime:telemetry-alerts:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "45", 步骤: "Run npm run entitlement:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "46", 步骤: "Run npm run runtime:media:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "47", 步骤: "Run npm run runtime:voice:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "48", 步骤: "Run npm run runtime:journal:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "49", 步骤: "Run npm run runtime:preview:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "50", 步骤: "Run npm run media:evidence:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "51", 步骤: "Run npm run recording:evidence:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "52", 步骤: "Run npm run runtime:images:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "53", 步骤: "Run npm run output-probe:response:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "54", 步骤: "Run npm run channel:verification:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "55", 步骤: "Run npm run settlement:reconciliation:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "56", 步骤: "Run npm run alert-notifier:health:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "57", 步骤: "Run node --check apps/runtime-worker/index.mjs", 结论: success, 标签: static }
      - { job: static-gates, 序号: "58", 步骤: "Run node --check apps/runtime-observer/index.mjs", 结论: success, 标签: static }
      - { job: static-gates, 序号: "59", 步骤: "Run node --check apps/runtime-observer/targets.mjs", 结论: success, 标签: static }
      - { job: static-gates, 序号: "60", 步骤: "Run node --check apps/output-probe/index.mjs", 结论: success, 标签: static }
      - { job: static-gates, 序号: "61", 步骤: "Run node --check apps/channel-adapter/index.mjs", 结论: success, 标签: static }
      - { job: static-gates, 序号: "62", 步骤: "Run node --check apps/alert-notifier/index.mjs", 结论: success, 标签: static }
      - { job: static-gates, 序号: "63", 步骤: "Run npm run typecheck", 结论: success, 标签: static }
      - { job: static-gates, 序号: "64", 步骤: "Run npm run lint", 结论: success, 标签: static }
      - { job: static-gates, 序号: "65", 步骤: "Run npm run build", 结论: success, 标签: static }
      - { job: static-gates, 序号: "129", 步骤: "Post Set up Node.js", 结论: success }
      - { job: static-gates, 序号: "130", 步骤: "Post Checkout", 结论: success }
      - { job: static-gates, 序号: "131", 步骤: "Complete job", 结论: success }
    skipped 步骤数: "1"
    node20 弃用告警数: "0"
静态门禁覆盖:
  - { 门禁: "ci:coverage:check", 行为测试: [无] }
  - { 门禁: "ci:workflow:check", 行为测试: [无] }
  - { 门禁: "docs:governance:check", 行为测试: [无] }
  - { 门禁: "deploy:check", 行为测试: [无] }
  - { 门禁: "release:workflow:check", 行为测试: [无] }
  - { 门禁: "backup:automation:check", 行为测试: [无] }
  - { 门禁: "control-plane:compose:check", 行为测试: [无] }
  - { 门禁: "runtime:compose:check", 行为测试: [无] }
  - { 门禁: "console:page-auth:check", 行为测试: [无] }
  - { 门禁: "console:security-headers:check", 行为测试: [无] }
  - { 门禁: "console:client-requests:check", 行为测试: [无] }
  - { 门禁: "membership:authz:check", 行为测试: [无] }
  - { 门禁: "membership:scopes:check", 行为测试: [无] }
  - { 门禁: "governance:tenant-scope:check", 行为测试: [无] }
  - { 门禁: "governance:immutability:check", 行为测试: [无] }
  - { 门禁: "program:revisions:check", 行为测试: [无] }
  - { 门禁: "program:runtime-scripts:check", 行为测试: [无] }
  - { 门禁: "runtime:program-transition:check", 行为测试: [无] }
  - { 门禁: "control-room:program-transition:check", 行为测试: [无] }
  - { 门禁: "runtime:program-output:check", 行为测试: [无] }
  - { 门禁: "preflight:check", 行为测试: [无] }
  - { 门禁: "lifecycle:authz:check", 行为测试: [无] }
  - { 门禁: "command:confirmation:check", 行为测试: [无] }
  - { 门禁: "service-ingest:auth:check", 行为测试: [无] }
  - { 门禁: "service-principals:check", 行为测试: [无] }
  - { 门禁: "start:ack:check", 行为测试: [无] }
  - { 门禁: "runtime:watchdog:check", 行为测试: [无] }
  - { 门禁: "runtime:outbox:check", 行为测试: [无] }
  - { 门禁: "runtime:telemetry-alerts:check", 行为测试: [无] }
  - { 门禁: "entitlement:check", 行为测试: [无] }
  - { 门禁: "runtime:media:check", 行为测试: [无] }
  - { 门禁: "runtime:voice:check", 行为测试: [无] }
  - { 门禁: "runtime:journal:check", 行为测试: [无] }
  - { 门禁: "runtime:preview:check", 行为测试: [无] }
  - { 门禁: "media:evidence:check", 行为测试: [无] }
  - { 门禁: "recording:evidence:check", 行为测试: [无] }
  - { 门禁: "runtime:images:check", 行为测试: [无] }
  - { 门禁: "output-probe:response:check", 行为测试: [无] }
  - { 门禁: "channel:verification:check", 行为测试: [无] }
  - { 门禁: "settlement:reconciliation:check", 行为测试: [无] }
  - { 门禁: "alert-notifier:health:check", 行为测试: [无] }
说明: >-
  依据由 npm run ci:evidence:collect -- --repo pengwenyi4061126-lgtm/shuzhiren --run-id 41986504433 于 2026-11-05 在本机生成
  （设置了用户授权读取 CI 的 GITHUB_TOKEN，退出码 0；token 只放在子进程环境中，没有打印或写入文件），改为本文件的流式写法，
  内容不变；runner 镜像取自各 job 日志 Set up job 步骤的 Runner Image 组。标签由 scripts/lib/verification-log.mjs 的
  createCheckResolver 按当前的 LOCAL_CHECKS、CI_ONLY_STEPS 与 ci.yml 求出后补入，准备步骤（Set up job、Initialize containers、
  Checkout、Set up Node.js、Set up Python、npm ci、prep: 开头的步骤、Post、Stop containers、Complete job）不写标签。
  python-gateway 第 5 步 pip install -r runtime/gateway/requirements.txt 没有写标签：44857e1 把这一步改为按哈希锁文件安装，
  当前的 CI_ONLY_STEPS 中已经没有原命令，门禁无法为它核对标签。
  运行由推送 master 触发，2026-11-05T07:20:12Z 创建，07:36:35Z 结束。job 结论与 job id：python-gateway success（127108377382）、
  postgres-integration failure（127108377739）、node-unit success（127108377741）、compose-render success（127108377791）、
  docker-build success（127108377802）、static-gates success（127108377932）。唯一的 skipped 步骤是 postgres-integration 的
  Post Set up Node.js。本运行覆盖 779bcdb 与 2672612。
  (1) docker-build 第 16 步 docker build runtime/cosyvoice (committed Miniforge pin) 为 success：N8 修复后通过的证据（AUDIT_REGISTER.md 的 N8）。
  (2) postgres-integration 第 12 步 control-plane:integration 失败，job 日志中的错误为 column "tenant_id" does not exist（code 42703）：
  seedProgramTransitionRun 在 users 表上按 tenant_id 查找审批人，由测试修复 4d9bfd5 改为经 memberships 查找，不是产品缺陷，不登记。
  779bcdb 修复的 23505 没有再出现。判定为未验证：运行结论为 failure，且有步骤的结论不是 success。
```

## V-20261105-14 CI #496（run 41987218022，提交 4d9bfd5）为 failure：control-plane:integration 因测试以超级用户连接绕过 RLS 失败

```yaml
编号: V-20261105-14
类型: 结论
结论: 第 496 次 CI 运行（run 41987218022，提交 4d9bfd5）的结论为 failure；五个 job 为 success；postgres-integration 第 12 步 control-plane:integration 失败；共 1 个步骤为 skipped
判定: 未验证
依据来源:
  - 类别: CI 或 Linux 运行
    平台: GitHub Actions
    run id: "41987218022"
    提交: 4d9bfd52957ab918af73f8a1ede44e5c994ce670
    运行结论: failure
    runner 镜像:
      - { job: compose-render, 镜像: ubuntu-24.04, 版本: "20261025.353.1" }
      - { job: python-gateway, 镜像: ubuntu-24.04, 版本: "20261025.353.1" }
      - { job: static-gates, 镜像: ubuntu-24.04, 版本: "20261101.360.1" }
      - { job: docker-build, 镜像: ubuntu-24.04, 版本: "20261101.360.1" }
      - { job: postgres-integration, 镜像: ubuntu-24.04, 版本: "20261025.353.1" }
      - { job: node-unit, 镜像: ubuntu-24.04, 版本: "20261101.360.1" }
    步骤:
      - { job: compose-render, 序号: "1", 步骤: "Set up job", 结论: success }
      - { job: compose-render, 序号: "2", 步骤: "Checkout", 结论: success }
      - { job: compose-render, 序号: "3", 步骤: "Set up Node.js", 结论: success }
      - { job: compose-render, 序号: "4", 步骤: "Run npm ci", 结论: success }
      - { job: compose-render, 序号: "5", 步骤: "Run docker compose --env-file config/control-plane-compose.example.env -f infra/compose/docker-compose.control-plane.yml config", 结论: success, 标签: static }
      - { job: compose-render, 序号: "6", 步骤: "Run docker compose --env-file config/runtime.example.env --env-file config/runtime-gateway.example.env --env-file config/channel-adapter.example.env --env-file config/alert-notifier.example.env --profile output-probe --profile channel-adapter --profile alert-notifier --profile cosyvoice -f infra/compose/docker-compose.runtime.yml config", 结论: success, 标签: static }
      - { job: compose-render, 序号: "11", 步骤: "Post Set up Node.js", 结论: success }
      - { job: compose-render, 序号: "12", 步骤: "Post Checkout", 结论: success }
      - { job: compose-render, 序号: "13", 步骤: "Complete job", 结论: success }
      - { job: python-gateway, 序号: "1", 步骤: "Set up job", 结论: success }
      - { job: python-gateway, 序号: "2", 步骤: "Checkout", 结论: success }
      - { job: python-gateway, 序号: "3", 步骤: "Set up Python", 结论: success }
      - { job: python-gateway, 序号: "4", 步骤: "Set up Node.js", 结论: success }
      - { job: python-gateway, 序号: "5", 步骤: "Run python3 -m pip install --disable-pip-version-check --no-cache-dir -r runtime/gateway/requirements.txt", 结论: success }
      - { job: python-gateway, 序号: "6", 步骤: "Run npm run runtime:gateway:config:test", 结论: success, 标签: behavioral }
      - { job: python-gateway, 序号: "7", 步骤: "Run npm run runtime:gateway:errors:test", 结论: success, 标签: behavioral }
      - { job: python-gateway, 序号: "8", 步骤: "Run python3 -m py_compile runtime/gateway/*.py scripts/test-runtime-gateway-config.py", 结论: success, 标签: static }
      - { job: python-gateway, 序号: "9", 步骤: "Run python3 scripts/test-runtime-gateway-audio.py", 结论: success, 标签: behavioral }
      - { job: python-gateway, 序号: "10", 步骤: "Run python3 scripts/test-runtime-gateway-concurrency.py", 结论: success, 标签: behavioral }
      - { job: python-gateway, 序号: "11", 步骤: "Run python3 scripts/test-runtime-gateway-state-backup.py", 结论: success, 标签: behavioral }
      - { job: python-gateway, 序号: "12", 步骤: "Run python3 scripts/test-runtime-gateway-state-restore-drill.py", 结论: success, 标签: behavioral }
      - { job: python-gateway, 序号: "22", 步骤: "Post Set up Node.js", 结论: success }
      - { job: python-gateway, 序号: "23", 步骤: "Post Set up Python", 结论: success }
      - { job: python-gateway, 序号: "24", 步骤: "Post Checkout", 结论: success }
      - { job: python-gateway, 序号: "25", 步骤: "Complete job", 结论: success }
      - { job: static-gates, 序号: "1", 步骤: "Set up job", 结论: success }
      - { job: static-gates, 序号: "2", 步骤: "Checkout", 结论: success }
      - { job: static-gates, 序号: "3", 步骤: "Set up Node.js", 结论: success }
      - { job: static-gates, 序号: "4", 步骤: "Run npm ci", 结论: success }
      - { job: static-gates, 序号: "5", 步骤: "Run npm run ci:coverage:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "6", 步骤: "Run npm run ci:workflow:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "7", 步骤: "Run npm run ci:action-pins:verify", 结论: success, 标签: static }
      - { job: static-gates, 序号: "8", 步骤: "Run npm run docs:governance:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "9", 步骤: "Run bash -n scripts/check-runtime-host.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "10", 步骤: "Run bash -n scripts/backup-postgres.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "11", 步骤: "Run bash -n scripts/test-postgres-backup-direct.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "12", 步骤: "Run bash -n scripts/restore-postgres-drill.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "13", 步骤: "Run bash -n scripts/test-postgres-restore-drill.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "14", 步骤: "Run bash -n scripts/backup-runtime-gateway-state.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "15", 步骤: "Run bash -n scripts/restore-runtime-gateway-state-drill.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "16", 步骤: "Run bash -n scripts/verify-postgres-backup.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "17", 步骤: "Run bash -n scripts/verify-runtime-gateway-state-backup.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "18", 步骤: "Run bash scripts/check-runtime-host.sh --help", 结论: success, 标签: static }
      - { job: static-gates, 序号: "19", 步骤: "Run npm run deploy:check -- --allow-placeholders", 结论: success, 标签: static }
      - { job: static-gates, 序号: "20", 步骤: "Run npm run release:workflow:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "21", 步骤: "Run npm run backup:automation:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "22", 步骤: "Run npm run control-plane:compose:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "23", 步骤: "Run npm run runtime:compose:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "24", 步骤: "Run npm run console:page-auth:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "25", 步骤: "Run npm run console:security-headers:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "26", 步骤: "Run npm run console:client-requests:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "27", 步骤: "Run npm run membership:authz:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "28", 步骤: "Run npm run membership:scopes:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "29", 步骤: "Run npm run governance:tenant-scope:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "30", 步骤: "Run npm run governance:immutability:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "31", 步骤: "Run npm run program:revisions:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "32", 步骤: "Run npm run program:runtime-scripts:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "33", 步骤: "Run npm run runtime:program-transition:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "34", 步骤: "Run npm run control-room:program-transition:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "35", 步骤: "Run npm run runtime:program-output:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "36", 步骤: "Run npm run preflight:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "37", 步骤: "Run npm run lifecycle:authz:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "38", 步骤: "Run npm run command:confirmation:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "39", 步骤: "Run npm run service-ingest:auth:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "40", 步骤: "Run npm run service-principals:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "41", 步骤: "Run npm run start:ack:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "42", 步骤: "Run npm run runtime:watchdog:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "43", 步骤: "Run npm run runtime:outbox:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "44", 步骤: "Run npm run runtime:telemetry-alerts:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "45", 步骤: "Run npm run entitlement:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "46", 步骤: "Run npm run runtime:media:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "47", 步骤: "Run npm run runtime:voice:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "48", 步骤: "Run npm run runtime:journal:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "49", 步骤: "Run npm run runtime:preview:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "50", 步骤: "Run npm run media:evidence:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "51", 步骤: "Run npm run recording:evidence:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "52", 步骤: "Run npm run runtime:images:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "53", 步骤: "Run npm run output-probe:response:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "54", 步骤: "Run npm run channel:verification:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "55", 步骤: "Run npm run settlement:reconciliation:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "56", 步骤: "Run npm run alert-notifier:health:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "57", 步骤: "Run node --check apps/runtime-worker/index.mjs", 结论: success, 标签: static }
      - { job: static-gates, 序号: "58", 步骤: "Run node --check apps/runtime-observer/index.mjs", 结论: success, 标签: static }
      - { job: static-gates, 序号: "59", 步骤: "Run node --check apps/runtime-observer/targets.mjs", 结论: success, 标签: static }
      - { job: static-gates, 序号: "60", 步骤: "Run node --check apps/output-probe/index.mjs", 结论: success, 标签: static }
      - { job: static-gates, 序号: "61", 步骤: "Run node --check apps/channel-adapter/index.mjs", 结论: success, 标签: static }
      - { job: static-gates, 序号: "62", 步骤: "Run node --check apps/alert-notifier/index.mjs", 结论: success, 标签: static }
      - { job: static-gates, 序号: "63", 步骤: "Run npm run typecheck", 结论: success, 标签: static }
      - { job: static-gates, 序号: "64", 步骤: "Run npm run lint", 结论: success, 标签: static }
      - { job: static-gates, 序号: "65", 步骤: "Run npm run build", 结论: success, 标签: static }
      - { job: static-gates, 序号: "129", 步骤: "Post Set up Node.js", 结论: success }
      - { job: static-gates, 序号: "130", 步骤: "Post Checkout", 结论: success }
      - { job: static-gates, 序号: "131", 步骤: "Complete job", 结论: success }
      - { job: docker-build, 序号: "1", 步骤: "Set up job", 结论: success }
      - { job: docker-build, 序号: "2", 步骤: "Checkout", 结论: success }
      - { job: docker-build, 序号: "3", 步骤: "Set up Node.js", 结论: success }
      - { job: docker-build, 序号: "4", 步骤: "Run npm ci", 结论: success }
      - { job: docker-build, 序号: "5", 步骤: "prep: free runner disk", 结论: success }
      - { job: docker-build, 序号: "6", 步骤: "Run docker build --file apps/console/Dockerfile --tag shuzhiren-control-plane-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "7", 步骤: "Run docker build --file apps/console/Dockerfile --target migrator --tag shuzhiren-control-plane-migrator-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "8", 步骤: "Run docker build --file apps/runtime-worker/Dockerfile --tag shuzhiren-runtime-worker-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "9", 步骤: "Run docker build --file apps/runtime-observer/Dockerfile --tag shuzhiren-runtime-observer-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "10", 步骤: "Run docker build --file apps/output-probe/Dockerfile --tag shuzhiren-output-probe-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "11", 步骤: "Run docker build --file apps/channel-adapter/Dockerfile --tag shuzhiren-channel-adapter-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "12", 步骤: "Run docker build --file apps/alert-notifier/Dockerfile --tag shuzhiren-alert-notifier-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "13", 步骤: "Run docker build --file runtime/gateway/Dockerfile --tag shuzhiren-runtime-gateway-ci runtime/gateway", 结论: success, 标签: static }
      - { job: docker-build, 序号: "14", 步骤: "Run docker build --load --file runtime/livetalking/Dockerfile --tag shuzhiren/livetalking:ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "15", 步骤: "prep: reclaim disk before CosyVoice build", 结论: success }
      - { job: docker-build, 序号: "16", 步骤: "docker build runtime/cosyvoice (committed Miniforge pin)", 结论: success, 标签: static }
      - { job: docker-build, 序号: "31", 步骤: "Post Set up Node.js", 结论: success }
      - { job: docker-build, 序号: "32", 步骤: "Post Checkout", 结论: success }
      - { job: docker-build, 序号: "33", 步骤: "Complete job", 结论: success }
      - { job: postgres-integration, 序号: "1", 步骤: "Set up job", 结论: success }
      - { job: postgres-integration, 序号: "2", 步骤: "Initialize containers", 结论: success }
      - { job: postgres-integration, 序号: "3", 步骤: "Checkout", 结论: success }
      - { job: postgres-integration, 序号: "4", 步骤: "Set up Node.js", 结论: success }
      - { job: postgres-integration, 序号: "5", 步骤: "Run npm ci", 结论: success }
      - { job: postgres-integration, 序号: "6", 步骤: "Run npm run db:migrate", 结论: success, 标签: behavioral }
      - { job: postgres-integration, 序号: "7", 步骤: "Run npm run db:migrate:integrity:test", 结论: success, 标签: behavioral }
      - { job: postgres-integration, 序号: "8", 步骤: "Run npm run service-principals:integration", 结论: success, 标签: behavioral }
      - { job: postgres-integration, 序号: "9", 步骤: "Run npm run db:migrate:lock:test", 结论: success, 标签: behavioral }
      - { job: postgres-integration, 序号: "10", 步骤: "Run npm run db:verify -- --allow-privileged", 结论: success, 标签: behavioral }
      - { job: postgres-integration, 序号: "11", 步骤: "prep: build console for control-plane integration", 结论: success }
      - { job: postgres-integration, 序号: "12", 步骤: "Run npm run control-plane:integration", 结论: failure, 标签: behavioral }
      - { job: postgres-integration, 序号: "22", 步骤: "Post Set up Node.js", 结论: skipped }
      - { job: postgres-integration, 序号: "23", 步骤: "Post Checkout", 结论: success }
      - { job: postgres-integration, 序号: "24", 步骤: "Stop containers", 结论: success }
      - { job: postgres-integration, 序号: "25", 步骤: "Complete job", 结论: success }
      - { job: node-unit, 序号: "1", 步骤: "Set up job", 结论: success }
      - { job: node-unit, 序号: "2", 步骤: "Checkout", 结论: success }
      - { job: node-unit, 序号: "3", 步骤: "Set up Node.js", 结论: success }
      - { job: node-unit, 序号: "4", 步骤: "Run npm ci", 结论: success }
      - { job: node-unit, 序号: "5", 步骤: "Run npm run deploy:check:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "6", 步骤: "Run npm run deploy:manifest:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "7", 步骤: "Run npm run deploy:images:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "8", 步骤: "Run npm run release:evidence:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "9", 步骤: "Run bash scripts/test-postgres-backup-direct.sh", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "10", 步骤: "Run bash scripts/test-postgres-restore-drill.sh", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "11", 步骤: "Run npm run policy:red-team", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "12", 步骤: "Run npm run runtime:worker:config:test", 结论: success, 标签: static }
      - { job: node-unit, 序号: "13", 步骤: "Run npm run runtime:worker:health:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "14", 步骤: "Run npm run runtime:acceptance:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "15", 步骤: "Run npm run observer:runtime:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "16", 步骤: "Run npm run observer:targets:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "17", 步骤: "Run npm run observer:targets:apply:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "18", 步骤: "Run npm run output-probe:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "19", 步骤: "Run npm run output-probe:config:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "20", 步骤: "Run npm run channel-adapter:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "21", 步骤: "Run npm run alert-notifier:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "22", 步骤: "Run npm run ci:gates:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "23", 步骤: "Run npm run ci:db-fail-closed:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "24", 步骤: "Run npm run ci:evidence:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "25", 步骤: "Run npm run release:workflow:gate:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "26", 步骤: "Run npm run docs:governance:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "51", 步骤: "Post Set up Node.js", 结论: success }
      - { job: node-unit, 序号: "52", 步骤: "Post Checkout", 结论: success }
      - { job: node-unit, 序号: "53", 步骤: "Complete job", 结论: success }
    skipped 步骤数: "1"
    node20 弃用告警数: "0"
静态门禁覆盖:
  - { 门禁: "ci:coverage:check", 行为测试: [无] }
  - { 门禁: "ci:workflow:check", 行为测试: [无] }
  - { 门禁: "docs:governance:check", 行为测试: [无] }
  - { 门禁: "deploy:check", 行为测试: [无] }
  - { 门禁: "release:workflow:check", 行为测试: [无] }
  - { 门禁: "backup:automation:check", 行为测试: [无] }
  - { 门禁: "control-plane:compose:check", 行为测试: [无] }
  - { 门禁: "runtime:compose:check", 行为测试: [无] }
  - { 门禁: "console:page-auth:check", 行为测试: [无] }
  - { 门禁: "console:security-headers:check", 行为测试: [无] }
  - { 门禁: "console:client-requests:check", 行为测试: [无] }
  - { 门禁: "membership:authz:check", 行为测试: [无] }
  - { 门禁: "membership:scopes:check", 行为测试: [无] }
  - { 门禁: "governance:tenant-scope:check", 行为测试: [无] }
  - { 门禁: "governance:immutability:check", 行为测试: [无] }
  - { 门禁: "program:revisions:check", 行为测试: [无] }
  - { 门禁: "program:runtime-scripts:check", 行为测试: [无] }
  - { 门禁: "runtime:program-transition:check", 行为测试: [无] }
  - { 门禁: "control-room:program-transition:check", 行为测试: [无] }
  - { 门禁: "runtime:program-output:check", 行为测试: [无] }
  - { 门禁: "preflight:check", 行为测试: [无] }
  - { 门禁: "lifecycle:authz:check", 行为测试: [无] }
  - { 门禁: "command:confirmation:check", 行为测试: [无] }
  - { 门禁: "service-ingest:auth:check", 行为测试: [无] }
  - { 门禁: "service-principals:check", 行为测试: [无] }
  - { 门禁: "start:ack:check", 行为测试: [无] }
  - { 门禁: "runtime:watchdog:check", 行为测试: [无] }
  - { 门禁: "runtime:outbox:check", 行为测试: [无] }
  - { 门禁: "runtime:telemetry-alerts:check", 行为测试: [无] }
  - { 门禁: "entitlement:check", 行为测试: [无] }
  - { 门禁: "runtime:media:check", 行为测试: [无] }
  - { 门禁: "runtime:voice:check", 行为测试: [无] }
  - { 门禁: "runtime:journal:check", 行为测试: [无] }
  - { 门禁: "runtime:preview:check", 行为测试: [无] }
  - { 门禁: "media:evidence:check", 行为测试: [无] }
  - { 门禁: "recording:evidence:check", 行为测试: [无] }
  - { 门禁: "runtime:images:check", 行为测试: [无] }
  - { 门禁: "output-probe:response:check", 行为测试: [无] }
  - { 门禁: "channel:verification:check", 行为测试: [无] }
  - { 门禁: "settlement:reconciliation:check", 行为测试: [无] }
  - { 门禁: "alert-notifier:health:check", 行为测试: [无] }
说明: >-
  依据由 npm run ci:evidence:collect -- --repo pengwenyi4061126-lgtm/shuzhiren --run-id 41987218022 于 2026-11-05 在本机生成
  （设置了用户授权读取 CI 的 GITHUB_TOKEN，退出码 0；token 只放在子进程环境中，没有打印或写入文件），改为本文件的流式写法，
  内容不变；runner 镜像取自各 job 日志 Set up job 步骤的 Runner Image 组。标签由 scripts/lib/verification-log.mjs 的
  createCheckResolver 按当前的 LOCAL_CHECKS、CI_ONLY_STEPS 与 ci.yml 求出后补入，准备步骤（Set up job、Initialize containers、
  Checkout、Set up Node.js、Set up Python、npm ci、prep: 开头的步骤、Post、Stop containers、Complete job）不写标签。
  python-gateway 第 5 步 pip install -r runtime/gateway/requirements.txt 没有写标签：44857e1 把这一步改为按哈希锁文件安装，
  当前的 CI_ONLY_STEPS 中已经没有原命令，门禁无法为它核对标签。
  运行由推送 master 触发，2026-11-05T07:26:12Z 创建，07:41:29Z 结束。job 结论与 job id：compose-render success（127110693054）、
  python-gateway success（127110693268）、static-gates success（127110693356）、docker-build success（127110693383）、
  postgres-integration failure（127110693386）、node-unit success（127110693436）。唯一的 skipped 步骤是 postgres-integration 的
  Post Set up Node.js。本运行只覆盖 4d9bfd5。control-plane:integration 的错误为 AssertionError: the membership directory must expose
  seeded tenant members only（actual 5，expected 4）：测试中的控制台与各服务以 postgres 超级用户连接，绕过了 RLS，由测试修复 230e4c7
  改为以 NOSUPERUSER NOBYPASSRLS 的登录角色连接，不是产品缺陷，不登记。判定为未验证：运行结论为 failure，且有步骤的结论不是 success。
```

## V-20261105-15 CI #497（run 41988230415，提交 230e4c7）为 failure：control-plane:integration 中受限操作员读取未分配的 outbox 事件得到 500（M1）

```yaml
编号: V-20261105-15
类型: 结论
结论: 第 497 次 CI 运行（run 41988230415，提交 230e4c7）的结论为 failure；五个 job 为 success；postgres-integration 第 12 步 control-plane:integration 失败，断言为受限操作员读取未分配直播场次的 outbox 事件应得 404、实际得 500（M1）；共 1 个步骤为 skipped
判定: 未验证
依据来源:
  - 类别: CI 或 Linux 运行
    平台: GitHub Actions
    run id: "41988230415"
    提交: 230e4c77d0296f37b4c306dd62ee7c5247840f1c
    运行结论: failure
    runner 镜像:
      - { job: postgres-integration, 镜像: ubuntu-24.04, 版本: "20261025.353.1" }
      - { job: compose-render, 镜像: ubuntu-24.04, 版本: "20261025.353.1" }
      - { job: docker-build, 镜像: ubuntu-24.04, 版本: "20261101.360.1" }
      - { job: static-gates, 镜像: ubuntu-24.04, 版本: "20261025.353.1" }
      - { job: node-unit, 镜像: ubuntu-24.04, 版本: "20261025.353.1" }
      - { job: python-gateway, 镜像: ubuntu-24.04, 版本: "20261025.353.1" }
    步骤:
      - { job: postgres-integration, 序号: "1", 步骤: "Set up job", 结论: success }
      - { job: postgres-integration, 序号: "2", 步骤: "Initialize containers", 结论: success }
      - { job: postgres-integration, 序号: "3", 步骤: "Checkout", 结论: success }
      - { job: postgres-integration, 序号: "4", 步骤: "Set up Node.js", 结论: success }
      - { job: postgres-integration, 序号: "5", 步骤: "Run npm ci", 结论: success }
      - { job: postgres-integration, 序号: "6", 步骤: "Run npm run db:migrate", 结论: success, 标签: behavioral }
      - { job: postgres-integration, 序号: "7", 步骤: "Run npm run db:migrate:integrity:test", 结论: success, 标签: behavioral }
      - { job: postgres-integration, 序号: "8", 步骤: "Run npm run service-principals:integration", 结论: success, 标签: behavioral }
      - { job: postgres-integration, 序号: "9", 步骤: "Run npm run db:migrate:lock:test", 结论: success, 标签: behavioral }
      - { job: postgres-integration, 序号: "10", 步骤: "Run npm run db:verify -- --allow-privileged", 结论: success, 标签: behavioral }
      - { job: postgres-integration, 序号: "11", 步骤: "prep: build console for control-plane integration", 结论: success }
      - { job: postgres-integration, 序号: "12", 步骤: "Run npm run control-plane:integration", 结论: failure, 标签: behavioral }
      - { job: postgres-integration, 序号: "22", 步骤: "Post Set up Node.js", 结论: skipped }
      - { job: postgres-integration, 序号: "23", 步骤: "Post Checkout", 结论: success }
      - { job: postgres-integration, 序号: "24", 步骤: "Stop containers", 结论: success }
      - { job: postgres-integration, 序号: "25", 步骤: "Complete job", 结论: success }
      - { job: compose-render, 序号: "1", 步骤: "Set up job", 结论: success }
      - { job: compose-render, 序号: "2", 步骤: "Checkout", 结论: success }
      - { job: compose-render, 序号: "3", 步骤: "Set up Node.js", 结论: success }
      - { job: compose-render, 序号: "4", 步骤: "Run npm ci", 结论: success }
      - { job: compose-render, 序号: "5", 步骤: "Run docker compose --env-file config/control-plane-compose.example.env -f infra/compose/docker-compose.control-plane.yml config", 结论: success, 标签: static }
      - { job: compose-render, 序号: "6", 步骤: "Run docker compose --env-file config/runtime.example.env --env-file config/runtime-gateway.example.env --env-file config/channel-adapter.example.env --env-file config/alert-notifier.example.env --profile output-probe --profile channel-adapter --profile alert-notifier --profile cosyvoice -f infra/compose/docker-compose.runtime.yml config", 结论: success, 标签: static }
      - { job: compose-render, 序号: "11", 步骤: "Post Set up Node.js", 结论: success }
      - { job: compose-render, 序号: "12", 步骤: "Post Checkout", 结论: success }
      - { job: compose-render, 序号: "13", 步骤: "Complete job", 结论: success }
      - { job: docker-build, 序号: "1", 步骤: "Set up job", 结论: success }
      - { job: docker-build, 序号: "2", 步骤: "Checkout", 结论: success }
      - { job: docker-build, 序号: "3", 步骤: "Set up Node.js", 结论: success }
      - { job: docker-build, 序号: "4", 步骤: "Run npm ci", 结论: success }
      - { job: docker-build, 序号: "5", 步骤: "prep: free runner disk", 结论: success }
      - { job: docker-build, 序号: "6", 步骤: "Run docker build --file apps/console/Dockerfile --tag shuzhiren-control-plane-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "7", 步骤: "Run docker build --file apps/console/Dockerfile --target migrator --tag shuzhiren-control-plane-migrator-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "8", 步骤: "Run docker build --file apps/runtime-worker/Dockerfile --tag shuzhiren-runtime-worker-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "9", 步骤: "Run docker build --file apps/runtime-observer/Dockerfile --tag shuzhiren-runtime-observer-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "10", 步骤: "Run docker build --file apps/output-probe/Dockerfile --tag shuzhiren-output-probe-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "11", 步骤: "Run docker build --file apps/channel-adapter/Dockerfile --tag shuzhiren-channel-adapter-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "12", 步骤: "Run docker build --file apps/alert-notifier/Dockerfile --tag shuzhiren-alert-notifier-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "13", 步骤: "Run docker build --file runtime/gateway/Dockerfile --tag shuzhiren-runtime-gateway-ci runtime/gateway", 结论: success, 标签: static }
      - { job: docker-build, 序号: "14", 步骤: "Run docker build --load --file runtime/livetalking/Dockerfile --tag shuzhiren/livetalking:ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "15", 步骤: "prep: reclaim disk before CosyVoice build", 结论: success }
      - { job: docker-build, 序号: "16", 步骤: "docker build runtime/cosyvoice (committed Miniforge pin)", 结论: success, 标签: static }
      - { job: docker-build, 序号: "31", 步骤: "Post Set up Node.js", 结论: success }
      - { job: docker-build, 序号: "32", 步骤: "Post Checkout", 结论: success }
      - { job: docker-build, 序号: "33", 步骤: "Complete job", 结论: success }
      - { job: static-gates, 序号: "1", 步骤: "Set up job", 结论: success }
      - { job: static-gates, 序号: "2", 步骤: "Checkout", 结论: success }
      - { job: static-gates, 序号: "3", 步骤: "Set up Node.js", 结论: success }
      - { job: static-gates, 序号: "4", 步骤: "Run npm ci", 结论: success }
      - { job: static-gates, 序号: "5", 步骤: "Run npm run ci:coverage:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "6", 步骤: "Run npm run ci:workflow:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "7", 步骤: "Run npm run ci:action-pins:verify", 结论: success, 标签: static }
      - { job: static-gates, 序号: "8", 步骤: "Run npm run docs:governance:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "9", 步骤: "Run bash -n scripts/check-runtime-host.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "10", 步骤: "Run bash -n scripts/backup-postgres.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "11", 步骤: "Run bash -n scripts/test-postgres-backup-direct.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "12", 步骤: "Run bash -n scripts/restore-postgres-drill.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "13", 步骤: "Run bash -n scripts/test-postgres-restore-drill.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "14", 步骤: "Run bash -n scripts/backup-runtime-gateway-state.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "15", 步骤: "Run bash -n scripts/restore-runtime-gateway-state-drill.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "16", 步骤: "Run bash -n scripts/verify-postgres-backup.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "17", 步骤: "Run bash -n scripts/verify-runtime-gateway-state-backup.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "18", 步骤: "Run bash scripts/check-runtime-host.sh --help", 结论: success, 标签: static }
      - { job: static-gates, 序号: "19", 步骤: "Run npm run deploy:check -- --allow-placeholders", 结论: success, 标签: static }
      - { job: static-gates, 序号: "20", 步骤: "Run npm run release:workflow:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "21", 步骤: "Run npm run backup:automation:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "22", 步骤: "Run npm run control-plane:compose:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "23", 步骤: "Run npm run runtime:compose:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "24", 步骤: "Run npm run console:page-auth:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "25", 步骤: "Run npm run console:security-headers:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "26", 步骤: "Run npm run console:client-requests:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "27", 步骤: "Run npm run membership:authz:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "28", 步骤: "Run npm run membership:scopes:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "29", 步骤: "Run npm run governance:tenant-scope:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "30", 步骤: "Run npm run governance:immutability:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "31", 步骤: "Run npm run program:revisions:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "32", 步骤: "Run npm run program:runtime-scripts:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "33", 步骤: "Run npm run runtime:program-transition:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "34", 步骤: "Run npm run control-room:program-transition:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "35", 步骤: "Run npm run runtime:program-output:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "36", 步骤: "Run npm run preflight:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "37", 步骤: "Run npm run lifecycle:authz:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "38", 步骤: "Run npm run command:confirmation:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "39", 步骤: "Run npm run service-ingest:auth:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "40", 步骤: "Run npm run service-principals:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "41", 步骤: "Run npm run start:ack:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "42", 步骤: "Run npm run runtime:watchdog:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "43", 步骤: "Run npm run runtime:outbox:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "44", 步骤: "Run npm run runtime:telemetry-alerts:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "45", 步骤: "Run npm run entitlement:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "46", 步骤: "Run npm run runtime:media:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "47", 步骤: "Run npm run runtime:voice:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "48", 步骤: "Run npm run runtime:journal:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "49", 步骤: "Run npm run runtime:preview:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "50", 步骤: "Run npm run media:evidence:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "51", 步骤: "Run npm run recording:evidence:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "52", 步骤: "Run npm run runtime:images:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "53", 步骤: "Run npm run output-probe:response:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "54", 步骤: "Run npm run channel:verification:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "55", 步骤: "Run npm run settlement:reconciliation:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "56", 步骤: "Run npm run alert-notifier:health:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "57", 步骤: "Run node --check apps/runtime-worker/index.mjs", 结论: success, 标签: static }
      - { job: static-gates, 序号: "58", 步骤: "Run node --check apps/runtime-observer/index.mjs", 结论: success, 标签: static }
      - { job: static-gates, 序号: "59", 步骤: "Run node --check apps/runtime-observer/targets.mjs", 结论: success, 标签: static }
      - { job: static-gates, 序号: "60", 步骤: "Run node --check apps/output-probe/index.mjs", 结论: success, 标签: static }
      - { job: static-gates, 序号: "61", 步骤: "Run node --check apps/channel-adapter/index.mjs", 结论: success, 标签: static }
      - { job: static-gates, 序号: "62", 步骤: "Run node --check apps/alert-notifier/index.mjs", 结论: success, 标签: static }
      - { job: static-gates, 序号: "63", 步骤: "Run npm run typecheck", 结论: success, 标签: static }
      - { job: static-gates, 序号: "64", 步骤: "Run npm run lint", 结论: success, 标签: static }
      - { job: static-gates, 序号: "65", 步骤: "Run npm run build", 结论: success, 标签: static }
      - { job: static-gates, 序号: "129", 步骤: "Post Set up Node.js", 结论: success }
      - { job: static-gates, 序号: "130", 步骤: "Post Checkout", 结论: success }
      - { job: static-gates, 序号: "131", 步骤: "Complete job", 结论: success }
      - { job: node-unit, 序号: "1", 步骤: "Set up job", 结论: success }
      - { job: node-unit, 序号: "2", 步骤: "Checkout", 结论: success }
      - { job: node-unit, 序号: "3", 步骤: "Set up Node.js", 结论: success }
      - { job: node-unit, 序号: "4", 步骤: "Run npm ci", 结论: success }
      - { job: node-unit, 序号: "5", 步骤: "Run npm run deploy:check:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "6", 步骤: "Run npm run deploy:manifest:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "7", 步骤: "Run npm run deploy:images:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "8", 步骤: "Run npm run release:evidence:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "9", 步骤: "Run bash scripts/test-postgres-backup-direct.sh", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "10", 步骤: "Run bash scripts/test-postgres-restore-drill.sh", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "11", 步骤: "Run npm run policy:red-team", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "12", 步骤: "Run npm run runtime:worker:config:test", 结论: success, 标签: static }
      - { job: node-unit, 序号: "13", 步骤: "Run npm run runtime:worker:health:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "14", 步骤: "Run npm run runtime:acceptance:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "15", 步骤: "Run npm run observer:runtime:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "16", 步骤: "Run npm run observer:targets:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "17", 步骤: "Run npm run observer:targets:apply:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "18", 步骤: "Run npm run output-probe:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "19", 步骤: "Run npm run output-probe:config:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "20", 步骤: "Run npm run channel-adapter:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "21", 步骤: "Run npm run alert-notifier:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "22", 步骤: "Run npm run ci:gates:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "23", 步骤: "Run npm run ci:db-fail-closed:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "24", 步骤: "Run npm run ci:evidence:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "25", 步骤: "Run npm run release:workflow:gate:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "26", 步骤: "Run npm run docs:governance:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "51", 步骤: "Post Set up Node.js", 结论: success }
      - { job: node-unit, 序号: "52", 步骤: "Post Checkout", 结论: success }
      - { job: node-unit, 序号: "53", 步骤: "Complete job", 结论: success }
      - { job: python-gateway, 序号: "1", 步骤: "Set up job", 结论: success }
      - { job: python-gateway, 序号: "2", 步骤: "Checkout", 结论: success }
      - { job: python-gateway, 序号: "3", 步骤: "Set up Python", 结论: success }
      - { job: python-gateway, 序号: "4", 步骤: "Set up Node.js", 结论: success }
      - { job: python-gateway, 序号: "5", 步骤: "Run python3 -m pip install --disable-pip-version-check --no-cache-dir -r runtime/gateway/requirements.txt", 结论: success }
      - { job: python-gateway, 序号: "6", 步骤: "Run npm run runtime:gateway:config:test", 结论: success, 标签: behavioral }
      - { job: python-gateway, 序号: "7", 步骤: "Run npm run runtime:gateway:errors:test", 结论: success, 标签: behavioral }
      - { job: python-gateway, 序号: "8", 步骤: "Run python3 -m py_compile runtime/gateway/*.py scripts/test-runtime-gateway-config.py", 结论: success, 标签: static }
      - { job: python-gateway, 序号: "9", 步骤: "Run python3 scripts/test-runtime-gateway-audio.py", 结论: success, 标签: behavioral }
      - { job: python-gateway, 序号: "10", 步骤: "Run python3 scripts/test-runtime-gateway-concurrency.py", 结论: success, 标签: behavioral }
      - { job: python-gateway, 序号: "11", 步骤: "Run python3 scripts/test-runtime-gateway-state-backup.py", 结论: success, 标签: behavioral }
      - { job: python-gateway, 序号: "12", 步骤: "Run python3 scripts/test-runtime-gateway-state-restore-drill.py", 结论: success, 标签: behavioral }
      - { job: python-gateway, 序号: "22", 步骤: "Post Set up Node.js", 结论: success }
      - { job: python-gateway, 序号: "23", 步骤: "Post Set up Python", 结论: success }
      - { job: python-gateway, 序号: "24", 步骤: "Post Checkout", 结论: success }
      - { job: python-gateway, 序号: "25", 步骤: "Complete job", 结论: success }
    skipped 步骤数: "1"
    node20 弃用告警数: "0"
静态门禁覆盖:
  - { 门禁: "ci:coverage:check", 行为测试: [无] }
  - { 门禁: "ci:workflow:check", 行为测试: [无] }
  - { 门禁: "docs:governance:check", 行为测试: [无] }
  - { 门禁: "deploy:check", 行为测试: [无] }
  - { 门禁: "release:workflow:check", 行为测试: [无] }
  - { 门禁: "backup:automation:check", 行为测试: [无] }
  - { 门禁: "control-plane:compose:check", 行为测试: [无] }
  - { 门禁: "runtime:compose:check", 行为测试: [无] }
  - { 门禁: "console:page-auth:check", 行为测试: [无] }
  - { 门禁: "console:security-headers:check", 行为测试: [无] }
  - { 门禁: "console:client-requests:check", 行为测试: [无] }
  - { 门禁: "membership:authz:check", 行为测试: [无] }
  - { 门禁: "membership:scopes:check", 行为测试: [无] }
  - { 门禁: "governance:tenant-scope:check", 行为测试: [无] }
  - { 门禁: "governance:immutability:check", 行为测试: [无] }
  - { 门禁: "program:revisions:check", 行为测试: [无] }
  - { 门禁: "program:runtime-scripts:check", 行为测试: [无] }
  - { 门禁: "runtime:program-transition:check", 行为测试: [无] }
  - { 门禁: "control-room:program-transition:check", 行为测试: [无] }
  - { 门禁: "runtime:program-output:check", 行为测试: [无] }
  - { 门禁: "preflight:check", 行为测试: [无] }
  - { 门禁: "lifecycle:authz:check", 行为测试: [无] }
  - { 门禁: "command:confirmation:check", 行为测试: [无] }
  - { 门禁: "service-ingest:auth:check", 行为测试: [无] }
  - { 门禁: "service-principals:check", 行为测试: [无] }
  - { 门禁: "start:ack:check", 行为测试: [无] }
  - { 门禁: "runtime:watchdog:check", 行为测试: [无] }
  - { 门禁: "runtime:outbox:check", 行为测试: [无] }
  - { 门禁: "runtime:telemetry-alerts:check", 行为测试: [无] }
  - { 门禁: "entitlement:check", 行为测试: [无] }
  - { 门禁: "runtime:media:check", 行为测试: [无] }
  - { 门禁: "runtime:voice:check", 行为测试: [无] }
  - { 门禁: "runtime:journal:check", 行为测试: [无] }
  - { 门禁: "runtime:preview:check", 行为测试: [无] }
  - { 门禁: "media:evidence:check", 行为测试: [无] }
  - { 门禁: "recording:evidence:check", 行为测试: [无] }
  - { 门禁: "runtime:images:check", 行为测试: [无] }
  - { 门禁: "output-probe:response:check", 行为测试: [无] }
  - { 门禁: "channel:verification:check", 行为测试: [无] }
  - { 门禁: "settlement:reconciliation:check", 行为测试: [无] }
  - { 门禁: "alert-notifier:health:check", 行为测试: [无] }
说明: >-
  依据由 npm run ci:evidence:collect -- --repo pengwenyi4061126-lgtm/shuzhiren --run-id 41988230415 于 2026-11-05 在本机生成
  （设置了用户授权读取 CI 的 GITHUB_TOKEN，退出码 0；token 只放在子进程环境中，没有打印或写入文件），改为本文件的流式写法，
  内容不变；runner 镜像取自各 job 日志 Set up job 步骤的 Runner Image 组。标签由 scripts/lib/verification-log.mjs 的
  createCheckResolver 按当前的 LOCAL_CHECKS、CI_ONLY_STEPS 与 ci.yml 求出后补入，准备步骤（Set up job、Initialize containers、
  Checkout、Set up Node.js、Set up Python、npm ci、prep: 开头的步骤、Post、Stop containers、Complete job）不写标签。
  python-gateway 第 5 步 pip install -r runtime/gateway/requirements.txt 没有写标签：44857e1 把这一步改为按哈希锁文件安装，
  当前的 CI_ONLY_STEPS 中已经没有原命令，门禁无法为它核对标签。
  运行由推送 master 触发，2026-11-05T07:34:51Z 创建，07:48:45Z 结束。job 结论与 job id：postgres-integration failure（127113973430）、
  compose-render success（127113973609）、docker-build success（127113973752）、static-gates success（127113973777）、
  node-unit success（127113973793）、python-gateway success（127113973856）。唯一的 skipped 步骤是 postgres-integration 的
  Post Set up Node.js。本运行只覆盖 230e4c7。control-plane:integration 的错误为 AssertionError [ERR_ASSERTION]: a restricted operator
  must not read an unassigned live-run outbox event，500 !== 404（scripts/test-control-plane-postgres.mjs 第 235 行）：
  GET /api/v1/runtime/outbox/{eventId} 在 try 之外调用 requestContextFrom、requireRole 与 getOutboxEvent，抛出的 404 Response
  被 Next.js 当作未处理异常答为 500，即 AUDIT_REGISTER.md 的 M1（401/403 变成 500）。提交 230e4c7 是 M1 修复提交 34236ef 的父提交，
  本运行即 M1 修复前失败的证据；修复后的结果见 V-20261105-16。测试在第 235 行停止，其后的断言（包括 H4 的第 346 行、
  结算导入的第 771 行与输出观测重试的第 865 行）在本运行中没有执行。判定为未验证：运行结论为 failure，且有步骤的结论不是 success。
```

## V-20261105-16 CI #498（run 41993338992，提交 a2804d1）是 #491 之后第一次全部 job 为 success、没有 skipped 步骤的运行

```yaml
编号: V-20261105-16
类型: 首次绿色 CI
结论: 第 498 次 CI 运行（run 41993338992，提交 a2804d1）的结论为 success，六个 job 的全部步骤为 success，skipped 步骤数为 0，node20 弃用告警数为 0；这是 #491 之后第一次绿色的 CI 运行
判定: 行为验证
run id: "41993338992"
提交: a2804d12137af0bfa0e3ab79b337e53cd3381656
skipped 步骤数: "0"
依据来源:
  - 类别: CI 或 Linux 运行
    平台: GitHub Actions
    run id: "41993338992"
    提交: a2804d12137af0bfa0e3ab79b337e53cd3381656
    运行结论: success
    runner 镜像:
      - { job: node-unit, 镜像: ubuntu-24.04, 版本: "20261025.353.1" }
      - { job: compose-render, 镜像: ubuntu-24.04, 版本: "20261101.360.1" }
      - { job: postgres-integration, 镜像: ubuntu-24.04, 版本: "20261101.360.1" }
      - { job: docker-build, 镜像: ubuntu-24.04, 版本: "20261025.353.1" }
      - { job: python-gateway, 镜像: ubuntu-24.04, 版本: "20261101.360.1" }
      - { job: static-gates, 镜像: ubuntu-24.04, 版本: "20261025.353.1" }
    步骤:
      - { job: node-unit, 序号: "1", 步骤: "Set up job", 结论: success }
      - { job: node-unit, 序号: "2", 步骤: "Checkout", 结论: success }
      - { job: node-unit, 序号: "3", 步骤: "Set up Node.js", 结论: success }
      - { job: node-unit, 序号: "4", 步骤: "Run npm ci", 结论: success }
      - { job: node-unit, 序号: "5", 步骤: "Run npm run deploy:check:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "6", 步骤: "Run npm run deploy:manifest:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "7", 步骤: "Run npm run deploy:images:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "8", 步骤: "Run npm run release:evidence:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "9", 步骤: "Run bash scripts/test-postgres-backup-direct.sh", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "10", 步骤: "Run bash scripts/test-postgres-restore-drill.sh", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "11", 步骤: "Run npm run policy:red-team", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "12", 步骤: "Run npm run runtime:worker:config:test", 结论: success, 标签: static }
      - { job: node-unit, 序号: "13", 步骤: "Run npm run runtime:worker:health:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "14", 步骤: "Run npm run runtime:acceptance:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "15", 步骤: "Run npm run observer:runtime:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "16", 步骤: "Run npm run observer:targets:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "17", 步骤: "Run npm run observer:targets:apply:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "18", 步骤: "Run npm run output-probe:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "19", 步骤: "Run npm run output-probe:config:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "20", 步骤: "Run npm run channel-adapter:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "21", 步骤: "Run npm run alert-notifier:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "22", 步骤: "Run npm run ci:gates:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "23", 步骤: "Run npm run ci:db-fail-closed:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "24", 步骤: "Run npm run ci:evidence:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "25", 步骤: "Run npm run release:workflow:gate:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "26", 步骤: "Run npm run docs:governance:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "51", 步骤: "Post Set up Node.js", 结论: success }
      - { job: node-unit, 序号: "52", 步骤: "Post Checkout", 结论: success }
      - { job: node-unit, 序号: "53", 步骤: "Complete job", 结论: success }
      - { job: compose-render, 序号: "1", 步骤: "Set up job", 结论: success }
      - { job: compose-render, 序号: "2", 步骤: "Checkout", 结论: success }
      - { job: compose-render, 序号: "3", 步骤: "Set up Node.js", 结论: success }
      - { job: compose-render, 序号: "4", 步骤: "Run npm ci", 结论: success }
      - { job: compose-render, 序号: "5", 步骤: "Run docker compose --env-file config/control-plane-compose.example.env -f infra/compose/docker-compose.control-plane.yml config", 结论: success, 标签: static }
      - { job: compose-render, 序号: "6", 步骤: "Run docker compose --env-file config/runtime.example.env --env-file config/runtime-gateway.example.env --env-file config/channel-adapter.example.env --env-file config/alert-notifier.example.env --profile output-probe --profile channel-adapter --profile alert-notifier --profile cosyvoice -f infra/compose/docker-compose.runtime.yml config", 结论: success, 标签: static }
      - { job: compose-render, 序号: "11", 步骤: "Post Set up Node.js", 结论: success }
      - { job: compose-render, 序号: "12", 步骤: "Post Checkout", 结论: success }
      - { job: compose-render, 序号: "13", 步骤: "Complete job", 结论: success }
      - { job: postgres-integration, 序号: "1", 步骤: "Set up job", 结论: success }
      - { job: postgres-integration, 序号: "2", 步骤: "Initialize containers", 结论: success }
      - { job: postgres-integration, 序号: "3", 步骤: "Checkout", 结论: success }
      - { job: postgres-integration, 序号: "4", 步骤: "Set up Node.js", 结论: success }
      - { job: postgres-integration, 序号: "5", 步骤: "Run npm ci", 结论: success }
      - { job: postgres-integration, 序号: "6", 步骤: "Run npm run db:migrate", 结论: success, 标签: behavioral }
      - { job: postgres-integration, 序号: "7", 步骤: "Run npm run db:migrate:integrity:test", 结论: success, 标签: behavioral }
      - { job: postgres-integration, 序号: "8", 步骤: "Run npm run service-principals:integration", 结论: success, 标签: behavioral }
      - { job: postgres-integration, 序号: "9", 步骤: "Run npm run db:migrate:lock:test", 结论: success, 标签: behavioral }
      - { job: postgres-integration, 序号: "10", 步骤: "Run npm run db:verify -- --allow-privileged", 结论: success, 标签: behavioral }
      - { job: postgres-integration, 序号: "11", 步骤: "prep: build console for control-plane integration", 结论: success }
      - { job: postgres-integration, 序号: "12", 步骤: "Run npm run control-plane:integration", 结论: success, 标签: behavioral }
      - { job: postgres-integration, 序号: "22", 步骤: "Post Set up Node.js", 结论: success }
      - { job: postgres-integration, 序号: "23", 步骤: "Post Checkout", 结论: success }
      - { job: postgres-integration, 序号: "24", 步骤: "Stop containers", 结论: success }
      - { job: postgres-integration, 序号: "25", 步骤: "Complete job", 结论: success }
      - { job: docker-build, 序号: "1", 步骤: "Set up job", 结论: success }
      - { job: docker-build, 序号: "2", 步骤: "Checkout", 结论: success }
      - { job: docker-build, 序号: "3", 步骤: "Set up Node.js", 结论: success }
      - { job: docker-build, 序号: "4", 步骤: "Run npm ci", 结论: success }
      - { job: docker-build, 序号: "5", 步骤: "prep: free runner disk", 结论: success }
      - { job: docker-build, 序号: "6", 步骤: "Run docker build --file apps/console/Dockerfile --tag shuzhiren-control-plane-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "7", 步骤: "Run docker build --file apps/console/Dockerfile --target migrator --tag shuzhiren-control-plane-migrator-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "8", 步骤: "Run docker build --file apps/runtime-worker/Dockerfile --tag shuzhiren-runtime-worker-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "9", 步骤: "Run docker build --file apps/runtime-observer/Dockerfile --tag shuzhiren-runtime-observer-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "10", 步骤: "Run docker build --file apps/output-probe/Dockerfile --tag shuzhiren-output-probe-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "11", 步骤: "Run docker build --file apps/channel-adapter/Dockerfile --tag shuzhiren-channel-adapter-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "12", 步骤: "Run docker build --file apps/alert-notifier/Dockerfile --tag shuzhiren-alert-notifier-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "13", 步骤: "Run docker build --file runtime/gateway/Dockerfile --tag shuzhiren-runtime-gateway-ci runtime/gateway", 结论: success, 标签: static }
      - { job: docker-build, 序号: "14", 步骤: "Run docker build --load --file runtime/livetalking/Dockerfile --tag shuzhiren/livetalking:ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "15", 步骤: "prep: reclaim disk before CosyVoice build", 结论: success }
      - { job: docker-build, 序号: "16", 步骤: "docker build runtime/cosyvoice (committed Miniforge pin)", 结论: success, 标签: static }
      - { job: docker-build, 序号: "31", 步骤: "Post Set up Node.js", 结论: success }
      - { job: docker-build, 序号: "32", 步骤: "Post Checkout", 结论: success }
      - { job: docker-build, 序号: "33", 步骤: "Complete job", 结论: success }
      - { job: python-gateway, 序号: "1", 步骤: "Set up job", 结论: success }
      - { job: python-gateway, 序号: "2", 步骤: "Checkout", 结论: success }
      - { job: python-gateway, 序号: "3", 步骤: "Set up Python", 结论: success }
      - { job: python-gateway, 序号: "4", 步骤: "Set up Node.js", 结论: success }
      - { job: python-gateway, 序号: "5", 步骤: "Run python3 -m pip install --disable-pip-version-check --no-cache-dir -r runtime/gateway/requirements.txt", 结论: success }
      - { job: python-gateway, 序号: "6", 步骤: "Run npm run runtime:gateway:config:test", 结论: success, 标签: behavioral }
      - { job: python-gateway, 序号: "7", 步骤: "Run npm run runtime:gateway:errors:test", 结论: success, 标签: behavioral }
      - { job: python-gateway, 序号: "8", 步骤: "Run python3 -m py_compile runtime/gateway/*.py scripts/test-runtime-gateway-config.py", 结论: success, 标签: static }
      - { job: python-gateway, 序号: "9", 步骤: "Run python3 scripts/test-runtime-gateway-audio.py", 结论: success, 标签: behavioral }
      - { job: python-gateway, 序号: "10", 步骤: "Run python3 scripts/test-runtime-gateway-concurrency.py", 结论: success, 标签: behavioral }
      - { job: python-gateway, 序号: "11", 步骤: "Run python3 scripts/test-runtime-gateway-state-backup.py", 结论: success, 标签: behavioral }
      - { job: python-gateway, 序号: "12", 步骤: "Run python3 scripts/test-runtime-gateway-state-restore-drill.py", 结论: success, 标签: behavioral }
      - { job: python-gateway, 序号: "22", 步骤: "Post Set up Node.js", 结论: success }
      - { job: python-gateway, 序号: "23", 步骤: "Post Set up Python", 结论: success }
      - { job: python-gateway, 序号: "24", 步骤: "Post Checkout", 结论: success }
      - { job: python-gateway, 序号: "25", 步骤: "Complete job", 结论: success }
      - { job: static-gates, 序号: "1", 步骤: "Set up job", 结论: success }
      - { job: static-gates, 序号: "2", 步骤: "Checkout", 结论: success }
      - { job: static-gates, 序号: "3", 步骤: "Set up Node.js", 结论: success }
      - { job: static-gates, 序号: "4", 步骤: "Run npm ci", 结论: success }
      - { job: static-gates, 序号: "5", 步骤: "Run npm run ci:coverage:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "6", 步骤: "Run npm run ci:workflow:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "7", 步骤: "Run npm run ci:action-pins:verify", 结论: success, 标签: static }
      - { job: static-gates, 序号: "8", 步骤: "Run npm run docs:governance:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "9", 步骤: "Run bash -n scripts/check-runtime-host.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "10", 步骤: "Run bash -n scripts/backup-postgres.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "11", 步骤: "Run bash -n scripts/test-postgres-backup-direct.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "12", 步骤: "Run bash -n scripts/restore-postgres-drill.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "13", 步骤: "Run bash -n scripts/test-postgres-restore-drill.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "14", 步骤: "Run bash -n scripts/backup-runtime-gateway-state.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "15", 步骤: "Run bash -n scripts/restore-runtime-gateway-state-drill.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "16", 步骤: "Run bash -n scripts/verify-postgres-backup.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "17", 步骤: "Run bash -n scripts/verify-runtime-gateway-state-backup.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "18", 步骤: "Run bash scripts/check-runtime-host.sh --help", 结论: success, 标签: static }
      - { job: static-gates, 序号: "19", 步骤: "Run npm run deploy:check -- --allow-placeholders", 结论: success, 标签: static }
      - { job: static-gates, 序号: "20", 步骤: "Run npm run release:workflow:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "21", 步骤: "Run npm run backup:automation:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "22", 步骤: "Run npm run control-plane:compose:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "23", 步骤: "Run npm run runtime:compose:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "24", 步骤: "Run npm run console:page-auth:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "25", 步骤: "Run npm run console:security-headers:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "26", 步骤: "Run npm run console:client-requests:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "27", 步骤: "Run npm run membership:authz:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "28", 步骤: "Run npm run membership:scopes:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "29", 步骤: "Run npm run governance:tenant-scope:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "30", 步骤: "Run npm run governance:immutability:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "31", 步骤: "Run npm run program:revisions:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "32", 步骤: "Run npm run program:runtime-scripts:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "33", 步骤: "Run npm run runtime:program-transition:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "34", 步骤: "Run npm run control-room:program-transition:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "35", 步骤: "Run npm run runtime:program-output:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "36", 步骤: "Run npm run preflight:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "37", 步骤: "Run npm run lifecycle:authz:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "38", 步骤: "Run npm run command:confirmation:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "39", 步骤: "Run npm run service-ingest:auth:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "40", 步骤: "Run npm run service-principals:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "41", 步骤: "Run npm run start:ack:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "42", 步骤: "Run npm run runtime:watchdog:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "43", 步骤: "Run npm run runtime:outbox:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "44", 步骤: "Run npm run runtime:telemetry-alerts:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "45", 步骤: "Run npm run entitlement:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "46", 步骤: "Run npm run runtime:media:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "47", 步骤: "Run npm run runtime:voice:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "48", 步骤: "Run npm run runtime:journal:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "49", 步骤: "Run npm run runtime:preview:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "50", 步骤: "Run npm run media:evidence:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "51", 步骤: "Run npm run recording:evidence:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "52", 步骤: "Run npm run runtime:images:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "53", 步骤: "Run npm run output-probe:response:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "54", 步骤: "Run npm run channel:verification:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "55", 步骤: "Run npm run settlement:reconciliation:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "56", 步骤: "Run npm run alert-notifier:health:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "57", 步骤: "Run node --check apps/runtime-worker/index.mjs", 结论: success, 标签: static }
      - { job: static-gates, 序号: "58", 步骤: "Run node --check apps/runtime-observer/index.mjs", 结论: success, 标签: static }
      - { job: static-gates, 序号: "59", 步骤: "Run node --check apps/runtime-observer/targets.mjs", 结论: success, 标签: static }
      - { job: static-gates, 序号: "60", 步骤: "Run node --check apps/output-probe/index.mjs", 结论: success, 标签: static }
      - { job: static-gates, 序号: "61", 步骤: "Run node --check apps/channel-adapter/index.mjs", 结论: success, 标签: static }
      - { job: static-gates, 序号: "62", 步骤: "Run node --check apps/alert-notifier/index.mjs", 结论: success, 标签: static }
      - { job: static-gates, 序号: "63", 步骤: "Run npm run typecheck", 结论: success, 标签: static }
      - { job: static-gates, 序号: "64", 步骤: "Run npm run lint", 结论: success, 标签: static }
      - { job: static-gates, 序号: "65", 步骤: "Run npm run build", 结论: success, 标签: static }
      - { job: static-gates, 序号: "129", 步骤: "Post Set up Node.js", 结论: success }
      - { job: static-gates, 序号: "130", 步骤: "Post Checkout", 结论: success }
      - { job: static-gates, 序号: "131", 步骤: "Complete job", 结论: success }
    skipped 步骤数: "0"
    node20 弃用告警数: "0"
静态门禁覆盖:
  - { 门禁: "ci:coverage:check", 行为测试: [无] }
  - { 门禁: "ci:workflow:check", 行为测试: [无] }
  - { 门禁: "docs:governance:check", 行为测试: [无] }
  - { 门禁: "deploy:check", 行为测试: [无] }
  - { 门禁: "release:workflow:check", 行为测试: [无] }
  - { 门禁: "backup:automation:check", 行为测试: [无] }
  - { 门禁: "control-plane:compose:check", 行为测试: [无] }
  - { 门禁: "runtime:compose:check", 行为测试: [无] }
  - { 门禁: "console:page-auth:check", 行为测试: [无] }
  - { 门禁: "console:security-headers:check", 行为测试: [无] }
  - { 门禁: "console:client-requests:check", 行为测试: [无] }
  - { 门禁: "membership:authz:check", 行为测试: [无] }
  - { 门禁: "membership:scopes:check", 行为测试: [无] }
  - { 门禁: "governance:tenant-scope:check", 行为测试: [无] }
  - { 门禁: "governance:immutability:check", 行为测试: [无] }
  - { 门禁: "program:revisions:check", 行为测试: [无] }
  - { 门禁: "program:runtime-scripts:check", 行为测试: [无] }
  - { 门禁: "runtime:program-transition:check", 行为测试: [无] }
  - { 门禁: "control-room:program-transition:check", 行为测试: [无] }
  - { 门禁: "runtime:program-output:check", 行为测试: [无] }
  - { 门禁: "preflight:check", 行为测试: [无] }
  - { 门禁: "lifecycle:authz:check", 行为测试: [无] }
  - { 门禁: "command:confirmation:check", 行为测试: [无] }
  - { 门禁: "service-ingest:auth:check", 行为测试: [无] }
  - { 门禁: "service-principals:check", 行为测试: [无] }
  - { 门禁: "start:ack:check", 行为测试: [无] }
  - { 门禁: "runtime:watchdog:check", 行为测试: [无] }
  - { 门禁: "runtime:outbox:check", 行为测试: [无] }
  - { 门禁: "runtime:telemetry-alerts:check", 行为测试: [无] }
  - { 门禁: "entitlement:check", 行为测试: [无] }
  - { 门禁: "runtime:media:check", 行为测试: [无] }
  - { 门禁: "runtime:voice:check", 行为测试: [无] }
  - { 门禁: "runtime:journal:check", 行为测试: [无] }
  - { 门禁: "runtime:preview:check", 行为测试: [无] }
  - { 门禁: "media:evidence:check", 行为测试: [无] }
  - { 门禁: "recording:evidence:check", 行为测试: [无] }
  - { 门禁: "runtime:images:check", 行为测试: [无] }
  - { 门禁: "output-probe:response:check", 行为测试: [无] }
  - { 门禁: "channel:verification:check", 行为测试: [无] }
  - { 门禁: "settlement:reconciliation:check", 行为测试: [无] }
  - { 门禁: "alert-notifier:health:check", 行为测试: [无] }
说明: >-
  依据由 npm run ci:evidence:collect -- --repo pengwenyi4061126-lgtm/shuzhiren --run-id 41993338992 于 2026-11-05 在本机生成
  （设置了用户授权读取 CI 的 GITHUB_TOKEN，退出码 0；token 只放在子进程环境中，没有打印或写入文件），改为本文件的流式写法，
  内容不变；runner 镜像取自各 job 日志 Set up job 步骤的 Runner Image 组。标签由 scripts/lib/verification-log.mjs 的
  createCheckResolver 按当前的 LOCAL_CHECKS、CI_ONLY_STEPS 与 ci.yml 求出后补入，准备步骤（Set up job、Initialize containers、
  Checkout、Set up Node.js、Set up Python、npm ci、prep: 开头的步骤、Post、Stop containers、Complete job）不写标签。
  python-gateway 第 5 步 pip install -r runtime/gateway/requirements.txt 没有写标签：44857e1 把这一步改为按哈希锁文件安装，
  当前的 CI_ONLY_STEPS 中已经没有原命令，门禁无法为它核对标签。
  运行由推送 master 触发，2026-11-05T08:17:39Z 创建，08:33:41Z 结束。job 结论与 job id：node-unit success（127130543524）、
  compose-render success（127130543872）、postgres-integration success（127130543914）、docker-build success（127130543985）、
  python-gateway success（127130544091）、static-gates success（127130544243）。2026-11-05 用 GitHub API 核对：run 的 head_sha 为
  a2804d12137af0bfa0e3ab79b337e53cd3381656，conclusion 为 success，六个 job 的全部步骤中没有 conclusion 为 skipped 的步骤
  （采集器的 skipped 步骤数为 0）。#472 至 #497 的结论都是 failure。本运行覆盖 230e4c7 之后的 34236ef（M1）、a9c3420（H4）、
  4576a01、e68a3ee 与测试修复 6e47302、aff1ec5、03979b1、2e4731d、a2804d1。control-plane:integration 为 success：#497 中失败的
  第 235 行断言（M1）与此前未执行的第 346 行（H4）、第 771 行（PostgreSQL 17 上的结算导入）、第 865 行（输出观测重试）断言都已执行并通过，
  见 AUDIT_REGISTER.md 的 M1、H4、N10、N11。
```

## V-20261105-17 CI #499（run 42007377400，提交 806d24a）为 success：六个 job 全部通过，没有 skipped 步骤

```yaml
编号: V-20261105-17
类型: 结论
结论: 第 499 次 CI 运行（run 42007377400，提交 806d24a）的结论为 success，六个 job 的全部步骤为 success，skipped 步骤数为 0
判定: 行为验证
依据来源:
  - 类别: CI 或 Linux 运行
    平台: GitHub Actions
    run id: "42007377400"
    提交: 806d24a764a797d0afae7d1d1907d8725b061dd3
    运行结论: success
    runner 镜像:
      - { job: compose-render, 镜像: ubuntu-24.04, 版本: "20261101.360.1" }
      - { job: docker-build, 镜像: ubuntu-24.04, 版本: "20261025.353.1" }
      - { job: postgres-integration, 镜像: ubuntu-24.04, 版本: "20261025.353.1" }
      - { job: python-gateway, 镜像: ubuntu-24.04, 版本: "20261025.353.1" }
      - { job: static-gates, 镜像: ubuntu-24.04, 版本: "20261025.353.1" }
      - { job: node-unit, 镜像: ubuntu-24.04, 版本: "20261025.353.1" }
    步骤:
      - { job: compose-render, 序号: "1", 步骤: "Set up job", 结论: success }
      - { job: compose-render, 序号: "2", 步骤: "Checkout", 结论: success }
      - { job: compose-render, 序号: "3", 步骤: "Set up Node.js", 结论: success }
      - { job: compose-render, 序号: "4", 步骤: "Run npm ci", 结论: success }
      - { job: compose-render, 序号: "5", 步骤: "Run docker compose --env-file config/control-plane-compose.example.env -f infra/compose/docker-compose.control-plane.yml config", 结论: success, 标签: static }
      - { job: compose-render, 序号: "6", 步骤: "Run docker compose --env-file config/runtime.example.env --env-file config/runtime-gateway.example.env --env-file config/channel-adapter.example.env --env-file config/alert-notifier.example.env --profile output-probe --profile channel-adapter --profile alert-notifier --profile cosyvoice -f infra/compose/docker-compose.runtime.yml config", 结论: success, 标签: static }
      - { job: compose-render, 序号: "11", 步骤: "Post Set up Node.js", 结论: success }
      - { job: compose-render, 序号: "12", 步骤: "Post Checkout", 结论: success }
      - { job: compose-render, 序号: "13", 步骤: "Complete job", 结论: success }
      - { job: docker-build, 序号: "1", 步骤: "Set up job", 结论: success }
      - { job: docker-build, 序号: "2", 步骤: "Checkout", 结论: success }
      - { job: docker-build, 序号: "3", 步骤: "Set up Node.js", 结论: success }
      - { job: docker-build, 序号: "4", 步骤: "Run npm ci", 结论: success }
      - { job: docker-build, 序号: "5", 步骤: "prep: free runner disk", 结论: success }
      - { job: docker-build, 序号: "6", 步骤: "Run docker build --file apps/console/Dockerfile --tag shuzhiren-control-plane-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "7", 步骤: "Run docker build --file apps/console/Dockerfile --target migrator --tag shuzhiren-control-plane-migrator-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "8", 步骤: "Run docker build --file apps/runtime-worker/Dockerfile --tag shuzhiren-runtime-worker-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "9", 步骤: "Run docker build --file apps/runtime-observer/Dockerfile --tag shuzhiren-runtime-observer-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "10", 步骤: "Run docker build --file apps/output-probe/Dockerfile --tag shuzhiren-output-probe-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "11", 步骤: "Run docker build --file apps/channel-adapter/Dockerfile --tag shuzhiren-channel-adapter-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "12", 步骤: "Run docker build --file apps/alert-notifier/Dockerfile --tag shuzhiren-alert-notifier-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "13", 步骤: "Run docker build --file runtime/gateway/Dockerfile --tag shuzhiren-runtime-gateway-ci runtime/gateway", 结论: success, 标签: static }
      - { job: docker-build, 序号: "14", 步骤: "Run docker build --load --file runtime/livetalking/Dockerfile --tag shuzhiren/livetalking:ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "15", 步骤: "prep: reclaim disk before CosyVoice build", 结论: success }
      - { job: docker-build, 序号: "16", 步骤: "docker build runtime/cosyvoice (committed Miniforge pin)", 结论: success, 标签: static }
      - { job: docker-build, 序号: "31", 步骤: "Post Set up Node.js", 结论: success }
      - { job: docker-build, 序号: "32", 步骤: "Post Checkout", 结论: success }
      - { job: docker-build, 序号: "33", 步骤: "Complete job", 结论: success }
      - { job: postgres-integration, 序号: "1", 步骤: "Set up job", 结论: success }
      - { job: postgres-integration, 序号: "2", 步骤: "Initialize containers", 结论: success }
      - { job: postgres-integration, 序号: "3", 步骤: "Checkout", 结论: success }
      - { job: postgres-integration, 序号: "4", 步骤: "Set up Node.js", 结论: success }
      - { job: postgres-integration, 序号: "5", 步骤: "Run npm ci", 结论: success }
      - { job: postgres-integration, 序号: "6", 步骤: "Run npm run db:migrate", 结论: success, 标签: behavioral }
      - { job: postgres-integration, 序号: "7", 步骤: "Run npm run db:migrate:integrity:test", 结论: success, 标签: behavioral }
      - { job: postgres-integration, 序号: "8", 步骤: "Run npm run service-principals:integration", 结论: success, 标签: behavioral }
      - { job: postgres-integration, 序号: "9", 步骤: "Run npm run db:migrate:lock:test", 结论: success, 标签: behavioral }
      - { job: postgres-integration, 序号: "10", 步骤: "Run npm run db:verify -- --allow-privileged", 结论: success, 标签: behavioral }
      - { job: postgres-integration, 序号: "11", 步骤: "prep: build console for control-plane integration", 结论: success }
      - { job: postgres-integration, 序号: "12", 步骤: "Run npm run control-plane:integration", 结论: success, 标签: behavioral }
      - { job: postgres-integration, 序号: "22", 步骤: "Post Set up Node.js", 结论: success }
      - { job: postgres-integration, 序号: "23", 步骤: "Post Checkout", 结论: success }
      - { job: postgres-integration, 序号: "24", 步骤: "Stop containers", 结论: success }
      - { job: postgres-integration, 序号: "25", 步骤: "Complete job", 结论: success }
      - { job: python-gateway, 序号: "1", 步骤: "Set up job", 结论: success }
      - { job: python-gateway, 序号: "2", 步骤: "Checkout", 结论: success }
      - { job: python-gateway, 序号: "3", 步骤: "Set up Python", 结论: success }
      - { job: python-gateway, 序号: "4", 步骤: "Set up Node.js", 结论: success }
      - { job: python-gateway, 序号: "5", 步骤: "Run python3 -m pip install --disable-pip-version-check --no-cache-dir -r runtime/gateway/requirements.txt", 结论: success }
      - { job: python-gateway, 序号: "6", 步骤: "Run npm run runtime:gateway:config:test", 结论: success, 标签: behavioral }
      - { job: python-gateway, 序号: "7", 步骤: "Run npm run runtime:gateway:errors:test", 结论: success, 标签: behavioral }
      - { job: python-gateway, 序号: "8", 步骤: "Run python3 -m py_compile runtime/gateway/*.py scripts/test-runtime-gateway-config.py", 结论: success, 标签: static }
      - { job: python-gateway, 序号: "9", 步骤: "Run python3 scripts/test-runtime-gateway-audio.py", 结论: success, 标签: behavioral }
      - { job: python-gateway, 序号: "10", 步骤: "Run python3 scripts/test-runtime-gateway-concurrency.py", 结论: success, 标签: behavioral }
      - { job: python-gateway, 序号: "11", 步骤: "Run python3 scripts/test-runtime-gateway-state-backup.py", 结论: success, 标签: behavioral }
      - { job: python-gateway, 序号: "12", 步骤: "Run python3 scripts/test-runtime-gateway-state-restore-drill.py", 结论: success, 标签: behavioral }
      - { job: python-gateway, 序号: "22", 步骤: "Post Set up Node.js", 结论: success }
      - { job: python-gateway, 序号: "23", 步骤: "Post Set up Python", 结论: success }
      - { job: python-gateway, 序号: "24", 步骤: "Post Checkout", 结论: success }
      - { job: python-gateway, 序号: "25", 步骤: "Complete job", 结论: success }
      - { job: static-gates, 序号: "1", 步骤: "Set up job", 结论: success }
      - { job: static-gates, 序号: "2", 步骤: "Checkout", 结论: success }
      - { job: static-gates, 序号: "3", 步骤: "Set up Node.js", 结论: success }
      - { job: static-gates, 序号: "4", 步骤: "Run npm ci", 结论: success }
      - { job: static-gates, 序号: "5", 步骤: "Run npm run ci:coverage:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "6", 步骤: "Run npm run ci:workflow:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "7", 步骤: "Run npm run ci:action-pins:verify", 结论: success, 标签: static }
      - { job: static-gates, 序号: "8", 步骤: "Run npm run docs:governance:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "9", 步骤: "Run bash -n scripts/check-runtime-host.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "10", 步骤: "Run bash -n scripts/backup-postgres.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "11", 步骤: "Run bash -n scripts/test-postgres-backup-direct.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "12", 步骤: "Run bash -n scripts/restore-postgres-drill.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "13", 步骤: "Run bash -n scripts/test-postgres-restore-drill.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "14", 步骤: "Run bash -n scripts/backup-runtime-gateway-state.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "15", 步骤: "Run bash -n scripts/restore-runtime-gateway-state-drill.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "16", 步骤: "Run bash -n scripts/verify-postgres-backup.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "17", 步骤: "Run bash -n scripts/verify-runtime-gateway-state-backup.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "18", 步骤: "Run bash scripts/check-runtime-host.sh --help", 结论: success, 标签: static }
      - { job: static-gates, 序号: "19", 步骤: "Run npm run deploy:check -- --allow-placeholders", 结论: success, 标签: static }
      - { job: static-gates, 序号: "20", 步骤: "Run npm run release:workflow:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "21", 步骤: "Run npm run backup:automation:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "22", 步骤: "Run npm run control-plane:compose:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "23", 步骤: "Run npm run runtime:compose:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "24", 步骤: "Run npm run console:page-auth:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "25", 步骤: "Run npm run console:security-headers:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "26", 步骤: "Run npm run console:client-requests:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "27", 步骤: "Run npm run membership:authz:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "28", 步骤: "Run npm run membership:scopes:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "29", 步骤: "Run npm run governance:tenant-scope:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "30", 步骤: "Run npm run governance:immutability:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "31", 步骤: "Run npm run program:revisions:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "32", 步骤: "Run npm run program:runtime-scripts:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "33", 步骤: "Run npm run runtime:program-transition:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "34", 步骤: "Run npm run control-room:program-transition:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "35", 步骤: "Run npm run runtime:program-output:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "36", 步骤: "Run npm run preflight:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "37", 步骤: "Run npm run lifecycle:authz:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "38", 步骤: "Run npm run command:confirmation:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "39", 步骤: "Run npm run service-ingest:auth:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "40", 步骤: "Run npm run service-principals:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "41", 步骤: "Run npm run start:ack:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "42", 步骤: "Run npm run runtime:watchdog:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "43", 步骤: "Run npm run runtime:outbox:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "44", 步骤: "Run npm run runtime:telemetry-alerts:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "45", 步骤: "Run npm run entitlement:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "46", 步骤: "Run npm run runtime:media:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "47", 步骤: "Run npm run runtime:voice:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "48", 步骤: "Run npm run runtime:journal:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "49", 步骤: "Run npm run runtime:preview:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "50", 步骤: "Run npm run media:evidence:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "51", 步骤: "Run npm run recording:evidence:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "52", 步骤: "Run npm run runtime:images:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "53", 步骤: "Run npm run output-probe:response:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "54", 步骤: "Run npm run channel:verification:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "55", 步骤: "Run npm run settlement:reconciliation:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "56", 步骤: "Run npm run alert-notifier:health:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "57", 步骤: "Run node --check apps/runtime-worker/index.mjs", 结论: success, 标签: static }
      - { job: static-gates, 序号: "58", 步骤: "Run node --check apps/runtime-observer/index.mjs", 结论: success, 标签: static }
      - { job: static-gates, 序号: "59", 步骤: "Run node --check apps/runtime-observer/targets.mjs", 结论: success, 标签: static }
      - { job: static-gates, 序号: "60", 步骤: "Run node --check apps/output-probe/index.mjs", 结论: success, 标签: static }
      - { job: static-gates, 序号: "61", 步骤: "Run node --check apps/channel-adapter/index.mjs", 结论: success, 标签: static }
      - { job: static-gates, 序号: "62", 步骤: "Run node --check apps/alert-notifier/index.mjs", 结论: success, 标签: static }
      - { job: static-gates, 序号: "63", 步骤: "Run npm run typecheck", 结论: success, 标签: static }
      - { job: static-gates, 序号: "64", 步骤: "Run npm run lint", 结论: success, 标签: static }
      - { job: static-gates, 序号: "65", 步骤: "Run npm run build", 结论: success, 标签: static }
      - { job: static-gates, 序号: "129", 步骤: "Post Set up Node.js", 结论: success }
      - { job: static-gates, 序号: "130", 步骤: "Post Checkout", 结论: success }
      - { job: static-gates, 序号: "131", 步骤: "Complete job", 结论: success }
      - { job: node-unit, 序号: "1", 步骤: "Set up job", 结论: success }
      - { job: node-unit, 序号: "2", 步骤: "Checkout", 结论: success }
      - { job: node-unit, 序号: "3", 步骤: "Set up Node.js", 结论: success }
      - { job: node-unit, 序号: "4", 步骤: "Run npm ci", 结论: success }
      - { job: node-unit, 序号: "5", 步骤: "Run npm run deploy:check:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "6", 步骤: "Run npm run deploy:manifest:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "7", 步骤: "Run npm run deploy:images:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "8", 步骤: "Run npm run release:evidence:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "9", 步骤: "Run bash scripts/test-postgres-backup-direct.sh", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "10", 步骤: "Run bash scripts/test-postgres-restore-drill.sh", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "11", 步骤: "Run npm run policy:red-team", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "12", 步骤: "Run npm run runtime:worker:config:test", 结论: success, 标签: static }
      - { job: node-unit, 序号: "13", 步骤: "Run npm run runtime:worker:health:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "14", 步骤: "Run npm run runtime:acceptance:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "15", 步骤: "Run npm run observer:runtime:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "16", 步骤: "Run npm run observer:targets:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "17", 步骤: "Run npm run observer:targets:apply:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "18", 步骤: "Run npm run output-probe:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "19", 步骤: "Run npm run output-probe:config:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "20", 步骤: "Run npm run channel-adapter:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "21", 步骤: "Run npm run alert-notifier:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "22", 步骤: "Run npm run ci:gates:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "23", 步骤: "Run npm run ci:db-fail-closed:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "24", 步骤: "Run npm run ci:evidence:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "25", 步骤: "Run npm run release:workflow:gate:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "26", 步骤: "Run npm run docs:governance:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "51", 步骤: "Post Set up Node.js", 结论: success }
      - { job: node-unit, 序号: "52", 步骤: "Post Checkout", 结论: success }
      - { job: node-unit, 序号: "53", 步骤: "Complete job", 结论: success }
    skipped 步骤数: "0"
    node20 弃用告警数: "0"
静态门禁覆盖:
  - { 门禁: "ci:coverage:check", 行为测试: [无] }
  - { 门禁: "ci:workflow:check", 行为测试: [无] }
  - { 门禁: "docs:governance:check", 行为测试: [无] }
  - { 门禁: "deploy:check", 行为测试: [无] }
  - { 门禁: "release:workflow:check", 行为测试: [无] }
  - { 门禁: "backup:automation:check", 行为测试: [无] }
  - { 门禁: "control-plane:compose:check", 行为测试: [无] }
  - { 门禁: "runtime:compose:check", 行为测试: [无] }
  - { 门禁: "console:page-auth:check", 行为测试: [无] }
  - { 门禁: "console:security-headers:check", 行为测试: [无] }
  - { 门禁: "console:client-requests:check", 行为测试: [无] }
  - { 门禁: "membership:authz:check", 行为测试: [无] }
  - { 门禁: "membership:scopes:check", 行为测试: [无] }
  - { 门禁: "governance:tenant-scope:check", 行为测试: [无] }
  - { 门禁: "governance:immutability:check", 行为测试: [无] }
  - { 门禁: "program:revisions:check", 行为测试: [无] }
  - { 门禁: "program:runtime-scripts:check", 行为测试: [无] }
  - { 门禁: "runtime:program-transition:check", 行为测试: [无] }
  - { 门禁: "control-room:program-transition:check", 行为测试: [无] }
  - { 门禁: "runtime:program-output:check", 行为测试: [无] }
  - { 门禁: "preflight:check", 行为测试: [无] }
  - { 门禁: "lifecycle:authz:check", 行为测试: [无] }
  - { 门禁: "command:confirmation:check", 行为测试: [无] }
  - { 门禁: "service-ingest:auth:check", 行为测试: [无] }
  - { 门禁: "service-principals:check", 行为测试: [无] }
  - { 门禁: "start:ack:check", 行为测试: [无] }
  - { 门禁: "runtime:watchdog:check", 行为测试: [无] }
  - { 门禁: "runtime:outbox:check", 行为测试: [无] }
  - { 门禁: "runtime:telemetry-alerts:check", 行为测试: [无] }
  - { 门禁: "entitlement:check", 行为测试: [无] }
  - { 门禁: "runtime:media:check", 行为测试: [无] }
  - { 门禁: "runtime:voice:check", 行为测试: [无] }
  - { 门禁: "runtime:journal:check", 行为测试: [无] }
  - { 门禁: "runtime:preview:check", 行为测试: [无] }
  - { 门禁: "media:evidence:check", 行为测试: [无] }
  - { 门禁: "recording:evidence:check", 行为测试: [无] }
  - { 门禁: "runtime:images:check", 行为测试: [无] }
  - { 门禁: "output-probe:response:check", 行为测试: [无] }
  - { 门禁: "channel:verification:check", 行为测试: [无] }
  - { 门禁: "settlement:reconciliation:check", 行为测试: [无] }
  - { 门禁: "alert-notifier:health:check", 行为测试: [无] }
说明: >-
  依据由 npm run ci:evidence:collect -- --repo pengwenyi4061126-lgtm/shuzhiren --run-id 42007377400 于 2026-11-05 在本机生成
  （设置了用户授权读取 CI 的 GITHUB_TOKEN，退出码 0；token 只放在子进程环境中，没有打印或写入文件），改为本文件的流式写法，
  内容不变；runner 镜像取自各 job 日志 Set up job 步骤的 Runner Image 组。标签由 scripts/lib/verification-log.mjs 的
  createCheckResolver 按当前的 LOCAL_CHECKS、CI_ONLY_STEPS 与 ci.yml 求出后补入，准备步骤（Set up job、Initialize containers、
  Checkout、Set up Node.js、Set up Python、npm ci、prep: 开头的步骤、Post、Stop containers、Complete job）不写标签。
  python-gateway 第 5 步 pip install -r runtime/gateway/requirements.txt 没有写标签：44857e1 把这一步改为按哈希锁文件安装，
  当前的 CI_ONLY_STEPS 中已经没有原命令，门禁无法为它核对标签。
  运行由推送 master 触发，2026-11-05T10:02:37Z 创建，10:16:29Z 结束。job 结论与 job id：compose-render success（127177441200）、
  docker-build success（127177441538）、postgres-integration success（127177441591）、python-gateway success（127177441675）、
  static-gates success（127177441724）、node-unit success（127177441755）。本运行覆盖 a2804d1 之后的 41 个提交（fcacdbc 至 806d24a），
  其中 H2（0ff6621）、H7（fcacdbc）、M2 至 M7、M10、M13 至 M17、M19、M22、M23、M25、L1 至 L16、N2 的修复提交及其回归测试，
  各问题引用的步骤见 AUDIT_REGISTER.md。
```

## V-20261105-18 CI #500（run 42009594325，提交 dfb1296）为 success：六个 job 全部通过，没有 skipped 步骤

```yaml
编号: V-20261105-18
类型: 结论
结论: 第 500 次 CI 运行（run 42009594325，提交 dfb1296）的结论为 success，六个 job 的全部步骤为 success，skipped 步骤数为 0
判定: 行为验证
依据来源:
  - 类别: CI 或 Linux 运行
    平台: GitHub Actions
    run id: "42009594325"
    提交: dfb1296ed9b76094c3b422b70188faf86633afc9
    运行结论: success
    runner 镜像:
      - { job: docker-build, 镜像: ubuntu-24.04, 版本: "20261025.353.1" }
      - { job: postgres-integration, 镜像: ubuntu-24.04, 版本: "20261025.353.1" }
      - { job: node-unit, 镜像: ubuntu-24.04, 版本: "20261025.353.1" }
      - { job: compose-render, 镜像: ubuntu-24.04, 版本: "20261101.360.1" }
      - { job: static-gates, 镜像: ubuntu-24.04, 版本: "20261025.353.1" }
      - { job: python-gateway, 镜像: ubuntu-24.04, 版本: "20261101.360.1" }
    步骤:
      - { job: docker-build, 序号: "1", 步骤: "Set up job", 结论: success }
      - { job: docker-build, 序号: "2", 步骤: "Checkout", 结论: success }
      - { job: docker-build, 序号: "3", 步骤: "Set up Node.js", 结论: success }
      - { job: docker-build, 序号: "4", 步骤: "Run npm ci", 结论: success }
      - { job: docker-build, 序号: "5", 步骤: "prep: free runner disk", 结论: success }
      - { job: docker-build, 序号: "6", 步骤: "Run docker build --file apps/console/Dockerfile --tag shuzhiren-control-plane-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "7", 步骤: "Run docker build --file apps/console/Dockerfile --target migrator --tag shuzhiren-control-plane-migrator-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "8", 步骤: "Run docker build --file apps/runtime-worker/Dockerfile --tag shuzhiren-runtime-worker-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "9", 步骤: "Run docker build --file apps/runtime-observer/Dockerfile --tag shuzhiren-runtime-observer-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "10", 步骤: "Run docker build --file apps/output-probe/Dockerfile --tag shuzhiren-output-probe-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "11", 步骤: "Run docker build --file apps/channel-adapter/Dockerfile --tag shuzhiren-channel-adapter-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "12", 步骤: "Run docker build --file apps/alert-notifier/Dockerfile --tag shuzhiren-alert-notifier-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "13", 步骤: "Run docker build --file runtime/gateway/Dockerfile --tag shuzhiren-runtime-gateway-ci runtime/gateway", 结论: success, 标签: static }
      - { job: docker-build, 序号: "14", 步骤: "Run docker build --load --file runtime/livetalking/Dockerfile --tag shuzhiren/livetalking:ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "15", 步骤: "prep: reclaim disk before CosyVoice build", 结论: success }
      - { job: docker-build, 序号: "16", 步骤: "docker build runtime/cosyvoice (committed Miniforge pin)", 结论: success, 标签: static }
      - { job: docker-build, 序号: "31", 步骤: "Post Set up Node.js", 结论: success }
      - { job: docker-build, 序号: "32", 步骤: "Post Checkout", 结论: success }
      - { job: docker-build, 序号: "33", 步骤: "Complete job", 结论: success }
      - { job: postgres-integration, 序号: "1", 步骤: "Set up job", 结论: success }
      - { job: postgres-integration, 序号: "2", 步骤: "Initialize containers", 结论: success }
      - { job: postgres-integration, 序号: "3", 步骤: "Checkout", 结论: success }
      - { job: postgres-integration, 序号: "4", 步骤: "Set up Node.js", 结论: success }
      - { job: postgres-integration, 序号: "5", 步骤: "Run npm ci", 结论: success }
      - { job: postgres-integration, 序号: "6", 步骤: "Run npm run db:migrate", 结论: success, 标签: behavioral }
      - { job: postgres-integration, 序号: "7", 步骤: "Run npm run db:migrate:integrity:test", 结论: success, 标签: behavioral }
      - { job: postgres-integration, 序号: "8", 步骤: "Run npm run service-principals:integration", 结论: success, 标签: behavioral }
      - { job: postgres-integration, 序号: "9", 步骤: "Run npm run db:migrate:lock:test", 结论: success, 标签: behavioral }
      - { job: postgres-integration, 序号: "10", 步骤: "Run npm run db:verify -- --allow-privileged", 结论: success, 标签: behavioral }
      - { job: postgres-integration, 序号: "11", 步骤: "prep: build console for control-plane integration", 结论: success }
      - { job: postgres-integration, 序号: "12", 步骤: "Run npm run control-plane:integration", 结论: success, 标签: behavioral }
      - { job: postgres-integration, 序号: "22", 步骤: "Post Set up Node.js", 结论: success }
      - { job: postgres-integration, 序号: "23", 步骤: "Post Checkout", 结论: success }
      - { job: postgres-integration, 序号: "24", 步骤: "Stop containers", 结论: success }
      - { job: postgres-integration, 序号: "25", 步骤: "Complete job", 结论: success }
      - { job: node-unit, 序号: "1", 步骤: "Set up job", 结论: success }
      - { job: node-unit, 序号: "2", 步骤: "Checkout", 结论: success }
      - { job: node-unit, 序号: "3", 步骤: "Set up Node.js", 结论: success }
      - { job: node-unit, 序号: "4", 步骤: "Run npm ci", 结论: success }
      - { job: node-unit, 序号: "5", 步骤: "Run npm run deploy:check:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "6", 步骤: "Run npm run deploy:manifest:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "7", 步骤: "Run npm run deploy:images:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "8", 步骤: "Run npm run release:evidence:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "9", 步骤: "Run bash scripts/test-postgres-backup-direct.sh", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "10", 步骤: "Run bash scripts/test-postgres-restore-drill.sh", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "11", 步骤: "Run npm run policy:red-team", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "12", 步骤: "Run npm run runtime:worker:config:test", 结论: success, 标签: static }
      - { job: node-unit, 序号: "13", 步骤: "Run npm run runtime:worker:health:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "14", 步骤: "Run npm run runtime:acceptance:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "15", 步骤: "Run npm run observer:runtime:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "16", 步骤: "Run npm run observer:targets:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "17", 步骤: "Run npm run observer:targets:apply:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "18", 步骤: "Run npm run output-probe:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "19", 步骤: "Run npm run output-probe:config:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "20", 步骤: "Run npm run channel-adapter:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "21", 步骤: "Run npm run alert-notifier:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "22", 步骤: "Run npm run ci:gates:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "23", 步骤: "Run npm run ci:db-fail-closed:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "24", 步骤: "Run npm run ci:evidence:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "25", 步骤: "Run npm run release:workflow:gate:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "26", 步骤: "Run npm run docs:governance:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "51", 步骤: "Post Set up Node.js", 结论: success }
      - { job: node-unit, 序号: "52", 步骤: "Post Checkout", 结论: success }
      - { job: node-unit, 序号: "53", 步骤: "Complete job", 结论: success }
      - { job: compose-render, 序号: "1", 步骤: "Set up job", 结论: success }
      - { job: compose-render, 序号: "2", 步骤: "Checkout", 结论: success }
      - { job: compose-render, 序号: "3", 步骤: "Set up Node.js", 结论: success }
      - { job: compose-render, 序号: "4", 步骤: "Run npm ci", 结论: success }
      - { job: compose-render, 序号: "5", 步骤: "Run docker compose --env-file config/control-plane-compose.example.env -f infra/compose/docker-compose.control-plane.yml config", 结论: success, 标签: static }
      - { job: compose-render, 序号: "6", 步骤: "Run docker compose --env-file config/runtime.example.env --env-file config/runtime-gateway.example.env --env-file config/channel-adapter.example.env --env-file config/alert-notifier.example.env --profile output-probe --profile channel-adapter --profile alert-notifier --profile cosyvoice -f infra/compose/docker-compose.runtime.yml config", 结论: success, 标签: static }
      - { job: compose-render, 序号: "11", 步骤: "Post Set up Node.js", 结论: success }
      - { job: compose-render, 序号: "12", 步骤: "Post Checkout", 结论: success }
      - { job: compose-render, 序号: "13", 步骤: "Complete job", 结论: success }
      - { job: static-gates, 序号: "1", 步骤: "Set up job", 结论: success }
      - { job: static-gates, 序号: "2", 步骤: "Checkout", 结论: success }
      - { job: static-gates, 序号: "3", 步骤: "Set up Node.js", 结论: success }
      - { job: static-gates, 序号: "4", 步骤: "Run npm ci", 结论: success }
      - { job: static-gates, 序号: "5", 步骤: "Run npm run ci:coverage:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "6", 步骤: "Run npm run ci:workflow:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "7", 步骤: "Run npm run ci:action-pins:verify", 结论: success, 标签: static }
      - { job: static-gates, 序号: "8", 步骤: "Run npm run docs:governance:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "9", 步骤: "Run bash -n scripts/check-runtime-host.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "10", 步骤: "Run bash -n scripts/backup-postgres.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "11", 步骤: "Run bash -n scripts/test-postgres-backup-direct.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "12", 步骤: "Run bash -n scripts/restore-postgres-drill.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "13", 步骤: "Run bash -n scripts/test-postgres-restore-drill.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "14", 步骤: "Run bash -n scripts/backup-runtime-gateway-state.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "15", 步骤: "Run bash -n scripts/restore-runtime-gateway-state-drill.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "16", 步骤: "Run bash -n scripts/verify-postgres-backup.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "17", 步骤: "Run bash -n scripts/verify-runtime-gateway-state-backup.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "18", 步骤: "Run bash scripts/check-runtime-host.sh --help", 结论: success, 标签: static }
      - { job: static-gates, 序号: "19", 步骤: "Run npm run deploy:check -- --allow-placeholders", 结论: success, 标签: static }
      - { job: static-gates, 序号: "20", 步骤: "Run npm run release:workflow:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "21", 步骤: "Run npm run backup:automation:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "22", 步骤: "Run npm run control-plane:compose:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "23", 步骤: "Run npm run runtime:compose:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "24", 步骤: "Run npm run console:page-auth:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "25", 步骤: "Run npm run console:security-headers:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "26", 步骤: "Run npm run console:client-requests:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "27", 步骤: "Run npm run membership:authz:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "28", 步骤: "Run npm run membership:scopes:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "29", 步骤: "Run npm run governance:tenant-scope:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "30", 步骤: "Run npm run governance:immutability:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "31", 步骤: "Run npm run program:revisions:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "32", 步骤: "Run npm run program:runtime-scripts:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "33", 步骤: "Run npm run runtime:program-transition:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "34", 步骤: "Run npm run control-room:program-transition:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "35", 步骤: "Run npm run runtime:program-output:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "36", 步骤: "Run npm run preflight:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "37", 步骤: "Run npm run lifecycle:authz:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "38", 步骤: "Run npm run command:confirmation:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "39", 步骤: "Run npm run service-ingest:auth:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "40", 步骤: "Run npm run service-principals:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "41", 步骤: "Run npm run start:ack:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "42", 步骤: "Run npm run runtime:watchdog:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "43", 步骤: "Run npm run runtime:outbox:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "44", 步骤: "Run npm run runtime:telemetry-alerts:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "45", 步骤: "Run npm run entitlement:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "46", 步骤: "Run npm run runtime:media:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "47", 步骤: "Run npm run runtime:voice:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "48", 步骤: "Run npm run runtime:journal:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "49", 步骤: "Run npm run runtime:preview:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "50", 步骤: "Run npm run media:evidence:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "51", 步骤: "Run npm run recording:evidence:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "52", 步骤: "Run npm run runtime:images:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "53", 步骤: "Run npm run output-probe:response:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "54", 步骤: "Run npm run channel:verification:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "55", 步骤: "Run npm run settlement:reconciliation:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "56", 步骤: "Run npm run alert-notifier:health:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "57", 步骤: "Run node --check apps/runtime-worker/index.mjs", 结论: success, 标签: static }
      - { job: static-gates, 序号: "58", 步骤: "Run node --check apps/runtime-observer/index.mjs", 结论: success, 标签: static }
      - { job: static-gates, 序号: "59", 步骤: "Run node --check apps/runtime-observer/targets.mjs", 结论: success, 标签: static }
      - { job: static-gates, 序号: "60", 步骤: "Run node --check apps/output-probe/index.mjs", 结论: success, 标签: static }
      - { job: static-gates, 序号: "61", 步骤: "Run node --check apps/channel-adapter/index.mjs", 结论: success, 标签: static }
      - { job: static-gates, 序号: "62", 步骤: "Run node --check apps/alert-notifier/index.mjs", 结论: success, 标签: static }
      - { job: static-gates, 序号: "63", 步骤: "Run npm run typecheck", 结论: success, 标签: static }
      - { job: static-gates, 序号: "64", 步骤: "Run npm run lint", 结论: success, 标签: static }
      - { job: static-gates, 序号: "65", 步骤: "Run npm run build", 结论: success, 标签: static }
      - { job: static-gates, 序号: "129", 步骤: "Post Set up Node.js", 结论: success }
      - { job: static-gates, 序号: "130", 步骤: "Post Checkout", 结论: success }
      - { job: static-gates, 序号: "131", 步骤: "Complete job", 结论: success }
      - { job: python-gateway, 序号: "1", 步骤: "Set up job", 结论: success }
      - { job: python-gateway, 序号: "2", 步骤: "Checkout", 结论: success }
      - { job: python-gateway, 序号: "3", 步骤: "Set up Python", 结论: success }
      - { job: python-gateway, 序号: "4", 步骤: "Set up Node.js", 结论: success }
      - { job: python-gateway, 序号: "5", 步骤: "Run python3 -m pip install --disable-pip-version-check --no-cache-dir -r runtime/gateway/requirements.txt", 结论: success }
      - { job: python-gateway, 序号: "6", 步骤: "Run npm run runtime:gateway:config:test", 结论: success, 标签: behavioral }
      - { job: python-gateway, 序号: "7", 步骤: "Run npm run runtime:gateway:errors:test", 结论: success, 标签: behavioral }
      - { job: python-gateway, 序号: "8", 步骤: "Run python3 -m py_compile runtime/gateway/*.py scripts/test-runtime-gateway-config.py", 结论: success, 标签: static }
      - { job: python-gateway, 序号: "9", 步骤: "Run python3 scripts/test-runtime-gateway-audio.py", 结论: success, 标签: behavioral }
      - { job: python-gateway, 序号: "10", 步骤: "Run python3 scripts/test-runtime-gateway-concurrency.py", 结论: success, 标签: behavioral }
      - { job: python-gateway, 序号: "11", 步骤: "Run python3 scripts/test-runtime-gateway-state-backup.py", 结论: success, 标签: behavioral }
      - { job: python-gateway, 序号: "12", 步骤: "Run python3 scripts/test-runtime-gateway-state-restore-drill.py", 结论: success, 标签: behavioral }
      - { job: python-gateway, 序号: "22", 步骤: "Post Set up Node.js", 结论: success }
      - { job: python-gateway, 序号: "23", 步骤: "Post Set up Python", 结论: success }
      - { job: python-gateway, 序号: "24", 步骤: "Post Checkout", 结论: success }
      - { job: python-gateway, 序号: "25", 步骤: "Complete job", 结论: success }
    skipped 步骤数: "0"
    node20 弃用告警数: "0"
静态门禁覆盖:
  - { 门禁: "ci:coverage:check", 行为测试: [无] }
  - { 门禁: "ci:workflow:check", 行为测试: [无] }
  - { 门禁: "docs:governance:check", 行为测试: [无] }
  - { 门禁: "deploy:check", 行为测试: [无] }
  - { 门禁: "release:workflow:check", 行为测试: [无] }
  - { 门禁: "backup:automation:check", 行为测试: [无] }
  - { 门禁: "control-plane:compose:check", 行为测试: [无] }
  - { 门禁: "runtime:compose:check", 行为测试: [无] }
  - { 门禁: "console:page-auth:check", 行为测试: [无] }
  - { 门禁: "console:security-headers:check", 行为测试: [无] }
  - { 门禁: "console:client-requests:check", 行为测试: [无] }
  - { 门禁: "membership:authz:check", 行为测试: [无] }
  - { 门禁: "membership:scopes:check", 行为测试: [无] }
  - { 门禁: "governance:tenant-scope:check", 行为测试: [无] }
  - { 门禁: "governance:immutability:check", 行为测试: [无] }
  - { 门禁: "program:revisions:check", 行为测试: [无] }
  - { 门禁: "program:runtime-scripts:check", 行为测试: [无] }
  - { 门禁: "runtime:program-transition:check", 行为测试: [无] }
  - { 门禁: "control-room:program-transition:check", 行为测试: [无] }
  - { 门禁: "runtime:program-output:check", 行为测试: [无] }
  - { 门禁: "preflight:check", 行为测试: [无] }
  - { 门禁: "lifecycle:authz:check", 行为测试: [无] }
  - { 门禁: "command:confirmation:check", 行为测试: [无] }
  - { 门禁: "service-ingest:auth:check", 行为测试: [无] }
  - { 门禁: "service-principals:check", 行为测试: [无] }
  - { 门禁: "start:ack:check", 行为测试: [无] }
  - { 门禁: "runtime:watchdog:check", 行为测试: [无] }
  - { 门禁: "runtime:outbox:check", 行为测试: [无] }
  - { 门禁: "runtime:telemetry-alerts:check", 行为测试: [无] }
  - { 门禁: "entitlement:check", 行为测试: [无] }
  - { 门禁: "runtime:media:check", 行为测试: [无] }
  - { 门禁: "runtime:voice:check", 行为测试: [无] }
  - { 门禁: "runtime:journal:check", 行为测试: [无] }
  - { 门禁: "runtime:preview:check", 行为测试: [无] }
  - { 门禁: "media:evidence:check", 行为测试: [无] }
  - { 门禁: "recording:evidence:check", 行为测试: [无] }
  - { 门禁: "runtime:images:check", 行为测试: [无] }
  - { 门禁: "output-probe:response:check", 行为测试: [无] }
  - { 门禁: "channel:verification:check", 行为测试: [无] }
  - { 门禁: "settlement:reconciliation:check", 行为测试: [无] }
  - { 门禁: "alert-notifier:health:check", 行为测试: [无] }
说明: >-
  依据由 npm run ci:evidence:collect -- --repo pengwenyi4061126-lgtm/shuzhiren --run-id 42009594325 于 2026-11-05 在本机生成
  （设置了用户授权读取 CI 的 GITHUB_TOKEN，退出码 0；token 只放在子进程环境中，没有打印或写入文件），改为本文件的流式写法，
  内容不变；runner 镜像取自各 job 日志 Set up job 步骤的 Runner Image 组。标签由 scripts/lib/verification-log.mjs 的
  createCheckResolver 按当前的 LOCAL_CHECKS、CI_ONLY_STEPS 与 ci.yml 求出后补入，准备步骤（Set up job、Initialize containers、
  Checkout、Set up Node.js、Set up Python、npm ci、prep: 开头的步骤、Post、Stop containers、Complete job）不写标签。
  python-gateway 第 5 步 pip install -r runtime/gateway/requirements.txt 没有写标签：44857e1 把这一步改为按哈希锁文件安装，
  当前的 CI_ONLY_STEPS 中已经没有原命令，门禁无法为它核对标签。
  运行由推送 master 触发，2026-11-05T10:18:19Z 创建，10:35:38Z 结束。job 结论与 job id：docker-build success（127184919094）、
  postgres-integration success（127184919567）、node-unit success（127184919578）、compose-render success（127184919589）、
  static-gates success（127184919601）、python-gateway success（127184919634）。本运行只覆盖 dfb1296（H2 的推流密钥文件权限说明），
  deploy:check:test 为 success。
```

## V-20261105-19 CI #501（run 42023849073，提交 2109ab8）为 success：六个 job 全部通过，没有 skipped 步骤

```yaml
编号: V-20261105-19
类型: 结论
结论: 第 501 次 CI 运行（run 42023849073，提交 2109ab8）的结论为 success，六个 job 的全部步骤为 success，skipped 步骤数为 0
判定: 行为验证
依据来源:
  - 类别: CI 或 Linux 运行
    平台: GitHub Actions
    run id: "42023849073"
    提交: 2109ab8daf7ffe0a12d4c29c31a000c06e65a877
    运行结论: success
    runner 镜像:
      - { job: python-gateway, 镜像: ubuntu-24.04, 版本: "20261101.360.1" }
      - { job: static-gates, 镜像: ubuntu-24.04, 版本: "20261025.353.1" }
      - { job: node-unit, 镜像: ubuntu-24.04, 版本: "20261025.353.1" }
      - { job: docker-build, 镜像: ubuntu-24.04, 版本: "20261025.353.1" }
      - { job: compose-render, 镜像: ubuntu-24.04, 版本: "20261025.353.1" }
      - { job: postgres-integration, 镜像: ubuntu-24.04, 版本: "20261025.353.1" }
    步骤:
      - { job: python-gateway, 序号: "1", 步骤: "Set up job", 结论: success }
      - { job: python-gateway, 序号: "2", 步骤: "Checkout", 结论: success }
      - { job: python-gateway, 序号: "3", 步骤: "Set up Python", 结论: success }
      - { job: python-gateway, 序号: "4", 步骤: "Set up Node.js", 结论: success }
      - { job: python-gateway, 序号: "5", 步骤: "Run python3 -m pip install --disable-pip-version-check --no-cache-dir --require-hashes -r runtime/gateway/requirements.lock", 结论: success, 标签: static }
      - { job: python-gateway, 序号: "6", 步骤: "Run npm run runtime:gateway:config:test", 结论: success, 标签: behavioral }
      - { job: python-gateway, 序号: "7", 步骤: "Run npm run runtime:gateway:errors:test", 结论: success, 标签: behavioral }
      - { job: python-gateway, 序号: "8", 步骤: "Run python3 -m py_compile runtime/gateway/*.py scripts/test-runtime-gateway-config.py", 结论: success, 标签: static }
      - { job: python-gateway, 序号: "9", 步骤: "Run python3 scripts/test-runtime-gateway-audio.py", 结论: success, 标签: behavioral }
      - { job: python-gateway, 序号: "10", 步骤: "Run python3 scripts/test-runtime-gateway-concurrency.py", 结论: success, 标签: behavioral }
      - { job: python-gateway, 序号: "11", 步骤: "Run python3 scripts/test-runtime-gateway-state-backup.py", 结论: success, 标签: behavioral }
      - { job: python-gateway, 序号: "12", 步骤: "Run python3 scripts/test-runtime-gateway-state-restore-drill.py", 结论: success, 标签: behavioral }
      - { job: python-gateway, 序号: "22", 步骤: "Post Set up Node.js", 结论: success }
      - { job: python-gateway, 序号: "23", 步骤: "Post Set up Python", 结论: success }
      - { job: python-gateway, 序号: "24", 步骤: "Post Checkout", 结论: success }
      - { job: python-gateway, 序号: "25", 步骤: "Complete job", 结论: success }
      - { job: static-gates, 序号: "1", 步骤: "Set up job", 结论: success }
      - { job: static-gates, 序号: "2", 步骤: "Checkout", 结论: success }
      - { job: static-gates, 序号: "3", 步骤: "Set up Node.js", 结论: success }
      - { job: static-gates, 序号: "4", 步骤: "Run npm ci", 结论: success }
      - { job: static-gates, 序号: "5", 步骤: "Run npm run ci:coverage:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "6", 步骤: "Run npm run ci:workflow:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "7", 步骤: "Run npm run ci:action-pins:verify", 结论: success, 标签: static }
      - { job: static-gates, 序号: "8", 步骤: "Run npm run docs:governance:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "9", 步骤: "Run bash -n scripts/check-runtime-host.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "10", 步骤: "Run bash -n scripts/backup-postgres.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "11", 步骤: "Run bash -n scripts/test-postgres-backup-direct.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "12", 步骤: "Run bash -n scripts/restore-postgres-drill.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "13", 步骤: "Run bash -n scripts/test-postgres-restore-drill.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "14", 步骤: "Run bash -n scripts/backup-runtime-gateway-state.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "15", 步骤: "Run bash -n scripts/restore-runtime-gateway-state-drill.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "16", 步骤: "Run bash -n scripts/verify-postgres-backup.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "17", 步骤: "Run bash -n scripts/verify-runtime-gateway-state-backup.sh", 结论: success, 标签: static }
      - { job: static-gates, 序号: "18", 步骤: "Run bash scripts/check-runtime-host.sh --help", 结论: success, 标签: static }
      - { job: static-gates, 序号: "19", 步骤: "Run npm run deploy:check -- --allow-placeholders", 结论: success, 标签: static }
      - { job: static-gates, 序号: "20", 步骤: "Run npm run release:workflow:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "21", 步骤: "Run npm run backup:automation:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "22", 步骤: "Run npm run control-plane:compose:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "23", 步骤: "Run npm run runtime:compose:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "24", 步骤: "Run npm run console:page-auth:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "25", 步骤: "Run npm run console:security-headers:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "26", 步骤: "Run npm run console:client-requests:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "27", 步骤: "Run npm run membership:authz:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "28", 步骤: "Run npm run membership:scopes:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "29", 步骤: "Run npm run governance:tenant-scope:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "30", 步骤: "Run npm run governance:immutability:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "31", 步骤: "Run npm run program:revisions:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "32", 步骤: "Run npm run program:runtime-scripts:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "33", 步骤: "Run npm run runtime:program-transition:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "34", 步骤: "Run npm run control-room:program-transition:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "35", 步骤: "Run npm run runtime:program-output:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "36", 步骤: "Run npm run preflight:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "37", 步骤: "Run npm run lifecycle:authz:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "38", 步骤: "Run npm run command:confirmation:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "39", 步骤: "Run npm run service-ingest:auth:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "40", 步骤: "Run npm run service-principals:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "41", 步骤: "Run npm run start:ack:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "42", 步骤: "Run npm run runtime:watchdog:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "43", 步骤: "Run npm run runtime:outbox:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "44", 步骤: "Run npm run runtime:telemetry-alerts:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "45", 步骤: "Run npm run entitlement:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "46", 步骤: "Run npm run runtime:media:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "47", 步骤: "Run npm run runtime:voice:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "48", 步骤: "Run npm run runtime:journal:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "49", 步骤: "Run npm run runtime:preview:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "50", 步骤: "Run npm run media:evidence:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "51", 步骤: "Run npm run recording:evidence:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "52", 步骤: "Run npm run runtime:images:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "53", 步骤: "Run npm run output-probe:response:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "54", 步骤: "Run npm run channel:verification:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "55", 步骤: "Run npm run settlement:reconciliation:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "56", 步骤: "Run npm run alert-notifier:health:check", 结论: success, 标签: static }
      - { job: static-gates, 序号: "57", 步骤: "Run node --check apps/runtime-worker/index.mjs", 结论: success, 标签: static }
      - { job: static-gates, 序号: "58", 步骤: "Run node --check apps/runtime-observer/index.mjs", 结论: success, 标签: static }
      - { job: static-gates, 序号: "59", 步骤: "Run node --check apps/runtime-observer/targets.mjs", 结论: success, 标签: static }
      - { job: static-gates, 序号: "60", 步骤: "Run node --check apps/output-probe/index.mjs", 结论: success, 标签: static }
      - { job: static-gates, 序号: "61", 步骤: "Run node --check apps/channel-adapter/index.mjs", 结论: success, 标签: static }
      - { job: static-gates, 序号: "62", 步骤: "Run node --check apps/alert-notifier/index.mjs", 结论: success, 标签: static }
      - { job: static-gates, 序号: "63", 步骤: "Run npm run typecheck", 结论: success, 标签: static }
      - { job: static-gates, 序号: "64", 步骤: "Run npm run lint", 结论: success, 标签: static }
      - { job: static-gates, 序号: "65", 步骤: "Run npm run build", 结论: success, 标签: static }
      - { job: static-gates, 序号: "129", 步骤: "Post Set up Node.js", 结论: success }
      - { job: static-gates, 序号: "130", 步骤: "Post Checkout", 结论: success }
      - { job: static-gates, 序号: "131", 步骤: "Complete job", 结论: success }
      - { job: node-unit, 序号: "1", 步骤: "Set up job", 结论: success }
      - { job: node-unit, 序号: "2", 步骤: "Checkout", 结论: success }
      - { job: node-unit, 序号: "3", 步骤: "Set up Node.js", 结论: success }
      - { job: node-unit, 序号: "4", 步骤: "Run npm ci", 结论: success }
      - { job: node-unit, 序号: "5", 步骤: "Run npm run deploy:check:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "6", 步骤: "Run npm run deploy:manifest:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "7", 步骤: "Run npm run deploy:images:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "8", 步骤: "Run npm run release:evidence:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "9", 步骤: "Run bash scripts/test-postgres-backup-direct.sh", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "10", 步骤: "Run bash scripts/test-postgres-restore-drill.sh", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "11", 步骤: "Run npm run policy:red-team", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "12", 步骤: "Run npm run runtime:worker:config:test", 结论: success, 标签: static }
      - { job: node-unit, 序号: "13", 步骤: "Run npm run runtime:worker:health:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "14", 步骤: "Run npm run runtime:acceptance:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "15", 步骤: "Run npm run observer:runtime:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "16", 步骤: "Run npm run observer:targets:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "17", 步骤: "Run npm run observer:targets:apply:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "18", 步骤: "Run npm run output-probe:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "19", 步骤: "Run npm run output-probe:config:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "20", 步骤: "Run npm run channel-adapter:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "21", 步骤: "Run npm run alert-notifier:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "22", 步骤: "Run npm run ci:gates:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "23", 步骤: "Run npm run ci:db-fail-closed:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "24", 步骤: "Run npm run ci:evidence:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "25", 步骤: "Run npm run release:workflow:gate:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "26", 步骤: "Run npm run docs:governance:test", 结论: success, 标签: behavioral }
      - { job: node-unit, 序号: "51", 步骤: "Post Set up Node.js", 结论: success }
      - { job: node-unit, 序号: "52", 步骤: "Post Checkout", 结论: success }
      - { job: node-unit, 序号: "53", 步骤: "Complete job", 结论: success }
      - { job: docker-build, 序号: "1", 步骤: "Set up job", 结论: success }
      - { job: docker-build, 序号: "2", 步骤: "Checkout", 结论: success }
      - { job: docker-build, 序号: "3", 步骤: "Set up Node.js", 结论: success }
      - { job: docker-build, 序号: "4", 步骤: "Run npm ci", 结论: success }
      - { job: docker-build, 序号: "5", 步骤: "prep: free runner disk", 结论: success }
      - { job: docker-build, 序号: "6", 步骤: "Run docker build --file apps/console/Dockerfile --tag shuzhiren-control-plane-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "7", 步骤: "Run docker build --file apps/console/Dockerfile --target migrator --tag shuzhiren-control-plane-migrator-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "8", 步骤: "Run docker build --file apps/runtime-worker/Dockerfile --tag shuzhiren-runtime-worker-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "9", 步骤: "Run docker build --file apps/runtime-observer/Dockerfile --tag shuzhiren-runtime-observer-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "10", 步骤: "Run docker build --file apps/output-probe/Dockerfile --tag shuzhiren-output-probe-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "11", 步骤: "Run docker build --file apps/channel-adapter/Dockerfile --tag shuzhiren-channel-adapter-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "12", 步骤: "Run docker build --file apps/alert-notifier/Dockerfile --tag shuzhiren-alert-notifier-ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "13", 步骤: "Run docker build --file runtime/gateway/Dockerfile --tag shuzhiren-runtime-gateway-ci runtime/gateway", 结论: success, 标签: static }
      - { job: docker-build, 序号: "14", 步骤: "Run docker build --load --file runtime/livetalking/Dockerfile --tag shuzhiren/livetalking:ci .", 结论: success, 标签: static }
      - { job: docker-build, 序号: "15", 步骤: "prep: reclaim disk before CosyVoice build", 结论: success }
      - { job: docker-build, 序号: "16", 步骤: "docker build runtime/cosyvoice (committed Miniforge pin)", 结论: success, 标签: static }
      - { job: docker-build, 序号: "31", 步骤: "Post Set up Node.js", 结论: success }
      - { job: docker-build, 序号: "32", 步骤: "Post Checkout", 结论: success }
      - { job: docker-build, 序号: "33", 步骤: "Complete job", 结论: success }
      - { job: compose-render, 序号: "1", 步骤: "Set up job", 结论: success }
      - { job: compose-render, 序号: "2", 步骤: "Checkout", 结论: success }
      - { job: compose-render, 序号: "3", 步骤: "Set up Node.js", 结论: success }
      - { job: compose-render, 序号: "4", 步骤: "Run npm ci", 结论: success }
      - { job: compose-render, 序号: "5", 步骤: "Run docker compose --env-file config/control-plane-compose.example.env -f infra/compose/docker-compose.control-plane.yml config", 结论: success, 标签: static }
      - { job: compose-render, 序号: "6", 步骤: "Run docker compose --env-file config/runtime.example.env --env-file config/runtime-gateway.example.env --env-file config/channel-adapter.example.env --env-file config/alert-notifier.example.env --profile output-probe --profile channel-adapter --profile alert-notifier --profile cosyvoice -f infra/compose/docker-compose.runtime.yml config", 结论: success, 标签: static }
      - { job: compose-render, 序号: "11", 步骤: "Post Set up Node.js", 结论: success }
      - { job: compose-render, 序号: "12", 步骤: "Post Checkout", 结论: success }
      - { job: compose-render, 序号: "13", 步骤: "Complete job", 结论: success }
      - { job: postgres-integration, 序号: "1", 步骤: "Set up job", 结论: success }
      - { job: postgres-integration, 序号: "2", 步骤: "Initialize containers", 结论: success }
      - { job: postgres-integration, 序号: "3", 步骤: "Checkout", 结论: success }
      - { job: postgres-integration, 序号: "4", 步骤: "Set up Node.js", 结论: success }
      - { job: postgres-integration, 序号: "5", 步骤: "Run npm ci", 结论: success }
      - { job: postgres-integration, 序号: "6", 步骤: "Run npm run db:migrate", 结论: success, 标签: behavioral }
      - { job: postgres-integration, 序号: "7", 步骤: "Run npm run db:migrate:integrity:test", 结论: success, 标签: behavioral }
      - { job: postgres-integration, 序号: "8", 步骤: "Run npm run service-principals:integration", 结论: success, 标签: behavioral }
      - { job: postgres-integration, 序号: "9", 步骤: "Run npm run db:migrate:lock:test", 结论: success, 标签: behavioral }
      - { job: postgres-integration, 序号: "10", 步骤: "Run npm run db:verify -- --allow-privileged", 结论: success, 标签: behavioral }
      - { job: postgres-integration, 序号: "11", 步骤: "prep: build console for control-plane integration", 结论: success }
      - { job: postgres-integration, 序号: "12", 步骤: "Run npm run control-plane:integration", 结论: success, 标签: behavioral }
      - { job: postgres-integration, 序号: "22", 步骤: "Post Set up Node.js", 结论: success }
      - { job: postgres-integration, 序号: "23", 步骤: "Post Checkout", 结论: success }
      - { job: postgres-integration, 序号: "24", 步骤: "Stop containers", 结论: success }
      - { job: postgres-integration, 序号: "25", 步骤: "Complete job", 结论: success }
    skipped 步骤数: "0"
    node20 弃用告警数: "0"
静态门禁覆盖:
  - { 门禁: "ci:coverage:check", 行为测试: [无] }
  - { 门禁: "ci:workflow:check", 行为测试: [无] }
  - { 门禁: "docs:governance:check", 行为测试: [无] }
  - { 门禁: "deploy:check", 行为测试: [无] }
  - { 门禁: "release:workflow:check", 行为测试: [无] }
  - { 门禁: "backup:automation:check", 行为测试: [无] }
  - { 门禁: "control-plane:compose:check", 行为测试: [无] }
  - { 门禁: "runtime:compose:check", 行为测试: [无] }
  - { 门禁: "console:page-auth:check", 行为测试: [无] }
  - { 门禁: "console:security-headers:check", 行为测试: [无] }
  - { 门禁: "console:client-requests:check", 行为测试: [无] }
  - { 门禁: "membership:authz:check", 行为测试: [无] }
  - { 门禁: "membership:scopes:check", 行为测试: [无] }
  - { 门禁: "governance:tenant-scope:check", 行为测试: [无] }
  - { 门禁: "governance:immutability:check", 行为测试: [无] }
  - { 门禁: "program:revisions:check", 行为测试: [无] }
  - { 门禁: "program:runtime-scripts:check", 行为测试: [无] }
  - { 门禁: "runtime:program-transition:check", 行为测试: [无] }
  - { 门禁: "control-room:program-transition:check", 行为测试: [无] }
  - { 门禁: "runtime:program-output:check", 行为测试: [无] }
  - { 门禁: "preflight:check", 行为测试: [无] }
  - { 门禁: "lifecycle:authz:check", 行为测试: [无] }
  - { 门禁: "command:confirmation:check", 行为测试: [无] }
  - { 门禁: "service-ingest:auth:check", 行为测试: [无] }
  - { 门禁: "service-principals:check", 行为测试: [无] }
  - { 门禁: "start:ack:check", 行为测试: [无] }
  - { 门禁: "runtime:watchdog:check", 行为测试: [无] }
  - { 门禁: "runtime:outbox:check", 行为测试: [无] }
  - { 门禁: "runtime:telemetry-alerts:check", 行为测试: [无] }
  - { 门禁: "entitlement:check", 行为测试: [无] }
  - { 门禁: "runtime:media:check", 行为测试: [无] }
  - { 门禁: "runtime:voice:check", 行为测试: [无] }
  - { 门禁: "runtime:journal:check", 行为测试: [无] }
  - { 门禁: "runtime:preview:check", 行为测试: [无] }
  - { 门禁: "media:evidence:check", 行为测试: [无] }
  - { 门禁: "recording:evidence:check", 行为测试: [无] }
  - { 门禁: "runtime:images:check", 行为测试: [无] }
  - { 门禁: "output-probe:response:check", 行为测试: [无] }
  - { 门禁: "channel:verification:check", 行为测试: [无] }
  - { 门禁: "settlement:reconciliation:check", 行为测试: [无] }
  - { 门禁: "alert-notifier:health:check", 行为测试: [无] }
说明: >-
  依据由 npm run ci:evidence:collect -- --repo pengwenyi4061126-lgtm/shuzhiren --run-id 42023849073 于 2026-11-05 在本机生成
  （设置了用户授权读取 CI 的 GITHUB_TOKEN，退出码 0；token 只放在子进程环境中，没有打印或写入文件），改为本文件的流式写法，
  内容不变；runner 镜像取自各 job 日志 Set up job 步骤的 Runner Image 组。标签由 scripts/lib/verification-log.mjs 的
  createCheckResolver 按当前的 LOCAL_CHECKS、CI_ONLY_STEPS 与 ci.yml 求出后补入，准备步骤（Set up job、Initialize containers、
  Checkout、Set up Node.js、Set up Python、npm ci、prep: 开头的步骤、Post、Stop containers、Complete job）不写标签。
  python-gateway 第 5 步已是 44857e1 之后按哈希锁文件安装的命令。
  运行由推送 master 触发，2026-11-05T12:02:54Z 创建，12:19:17Z 结束。job 结论与 job id：python-gateway success（127233024768）、
  static-gates success（127233025004）、node-unit success（127233025010）、docker-build success（127233025047）、
  compose-render success（127233025098）、postgres-integration success（127233025396）。本运行覆盖 dfb1296 之后的 17 个提交
  （646d678 至 2109ab8），其中 M8、M9、M11、M12、M21、M24、L17 与 H3、M18 的代码修复提交及其回归测试。截至 2026-11-05，
  本地 master 上 2109ab8 之后的提交（211f379 起）没有推送，没有 CI 运行结果。
```

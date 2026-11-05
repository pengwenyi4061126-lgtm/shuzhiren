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
      - { job: console, 镜像: 待抄录, 版本: 待抄录 }
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
  公开 API 不提供 job 日志，runner 镜像与第 31 步的错误文本须由仓库所有者登录后抄录（任务 3），
  由任务 4.1 补入本条与 CI 根因条目；补入之前 runner 镜像保持"待抄录"。本条是 Readiness_Matrix
  与交接文档引用的失败基线。
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

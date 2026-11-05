# 样例 Audit_Register（不合格）

scripts/test-governance-docs.mjs 的 CLI 用例使用本样例：每条记录违反一条或几条规则，其余报告编号都没有登记。

### C1 标为已修复但缺少修复前失败

```yaml
编号: C1
标题: 标为已修复但缺少修复前失败
来源: 审计报告 §2 C1
来源标记: 已核实
优先级: P0
位置: ["scripts/example.mjs:1"]
状态: 已修复
对应需求: ["8"]
证据: ["审计报告 §2 C1"]
修复:
  提交: 0123456789abcdef0123456789abcdef01234567
  回归测试: [scripts/integration/example.test.mjs]
  修复后通过: { run id: "41900000000" }
```

### C1 重复登记

```yaml
编号: C1
标题: 重复登记
来源: 审计报告 §2 C1
来源标记: 已核实
优先级: P0
位置: ["scripts/example.mjs:1"]
状态: 已确认
对应需求: ["8"]
证据: ["审计报告 §2 C1"]
```

### H1 YAML 解析失败

```yaml
编号: H1
编号: H1
```

### L1 原始描述被改写

```yaml
编号: L1
标题: 原始描述被改写
来源: 审计报告 §5 L1
来源标记: 未标注
原始描述: token 比较不安全
优先级: P0
位置: ["apps/output-probe/index.mjs:36"]
状态: 待复核
对应需求: ["17", "37"]
证据: ["审计报告 §5 L1"]
```

### M10 待复核问题未经核实就写了修复

```yaml
编号: M10
标题: 待复核问题未经核实就写了修复
来源: 审计报告 §4 M10
来源标记: 待复核
优先级: P1
位置: ["apps/runtime-worker/index.mjs:72-74"]
状态: 待复核
对应需求: ["28"]
证据: ["审计报告 §4 M10"]
修复:
  提交: 0123456789abcdef0123456789abcdef01234567
```

### M11 只以 static 检查否定且缺少无需修复

```yaml
编号: M11
标题: 只以 static 检查否定且缺少无需修复
来源: 审计报告 §4 M11
来源标记: 待复核
优先级: P1
位置: ["apps/console/lib/control-plane/outbox.ts:125-134"]
状态: 已否定
对应需求: ["28"]
证据: ["审计报告 §4 M11"]
核实:
  - 提交: 0123456789abcdef0123456789abcdef01234567
    方法: 本机测试
    结论: 已否定
    证据: { 测试名称: "runtime:outbox:check", 命令: "npm run runtime:outbox:check" }
```

### M12 核实缺少方法

```yaml
编号: M12
标题: 核实缺少方法
来源: 审计报告 §4 M12
来源标记: 待复核
优先级: P1
位置: ["infra/postgres/migrations/061_channel_verification_remediation.sql:69-78"]
状态: 已确认
对应需求: ["30"]
证据: ["审计报告 §4 M12"]
核实:
  - 提交: 0123456789abcdef0123456789abcdef01234567
    结论: 已确认
    证据: { 文件: infra/postgres/migrations/061_channel_verification_remediation.sql, 行号范围: "69-78", 推理: 样例 }
```

### M13 状态不在五个取值内

```yaml
编号: M13
标题: 状态不在五个取值内
来源: 审计报告 §4 M13
来源标记: 待复核
优先级: P1
位置: ["infra/postgres/migrations/051_governed_evidence_immutability.sql"]
状态: 已验证
对应需求: ["29"]
证据: ["审计报告 §4 M13"]
```

### M14 对应需求写无但没有理由

```yaml
编号: M14
标题: 对应需求写无但没有理由
来源: 审计报告 §4 M14
来源标记: 待复核
优先级: P1
位置: ["infra/postgres/migrations/054_governed_membership_authorization.sql:24-52"]
状态: 待复核
对应需求: ["无"]
证据: ["审计报告 §4 M14"]
```

### N2 没有 N1 且缺少优先级

```yaml
编号: N2
标题: 没有 N1 且缺少优先级
来源: 本规格执行期间新发现（样例）
来源标记: 新发现
位置: ["apps/console/lib/channels.ts:101-107"]
状态: 待复核
对应需求: ["8"]
证据: ["样例"]
```

export type PreflightCheck = {
  id: string;
  label: string;
  status: "passed" | "blocked";
  detail: string;
};

export function evaluatePreflight(input: { hasApprovedRights: boolean; rightsDetail: string; hasApprovedModelReleases: boolean; modelReleaseDetail: string; hasApprovedPolicyProfile: boolean; policyProfileDetail: string; hasOperator: boolean; hasApprovedSkuVersion: boolean; skuDetail: string; hasFallbackProgram: boolean; channelReady: boolean; channelDetail: string; outputReady: boolean; outputDetail: string; runtimeSessionReady: boolean; runtimeSessionDetail: string; aiDisclosureEnabled: boolean; aigcLabelReady: boolean; aigcLabelDetail: string }) {
  const checks: PreflightCheck[] = [
    { id: "rights", label: "人物与声音授权", status: input.hasApprovedRights ? "passed" : "blocked", detail: input.rightsDetail },
    { id: "model_release", label: "模型与运行时发布包", status: input.hasApprovedModelReleases ? "passed" : "blocked", detail: input.modelReleaseDetail },
    { id: "policy_profile", label: "策略包版本", status: input.hasApprovedPolicyProfile ? "passed" : "blocked", detail: input.policyProfileDetail },
    { id: "sku", label: "SKU 与资质审核", status: input.hasApprovedSkuVersion ? "passed" : "blocked", detail: input.skuDetail },
    { id: "program", label: "节目单与降级策略", status: input.hasFallbackProgram ? "passed" : "blocked", detail: input.hasFallbackProgram ? "已批准的节目单包含备用或人工接管段" : "节目单缺少可用的降级段" },
    { id: "channel", label: "渠道连接与能力", status: input.channelReady ? "passed" : "blocked", detail: input.channelDetail },
    { id: "operator", label: "场控值守", status: input.hasOperator ? "passed" : "blocked", detail: input.hasOperator ? "已指定值守人" : "必须指定场控" },
    { id: "output", label: "推流与备用节目", status: input.outputReady ? "passed" : "blocked", detail: input.outputDetail },
    { id: "runtime_session", label: "运行时会话绑定", status: input.runtimeSessionReady ? "passed" : "blocked", detail: input.runtimeSessionDetail },
    { id: "disclosure", label: "AI 标识", status: input.aiDisclosureEnabled ? "passed" : "blocked", detail: input.aiDisclosureEnabled ? "已启用" : "AI 标识未启用" },
    // 人工智能生成合成内容标识办法: LiveTalking must report the on-screen AIGC label enabled with the run's text.
    { id: "aigc_label", label: "AIGC 标识已启用", status: input.aigcLabelReady ? "passed" : "blocked", detail: input.aigcLabelDetail }
  ];

  return { passed: checks.every((check) => check.status === "passed"), checks };
}

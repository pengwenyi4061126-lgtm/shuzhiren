export type PreflightCheck = {
  id: string;
  label: string;
  status: "passed" | "blocked";
  detail: string;
};

export function evaluatePreflight(input: { hasApprovedRights: boolean; hasApprovedModelReleases: boolean; hasOperator: boolean; hasApprovedSkuVersion: boolean; hasFallbackProgram: boolean; channelReady: boolean; channelDetail: string; outputReady: boolean; outputDetail: string; runtimeSessionReady: boolean; runtimeSessionDetail: string; aiDisclosureEnabled: boolean }) {
  const checks: PreflightCheck[] = [
    { id: "rights", label: "人物与声音授权", status: input.hasApprovedRights ? "passed" : "blocked", detail: input.hasApprovedRights ? "肖像、声音、商品视频和音乐授权有效" : "缺少已批准或未过期的媒体授权" },
    { id: "model_release", label: "模型与运行时发布包", status: input.hasApprovedModelReleases ? "passed" : "blocked", detail: input.hasApprovedModelReleases ? "运行时、口型驱动与语音模型均有已批准发布包" : "缺少已批准的运行时、口型驱动或语音模型发布包" },
    { id: "sku", label: "SKU 与资质审核", status: input.hasApprovedSkuVersion ? "passed" : "blocked", detail: input.hasApprovedSkuVersion ? "商品版本已批准" : "缺少已批准的商品版本" },
    { id: "program", label: "节目单与降级策略", status: input.hasFallbackProgram ? "passed" : "blocked", detail: input.hasFallbackProgram ? "已批准的节目单包含备用或人工接管段" : "节目单缺少可用的降级段" },
    { id: "channel", label: "渠道连接与能力", status: input.channelReady ? "passed" : "blocked", detail: input.channelDetail },
    { id: "operator", label: "场控值守", status: input.hasOperator ? "passed" : "blocked", detail: input.hasOperator ? "已指定值守人" : "必须指定场控" },
    { id: "output", label: "推流与备用节目", status: input.outputReady ? "passed" : "blocked", detail: input.outputDetail },
    { id: "runtime_session", label: "运行时会话绑定", status: input.runtimeSessionReady ? "passed" : "blocked", detail: input.runtimeSessionDetail },
    { id: "disclosure", label: "AI 标识", status: input.aiDisclosureEnabled ? "passed" : "blocked", detail: input.aiDisclosureEnabled ? "已启用" : "AI 标识未启用" }
  ];

  return { passed: checks.every((check) => check.status === "passed"), checks };
}

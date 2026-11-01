import type { LiveRun } from "@/lib/domain";

export const demoRun: LiveRun = {
  id: "run_20261101_001",
  showName: "双十一预热场 · 美妆专场",
  state: "LIVE",
  traceId: "run_20261101_001",
  commandHistory: [
    { id: "cmd_001", action: "START", actorName: "林晓", issuedAt: "2026-11-01T11:00:00.000Z", expectedState: "ARMED", result: "accepted" },
    { id: "cmd_002", action: "HANDOFF", actorName: "陈文", issuedAt: "2026-11-01T11:06:00.000Z", expectedState: "LIVE", result: "accepted" }
  ],
  questions: [
    { id: "q_1", text: "这款敏感肌可以用吗？", detail: "系统已拦截功效/适用人群回答", risk: "high" },
    { id: "q_2", text: "现在拍有赠品吗？", detail: "SKU A-102 · 活动版本 v18", risk: "low" },
    { id: "q_3", text: "主播声音是真的吗？", detail: "白名单回复，预计 2.1 秒", risk: "low" }
  ]
};

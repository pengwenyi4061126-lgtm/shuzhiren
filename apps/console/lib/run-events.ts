import { listAuditEvents } from "@/lib/audit";
import type { RequestContext } from "@/lib/control-plane/auth-context";
import { getRun } from "@/lib/control-plane/store";
import { listOutboxEvents } from "@/lib/control-plane/outbox";
import { listInteractions } from "@/lib/interactions";
import { listAlerts } from "@/lib/monitoring";

export type RunEventCategory = "command" | "media" | "alert" | "interaction" | "audit";

export type RunEvent = {
  id: string;
  category: RunEventCategory;
  occurredAt: string;
  title: string;
  detail: string;
  state?: "accepted" | "pending" | "delivering" | "delivered" | "failed" | "open" | "resolved" | "queued" | "handled";
};

export async function listRunEvents(context: RequestContext, runId: string) {
  const run = await getRun(context, runId);
  if (!run) return null;

  const [outbox, alerts, interactions, audit] = await Promise.all([
    listOutboxEvents(context),
    listAlerts(context, runId),
    listInteractions(context, runId),
    listAuditEvents(context)
  ]);

  const events: RunEvent[] = [
    ...run.commandHistory.map((command) => ({
      id: `command:${command.id}`,
      category: "command" as const,
      occurredAt: command.issuedAt,
      title: commandTitle(command.action),
      detail: `${command.actorName} · 期望状态 ${command.expectedState}`,
      state: "accepted" as const
    })),
    ...outbox.filter((event) => event.command.runId === runId).map((event) => ({
      id: `media:${event.id}`,
      category: "media" as const,
      occurredAt: event.deliveredAt ?? event.createdAt,
      title: mediaTitle(event.command.type),
      detail: `运行时会话 ${event.sessionId} · 第 ${event.attempts} 次投递${event.lastError ? ` · ${event.lastError}` : ""}`,
      state: event.state
    })),
    ...alerts.map((alert) => ({
      id: `alert:${alert.id}`,
      category: "alert" as const,
      occurredAt: alert.resolvedAt ?? alert.openedAt,
      title: alert.status === "resolved" ? `告警已恢复：${alert.code}` : `运行告警：${alert.code}`,
      detail: alert.message,
      state: alert.status
    })),
    ...interactions.map((interaction) => ({
      id: `interaction:${interaction.id}`,
      category: "interaction" as const,
      occurredAt: interaction.handledAt ?? interaction.submittedAt,
      title: interaction.status === "handled" ? "互动已处理" : "观众互动进入队列",
      detail: `${interaction.risk.toUpperCase()} · ${interaction.text}`,
      state: interaction.status
    })),
    ...audit.filter((event) => event.resourceId === runId || event.detail.runId === runId).map((event) => ({
      id: `audit:${event.id}`,
      category: "audit" as const,
      occurredAt: event.occurredAt,
      title: event.type,
      detail: `${event.actorName} · ${formatAuditDetail(event.detail)}`
    }))
  ];

  return events.sort((left, right) => right.occurredAt.localeCompare(left.occurredAt)).slice(0, 250);
}

function commandTitle(action: string) {
  return ({ START: "启动直播", PAUSE: "切入备用节目", HANDOFF: "切入人工接管", RECOVER: "恢复数字人节目", END: "结束直播" } as Record<string, string>)[action] ?? `控制命令：${action}`;
}

function mediaTitle(type: string) {
  return ({ start_program: "媒体指令：启动节目", switch_to_fallback: "媒体指令：切换备用节目", switch_to_human: "媒体指令：切换人工", stop_program: "媒体指令：结束节目" } as Record<string, string>)[type] ?? `媒体指令：${type}`;
}

function formatAuditDetail(detail: Record<string, string | number | boolean | null>) {
  const values = Object.entries(detail).filter(([, value]) => value !== null).map(([key, value]) => `${key}=${String(value)}`);
  return values.length ? values.join(" · ") : "无附加字段";
}

import { readBoundedJson } from "@/lib/bounded-json";
import { channelVerificationStatus, getChannelConnection } from "@/lib/channels";
import type { RequestContext } from "@/lib/control-plane/auth-context";
import { requireSettlementIngestService } from "@/lib/runtime-service-auth";
import { importSettlementBatch, type ImportSettlementBatchInput } from "@/lib/settlements";

export const dynamic = "force-dynamic";

type SettlementIngestBody = ImportSettlementBatchInput & { tenantId: string };

export async function POST(request: Request) {
  try {
    const body = await readBoundedJson(request, 1024 * 1024);
    if (!isSettlementIngestBody(body)) return Response.json({ error: "invalid_settlement_batch" }, { status: 400 });
    requireSettlementIngestService(request, body.tenantId);
    const context: RequestContext = { tenantId: body.tenantId, actorId: "settlement-ingest-service", actorName: "结算账单接入服务", role: "operator" };
    const channel = await getChannelConnection(context, body.channelConnectionId);
    if (!channel) return Response.json({ error: "channel_not_found" }, { status: 404 });
    if (!channelVerificationStatus(channel).active || !channel.capability.supportsWebhook) return Response.json({ error: "channel_not_enabled_for_settlement_ingest" }, { status: 409 });
    const batch = await importSettlementBatch(context, body);
    return Response.json({ data: batch }, { status: batch.duplicate ? 200 : 202 });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "settlement_ingest_rejected" }, { status: error.status });
    throw error;
  }
}

function isSettlementIngestBody(value: unknown): value is SettlementIngestBody {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  return typeof body.tenantId === "string" && body.tenantId.length > 0 && body.tenantId.length <= 200 && typeof body.channelConnectionId === "string" && typeof body.providerStatementRef === "string" && typeof body.periodStart === "string" && typeof body.periodEnd === "string" && typeof body.sourceSha256 === "string" && typeof body.evidenceRef === "string" && Array.isArray(body.lines);
}

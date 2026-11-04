import type { RequestContext } from "@/lib/control-plane/auth-context";
import { recordAuditEvent, recordAuditEventInTransaction } from "@/lib/audit";
import { databasePool, withTenantTransaction } from "@/lib/database";
import { verifyChannelConnectionEvidence } from "@/lib/channel-evidence";

export type ChannelCapability = { channel: string; supportsRtmp: boolean; supportsSrt: boolean; supportsComments: boolean; supportsOutboundReplies: boolean; supportsProductPins: boolean; requiresAiDisclosure: boolean; maxResolution: "720p" | "1080p"; supportsReplay: boolean; supportsWebhook: boolean };
export type ChannelStatus = "connected" | "degraded" | "disabled";
export type OutputProtocol = "rtmp" | "srt";
export type ChannelProvider = "generic-rtmp" | "normalized-webhook-rtmp";
export type ChannelConnection = { id: string; tenantId: string; name: string; provider: ChannelProvider; status: ChannelStatus; outputProtocol: OutputProtocol; capability: ChannelCapability; secretRef: string; lastVerifiedAt?: string; verificationEvidenceRef?: string; verifiedBy?: string };
export type CreateChannelConnectionInput = Pick<ChannelConnection, "name" | "provider" | "outputProtocol" | "secretRef">;
export type ChannelVerificationInput = { status: ChannelStatus };
export const maxChannelVerificationAgeMs = 24 * 60 * 60 * 1000;
const channelVerificationEvidenceRefPattern = /^(?:evidence:\/\/[A-Za-z0-9][A-Za-z0-9._/-]{0,255}|urn:[A-Za-z0-9][A-Za-z0-9:._/-]{0,255})$/;

export interface ChannelAdapter { readonly provider: ChannelProvider; readonly capability: ChannelCapability; supportsOutput(protocol: OutputProtocol): boolean; validateShow(input: { resolution: "720p" | "1080p"; aiDisclosureEnabled: boolean }): string[]; }

export class RtmpOnlyAdapter implements ChannelAdapter {
  readonly provider: ChannelProvider = "generic-rtmp";
  readonly capability: ChannelCapability = { channel: "generic-rtmp", supportsRtmp: true, supportsSrt: false, supportsComments: false, supportsOutboundReplies: false, supportsProductPins: false, requiresAiDisclosure: true, maxResolution: "1080p", supportsReplay: false, supportsWebhook: false };
  supportsOutput(protocol: OutputProtocol) { return protocol === "rtmp"; }
  validateShow(input: { resolution: "720p" | "1080p"; aiDisclosureEnabled: boolean }) { const errors: string[] = []; if (input.resolution === "1080p" && this.capability.maxResolution !== "1080p") errors.push("目标渠道不支持 1080p"); if (this.capability.requiresAiDisclosure && !input.aiDisclosureEnabled) errors.push("目标渠道要求 AI 标识"); return errors; }
}

export class NormalizedWebhookRtmpAdapter implements ChannelAdapter {
  readonly provider: ChannelProvider = "normalized-webhook-rtmp";
  readonly capability: ChannelCapability = { channel: "normalized-webhook-rtmp", supportsRtmp: true, supportsSrt: false, supportsComments: true, supportsOutboundReplies: true, supportsProductPins: false, requiresAiDisclosure: true, maxResolution: "1080p", supportsReplay: false, supportsWebhook: true };
  supportsOutput(protocol: OutputProtocol) { return protocol === "rtmp"; }
  validateShow(input: { resolution: "720p" | "1080p"; aiDisclosureEnabled: boolean }) { const errors: string[] = []; if (input.resolution === "1080p" && this.capability.maxResolution !== "1080p") errors.push("目标渠道不支持 1080p"); if (this.capability.requiresAiDisclosure && !input.aiDisclosureEnabled) errors.push("目标渠道要求 AI 标识"); return errors; }
}

const adapters = new Map<ChannelProvider, ChannelAdapter>([["generic-rtmp", new RtmpOnlyAdapter()], ["normalized-webhook-rtmp", new NormalizedWebhookRtmpAdapter()]]);
export const supportedChannelProviders = [...adapters.keys()];

type ChannelStore = { connections: Map<string, ChannelConnection> };
type PersistentConnectionRow = {
  id: string;
  tenant_id: string;
  name: string;
  provider: ChannelProvider;
  status: ChannelStatus;
  output_protocol: OutputProtocol;
  secret_ref: string;
  capabilities: unknown;
  last_verified_at: Date | string | null;
  verification_evidence_ref: string | null;
  verified_by: string | null;
};

declare global { var shuzhirenChannelStore: ChannelStore | undefined; }

function channelStore(): ChannelStore {
  const adapter = new NormalizedWebhookRtmpAdapter();
  globalThis.shuzhirenChannelStore ??= { connections: new Map([["channel_demo", { id: "channel_demo", tenantId: "tenant_demo", name: "店播 RTMP 主通道", provider: "normalized-webhook-rtmp", status: "connected", outputProtocol: "rtmp", capability: adapter.capability, secretRef: "kms://shuzhiren/tenant_demo/channel/rtmp-main", lastVerifiedAt: "2026-11-01T14:30:00.000Z", verificationEvidenceRef: "evidence://demo/channel-verification-fixture", verifiedBy: "demo-channel-verifier" }]]) };
  return globalThis.shuzhirenChannelStore;
}

export async function listChannelConnections(context: RequestContext) {
  if (!databasePool()) return demoConnections(context);
  return withTenantTransaction(context.tenantId, async (client) => {
    const scopeClause = restrictedMembership(context)
      ? "where exists (select 1 from membership_resource_scopes scope where scope.membership_id = $1::uuid and scope.resource_type = 'channel_connection' and scope.resource_id = channel_connections.id)"
      : "";
    const result = await client.query<PersistentConnectionRow>(
      `select id, tenant_id, name, provider, status, output_protocol, secret_ref, capabilities, last_verified_at, verification_evidence_ref, verified_by from channel_connections ${scopeClause} order by created_at desc`,
      restrictedMembership(context) ? [context.membershipId] : []
    );
    return result.rows.map(persistentConnection);
  });
}

export async function getChannelConnection(context: RequestContext, id: string) {
  if (!databasePool()) {
    const connection = channelStore().connections.get(id);
    return connection?.tenantId === context.tenantId ? connection : null;
  }
  return withTenantTransaction(context.tenantId, async (client) => {
    const scopeClause = restrictedMembership(context)
      ? "and exists (select 1 from membership_resource_scopes scope where scope.membership_id = $2::uuid and scope.resource_type = 'channel_connection' and scope.resource_id = channel_connections.id)"
      : "";
    const result = await client.query<PersistentConnectionRow>(
      `select id, tenant_id, name, provider, status, output_protocol, secret_ref, capabilities, last_verified_at, verification_evidence_ref, verified_by from channel_connections where id = $1 ${scopeClause}`,
      restrictedMembership(context) ? [id, context.membershipId] : [id]
    );
    return result.rows[0] ? persistentConnection(result.rows[0]) : null;
  });
}

export async function createChannelConnection(context: RequestContext, input: CreateChannelConnectionInput) {
  if (restrictedMembership(context)) throw new Response("Restricted members cannot create tenant-wide channel connections", { status: 403 });
  const adapter = getChannelAdapter(input.provider);
  if (!adapter.supportsOutput(input.outputProtocol)) throw new Response(`Adapter ${input.provider} does not support ${input.outputProtocol.toUpperCase()}`, { status: 409 });
  if (!isManagedSecretRef(input.secretRef)) throw new Response("Channel secret reference must use kms:// or secret://", { status: 400 });
  if (!databasePool()) {
    if (demoConnections(context).some((connection) => connection.name === input.name)) throw new Response("Channel connection name already exists", { status: 409 });
    const connection: ChannelConnection = { id: `channel_${crypto.randomUUID()}`, tenantId: context.tenantId, status: "disabled", capability: adapter.capability, ...input };
    channelStore().connections.set(connection.id, connection);
    return connection;
  }
  try {
    return await withTenantTransaction(context.tenantId, async (client) => {
      const result = await client.query<PersistentConnectionRow>(
        "insert into channel_connections (tenant_id, name, provider, status, output_protocol, secret_ref, capabilities) values ($1, $2, $3, 'disabled', $4, $5, $6::jsonb) returning id, tenant_id, name, provider, status, output_protocol, secret_ref, capabilities, last_verified_at, verification_evidence_ref, verified_by",
        [context.tenantId, input.name, input.provider, input.outputProtocol, input.secretRef, JSON.stringify(adapter.capability)]
      );
      return persistentConnection(result.rows[0]);
    });
  } catch (error) {
    if (databaseErrorCode(error) === "23505") throw new Response("Channel connection name already exists", { status: 409 });
    throw error;
  }
}

export async function recordChannelVerification(context: RequestContext, id: string, input: ChannelVerificationInput) {
  const existing = await getChannelConnection(context, id);
  if (!existing) throw new Response("Channel connection not found", { status: 404 });
  const attestation = input.status === "connected" ? await verifyChannelConnectionEvidence(context, existing) : null;
  if (!databasePool()) {
    const connection = channelStore().connections.get(id);
    if (!connection || connection.tenantId !== context.tenantId) throw new Response("Channel connection not found", { status: 404 });
    connection.status = input.status;
    if (attestation) { connection.lastVerifiedAt = attestation.verifiedAt; connection.verificationEvidenceRef = attestation.evidenceRef; connection.verifiedBy = context.actorId; }
    await recordAuditEvent(context, { type: "channel_connection.verified", resource: "channel_connection", resourceId: connection.id, detail: { status: connection.status, protocol: connection.outputProtocol, evidenceRef: connection.verificationEvidenceRef ?? null } });
    return connection;
  }
  return withTenantTransaction(context.tenantId, async (client) => {
    if (restrictedMembership(context)) {
      const allowed = await client.query<{ allowed: boolean }>(
        "select exists (select 1 from membership_resource_scopes where membership_id = $1::uuid and resource_type = 'channel_connection' and resource_id = $2::uuid) as allowed",
        [context.membershipId, id]
      );
      if (!allowed.rows[0]?.allowed) throw new Response("Channel connection not found", { status: 404 });
    }
    const actor = await client.query<{ id: string }>("select sync_control_plane_actor($1::uuid, $2, $3, $4::membership_role) as id", [context.tenantId, context.actorId, context.actorName, context.role]);
    const result = await client.query<PersistentConnectionRow>(attestation
      ? "update channel_connections set status = $2, last_verified_at = $3::timestamptz, verification_evidence_ref = $4, verified_by = $5 where id = $1 returning id, tenant_id, name, provider, status, output_protocol, secret_ref, capabilities, last_verified_at, verification_evidence_ref, verified_by"
      : "update channel_connections set status = $2 where id = $1 returning id, tenant_id, name, provider, status, output_protocol, secret_ref, capabilities, last_verified_at, verification_evidence_ref, verified_by",
      attestation ? [id, input.status, attestation.verifiedAt, attestation.evidenceRef, actor.rows[0].id] : [id, input.status]);
    if (!result.rows[0]) throw new Response("Channel connection not found", { status: 404 });
    const connection = persistentConnection(result.rows[0]);
    await recordAuditEventInTransaction(client, context, { type: "channel_connection.verified", resource: "channel_connection", resourceId: connection.id, detail: { status: connection.status, protocol: connection.outputProtocol, evidenceRef: connection.verificationEvidenceRef ?? null } });
    return connection;
  });
}

export async function validateChannelConnection(context: RequestContext, id: string | undefined, input: { resolution: "720p" | "1080p"; aiDisclosureEnabled: boolean }) {
  const connection = id ? await getChannelConnection(context, id) : null;
  if (!connection) return { passed: false, detail: "未绑定有效的平台连接" };
  const verification = channelVerificationStatus(connection);
  if (!verification.active) return { passed: false, detail: verification.detail };
  let adapter: ChannelAdapter;
  try { adapter = getChannelAdapter(connection.provider); } catch { return { passed: false, detail: `未注册的渠道适配器：${connection.provider}` }; }
  const errors = adapter.validateShow(input);
  if (!adapter.supportsOutput(connection.outputProtocol)) errors.push(`适配器不支持 ${connection.outputProtocol.toUpperCase()}`);
  return errors.length ? { passed: false, detail: errors.join("；") } : { passed: true, detail: `${connection.name} 已验证 · ${connection.outputProtocol.toUpperCase()} · ${adapter.capability.maxResolution}` };
}

export function isChannelProvider(value: unknown): value is ChannelProvider { return typeof value === "string" && adapters.has(value as ChannelProvider); }
export function isChannelVerificationEvidenceRef(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 300 && channelVerificationEvidenceRefPattern.test(value); }
export function channelVerificationStatus(connection: Pick<ChannelConnection, "status" | "lastVerifiedAt" | "verificationEvidenceRef" | "verifiedBy">, now = Date.now()) {
  if (connection.status !== "connected") return { active: false, detail: `渠道连接当前为 ${connection.status}` };
  if (!connection.lastVerifiedAt || !connection.verificationEvidenceRef || !connection.verifiedBy) return { active: false, detail: "渠道连接缺少可审计的验证时间、证据或验证人" };
  if (!isChannelVerificationEvidenceRef(connection.verificationEvidenceRef)) return { active: false, detail: "渠道连接验证证据格式不符合受控引用要求" };
  const verifiedAt = Date.parse(connection.lastVerifiedAt);
  if (!Number.isFinite(verifiedAt) || verifiedAt > now + 60_000 || now - verifiedAt > maxChannelVerificationAgeMs) return { active: false, detail: "渠道连接验证已过期或时间异常（最长 24 小时）" };
  return { active: true, detail: "渠道连接验证有效" };
}

function getChannelAdapter(provider: ChannelProvider) {
  const adapter = adapters.get(provider);
  if (!adapter) throw new Response(`Unsupported channel adapter: ${provider}`, { status: 400 });
  return adapter;
}

function isManagedSecretRef(value: string) { return /^(kms|secret):\/\/[A-Za-z0-9._/-]+$/.test(value); }

export function isChannelCapability(value: unknown): value is ChannelCapability {
  if (!value || typeof value !== "object") return false;
  const capability = value as Record<string, unknown>;
  return typeof capability.channel === "string" && capability.channel.length > 0
    && ["supportsRtmp", "supportsSrt", "supportsComments", "supportsOutboundReplies", "supportsProductPins", "requiresAiDisclosure", "supportsReplay", "supportsWebhook"].every((key) => typeof capability[key] === "boolean")
    && (capability.maxResolution === "720p" || capability.maxResolution === "1080p");
}

function demoConnections(context: RequestContext) {
  return [...channelStore().connections.values()].filter((connection) => connection.tenantId === context.tenantId);
}

function persistentConnection(row: PersistentConnectionRow): ChannelConnection {
  if (!isChannelCapability(row.capabilities)) throw new Error(`Invalid capabilities for channel connection ${row.id}`);
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    provider: row.provider,
    status: row.status,
    outputProtocol: row.output_protocol,
    capability: row.capabilities,
    secretRef: row.secret_ref,
    lastVerifiedAt: row.last_verified_at ? new Date(row.last_verified_at).toISOString() : undefined,
    verificationEvidenceRef: row.verification_evidence_ref ?? undefined,
    verifiedBy: row.verified_by ?? undefined
  };
}

function databaseErrorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function restrictedMembership(context: RequestContext) {
  return context.accessScope === "restricted" && Boolean(context.membershipId);
}

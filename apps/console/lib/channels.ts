import type { RequestContext } from "@/lib/control-plane/auth-context";
import { databasePool, withTenantTransaction } from "@/lib/database";

export type ChannelCapability = { channel: string; supportsRtmp: boolean; supportsSrt: boolean; supportsComments: boolean; supportsProductPins: boolean; requiresAiDisclosure: boolean; maxResolution: "720p" | "1080p"; supportsReplay: boolean; supportsWebhook: boolean };
export type ChannelStatus = "connected" | "degraded" | "disabled";
export type OutputProtocol = "rtmp" | "srt";
export type ChannelProvider = "generic-rtmp" | "normalized-webhook-rtmp";
export type ChannelConnection = { id: string; tenantId: string; name: string; provider: ChannelProvider; status: ChannelStatus; outputProtocol: OutputProtocol; capability: ChannelCapability; secretRef: string; lastVerifiedAt?: string; verificationEvidenceRef?: string };
export type CreateChannelConnectionInput = Pick<ChannelConnection, "name" | "provider" | "outputProtocol" | "secretRef">;
export type ChannelVerificationInput = { status: ChannelStatus; evidenceRef: string };
export const maxChannelVerificationAgeMs = 24 * 60 * 60 * 1000;

export interface ChannelAdapter { readonly provider: ChannelProvider; readonly capability: ChannelCapability; supportsOutput(protocol: OutputProtocol): boolean; validateShow(input: { resolution: "720p" | "1080p"; aiDisclosureEnabled: boolean }): string[]; }

export class RtmpOnlyAdapter implements ChannelAdapter {
  readonly provider: ChannelProvider = "generic-rtmp";
  readonly capability: ChannelCapability = { channel: "generic-rtmp", supportsRtmp: true, supportsSrt: false, supportsComments: false, supportsProductPins: false, requiresAiDisclosure: true, maxResolution: "1080p", supportsReplay: false, supportsWebhook: false };
  supportsOutput(protocol: OutputProtocol) { return protocol === "rtmp"; }
  validateShow(input: { resolution: "720p" | "1080p"; aiDisclosureEnabled: boolean }) { const errors: string[] = []; if (input.resolution === "1080p" && this.capability.maxResolution !== "1080p") errors.push("目标渠道不支持 1080p"); if (this.capability.requiresAiDisclosure && !input.aiDisclosureEnabled) errors.push("目标渠道要求 AI 标识"); return errors; }
}

export class NormalizedWebhookRtmpAdapter implements ChannelAdapter {
  readonly provider: ChannelProvider = "normalized-webhook-rtmp";
  readonly capability: ChannelCapability = { channel: "normalized-webhook-rtmp", supportsRtmp: true, supportsSrt: false, supportsComments: true, supportsProductPins: false, requiresAiDisclosure: true, maxResolution: "1080p", supportsReplay: false, supportsWebhook: true };
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
};

declare global { var shuzhirenChannelStore: ChannelStore | undefined; }

function channelStore(): ChannelStore {
  const adapter = new NormalizedWebhookRtmpAdapter();
  globalThis.shuzhirenChannelStore ??= { connections: new Map([["channel_demo", { id: "channel_demo", tenantId: "tenant_demo", name: "店播 RTMP 主通道", provider: "normalized-webhook-rtmp", status: "connected", outputProtocol: "rtmp", capability: adapter.capability, secretRef: "kms://shuzhiren/tenant_demo/channel/rtmp-main", lastVerifiedAt: "2026-11-01T14:30:00.000Z", verificationEvidenceRef: "demo://channel-verification-fixture" }]]) };
  return globalThis.shuzhirenChannelStore;
}

export async function listChannelConnections(context: RequestContext) {
  if (!databasePool()) return demoConnections(context);
  return withTenantTransaction(context.tenantId, async (client) => {
    const result = await client.query<PersistentConnectionRow>(
      "select id, tenant_id, name, provider, status, output_protocol, secret_ref, capabilities, last_verified_at, verification_evidence_ref from channel_connections order by created_at desc"
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
    const result = await client.query<PersistentConnectionRow>(
      "select id, tenant_id, name, provider, status, output_protocol, secret_ref, capabilities, last_verified_at, verification_evidence_ref from channel_connections where id = $1",
      [id]
    );
    return result.rows[0] ? persistentConnection(result.rows[0]) : null;
  });
}

export async function createChannelConnection(context: RequestContext, input: CreateChannelConnectionInput) {
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
        "insert into channel_connections (tenant_id, name, provider, status, output_protocol, secret_ref, capabilities) values ($1, $2, $3, 'disabled', $4, $5, $6::jsonb) returning id, tenant_id, name, provider, status, output_protocol, secret_ref, capabilities, last_verified_at, verification_evidence_ref",
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
  if (!databasePool()) {
    const connection = channelStore().connections.get(id);
    if (!connection || connection.tenantId !== context.tenantId) throw new Response("Channel connection not found", { status: 404 });
    connection.status = input.status;
    connection.lastVerifiedAt = new Date().toISOString();
    connection.verificationEvidenceRef = input.evidenceRef;
    return connection;
  }
  return withTenantTransaction(context.tenantId, async (client) => {
    const actor = await client.query<{ id: string }>("select sync_control_plane_actor($1::uuid, $2, $3, $4::membership_role) as id", [context.tenantId, context.actorId, context.actorName, context.role]);
    const result = await client.query<PersistentConnectionRow>(
      "update channel_connections set status = $2, last_verified_at = now(), verification_evidence_ref = $3, verified_by = $4 where id = $1 returning id, tenant_id, name, provider, status, output_protocol, secret_ref, capabilities, last_verified_at, verification_evidence_ref",
      [id, input.status, input.evidenceRef, actor.rows[0].id]
    );
    if (!result.rows[0]) throw new Response("Channel connection not found", { status: 404 });
    return persistentConnection(result.rows[0]);
  });
}

export async function validateChannelConnection(context: RequestContext, id: string | undefined, input: { resolution: "720p" | "1080p"; aiDisclosureEnabled: boolean }) {
  const connection = id ? await getChannelConnection(context, id) : null;
  if (!connection) return { passed: false, detail: "未绑定有效的平台连接" };
  if (connection.status !== "connected") return { passed: false, detail: `渠道连接当前为 ${connection.status}` };
  if (!connection.lastVerifiedAt || !connection.verificationEvidenceRef) return { passed: false, detail: "渠道连接缺少可审计的验证证据" };
  const verifiedAt = Date.parse(connection.lastVerifiedAt);
  if (!Number.isFinite(verifiedAt) || Date.now() - verifiedAt > maxChannelVerificationAgeMs) return { passed: false, detail: "渠道连接验证已过期（超过 24 小时）" };
  let adapter: ChannelAdapter;
  try { adapter = getChannelAdapter(connection.provider); } catch { return { passed: false, detail: `未注册的渠道适配器：${connection.provider}` }; }
  const errors = adapter.validateShow(input);
  if (!adapter.supportsOutput(connection.outputProtocol)) errors.push(`适配器不支持 ${connection.outputProtocol.toUpperCase()}`);
  return errors.length ? { passed: false, detail: errors.join("；") } : { passed: true, detail: `${connection.name} 已验证 · ${connection.outputProtocol.toUpperCase()} · ${adapter.capability.maxResolution}` };
}

export function isChannelProvider(value: unknown): value is ChannelProvider { return typeof value === "string" && adapters.has(value as ChannelProvider); }

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
    && ["supportsRtmp", "supportsSrt", "supportsComments", "supportsProductPins", "requiresAiDisclosure", "supportsReplay", "supportsWebhook"].every((key) => typeof capability[key] === "boolean")
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
    verificationEvidenceRef: row.verification_evidence_ref ?? undefined
  };
}

function databaseErrorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

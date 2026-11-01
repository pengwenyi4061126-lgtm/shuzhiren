import type { RequestContext } from "@/lib/control-plane/auth-context";

export type ChannelCapability = { channel: string; supportsRtmp: boolean; supportsSrt: boolean; supportsComments: boolean; supportsProductPins: boolean; requiresAiDisclosure: boolean; maxResolution: "720p" | "1080p"; supportsReplay: boolean; supportsWebhook: boolean };
export type ChannelConnection = { id: string; tenantId: string; name: string; status: "connected" | "degraded" | "disabled"; outputProtocol: "rtmp" | "srt"; capability: ChannelCapability; secretRef: string; lastVerifiedAt: string };

export interface ChannelAdapter { readonly capability: ChannelCapability; validateShow(input: { resolution: "720p" | "1080p"; aiDisclosureEnabled: boolean }): string[]; }

export class RtmpOnlyAdapter implements ChannelAdapter {
  readonly capability: ChannelCapability = { channel: "generic-rtmp", supportsRtmp: true, supportsSrt: false, supportsComments: false, supportsProductPins: false, requiresAiDisclosure: true, maxResolution: "1080p", supportsReplay: false, supportsWebhook: false };
  validateShow(input: { resolution: "720p" | "1080p"; aiDisclosureEnabled: boolean }) { const errors: string[] = []; if (input.resolution === "1080p" && this.capability.maxResolution !== "1080p") errors.push("目标渠道不支持 1080p"); if (this.capability.requiresAiDisclosure && !input.aiDisclosureEnabled) errors.push("目标渠道要求 AI 标识"); return errors; }
}

type ChannelStore = { connections: Map<string, ChannelConnection> };
declare global { var shuzhirenChannelStore: ChannelStore | undefined; }

function channelStore(): ChannelStore {
  const adapter = new RtmpOnlyAdapter();
  globalThis.shuzhirenChannelStore ??= { connections: new Map([["channel_demo", { id: "channel_demo", tenantId: "tenant_demo", name: "店播 RTMP 主通道", status: "connected", outputProtocol: "rtmp", capability: adapter.capability, secretRef: "kms://shuzhiren/tenant_demo/channel/rtmp-main", lastVerifiedAt: "2026-11-01T14:30:00.000Z" }]]) };
  return globalThis.shuzhirenChannelStore;
}

export function listChannelConnections(context: RequestContext) { return [...channelStore().connections.values()].filter((connection) => connection.tenantId === context.tenantId); }
export function getChannelConnection(context: RequestContext, id: string) { const connection = channelStore().connections.get(id); return connection?.tenantId === context.tenantId ? connection : null; }

export function validateChannelConnection(context: RequestContext, id: string | undefined, input: { resolution: "720p" | "1080p"; aiDisclosureEnabled: boolean }) {
  const connection = id ? getChannelConnection(context, id) : null;
  if (!connection) return { passed: false, detail: "未绑定有效的平台连接" };
  if (connection.status !== "connected") return { passed: false, detail: `渠道连接当前为 ${connection.status}` };
  const errors: string[] = [];
  if (connection.outputProtocol === "rtmp" && !connection.capability.supportsRtmp) errors.push("渠道不支持 RTMP");
  if (connection.outputProtocol === "srt" && !connection.capability.supportsSrt) errors.push("渠道不支持 SRT");
  if (input.resolution === "1080p" && connection.capability.maxResolution !== "1080p") errors.push("渠道不支持 1080p");
  if (connection.capability.requiresAiDisclosure && !input.aiDisclosureEnabled) errors.push("渠道要求 AI 标识");
  return errors.length ? { passed: false, detail: errors.join("；") } : { passed: true, detail: `${connection.name} 已验证 · ${connection.outputProtocol.toUpperCase()} · ${connection.capability.maxResolution}` };
}

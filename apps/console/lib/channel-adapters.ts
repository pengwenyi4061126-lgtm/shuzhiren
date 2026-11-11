export type ChannelCapability = {
  channel: string;
  supportsRtmp: boolean;
  supportsSrt: boolean;
  supportsComments: boolean;
  supportsOutboundReplies: boolean;
  supportsProductPins: boolean;
  requiresAiDisclosure: boolean;
  maxResolution: "720p" | "1080p";
  supportsReplay: boolean;
  supportsWebhook: boolean;
};

export type OutputProtocol = "rtmp" | "srt";
export type ChannelProvider = "generic-rtmp" | "normalized-webhook-rtmp";

export interface ChannelAdapter {
  readonly provider: ChannelProvider;
  readonly capability: ChannelCapability;
  supportsOutput(protocol: OutputProtocol): boolean;
  validateShow(input: { resolution: "720p" | "1080p"; aiDisclosureEnabled: boolean }): string[];
}

export class RtmpOnlyAdapter implements ChannelAdapter {
  readonly provider: ChannelProvider = "generic-rtmp";
  readonly capability: ChannelCapability = {
    channel: "generic-rtmp",
    supportsRtmp: true,
    supportsSrt: false,
    supportsComments: false,
    supportsOutboundReplies: false,
    supportsProductPins: false,
    requiresAiDisclosure: true,
    maxResolution: "1080p",
    supportsReplay: false,
    supportsWebhook: false
  };

  supportsOutput(protocol: OutputProtocol) { return protocol === "rtmp"; }

  validateShow(input: { resolution: "720p" | "1080p"; aiDisclosureEnabled: boolean }) {
    const errors: string[] = [];
    if (input.resolution === "1080p" && this.capability.maxResolution !== "1080p") errors.push("目标渠道不支持 1080p");
    if (this.capability.requiresAiDisclosure && !input.aiDisclosureEnabled) errors.push("目标渠道要求 AI 标识");
    return errors;
  }
}

export class NormalizedWebhookRtmpAdapter implements ChannelAdapter {
  readonly provider: ChannelProvider = "normalized-webhook-rtmp";
  readonly capability: ChannelCapability = {
    channel: "normalized-webhook-rtmp",
    supportsRtmp: true,
    supportsSrt: false,
    supportsComments: true,
    supportsOutboundReplies: true,
    supportsProductPins: false,
    requiresAiDisclosure: true,
    maxResolution: "1080p",
    supportsReplay: false,
    supportsWebhook: true
  };

  supportsOutput(protocol: OutputProtocol) { return protocol === "rtmp"; }

  validateShow(input: { resolution: "720p" | "1080p"; aiDisclosureEnabled: boolean }) {
    const errors: string[] = [];
    if (input.resolution === "1080p" && this.capability.maxResolution !== "1080p") errors.push("目标渠道不支持 1080p");
    if (this.capability.requiresAiDisclosure && !input.aiDisclosureEnabled) errors.push("目标渠道要求 AI 标识");
    return errors;
  }
}

export const channelAdapters = new Map<ChannelProvider, ChannelAdapter>([
  ["generic-rtmp", new RtmpOnlyAdapter()],
  ["normalized-webhook-rtmp", new NormalizedWebhookRtmpAdapter()]
]);

export const supportedChannelProviders = [...channelAdapters.keys()];

export function isChannelProvider(value: unknown): value is ChannelProvider {
  return typeof value === "string" && channelAdapters.has(value as ChannelProvider);
}

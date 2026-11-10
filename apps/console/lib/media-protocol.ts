export type MediaCommandPayload = Record<string, string> & { overlaySceneJson?: string; overlaySceneSha256?: string; runtimeAvatarId?: string };
export type MediaCommand = {
  id: string;
  runId: string;
  type: "start_program" | "switch_to_fallback" | "switch_to_human" | "stop_program" | "insert_program" | "resume_program";
  issuedAt: string;
  traceId: string;
  payload: MediaCommandPayload;
};

export function createMediaCommand(input: Omit<MediaCommand, "id" | "issuedAt">): MediaCommand {
  if ((input.payload.overlaySceneJson === undefined) !== (input.payload.overlaySceneSha256 === undefined)) throw new TypeError("Overlay scene JSON and SHA-256 must be provided together");
  return { ...input, id: `media_${crypto.randomUUID()}`, issuedAt: new Date().toISOString() };
}

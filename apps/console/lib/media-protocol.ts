export type MediaCommand = {
  id: string;
  runId: string;
  type: "start_program" | "switch_to_fallback" | "switch_to_human" | "stop_program";
  issuedAt: string;
  traceId: string;
  payload: Record<string, string>;
};

export function createMediaCommand(input: Omit<MediaCommand, "id" | "issuedAt">): MediaCommand {
  return { ...input, id: `media_${crypto.randomUUID()}`, issuedAt: new Date().toISOString() };
}

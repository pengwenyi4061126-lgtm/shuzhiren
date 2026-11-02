export type SpeechCommand = {
  id: string;
  runId: string;
  issuedAt: string;
  traceId: string;
  text: string;
  voice: string;
  interrupt: false;
  productVersionId: string;
  productRevision: number;
};

type SpeechCommandInput = Omit<SpeechCommand, "id" | "issuedAt" | "interrupt"> & { idempotencyKey: string };

export function createSpeechCommand(input: SpeechCommandInput): SpeechCommand {
  const { idempotencyKey, ...command } = input;
  const text = command.text.trim();
  if (!text || text.length > 800) throw new Response("Grounded speech text must be between 1 and 800 characters", { status: 422 });
  if (!isSafeIdentifier(command.voice)) throw new Response("Configured speech voice is invalid", { status: 503 });
  if (!command.runId || command.runId.length > 128 || !command.traceId || command.traceId.length > 256) throw new Response("Speech run binding is invalid", { status: 422 });
  if (!command.productVersionId || command.productVersionId.length > 128 || !Number.isInteger(command.productRevision) || command.productRevision < 1) throw new Response("Speech product evidence is invalid", { status: 422 });
  if (!isSafeSpeechCommandId(idempotencyKey)) throw new Response("Speech idempotency key is invalid", { status: 422 });
  return { ...command, text, id: idempotencyKey, issuedAt: new Date().toISOString(), interrupt: false };
}

function isSafeIdentifier(value: string) {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}

export function isSafeSpeechCommandId(value: string) {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(value);
}

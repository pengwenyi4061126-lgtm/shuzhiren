export const maxInteractiveRequestBytes = 16 * 1024;

export async function readBoundedJson(request: Request, maxBytes = maxInteractiveRequestBytes): Promise<unknown> {
  const advertisedLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(advertisedLength) && advertisedLength > maxBytes) throw new Response("Request body exceeds configured limit", { status: 413 });
  if (!request.body) return null;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      received += next.value.byteLength;
      if (received > maxBytes) {
        await reader.cancel();
        throw new Response("Request body exceeds configured limit", { status: 413 });
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(body)); }
  catch { return null; }
}

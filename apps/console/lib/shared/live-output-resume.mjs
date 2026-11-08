export function canResumeLiveOutput(pending, projectId, requestFingerprint) {
  return Boolean(pending
    && pending.projectId === projectId
    && pending.requestFingerprint === requestFingerprint
    && typeof pending.idempotencyKey === "string"
    && pending.idempotencyKey.length > 0);
}

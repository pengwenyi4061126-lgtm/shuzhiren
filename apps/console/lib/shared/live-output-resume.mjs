export function canResumeLiveOutput(pending, projectId, requestFingerprint) {
  return Boolean(pending
    && pending.projectId === projectId
    && pending.requestFingerprint === requestFingerprint
    && typeof pending.idempotencyKey === "string"
    && pending.idempotencyKey.length > 0);
}

function checkpointKey(projectId) {
  return `shuzhiren:studio:live-output:${encodeURIComponent(projectId)}`;
}

export function readLiveOutputCheckpoint(storage, projectId) {
  if (!projectId) return null;
  try {
    const serialized = storage.getItem(checkpointKey(projectId));
    if (!serialized) return null;
    const pending = JSON.parse(serialized);
    const request = pending?.request;
    const validRequest = request && typeof request.showName === "string"
      && typeof request.channelConnectionId === "string"
      && typeof request.productVersionId === "string"
      && request.creationProjectId === projectId
      && request.aiDisclosureEnabled === true
      && Array.isArray(request.mediaAssetIds)
      && (request.scheduledAt === undefined || typeof request.scheduledAt === "string");
    const validRun = pending?.run === null || (pending?.run && typeof pending.run.id === "string" && typeof pending.run.showName === "string");
    if (!validRequest || !validRun || !canResumeLiveOutput(pending, projectId, pending.requestFingerprint)
      || JSON.stringify(request) !== pending.requestFingerprint) {
      storage.removeItem(checkpointKey(projectId));
      return null;
    }
    return pending;
  } catch {
    return null;
  }
}

export function saveLiveOutputCheckpoint(storage, pending) {
  try {
    storage.setItem(checkpointKey(pending.projectId), JSON.stringify(pending));
    return true;
  } catch {
    return false;
  }
}

export function clearLiveOutputCheckpoint(storage, projectId) {
  if (!projectId) return;
  try { storage.removeItem(checkpointKey(projectId)); } catch { /* Browser storage can be unavailable. */ }
}

export function canResumeLiveOutput(pending, projectId, productVersionId, channelId) {
  return Boolean(pending
    && pending.projectId === projectId
    && pending.productVersionId === productVersionId
    && pending.channelId === channelId
    && pending.run?.id);
}

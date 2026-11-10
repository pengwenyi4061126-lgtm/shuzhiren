export function getProductFactsStatus(facts, now = new Date()) {
  const nowMs = now.getTime();
  const syncedAt = Date.parse(facts.sourceSyncedAt);
  const validFrom = Date.parse(facts.validFrom);
  const validUntil = facts.validUntil ? Date.parse(facts.validUntil) : undefined;
  if (!facts.sourceRef.trim() || !Number.isFinite(syncedAt) || !Number.isFinite(validFrom)) return "invalid";
  if (syncedAt > nowMs + 5 * 60_000 || nowMs - syncedAt > 24 * 60 * 60_000) return "source_stale";
  if (validFrom > nowMs) return "not_yet_valid";
  if (validUntil !== undefined && (!Number.isFinite(validUntil) || validUntil <= nowMs)) return "expired";
  return "current";
}

export function isProductFactsCurrent(facts, now = new Date()) {
  return getProductFactsStatus(facts, now) === "current";
}

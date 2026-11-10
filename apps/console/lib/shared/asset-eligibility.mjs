export function isAssetCurrentlyUsable(asset, now = new Date()) {
  if (!asset || asset.approval !== "approved") return false;
  if (asset.expiresAt === undefined || asset.expiresAt === null) return true;
  if (typeof asset.expiresAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(asset.expiresAt)) return false;
  const parsedExpiry = new Date(`${asset.expiresAt}T00:00:00.000Z`);
  if (!Number.isFinite(parsedExpiry.getTime()) || parsedExpiry.toISOString().slice(0, 10) !== asset.expiresAt) return false;
  return asset.expiresAt >= now.toISOString().slice(0, 10);
}

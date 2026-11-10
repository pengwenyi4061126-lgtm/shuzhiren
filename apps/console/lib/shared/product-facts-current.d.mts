export type ProductFactsStatus = "current" | "source_stale" | "not_yet_valid" | "expired" | "invalid";
export type ProductFactsDates = { sourceRef: string; sourceSyncedAt: string; validFrom: string; validUntil?: string };
export function getProductFactsStatus(facts: ProductFactsDates, now?: Date): ProductFactsStatus;
export function isProductFactsCurrent(facts: ProductFactsDates, now?: Date): boolean;

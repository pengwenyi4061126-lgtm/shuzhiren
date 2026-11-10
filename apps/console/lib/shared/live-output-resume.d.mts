export type LiveOutputRequest = { showName: string; scheduledAt?: string; channelConnectionId: string; productVersionId: string; creationProjectId: string; mediaAssetIds: string[]; aiDisclosureEnabled: true };
export type LiveOutputRequestInput = Omit<LiveOutputRequest, "scheduledAt" | "aiDisclosureEnabled"> & { scheduledAt?: string; avatarBuildJobId: string };
export function buildLiveOutputRequest(input: LiveOutputRequestInput): { request: LiveOutputRequest; requestFingerprint: string };
export type PendingLiveOutput = { projectId: string; requestFingerprint: string; idempotencyKey: string; request: LiveOutputRequest; avatarBuildJobId: string; run: { id: string; showName: string } | null };
export function canResumeLiveOutput(pending: { projectId: string; requestFingerprint: string; idempotencyKey: string } | null, projectId: string, requestFingerprint: string): boolean;
export function readLiveOutputCheckpoint(storage: Pick<Storage, "getItem" | "removeItem">, projectId: string): PendingLiveOutput | null;
export function saveLiveOutputCheckpoint(storage: Pick<Storage, "setItem">, pending: PendingLiveOutput): boolean;
export function clearLiveOutputCheckpoint(storage: Pick<Storage, "removeItem">, projectId: string): void;

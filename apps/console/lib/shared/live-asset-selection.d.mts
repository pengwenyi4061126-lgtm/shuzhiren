export type LiveAssetSelection = { kind: string; id: string };
export function preferProjectLiveAssets<T extends LiveAssetSelection>(defaultAssets: Map<string, T>, projectAssets: T[]): Map<string, T>;

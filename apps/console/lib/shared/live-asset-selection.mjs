const liveKinds = new Set(["portrait", "voice", "product_clip", "music"]);

export function preferProjectLiveAssets(defaultAssets, projectAssets) {
  const selected = new Map(defaultAssets);
  for (const asset of projectAssets) {
    if (liveKinds.has(asset.kind)) selected.set(asset.kind, asset);
  }
  return selected;
}

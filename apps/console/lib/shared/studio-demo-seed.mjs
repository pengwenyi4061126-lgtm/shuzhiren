import { generateProductScript } from "./content-script.mjs";

export const studioDemoProjectName = "Shuzhiren Demo · 双输出";

const preferredAssetKinds = ["portrait_photo", "portrait", "voice", "product_clip", "music"];

export function buildStudioDemoSeedInput({ product, version, assets, now = new Date() }) {
  if (!product?.name || !version?.id || version.status !== "approved" || !version.facts) {
    throw new TypeError("an approved product version is required for the Studio demo seed");
  }
  const assetIds = preferredAssetKinds.flatMap((kind) => {
    const asset = assets.find((candidate) => candidate.kind === kind && isUsable(candidate, now));
    return asset ? [asset.id] : [];
  });
  return {
    name: studioDemoProjectName,
    goal: "用一份内容同时体验录播与直播准备",
    audience: "第一次使用数字人直播的店主",
    outputMode: "both",
    productVersionId: version.id,
    assetIds,
    script: generateProductScript({
      name: product.name,
      goal: "第一次选购时重点看哪些信息",
      audience: "第一次了解这类产品的用户",
      ...version.facts,
      style: "friendly",
      length: "standard"
    })
  };
}

function isUsable(asset, now) {
  if (!asset || asset.approval !== "approved") return false;
  if (!asset.expiresAt) return true;
  const expiry = Date.parse(`${asset.expiresAt}T23:59:59Z`);
  return Number.isFinite(expiry) && expiry >= now.getTime();
}

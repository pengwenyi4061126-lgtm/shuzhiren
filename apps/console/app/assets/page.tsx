import Link from "next/link";
import { BadgeCheck, FileAudio, FileVideo2, Image, Music2, PackageOpen } from "lucide-react";
import { listAssets, type AssetKind } from "@/lib/assets";
import { demoRequestContext } from "@/lib/control-plane/auth-context";

const typeMeta: Record<AssetKind, { label: string; icon: typeof Image }> = { portrait: { label: "肖像", icon: Image }, voice: { label: "声音", icon: FileAudio }, product_clip: { label: "讲品视频", icon: FileVideo2 }, music: { label: "音乐", icon: Music2 } };

export default function AssetsPage() {
  const assets = listAssets(demoRequestContext);
  return <main className="assets-page"><header className="assets-header"><div><p>内容工坊</p><h1>授权资产库</h1><span>人物、声音、商品视频和音乐只能在授权有效期内进入直播场次</span></div><span className="assets-count"><BadgeCheck size={16} />{assets.filter((asset) => asset.approval === "approved").length} 已批准</span></header><section className="assets-table"><div className="assets-row assets-labels"><span>资产</span><span>类型</span><span>授权范围</span><span>有效期</span><span>状态</span></div>{assets.map((asset) => { const meta = typeMeta[asset.kind]; const Icon = meta.icon; return <div className="assets-row" key={asset.id}><div className="asset-name"><Icon size={18} /><div><strong>{asset.name}</strong><small>{asset.source}</small></div></div><span>{meta.label}</span><span>{asset.rightsScope}</span><span>{asset.expiresAt ?? "长期 / 项目授权"}</span><span className="asset-approved"><BadgeCheck size={15} />已批准</span></div>; })}</section><Link className="catalog-back" href="/"><PackageOpen size={16} />返回指挥台</Link></main>;
}

import Link from "next/link";
import { ArrowLeft, BadgeCheck, Boxes, FileCheck2, ShieldAlert } from "lucide-react";
import { pageRequestContext } from "@/lib/control-plane/page-context";
import { isProductFactsCurrent } from "@/lib/catalog";
import { getRunReleaseManifest } from "@/lib/release-manifest";

const labels = { runtime: "运行时", avatar: "形象驱动", lip_sync: "口型驱动", voice: "语音", portrait: "肖像", product_clip: "商品视频", music: "音乐" } as const;

export default async function ReleaseManifestPage(props: PageProps<"/shows/[runId]/manifest">) {
  const { runId } = await props.params;
  const manifest = await getRunReleaseManifest(await pageRequestContext(), runId);
  if (!manifest) return <main className="empty-page"><h1>场次不存在</h1><Link href="/">返回指挥台</Link></main>;
  const active = manifest.product?.approval === "approved" && isProductFactsCurrent(manifest.product.facts) && manifest.policy?.approval === "approved" && manifest.models.length === 3 && manifest.models.every((item) => item.approval === "approved") && manifest.assets.length === 4 && manifest.assets.every((item) => item.approval === "approved");

  return <main className="manifest-page">
    <header className="manifest-header"><div><Link className="back-link" href={`/shows/${manifest.runId}/preflight`}><ArrowLeft size={16} />返回预检</Link><p>发布清单</p><h1>{manifest.showName}</h1><span>场次修订 {manifest.revisionId} 的冻结依赖与当前批准状态。</span></div><div className={active ? "manifest-state active" : "manifest-state blocked"}>{active ? <BadgeCheck size={19} /> : <ShieldAlert size={19} />}{active ? "冻结依赖有效" : "存在失效依赖"}</div></header>
    <section className="manifest-meta"><div><FileCheck2 size={17} /><span>当前状态哈希</span><code>{manifest.sha256}</code></div><div><span>创建快照哈希</span><code>{manifest.frozenSha256 ?? "历史场次未封存；请新建修订"}</code><strong>{manifest.frozenSha256 ? manifest.frozenSnapshotVerified ? "内容校验通过" : "内容校验失败" : ""}</strong></div><div><span>只读接口</span><code>/api/v1/live-runs/{manifest.runId}/release-manifest</code></div></section>
    <section className="manifest-grid">
      <article className="manifest-panel"><div className="manifest-panel-head"><h2>业务与策略</h2><Boxes size={17} /></div><dl className="manifest-facts"><div><dt>商品事实</dt><dd>{manifest.product ? <><strong>{manifest.product.externalSku} · {manifest.product.name}</strong><small>v{manifest.product.revision} · {manifest.product.id}</small><small>来源：{manifest.product.facts.sourceRef}</small><small>同步：{new Date(manifest.product.facts.sourceSyncedAt).toLocaleString("zh-CN")} · 有效至：{manifest.product.facts.validUntil ? new Date(manifest.product.facts.validUntil).toLocaleString("zh-CN") : "长期"}</small></> : "未冻结"}</dd></div><div><dt>策略包</dt><dd>{manifest.policy ? <><strong>{manifest.policy.name} v{manifest.policy.version}</strong><small>{manifest.policy.id}</small><small>证据：{manifest.policy.evidenceRef}</small><small>{manifest.policy.validationSummary}</small></> : "未冻结"}</dd></div></dl></article>
      <article className="manifest-panel"><div className="manifest-panel-head"><h2>模型发布包</h2><span>{manifest.models.length} 项</span></div><div className="manifest-rows">{manifest.models.map((item) => <div className="manifest-row" key={item.id}><span className="manifest-kind">{labels[item.component]}</span><div><strong>{item.name} v{item.version}</strong><small>{item.sourceCommit} · {item.artifactHash}</small></div><b className={item.approval}>{item.approval === "approved" ? "已批准" : "已撤销"}</b></div>)}</div></article>
      <article className="manifest-panel manifest-assets"><div className="manifest-panel-head"><h2>授权素材</h2><span>{manifest.assets.length} 项</span></div><div className="manifest-rows">{manifest.assets.map((item) => <div className="manifest-row" key={item.id}><span className="manifest-kind">{labels[item.kind]}</span><div><strong>{item.name}</strong><small>{item.expiresAt ? `有效至 ${item.expiresAt}` : "长期有效"} · {item.checksum}</small></div><b className={item.approval}>{item.approval === "approved" ? "已批准" : "已撤销"}</b></div>)}</div></article>
    </section>
  </main>;
}

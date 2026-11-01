import Link from "next/link";
import { Package, Plus, ShieldCheck } from "lucide-react";
import { listProducts } from "@/lib/catalog";
import { demoRequestContext } from "@/lib/control-plane/auth-context";

export const dynamic = "force-dynamic";

export default async function ProductsPage() {
  const products = await listProducts(demoRequestContext);
  return <main className="catalog-page"><header className="catalog-header"><div><p>商品中心</p><h1>商品事实版本</h1><span>直播只能引用审核通过的 SKU 版本</span></div><button type="button"><Plus size={16} />新建 SKU</button></header><section className="catalog-table"><div className="catalog-row catalog-labels"><span>SKU</span><span>商品名称</span><span>当前版本</span><span>价格 / 库存</span><span>审批状态</span></div>{products.map((product) => { const version = product.versions[0]; return <div className="catalog-row" key={product.id}><strong>{product.externalSku}</strong><span>{product.name}</span><span>v{version?.revision ?? "-"}</span><span>{version ? `¥${(version.facts.priceCent / 100).toFixed(2)} / ${version.facts.stock}` : "未配置"}</span><span className={version?.status === "approved" ? "approval approved" : "approval draft"}>{version?.status === "approved" ? <><ShieldCheck size={15} />已批准</> : "草稿"}</span></div>; })}</section><Link className="catalog-back" href="/"><Package size={16} />返回指挥台</Link></main>;
}

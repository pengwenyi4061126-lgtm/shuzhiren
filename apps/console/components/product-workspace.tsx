"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { BadgeCheck, ChevronDown, Package, Plus, ShieldCheck, X } from "lucide-react";
import type { Product, ProductFacts, ProductVersion } from "@/lib/catalog";

type Props = { initialProducts: Product[]; canManage: boolean; canApprove: boolean };
type VersionDraft = { price: string; unitCost: string; stock: string; highlights: string; faq: string; sourceRef: string; sourceSyncedAt: string; validFrom: string; validUntil: string };
const isoLocal = () => new Date().toISOString().slice(0, 16);
const emptyVersion = (): VersionDraft => ({ price: "", unitCost: "", stock: "", highlights: "", faq: "", sourceRef: "", sourceSyncedAt: isoLocal(), validFrom: isoLocal(), validUntil: "" });

export function ProductWorkspace({ initialProducts, canManage, canApprove }: Props) {
  const [products, setProducts] = useState(initialProducts);
  const [showProductForm, setShowProductForm] = useState(false);
  const [versionFor, setVersionFor] = useState<string | null>(null);
  const [sku, setSku] = useState("");
  const [name, setName] = useState("");
  const [draft, setDraft] = useState<VersionDraft>(() => emptyVersion());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function request<T>(url: string, init: RequestInit) {
    const response = await fetch(url, init);
    const payload = await response.json().catch(() => null) as { data?: T; error?: string } | null;
    if (!response.ok || !payload?.data) throw new Error(payload?.error || "操作失败，请稍后重试");
    return payload.data;
  }

  async function createProduct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(null); setBusy("product");
    try {
      const product = await request<Product>("/api/v1/products", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ externalSku: sku.trim(), name: name.trim() }) });
      setProducts((current) => [product, ...current]); setSku(""); setName(""); setShowProductForm(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "创建 SKU 失败"); } finally { setBusy(null); }
  }

  async function createVersion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!versionFor) return; setError(null);
    const facts = versionFacts(draft);
    if (!facts) { setError("价格、库存必须为非负数字；卖点与 FAQ 至少各填写一条。"); return; }
    setBusy(`version:${versionFor}`);
    try {
      const version = await request<ProductVersion>(`/api/v1/products/${versionFor}/versions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(facts) });
      setProducts((current) => current.map((product) => product.id === versionFor ? { ...product, versions: [version, ...product.versions] } : product)); setDraft(emptyVersion()); setVersionFor(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "创建版本失败"); } finally { setBusy(null); }
  }

  async function approve(productId: string, versionId: string) {
    setError(null); setBusy(`approve:${versionId}`);
    try {
      const version = await request<ProductVersion>(`/api/v1/products/${productId}/versions/${versionId}/approve`, { method: "POST" });
      setProducts((current) => current.map((product) => product.id === productId ? { ...product, versions: product.versions.map((candidate) => candidate.id === version.id ? version : candidate) } : product));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "批准版本失败"); } finally { setBusy(null); }
  }

  return <main className="catalog-page">
    <header className="catalog-header"><div><p>商品中心</p><h1>商品事实版本</h1><span>直播只能引用审核通过的 SKU 版本</span></div>{canManage ? <button type="button" onClick={() => { setError(null); setShowProductForm(true); }}><Plus size={16} />新建 SKU</button> : null}</header>
    {error ? <p className="catalog-error" role="alert">{error}</p> : null}
    {showProductForm && canManage ? <section className="catalog-form" aria-label="创建商品"><div className="catalog-form-head"><div><h2>新建 SKU</h2><span>SKU 创建后，仍需录入并审批商品事实版本。</span></div><button className="icon-button" type="button" onClick={() => setShowProductForm(false)} aria-label="关闭"><X size={16} /></button></div><form onSubmit={createProduct}><label>SKU<input value={sku} onChange={(event) => setSku(event.target.value)} required maxLength={80} placeholder="例如 A-102" /></label><label>商品名称<input value={name} onChange={(event) => setName(event.target.value)} required maxLength={200} placeholder="例如 氨基酸洁面慕斯" /></label><button disabled={busy === "product"} type="submit">{busy === "product" ? "创建中" : "创建 SKU"}</button></form></section> : null}
    <section className="catalog-table" aria-label="商品事实版本"><div className="catalog-row catalog-labels"><span>SKU</span><span>商品名称</span><span>当前版本</span><span>价格 / 库存</span><span>审批状态</span></div>{products.map((product) => <ProductRow key={product.id} product={product} canManage={canManage} canApprove={canApprove} busy={busy} onNewVersion={() => { setError(null); setVersionFor(product.id); setDraft(emptyVersion()); }} onApprove={approve} />)}</section>
    {versionFor && canManage ? <section className="catalog-form version-form" aria-label="新建商品事实版本"><div className="catalog-form-head"><div><h2>新建事实版本</h2><span>{products.find((product) => product.id === versionFor)?.name}</span></div><button className="icon-button" type="button" onClick={() => setVersionFor(null)} aria-label="关闭"><X size={16} /></button></div><form onSubmit={createVersion}><label>价格（元）<input inputMode="decimal" value={draft.price} onChange={(event) => setDraft({ ...draft, price: event.target.value })} required placeholder="99.00" /></label><label>单位成本（元，可选）<input inputMode="decimal" value={draft.unitCost} onChange={(event) => setDraft({ ...draft, unitCost: event.target.value })} placeholder="32.00" /></label><label>库存<input inputMode="numeric" value={draft.stock} onChange={(event) => setDraft({ ...draft, stock: event.target.value })} required placeholder="286" /></label><label>来源凭据<input value={draft.sourceRef} onChange={(event) => setDraft({ ...draft, sourceRef: event.target.value })} required maxLength={500} placeholder="pim://brand/sku/A-102/revision-18" /></label><label>同步时间<input type="datetime-local" value={draft.sourceSyncedAt} onChange={(event) => setDraft({ ...draft, sourceSyncedAt: event.target.value })} required /></label><label>生效时间<input type="datetime-local" value={draft.validFrom} onChange={(event) => setDraft({ ...draft, validFrom: event.target.value })} required /></label><label>失效时间（可选）<input type="datetime-local" value={draft.validUntil} onChange={(event) => setDraft({ ...draft, validUntil: event.target.value })} /></label><label className="form-wide">直播卖点（每行一条）<textarea value={draft.highlights} onChange={(event) => setDraft({ ...draft, highlights: event.target.value })} required rows={3} placeholder={"氨基酸表活\n按压泡沫"} /></label><label className="form-wide">FAQ / 履约事实（每行一条）<textarea value={draft.faq} onChange={(event) => setDraft({ ...draft, faq: event.target.value })} required rows={3} placeholder={"赠旅行装三件套\n48 小时内发货"} /></label><button disabled={busy === `version:${versionFor}`} type="submit">{busy === `version:${versionFor}` ? "创建中" : "提交草稿版本"}</button></form></section> : null}
    <Link className="catalog-back" href="/"><Package size={16} />返回指挥台</Link>
  </main>;
}

function ProductRow({ product, canManage, canApprove, busy, onNewVersion, onApprove }: { product: Product; canManage: boolean; canApprove: boolean; busy: string | null; onNewVersion: () => void; onApprove: (productId: string, versionId: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const version = product.versions[0];
  return <><div className="catalog-row catalog-product-row"><strong>{product.externalSku}</strong><span>{product.name}</span><span>v{version?.revision ?? "-"}</span><span>{version ? `¥${(version.facts.priceCent / 100).toFixed(2)} / ${version.facts.stock}` : "未配置"}</span><span className={version?.status === "approved" ? "approval approved" : "approval draft"}>{version?.status === "approved" ? <><ShieldCheck size={15} />已批准</> : "草稿"}</span><div className="catalog-actions">{canManage ? <button type="button" className="subtle-button" onClick={onNewVersion}><Plus size={14} />新版本</button> : null}<button type="button" className="icon-button" onClick={() => setExpanded(!expanded)} aria-label="展开版本记录"><ChevronDown className={expanded ? "rotated" : ""} size={16} /></button></div></div>{expanded ? <div className="catalog-version-list">{product.versions.length ? product.versions.map((item) => <article key={item.id} className="catalog-version"><div><strong>v{item.revision}</strong><span className={`approval ${item.status === "approved" ? "approved" : "draft"}`}>{item.status === "approved" ? <><BadgeCheck size={14} />已批准</> : "待审批"}</span></div><p>¥{(item.facts.priceCent / 100).toFixed(2)} · 库存 {item.facts.stock} · 来源：{item.facts.sourceRef}</p><small>同步：{new Date(item.facts.sourceSyncedAt).toLocaleString("zh-CN")} · 有效期：{new Date(item.facts.validFrom).toLocaleString("zh-CN")} 至 {item.facts.validUntil ? new Date(item.facts.validUntil).toLocaleString("zh-CN") : "长期"}</small><small>FAQ：{item.facts.faq.join("；")}</small>{item.status === "draft" ? canApprove ? <button type="button" onClick={() => onApprove(product.id, item.id)} disabled={busy === `approve:${item.id}`}>{busy === `approve:${item.id}` ? "批准中" : "批准版本"}</button> : <em>需审核员或管理员批准</em> : null}</article>) : <div className="catalog-version-empty">还没有可供直播引用的事实版本。</div>}</div> : null}</>;
}

function versionFacts(draft: VersionDraft): ProductFacts | null {
  const price = Number(draft.price); const unitCost = draft.unitCost.trim() ? Number(draft.unitCost) : undefined; const stock = Number(draft.stock); const highlights = toLines(draft.highlights); const faq = toLines(draft.faq);
  const sourceSyncedAtMs = Date.parse(draft.sourceSyncedAt); const validFromMs = Date.parse(draft.validFrom); const validUntilMs = draft.validUntil ? Date.parse(draft.validUntil) : undefined;
  if (!Number.isFinite(price) || price < 0 || (unitCost !== undefined && (!Number.isFinite(unitCost) || unitCost < 0)) || !Number.isInteger(stock) || stock < 0 || !highlights.length || !faq.length || !draft.sourceRef.trim() || !Number.isFinite(sourceSyncedAtMs) || !Number.isFinite(validFromMs) || (validUntilMs !== undefined && (!Number.isFinite(validUntilMs) || validUntilMs <= validFromMs))) return null;
  return { priceCent: Math.round(price * 100), unitCostCent: unitCost === undefined ? undefined : Math.round(unitCost * 100), stock, highlights, faq, sourceRef: draft.sourceRef.trim(), sourceSyncedAt: new Date(sourceSyncedAtMs).toISOString(), validFrom: new Date(validFromMs).toISOString(), validUntil: validUntilMs === undefined ? undefined : new Date(validUntilMs).toISOString() };
}

function toLines(value: string) { return value.split("\n").map((item) => item.trim()).filter(Boolean); }

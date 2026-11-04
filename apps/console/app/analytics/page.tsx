import Link from "next/link";
import { ArrowLeft, BarChart3, CircleDollarSign, MousePointerClick, ShoppingCart, Undo2 } from "lucide-react";
import { AccessDenied } from "@/components/access-denied";
import { getCommerceSummary } from "@/lib/commerce";
import { authorizedPageRequestContext } from "@/lib/control-plane/page-context";
import { listRuns } from "@/lib/control-plane/store";

export const dynamic = "force-dynamic";

export default async function AnalyticsPage() {
  const actor = await authorizedPageRequestContext(["admin", "operator", "reviewer", "analyst"]);
  if (!actor) return <AccessDenied />;
  const runs = await listRuns(actor);
  const rows = await Promise.all(runs.map(async (run) => ({ run, summary: await getCommerceSummary(actor, run.id) })));
  const total = rows.reduce((current, row) => ({ views: current.views + row.summary.views, addToCart: current.addToCart + row.summary.addToCart, paidOrders: current.paidOrders + row.summary.paidOrders, netPaidCents: current.netPaidCents + row.summary.netPaidCents, contributionMarginCents: current.contributionMarginCents === null || row.summary.contributionMarginCents === null ? null : current.contributionMarginCents + row.summary.contributionMarginCents }), { views: 0, addToCart: 0, paidOrders: 0, netPaidCents: 0, contributionMarginCents: 0 as number | null });
  return <main className="analytics-page">
    <header className="analytics-header"><div><Link className="back-link" href="/"><ArrowLeft size={16} />返回指挥台</Link><p>经营数据</p><h1>场次转化与贡献毛利</h1><span>仅汇总经私网渠道适配器验签并幂等接入的无 PII 交易事实；“净回款”是运营估算，不代表平台结算或实际打款。</span><Link className="analytics-settlement-link" href="/settlements">查看平台结算对账</Link></div><span className="analytics-count"><BarChart3 size={16} />{rows.length} 场次</span></header>
    <section className="analytics-metrics" aria-label="经营汇总"><Metric icon={MousePointerClick} label="曝光" value={formatInteger(total.views)} /><Metric icon={ShoppingCart} label="加购" value={formatInteger(total.addToCart)} /><Metric icon={CircleDollarSign} label="支付订单" value={formatInteger(total.paidOrders)} /><Metric icon={CircleDollarSign} label="退款后贡献毛利" value={formatMaybeCny(total.contributionMarginCents)} /></section>
    <section className="analytics-table" aria-label="场次经营数据"><div className="analytics-row analytics-labels analytics-margin-row"><span>场次</span><span>曝光</span><span>加购率</span><span>支付转化</span><span>净回款</span><span>贡献毛利</span><span>退款率</span></div>{rows.length ? rows.map(({ run, summary }) => <article className="analytics-row analytics-margin-row" key={run.id}><div><strong>{run.showName}</strong><small>{run.state} · {run.scheduledAt ? new Date(run.scheduledAt).toLocaleString("zh-CN") : "未排期"}</small></div><span>{formatInteger(summary.views)}</span><span>{formatRate(summary.viewToCartRate)}</span><span>{formatRate(summary.viewToPaidRate)}</span><strong>{formatCny(summary.netPaidCents)}</strong><span title={summary.unitCostCents === null ? "冻结 SKU 未录入单位成本" : `成本 ${formatCny(summary.productCostCents ?? 0)}，支付 ${summary.paidUnits} 件`}>{formatMaybeCny(summary.contributionMarginCents)}</span><span className={summary.refundRate && summary.refundRate > 0.1 ? "analytics-risk" : undefined}>{formatRate(summary.refundRate)}</span></article>) : <div className="analytics-empty"><Undo2 size={21} />暂无场次交易数据</div>}</section>
  </main>;
}

function Metric({ icon: Icon, label, value }: { icon: typeof BarChart3; label: string; value: string }) { return <article className="analytics-metric"><Icon size={18} /><span>{label}</span><strong>{value}</strong></article>; }
function formatInteger(value: number) { return new Intl.NumberFormat("zh-CN").format(value); }
function formatCny(cents: number) { return new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY" }).format(cents / 100); }
function formatMaybeCny(cents: number | null) { return cents === null ? "待录成本" : formatCny(cents); }
function formatRate(value: number | null) { return value === null ? "--" : `${(value * 100).toFixed(1)}%`; }

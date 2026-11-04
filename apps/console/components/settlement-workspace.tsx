"use client";

import { CheckCircle2, CircleDollarSign, FileWarning, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { clientFetch } from "@/lib/client-request";
import type { SettlementBatch, SettlementException } from "@/lib/settlements";

export function SettlementWorkspace({ initialBatches, canResolve }: { initialBatches: SettlementBatch[]; canResolve: boolean }) {
  const [batches, setBatches] = useState(initialBatches);
  const [editing, setEditing] = useState<string | null>(null);
  const [resolution, setResolution] = useState("");
  const [evidenceRef, setEvidenceRef] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function resolve(exceptionId: string) {
    setBusy(exceptionId); setError(null);
    try {
      const response = await clientFetch(`/api/v1/settlement-exceptions/${encodeURIComponent(exceptionId)}/resolve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ resolution, evidenceRef }) });
      const payload = await response.json().catch(() => null) as { data?: SettlementException; error?: string } | null;
      if (!response.ok || !payload?.data) throw new Error(payload?.error || "结算差异结案失败");
      setBatches((current) => current.map((batch) => {
        if (batch.id !== payload.data!.batchId) return batch;
        const exceptions = batch.exceptions.map((exception) => exception.id === payload.data!.id ? payload.data! : exception);
        return { ...batch, exceptions, status: exceptions.some((exception) => exception.status === "open") ? "review_required" : "reconciled" };
      }));
      setEditing(null); setResolution(""); setEvidenceRef("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "结算差异结案失败"); } finally { setBusy(null); }
  }
  if (!batches.length) return <section className="settlement-empty"><CircleDollarSign size={24} />暂无已导入的平台结算账单</section>;
  return <section className="settlement-list" aria-label="平台结算批次">{batches.map((batch) => <SettlementBatchCard key={batch.id} batch={batch} canResolve={canResolve} editing={editing} setEditing={setEditing} resolution={resolution} setResolution={setResolution} evidenceRef={evidenceRef} setEvidenceRef={setEvidenceRef} busy={busy} resolve={resolve} />)}{error ? <p className="settlement-error" role="alert">{error}</p> : null}</section>;
}

function SettlementBatchCard({ batch, canResolve, editing, setEditing, resolution, setResolution, evidenceRef, setEvidenceRef, busy, resolve }: { batch: SettlementBatch; canResolve: boolean; editing: string | null; setEditing: (value: string | null) => void; resolution: string; setResolution: (value: string) => void; evidenceRef: string; setEvidenceRef: (value: string) => void; busy: string | null; resolve: (id: string) => Promise<void> }) {
  const totals = batch.lines.reduce((value, line) => ({ ...value, [line.lineType]: value[line.lineType] + line.amountCents }), { gross_sale: 0, refund: 0, platform_fee: 0, adjustment: 0, payout: 0 } as Record<string, number>);
  const open = batch.exceptions.filter((exception) => exception.status === "open");
  return <article className="settlement-batch"><header><div><span className={`settlement-status ${batch.status}`}>{batch.status === "reconciled" ? "已对账" : batch.status === "review_required" ? "待复核" : "已导入"}</span><strong>{batch.providerStatementRef}</strong><small>{new Date(batch.periodStart).toLocaleString("zh-CN")} 至 {new Date(batch.periodEnd).toLocaleString("zh-CN")}</small></div><span className="settlement-import">{batch.importedBy} · {new Date(batch.importedAt).toLocaleString("zh-CN")}</span></header><dl className="settlement-totals"><Metric label="销售" value={totals.gross_sale} /><Metric label="退款" value={totals.refund} /><Metric label="平台费用" value={totals.platform_fee} /><Metric label="调整" value={totals.adjustment} /><Metric label="平台打款" value={totals.payout} /></dl><p className="settlement-evidence">来源 SHA-256：<code>{batch.sourceSha256}</code> · 证据：<code>{batch.evidenceRef}</code></p>{open.length ? <div className="settlement-exceptions"><h2><FileWarning size={16} />{open.length} 项待复核差异</h2>{batch.exceptions.map((exception) => <ExceptionRow key={exception.id} exception={exception} canResolve={canResolve} editing={editing} setEditing={setEditing} resolution={resolution} setResolution={setResolution} evidenceRef={evidenceRef} setEvidenceRef={setEvidenceRef} busy={busy} resolve={resolve} />)}</div> : <p className="settlement-clear"><CheckCircle2 size={16} />账单行、运营事件和平台打款口径当前无待复核差异。</p>}</article>;
}

function ExceptionRow({ exception, canResolve, editing, setEditing, resolution, setResolution, evidenceRef, setEvidenceRef, busy, resolve }: { exception: SettlementException; canResolve: boolean; editing: string | null; setEditing: (value: string | null) => void; resolution: string; setResolution: (value: string) => void; evidenceRef: string; setEvidenceRef: (value: string) => void; busy: string | null; resolve: (id: string) => Promise<void> }) {
  return <article className={`settlement-exception ${exception.status}`}><header><strong>{exceptionLabel(exception.exceptionType)}</strong><span>{exception.status === "open" ? "待处理" : "已结案"}</span></header><p>{exception.detail}</p><small>{exception.orderReference ? `订单引用：${exception.orderReference} · ` : ""}运营金额：{formatMaybe(exception.expectedAmountCents)} · 平台金额：{formatMaybe(exception.actualAmountCents)}</small>{exception.status === "resolved" ? <blockquote>{exception.resolution}<small>{exception.resolvedBy} · {exception.resolutionEvidenceRef}</small></blockquote> : canResolve ? editing === exception.id ? <div className="settlement-resolve"><textarea value={resolution} onChange={(event) => setResolution(event.target.value)} placeholder="填写结案结论（至少 10 个字符）" /><input value={evidenceRef} onChange={(event) => setEvidenceRef(event.target.value)} placeholder="evidence:// 或 urn: 受控证据引用" /><div><button type="button" onClick={() => { setEditing(null); setResolution(""); setEvidenceRef(""); }}>取消</button><button type="button" disabled={busy === exception.id || resolution.trim().length < 10 || !evidenceRef.trim()} onClick={() => void resolve(exception.id)}>{busy === exception.id ? <LoaderCircle className="button-spinner" size={14} /> : <CheckCircle2 size={14} />}{busy === exception.id ? "提交中" : "确认结案"}</button></div></div> : <button className="settlement-resolve-button" type="button" onClick={() => setEditing(exception.id)}>记录结论并结案</button> : null}</article>;
}

function Metric({ label, value }: { label: string; value: number }) { return <div><dt>{label}</dt><dd>{formatCny(value)}</dd></div>; }
function formatCny(value: number) { return new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY" }).format(value / 100); }
function formatMaybe(value: number | undefined) { return value === undefined ? "--" : formatCny(value); }
function exceptionLabel(value: SettlementException["exceptionType"]) { return ({ missing_operational_event: "缺少运营事件", missing_settlement_line: "缺少账单行", gross_amount_mismatch: "销售金额不一致", refund_amount_mismatch: "退款金额不一致", unattributable_statement_line: "账单行无法归因", statement_net_mismatch: "账单净额不一致" })[value]; }

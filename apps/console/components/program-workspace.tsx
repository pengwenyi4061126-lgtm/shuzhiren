"use client";

import { Check, ChevronDown, ChevronUp, Plus, Save, Send, Trash2 } from "lucide-react";
import { useState } from "react";
import { clientFetch as fetch } from "@/lib/client-request";
import type { ProgramSegmentInput, ShowProgram } from "@/lib/show-program";
import { maxScriptLength, maxScriptVariants } from "@/lib/shared/script-rotation.mjs";
import { ProhibitedTermHints } from "@/components/prohibited-term-hints";
import styles from "./program-workspace.module.css";

type Props = { runId: string; program: ShowProgram; canManage: boolean; canApprove: boolean };
const labels = { prepared_product: "预制讲品", interactive: "受控互动", fallback: "备用节目", human_handoff: "人工接管" } as const;

const iconButtonStyle = { width: 30, height: 30, display: "inline-grid", placeItems: "center", border: "1px solid var(--line)", borderRadius: 4, background: "var(--surface)", color: "var(--muted)", cursor: "pointer" } as const;

/** 可运行段落的"备选话术"列表：至多 4 条，增删、上移下移。主版本仍是"冻结运行脚本"，这里只编辑额外版本。 */
export function ScriptVariantsEditor({ variants, onChange, ariaPrefix }: { variants: string[]; onChange: (next: string[]) => void; ariaPrefix: string }) {
  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= variants.length) return;
    const next = [...variants];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };
  return <div className="script-variants" style={{ gridColumn: "1 / -1", display: "grid", gap: 6, marginTop: 6 }}>
    <small>备选话术 {variants.length}/{maxScriptVariants}，每次下发按顺序轮换，所有版本都需通过审核</small>
    {variants.map((variant, index) => <div key={index} style={{ display: "flex", gap: 4, alignItems: "flex-start" }}>
      <div style={{ flex: 1, minWidth: 0 }}><textarea style={{ width: "100%", minHeight: 40, boxSizing: "border-box", padding: "6px 8px", border: "1px solid var(--line)", borderRadius: 4, font: "inherit", fontSize: 12, resize: "vertical" }} value={variant} maxLength={maxScriptLength} onChange={(event) => onChange(variants.map((item, itemIndex) => itemIndex === index ? event.target.value : item))} aria-label={`${ariaPrefix}备选话术 ${index + 1}`} /><ProhibitedTermHints text={variant} context="script" onChange={(next) => onChange(variants.map((item, itemIndex) => itemIndex === index ? next : item))} /></div>
      <button type="button" style={iconButtonStyle} title="上移备选话术" onClick={() => move(index, -1)} disabled={index === 0}><ChevronUp size={15} /></button>
      <button type="button" style={iconButtonStyle} title="下移备选话术" onClick={() => move(index, 1)} disabled={index === variants.length - 1}><ChevronDown size={15} /></button>
      <button type="button" style={iconButtonStyle} title="删除备选话术" onClick={() => onChange(variants.filter((_, itemIndex) => itemIndex !== index))}><Trash2 size={15} /></button>
    </div>)}
    <button type="button" style={{ justifySelf: "start", width: "auto", display: "inline-flex", alignItems: "center", gap: 5, padding: "0 9px", height: 28, border: "1px solid var(--line)", borderRadius: 4, background: "var(--surface)", color: "var(--green)", fontSize: 12, fontWeight: 700, cursor: "pointer" }} onClick={() => onChange([...variants, ""])} disabled={variants.length >= maxScriptVariants}><Plus size={14} />添加备选话术</button>
  </div>;
}

/** 保存时只提交可运行段落的非空备选话术；其余段落不带该键，与改动前的请求体一致。 */
export function variantsForSave(kind: ProgramSegmentInput["kind"], variants: string[] | undefined): string[] | undefined {
  if (kind !== "prepared_product" && kind !== "interactive") return undefined;
  const kept = (variants ?? []).filter((item) => item.trim().length > 0);
  return kept.length > 0 ? kept : undefined;
}

export function ProgramWorkspace({ runId, program, canManage, canApprove }: Props) {
  const [segments, setSegments] = useState(program.segments);
  const [status, setStatus] = useState<string>();
  const [busy, setBusy] = useState(false);
  const editable = program.editable && canManage;

  function update(index: number, field: keyof ProgramSegmentInput, value: string | number) {
    setSegments((current) => current.map((segment, itemIndex) => itemIndex === index ? { ...segment, [field]: value } : segment));
  }
  function updateVariants(index: number, variants: string[]) {
    setSegments((current) => current.map((segment, itemIndex) => itemIndex === index ? { ...segment, runtimeScriptVariants: variants } : segment));
  }
  function reorder(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= segments.length) return;
    setSegments((current) => current.map((segment, itemIndex) => itemIndex === index ? { ...current[target], position: segment.position } : itemIndex === target ? { ...segment, position: current[target].position } : segment));
  }
  function addSegment() {
    setSegments((current) => [...current, { id: `draft_${crypto.randomUUID()}`, position: current.length + 1, kind: "prepared_product", title: "新节目段落", durationSeconds: 60, productVersionId: current.find((item) => item.productVersionId)?.productVersionId, purpose: "待补充节目目的", runtimeScript: "待审核的运行时口播脚本", fallback: false }]);
  }
  function removeSegment(index: number) {
    setSegments((current) => current.filter((_, itemIndex) => itemIndex !== index).map((segment, itemIndex) => ({ ...segment, position: itemIndex + 1 })));
  }
  async function save() {
    setBusy(true); setStatus(undefined);
    const payload = { segments: segments.map(({ kind, title, durationSeconds, purpose, runtimeScript, runtimeScriptVariants }) => ({ kind, title, durationSeconds, purpose, runtimeScript, ...(variantsForSave(kind, runtimeScriptVariants) ? { runtimeScriptVariants: variantsForSave(kind, runtimeScriptVariants) } : {}) })) };
    const response = await fetch(`/api/v1/live-runs/${runId}/program`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const body = await response.json();
    setBusy(false);
    if (!response.ok) return setStatus(body.error || "保存失败");
    setSegments(body.data.segments); setStatus("节目草稿已保存");
  }
  async function lifecycle(action: "submit_review" | "approve") {
    setBusy(true); setStatus(undefined);
    const response = await fetch(`/api/v1/live-runs/${runId}/lifecycle`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) });
    const body = await response.json();
    setBusy(false);
    setStatus(response.ok ? (action === "approve" ? "节目已批准" : "已提交审核，节目现已冻结") : (body.error || "状态变更失败"));
    if (response.ok) window.location.reload();
  }

  return <article className="program-panel"><div className="program-panel-head"><div><h2>节目段落</h2><span>{segments.length} 个段落 · 仅草稿可编辑，提交审核后冻结</span></div>{editable ? <div className={styles.actions}><button title="新增段落" onClick={addSegment} disabled={busy}><Plus size={16} /></button><button className={styles.command} onClick={save} disabled={busy}><Save size={15} />保存草稿</button><button className={styles.command} onClick={() => lifecycle("submit_review")} disabled={busy}><Send size={15} />提交审核</button></div> : canApprove && program.status === "draft" ? <button className={styles.command} onClick={() => lifecycle("approve")} disabled={busy}><Check size={15} />批准节目</button> : <b>{program.status === "approved" ? "已批准" : "审核中"}</b>}</div>{status ? <p className={styles.feedback}>{status}</p> : null}<ol className="program-list">{segments.map((segment, index) => <li className={`program-item ${segment.fallback ? "fallback" : ""}`} key={segment.id}><div className="segment-order">{index + 1}</div><div className="segment-kind">{editable ? <select className={styles.kindSelect} value={segment.kind} onChange={(event) => update(index, "kind", event.target.value)}>{Object.entries(labels).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}</select> : <span>{labels[segment.kind]}</span>}</div><div className="segment-copy">{editable ? <><input className={styles.titleInput} value={segment.title} onChange={(event) => update(index, "title", event.target.value)} aria-label="节目标题" /><textarea className={styles.purposeInput} value={segment.purpose} onChange={(event) => update(index, "purpose", event.target.value)} aria-label="节目目的" />{segment.kind === "prepared_product" || segment.kind === "interactive" ? <><textarea className={styles.purposeInput} value={segment.runtimeScript ?? ""} maxLength={800} onChange={(event) => update(index, "runtimeScript", event.target.value)} aria-label="冻结运行脚本" /><ProhibitedTermHints text={segment.runtimeScript ?? ""} context="script" onChange={(next) => update(index, "runtimeScript", next)} /></> : null}{segment.kind === "prepared_product" || segment.kind === "interactive" ? <ScriptVariantsEditor variants={segment.runtimeScriptVariants ?? []} onChange={(next) => updateVariants(index, next)} ariaPrefix="" /> : null}</> : <><strong>{segment.title}</strong><p>{segment.purpose}</p>{segment.runtimeScript ? <p>{segment.runtimeScript}</p> : null}{segment.runtimeScriptVariants?.map((variant, variantIndex) => <p key={variantIndex}>备选话术 {variantIndex + 1}：{variant}</p>)}</>}</div>{editable ? <input className={styles.durationInput} type="number" min="0" max="3600" value={segment.durationSeconds} onChange={(event) => update(index, "durationSeconds", Number(event.target.value))} aria-label="时长秒数" /> : <div className="segment-duration">{segment.durationSeconds ? `${segment.durationSeconds}s` : "按人工结束"}</div>}{editable ? <div className={styles.tools}><button title="上移" onClick={() => reorder(index, -1)} disabled={index === 0}><ChevronUp size={15} /></button><button title="下移" onClick={() => reorder(index, 1)} disabled={index === segments.length - 1}><ChevronDown size={15} /></button><button title="删除段落" onClick={() => removeSegment(index)}><Trash2 size={15} /></button></div> : <span className={segment.fallback ? "fallback-tag" : "normal-tag"}>{segment.fallback ? "降级可用" : "主节目"}</span>}</li>)}</ol></article>;
}

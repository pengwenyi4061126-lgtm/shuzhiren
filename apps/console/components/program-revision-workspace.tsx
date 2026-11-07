"use client";

import { Check, LoaderCircle, Plus, Save, Send, Trash2, X } from "lucide-react";
import { useState } from "react";
import { clientFetch as fetch } from "@/lib/client-request";
import type { ProgramSegmentInput } from "@/lib/show-program";
import type { ProgramRevisionRequest } from "@/lib/show-program-revisions";
import { ScriptVariantsEditor, variantsForSave } from "@/components/program-workspace";
import { ProhibitedTermHints } from "@/components/prohibited-term-hints";

type Props = { runId: string; requests: ProgramRevisionRequest[]; canManage: boolean; canApprove: boolean; canCreate: boolean };
const kinds: Array<{ value: ProgramSegmentInput["kind"]; label: string }> = [{ value: "prepared_product", label: "预制讲品" }, { value: "interactive", label: "受控互动" }, { value: "fallback", label: "备用节目" }, { value: "human_handoff", label: "人工接管" }];
const labels = { draft: "草稿", pending_approval: "待审核", approved: "已批准", rejected: "已拒绝", applied: "已应用" } as const;

export function ProgramRevisionWorkspace({ runId, requests, canManage, canApprove, canCreate }: Props) {
  const [items, setItems] = useState(requests);
  const [selectedId, setSelectedId] = useState(requests[0]?.id);
  const [segments, setSegments] = useState<ProgramSegmentInput[]>(requests[0]?.program.segments.map(toInput) ?? []);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [reason, setReason] = useState("");
  const selected = items.find((item) => item.id === selectedId);
  const editable = Boolean(selected?.status === "draft" && canManage);

  function choose(item: ProgramRevisionRequest) { setSelectedId(item.id); setSegments(item.program.segments.map(toInput)); setReason(""); setMessage(undefined); }
  function update(index: number, field: keyof ProgramSegmentInput, value: string | number) { setSegments((current) => current.map((segment, itemIndex) => itemIndex === index ? { ...segment, [field]: value } : segment)); }
  function updateVariants(index: number, variants: string[]) { setSegments((current) => current.map((segment, itemIndex) => itemIndex === index ? { ...segment, runtimeScriptVariants: variants } : segment)); }
  function add() { setSegments((current) => [...current, { kind: "prepared_product", title: "新节目段落", durationSeconds: 60, purpose: "待补充节目目的", runtimeScript: "待审核的运行时口播脚本" }]); }
  function remove(index: number) { setSegments((current) => current.filter((_, itemIndex) => itemIndex !== index)); }
  async function invoke(url: string, init: RequestInit, success: string) {
    setBusy(true); setMessage(undefined);
    try { const response = await fetch(url, init); const body = await response.json(); if (!response.ok) throw new Error(body.error ?? "操作失败"); const item = body.data as ProgramRevisionRequest; setItems((current) => current.some((entry) => entry.id === item.id) ? current.map((entry) => entry.id === item.id ? item : entry) : [item, ...current]); choose(item); setMessage(success); }
    catch (error) { setMessage(error instanceof Error ? error.message : "操作失败"); }
    finally { setBusy(false); }
  }
  const base = `/api/v1/live-runs/${runId}/program-revisions`;
  return <article className="program-panel revision-panel"><div className="program-panel-head"><div><h2>受控节目修订</h2><span>开播前候选版本需重新审核与预检，已开播场次不可替换。</span></div>{canManage && canCreate ? <button className="program-revision-create" type="button" disabled={busy} onClick={() => invoke(base, { method: "POST" }, "候选修订已创建")}>{busy ? <LoaderCircle className="button-spinner" size={15} /> : <Plus size={15} />}新建候选修订</button> : null}</div>
    {message ? <p className="program-revision-feedback">{message}</p> : null}
    <div className="program-revision-body"><aside>{items.length ? items.map((item) => <button type="button" key={item.id} onClick={() => choose(item)} className={item.id === selectedId ? "selected" : ""}><strong>候选 {item.candidateRevisionId.slice(0, 8)}</strong><span>{labels[item.status]}</span><small>{item.createdBy}</small></button>) : <p>暂无候选修订。</p>}</aside><section>{selected ? <Editor selected={selected} segments={segments} editable={editable} canApprove={canApprove} busy={busy} reason={reason} setReason={setReason} update={update} updateVariants={updateVariants} add={add} remove={remove} save={() => invoke(`${base}/${selected.id}`, { method: "PUT", body: JSON.stringify({ segments: segments.map(withSavedVariants) }) }, "候选节目单已保存")} submit={() => invoke(`${base}/${selected.id}/submit`, { method: "POST" }, "候选版本已送审并冻结")} approve={() => invoke(`${base}/${selected.id}/approve`, { method: "POST" }, "候选版本已批准并应用，场次需重新预检")} reject={() => invoke(`${base}/${selected.id}/reject`, { method: "POST", body: JSON.stringify({ reason }) }, "候选版本已拒绝")} /> : <p>创建候选修订后可在此编辑、送审和复核。</p>}</section></div>
  </article>;
}

function Editor({ selected, segments, editable, canApprove, busy, reason, setReason, update, updateVariants, add, remove, save, submit, approve, reject }: { selected: ProgramRevisionRequest; segments: ProgramSegmentInput[]; editable: boolean; canApprove: boolean; busy: boolean; reason: string; setReason: (value: string) => void; update: (index: number, field: keyof ProgramSegmentInput, value: string | number) => void; updateVariants: (index: number, variants: string[]) => void; add: () => void; remove: (index: number) => void; save: () => void; submit: () => void; approve: () => void; reject: () => void; }) {
  if (!editable) return <div className="program-revision-readonly"><header><strong>来源 {selected.sourceRevisionId}</strong><span>{labels[selected.status]}</span></header><ol>{selected.program.segments.map((segment) => <li key={segment.id}><strong>{segment.title}</strong><span>{kinds.find((kind) => kind.value === segment.kind)?.label} · {segment.durationSeconds ? `${segment.durationSeconds}s` : "人工结束"}</span><p>{segment.purpose}</p>{segment.runtimeScriptVariants?.map((variant, variantIndex) => <p key={variantIndex}>备选话术 {variantIndex + 1}：{variant}</p>)}</li>)}</ol>{selected.status === "pending_approval" && canApprove ? <div className="program-revision-review"><textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="拒绝时填写原因" maxLength={1000} /><button type="button" disabled={busy} onClick={approve}><Check size={15} />批准并应用</button><button type="button" disabled={busy || reason.trim().length === 0} onClick={reject}><X size={15} />拒绝</button></div> : null}{selected.rejectionReason ? <p className="program-revision-rejection">拒绝原因：{selected.rejectionReason}</p> : null}</div>;
  return <div className="program-revision-editor"><header><strong>候选节目单</strong><span>编辑后必须送审，送审后不可改写。</span></header>{segments.map((segment, index) => <div className="program-revision-segment" key={`${index}-${segment.title}`}><select value={segment.kind} onChange={(event) => update(index, "kind", event.target.value)}>{kinds.map((kind) => <option key={kind.value} value={kind.value}>{kind.label}</option>)}</select><input value={segment.title} onChange={(event) => update(index, "title", event.target.value)} aria-label="候选节目标题" /><input type="number" min="0" max="3600" value={segment.durationSeconds} onChange={(event) => update(index, "durationSeconds", Number(event.target.value))} aria-label="候选节目时长" /><textarea value={segment.purpose} onChange={(event) => update(index, "purpose", event.target.value)} aria-label="候选节目目的" />{segment.kind === "prepared_product" || segment.kind === "interactive" ? <><textarea value={segment.runtimeScript ?? ""} maxLength={800} onChange={(event) => update(index, "runtimeScript", event.target.value)} aria-label="候选运行脚本" /><ProhibitedTermHints text={segment.runtimeScript ?? ""} context="script" onChange={(next) => update(index, "runtimeScript", next)} /></> : null}{segment.kind === "prepared_product" || segment.kind === "interactive" ? <ScriptVariantsEditor variants={segment.runtimeScriptVariants ?? []} onChange={(next) => updateVariants(index, next)} ariaPrefix="候选" /> : null}<button type="button" title="删除段落" onClick={() => remove(index)}><Trash2 size={15} /></button></div>)}<button type="button" className="program-revision-add" onClick={add}><Plus size={15} />添加段落</button><div className="program-revision-actions"><button type="button" disabled={busy} onClick={save}><Save size={15} />保存草稿</button><button type="button" disabled={busy} onClick={submit}><Send size={15} />送审并冻结</button></div></div>;
}

function toInput(segment: ProgramRevisionRequest["program"]["segments"][number]): ProgramSegmentInput { return { kind: segment.kind, title: segment.title, durationSeconds: segment.durationSeconds, purpose: segment.purpose, runtimeScript: segment.runtimeScript, ...(segment.runtimeScriptVariants?.length ? { runtimeScriptVariants: segment.runtimeScriptVariants } : {}) }; }
function withSavedVariants({ runtimeScriptVariants, ...segment }: ProgramSegmentInput): ProgramSegmentInput { const kept = variantsForSave(segment.kind, runtimeScriptVariants); return kept ? { ...segment, runtimeScriptVariants: kept } : segment; }

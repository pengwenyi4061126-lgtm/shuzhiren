"use client";

import { useCallback, useEffect, useState } from "react";
import { CircleHelp, RefreshCw } from "lucide-react";
import type { UncertainCommandView } from "@/lib/control-plane/uncertain-commands";
import { clientFetch } from "@/lib/client-request";

type Resolution = "completed" | "failed_definite";
const noteMaxChars = 500;
const reasonLabels: Record<string, string> = {
  livetalking_timeout: "LiveTalking 超时",
  partial_execution: "部分步骤已执行",
  execution_interrupted: "执行被中断",
  gateway_restarted_during_execution: "执行中 Gateway 重启",
  journal_finalize_failed: "结果写入失败",
  legacy_reserved: "旧版本遗留预留",
  gateway_internal_error: "Gateway 内部错误"
};

// Commands the Runtime Gateway could not tell had run (Requirement 19.9-19.11). An admin checks the media session,
// records the outcome here, and then redelivers the outbox event: the Gateway answers a command resolved as
// completed with its recorded receipt and one resolved as failed_definite with its recorded failure.
export function UncertainCommandsPanel({ onResolved }: { onResolved?: () => void | Promise<void> }) {
  const [commands, setCommands] = useState<UncertainCommandView[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [resolution, setResolution] = useState<Resolution | null>(null);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const apply = useCallback((result: LoadResult) => {
    if ("commands" in result) setCommands(result.commands);
    setError("error" in result ? result.error : null);
    setLoading(false);
  }, []);

  async function load() {
    setLoading(true);
    setError(null);
    apply(await fetchUncertainCommands());
  }

  useEffect(() => {
    let cancelled = false;
    void fetchUncertainCommands().then((result) => { if (!cancelled) apply(result); });
    return () => { cancelled = true; };
  }, [apply]);

  function choose(command: UncertainCommandView) {
    setSelected(command.commandId);
    setResolution(null);
    setNote("");
    setMessage(null);
    setError(null);
  }

  async function submit(command: UncertainCommandView) {
    if (submitting || !resolution || !note.trim() || note.length > noteMaxChars) return;
    setSubmitting(true);
    setError(null);
    setMessage(null);
    try {
      const response = await clientFetch(`/api/v1/runtime/uncertain-commands/${encodeURIComponent(command.commandId)}/resolution`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ resolution, note }) });
      const payload = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok && payload?.error !== "resolution_audit_failed") throw new Error(resolutionError(payload?.error));
      setCommands((items) => items?.filter((item) => item.commandId !== command.commandId) ?? items);
      setSelected(null);
      setNote("");
      setMessage(payload?.error === "resolution_audit_failed"
        ? "Gateway 已记录处置，但审计事件写入失败，请联系管理员补记。可在投递队列中核对后重新投递。"
        : "已处置。请在投递队列中对该命令点击“核对后重新投递”。");
      await onResolved?.();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "处置失败"); } finally { setSubmitting(false); }
  }

  return <section className="uncertain-panel" aria-label="结果不确定的命令">
    <header><div><strong><CircleHelp size={15} />结果不确定的命令</strong><span>Gateway 无法确认这些命令是否已在媒体会话生效。请先人工核对媒体会话，再记录结论；结论会写入审计。</span></div><button type="button" className="subtle-button" disabled={loading} onClick={() => void load()}><RefreshCw size={14} />刷新</button></header>
    {error ? <p className="catalog-error" role="alert">{error}</p> : null}
    {message ? <p className="uncertain-message" role="status">{message}</p> : null}
    {commands === null ? <div className="outbox-empty">{loading ? "读取中" : "未读取"}</div> : commands.length === 0 ? <div className="outbox-empty">没有结果不确定的命令</div> : <ul>{commands.map((command) => <li key={command.commandId}>
      <div className="uncertain-summary">
        <div><strong>{command.kind === "media" ? command.action ?? "media" : "speech"}</strong><code>{command.commandId}</code></div>
        <div><small>直播 {command.runId}</small><small>会话 {command.sessionId ?? "未知"}</small></div>
        <div><small>原因：{reasonLabels[command.reason ?? ""] ?? command.reason ?? "未知"}</small><small>已完成步骤：{command.succeededSteps.length ? command.succeededSteps.join(" → ") : "无"}{command.failedStep ? `；失败于 ${command.failedStep}` : ""}</small></div>
        <div><small>{command.uncertainAt ? `标记于 ${new Date(command.uncertainAt).toLocaleString("zh-CN")}` : ""}</small><button type="button" className="subtle-button" disabled={submitting} onClick={() => choose(command)}>处置</button></div>
      </div>
      {selected === command.commandId ? <form className="uncertain-form" onSubmit={(event) => { event.preventDefault(); void submit(command); }}>
        <fieldset>
          <legend>核对结论</legend>
          <label><input type="radio" name={`resolution-${command.commandId}`} value="completed" checked={resolution === "completed"} disabled={!command.identityAvailable} onChange={() => setResolution("completed")} />已生效（completed）</label>
          <label><input type="radio" name={`resolution-${command.commandId}`} value="failed_definite" checked={resolution === "failed_definite"} onChange={() => setResolution("failed_definite")} />未生效（failed_definite）</label>
          {!command.identityAvailable ? <small>该命令缺少原始载荷，只能记录为未生效。</small> : null}
        </fieldset>
        <label>核对说明<textarea value={note} maxLength={noteMaxChars} required onChange={(event) => setNote(event.target.value)} placeholder="例如：已在媒体会话确认画面切换到兜底素材" /></label>
        <div><small>{note.length}/{noteMaxChars}</small><button type="button" className="subtle-button" disabled={submitting} onClick={() => setSelected(null)}>取消</button><button type="submit" className="subtle-button" disabled={submitting || !resolution || !note.trim()}>{submitting ? "提交中" : "提交处置"}</button></div>
      </form> : null}
    </li>)}</ul>}
  </section>;
}

type LoadResult = { commands: UncertainCommandView[] } | { error: string };
async function fetchUncertainCommands(): Promise<LoadResult> {
  try {
    const response = await clientFetch("/api/v1/runtime/uncertain-commands", { cache: "no-store" });
    const payload = await response.json().catch(() => null) as { data?: UncertainCommandView[]; error?: string } | null;
    if (response.ok && Array.isArray(payload?.data)) return { commands: payload.data };
    return { error: payload?.error === "runtime_unavailable" ? "Runtime Gateway 不可用" : payload?.error || "无法读取结果不确定的命令" };
  } catch (cause) { return { error: cause instanceof Error ? cause.message : "无法读取结果不确定的命令" }; }
}

function resolutionError(code: string | undefined) {
  if (code === "command_not_uncertain") return "该命令已被处置";
  if (code === "command_not_found") return "Gateway 中没有该命令";
  if (code === "command_identity_unavailable") return "该命令缺少原始载荷，只能记录为未生效";
  if (code === "invalid_resolution" || code === "request_invalid") return "请选择结论并填写 1–500 字符的说明";
  if (code === "runtime_unavailable") return "Runtime Gateway 不可用";
  return code || "处置失败";
}

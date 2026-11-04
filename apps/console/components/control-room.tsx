"use client";

import { AlertTriangle, Archive, BarChart3, BookOpenCheck, CalendarDays, ChartNoAxesCombined, Clapperboard, CircleStop, Clock3, FileText, Gauge, LoaderCircle, MonitorPlay, Package, PackageCheck, Pause, Play, Radio, RotateCcw, Send, ShieldCheck, SquareStack, UserRoundCheck, Users, UsersRound, Volume2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { LiveCommand, LiveRun, LiveRunState } from "@/lib/domain";
import { clientFetch as fetch } from "@/lib/client-request";
import type { RuntimeAlert, RuntimeTelemetry } from "@/lib/monitoring";
import type { LiveInteraction } from "@/lib/interactions";
import type { RuntimeOutboxEvent } from "@/lib/control-plane/outbox";
import { canTransition } from "@/lib/live-run";
import { ChannelReplyWorkflow } from "@/components/channel-reply-workflow";
import { ControlledPreview } from "@/components/controlled-preview";
import type { ShowProgram } from "@/lib/show-program";

type Props = { initialRun: LiveRun; initialProgram: ShowProgram | null; initialTelemetry: RuntimeTelemetry | null; initialAlerts: RuntimeAlert[]; initialInteractions: LiveInteraction[]; canOperate: boolean; canReview: boolean };
type CommandResponse = { data: { command: LiveCommand; run: LiveRun; mediaEvent: Pick<RuntimeOutboxEvent, "id" | "state">; duplicate: boolean } };
type GatewayConfirmedAction = Extract<LiveCommand["action"], "START" | "RECOVER" | "END" | "INSERT_PROGRAM" | "ROLLBACK_PROGRAM">;
type GatewayConfirmation = { action: GatewayConfirmedAction; waitingState: LiveRunState; eventId: string };

type NavigationItem = { icon: typeof MonitorPlay; label: string; href?: string };

const navigation: NavigationItem[] = [
  { icon: MonitorPlay, label: "指挥台", href: "/" },
  { icon: CalendarDays, label: "场次", href: "/shows" },
  { icon: Clapperboard, label: "内容工坊", href: "/assets" },
  { icon: Package, label: "商品中心", href: "/products" },
  { icon: PackageCheck, label: "发布治理", href: "/releases" },
  { icon: ShieldCheck, label: "知识与策略", href: "/policy" },
  { icon: ChartNoAxesCombined, label: "运行监控", href: "/monitoring" },
  { icon: BookOpenCheck, label: "运行手册", href: "/runbooks" },
  { icon: BarChart3, label: "经营数据", href: "/analytics" },
  { icon: Archive, label: "录制归档", href: "/recordings" },
  { icon: Gauge, label: "商业额度", href: "/usage" },
  { icon: Send, label: "投递队列", href: "/outbox" },
  { icon: FileText, label: "审计中心", href: "/audit" },
  { icon: SquareStack, label: "渠道设置", href: "/channels" },
  { icon: UsersRound, label: "人员权限", href: "/memberships" }
];
const stateLabel: Record<LiveRunState, string> = { DRAFT: "草稿", REVIEW: "审核中", APPROVED: "已批准", PREFLIGHT: "预检", ARMED: "待开播", LIVE: "直播中", DEGRADED: "降级运行", ENDED: "已结束", ARCHIVED: "已归档" };
const confirmationActions = new Set<LiveCommand["action"]>(["START", "PAUSE", "HANDOFF", "END", "INSERT_PROGRAM", "ROLLBACK_PROGRAM"]);
const commandActionLabel: Record<LiveCommand["action"], string> = { START: "开始直播", PAUSE: "切入备用节目", HANDOFF: "切入人工接管", RECOVER: "恢复数字人节目", END: "结束直播", INSERT_PROGRAM: "插播冻结节目", ROLLBACK_PROGRAM: "回退节目" };
const commandConfirmationNotice: Record<LiveCommand["action"], string> = {
  START: "该动作会向运行时投递开播指令，并等待 Gateway 回执后才进入直播状态。",
  PAUSE: "该动作会立即要求媒体运行时切入备用节目。",
  HANDOFF: "该动作会立即要求媒体运行时切入人工接管。",
  RECOVER: "该动作会在运行时健康校验通过后恢复数字人节目。",
  END: "该动作会向运行时投递停止指令；Gateway 确认后场次结束，不能撤销。",
  INSERT_PROGRAM: "该动作只会投递已批准节目修订中的冻结脚本；Gateway 回执绑定段落和脚本哈希后才移动节目游标。",
  ROLLBACK_PROGRAM: "该动作会回退到插播前的冻结段落；若插播前没有可恢复段落，将恢复主节目模式。"
};

export function ControlRoom({ initialRun, initialProgram, initialTelemetry, initialAlerts, initialInteractions, canOperate, canReview }: Props) {
  const [run, setRun] = useState(initialRun);
  const [commands, setCommands] = useState<LiveCommand[]>(initialRun.commandHistory);
  const [telemetry, setTelemetry] = useState<RuntimeTelemetry | null>(initialTelemetry);
  const [alerts, setAlerts] = useState<RuntimeAlert[]>(initialAlerts);
  const [selectedQuestion, setSelectedQuestion] = useState<string | null>(null);
  const [interactions, setInteractions] = useState(initialInteractions);
  const [handlingInteractionId, setHandlingInteractionId] = useState<string | null>(null);
  const [draftReply, setDraftReply] = useState<string | null>(null);
  const [draftLoading, setDraftLoading] = useState(false);
  const [speechLoading, setSpeechLoading] = useState(false);
  const [speechStatus, setSpeechStatus] = useState<string | null>(null);
  const [activeNav, setActiveNav] = useState("指挥台");
  const [pendingAction, setPendingAction] = useState<LiveCommand["action"] | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [commandNotice, setCommandNotice] = useState<string | null>(null);
  const [gatewayConfirmation, setGatewayConfirmation] = useState<GatewayConfirmation | null>(null);
  const [confirmationAction, setConfirmationAction] = useState<LiveCommand["action"] | null>(null);
  const [confirmationAcknowledged, setConfirmationAcknowledged] = useState(false);
  const [programCommandSegmentId, setProgramCommandSegmentId] = useState<string | null>(null);
  const elapsed = useMemo(() => (run.state === "LIVE" ? "01:24:17" : run.state === "DEGRADED" ? "已降级" : "未开始"), [run.state]);
  const telemetryHealthy = Boolean(telemetry?.outputConnected && telemetry.outputFps >= 24 && telemetry.avSyncMs <= 120 && telemetry.bitrateMbps >= 2 && telemetry.audioActive && telemetry.fallbackReady);
  const selectedInteraction = interactions.find((interaction) => interaction.id === selectedQuestion) ?? null;

  useEffect(() => {
    let active = true;
    let inFlight = false;
    const refreshOperationalState = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const encodedRunId = encodeURIComponent(run.id);
        const [runResponse, telemetryResponse, alertsResponse, interactionsResponse] = await Promise.all([
          fetch(`/api/v1/live-runs/${encodedRunId}`, { cache: "no-store" }),
          fetch(`/api/v1/live-runs/${encodedRunId}/telemetry`, { cache: "no-store" }),
          fetch(`/api/v1/alerts?runId=${encodedRunId}`, { cache: "no-store" }),
          fetch(`/api/v1/live-runs/${encodedRunId}/interactions`, { cache: "no-store" })
        ]);
        const [runPayload, telemetryPayload, alertsPayload, interactionsPayload] = await Promise.all([
          runResponse.json().catch(() => null) as Promise<{ data?: LiveRun } | null>,
          telemetryResponse.json().catch(() => null) as Promise<{ data?: RuntimeTelemetry } | null>,
          alertsResponse.json().catch(() => null) as Promise<{ data?: RuntimeAlert[] } | null>,
          interactionsResponse.json().catch(() => null) as Promise<{ data?: LiveInteraction[] } | null>
        ]);
        if (!active) return;
        if (runResponse.ok && runPayload?.data) {
          setRun(runPayload.data);
          setCommands(runPayload.data.commandHistory);
        }
        if (telemetryResponse.ok && telemetryPayload?.data) setTelemetry(telemetryPayload.data);
        if (alertsResponse.ok && alertsPayload?.data) setAlerts(alertsPayload.data);
        if (interactionsResponse.ok && interactionsPayload?.data) setInteractions(interactionsPayload.data);
      } catch {
        // The latest successful server snapshot remains visible while a refresh retries.
      } finally {
        inFlight = false;
      }
    };
    void refreshOperationalState();
    const timer = window.setInterval(() => void refreshOperationalState(), 5_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [run.id]);

  useEffect(() => {
    if (!gatewayConfirmation) return;
    let active = true;
    const refresh = async () => {
      try {
        const [response, outboxResponse] = await Promise.all([
          fetch(`/api/v1/live-runs/${encodeURIComponent(run.id)}`, { cache: "no-store" }),
          fetch(`/api/v1/runtime/outbox/${encodeURIComponent(gatewayConfirmation.eventId)}`, { cache: "no-store" })
        ]);
        const [payload, outboxPayload] = await Promise.all([
          response.json().catch(() => null) as Promise<{ data?: LiveRun } | null>,
          outboxResponse.json().catch(() => null) as Promise<{ data?: RuntimeOutboxEvent } | null>
        ]);
        if (!response.ok || !payload?.data || !active) return;
        setRun(payload.data);
        const event = outboxPayload?.data;
        if (event?.state === "failed") {
          setGatewayConfirmation(null);
          setCommandError(`运行时投递失败：${event.lastError ?? "未知错误"}。请前往投递队列确认后重试。`);
          return;
        }
        const confirmed = gatewayConfirmation.action === "END"
          ? payload.data.state === "ENDED"
          : gatewayConfirmation.action === "INSERT_PROGRAM" || gatewayConfirmation.action === "ROLLBACK_PROGRAM"
            ? event?.state === "delivered" && payload.data.pendingProgramTransitionEventId !== gatewayConfirmation.eventId
            : payload.data.state !== gatewayConfirmation.waitingState;
        if (confirmed) {
          setGatewayConfirmation(null);
          setCommandNotice(gatewayConfirmation.action === "INSERT_PROGRAM" ? "Gateway 已确认插播，节目游标已更新。" : gatewayConfirmation.action === "ROLLBACK_PROGRAM" ? "Gateway 已确认节目回退，节目游标已更新。" : gatewayConfirmation.action === "END" && payload.data.state === "ENDED" ? "运行时已确认，场次已结束。" : payload.data.state === "LIVE" ? "运行时已确认，场次正在直播。" : `运行时确认结束，场次当前为 ${stateLabel[payload.data.state]}。`);
        }
      } catch {
        // Keep waiting; the outbox and server-side retry policy remain authoritative.
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, [gatewayConfirmation, run.id]);

  function requestDispatch(action: LiveCommand["action"], programSegmentId?: string) {
    if (!canOperate || !canTransition(run.state, action) || pendingAction || gatewayConfirmation) return;
    if (action === "INSERT_PROGRAM" && !programSegmentId) return;
    setProgramCommandSegmentId(programSegmentId ?? null);
    if (confirmationActions.has(action)) {
      setConfirmationAction(action);
      setConfirmationAcknowledged(false);
      return;
    }
    void dispatch(action, programSegmentId);
  }

  function cancelCommandConfirmation() {
    if (pendingAction) return;
    setConfirmationAction(null);
    setConfirmationAcknowledged(false);
    setProgramCommandSegmentId(null);
  }

  function confirmCommandDispatch() {
    const action = confirmationAction;
    if (!action || !confirmationAcknowledged || pendingAction) return;
    setConfirmationAction(null);
    setConfirmationAcknowledged(false);
    const programSegmentId = programCommandSegmentId ?? undefined;
    setProgramCommandSegmentId(null);
    void dispatch(action, programSegmentId);
  }

  async function dispatch(action: LiveCommand["action"], programSegmentId?: string) {
    if (!canOperate || !canTransition(run.state, action) || pendingAction) return;
    setPendingAction(action);
    setCommandError(null);
    setCommandNotice(null);
    try {
      const response = await fetch(`/api/v1/live-runs/${encodeURIComponent(run.id)}/commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, expectedState: run.state, idempotencyKey: crypto.randomUUID(), ...(programSegmentId ? { programSegmentId } : {}) })
      });
      const payload = await response.json().catch(() => null) as CommandResponse | { error?: string } | null;
      if (!response.ok || !payload || !("data" in payload)) throw new Error(payload && "error" in payload ? payload.error : "命令提交失败");
      setRun(payload.data.run);
      setCommands((current) => [payload.data.command, ...current.filter((item) => item.id !== payload.data.command.id)].slice(0, 8));
      if ((action === "START" && payload.data.run.state === "ARMED") || (action === "RECOVER" && payload.data.run.state === "DEGRADED") || (action === "END" && (payload.data.run.state === "LIVE" || payload.data.run.state === "DEGRADED")) || ((action === "INSERT_PROGRAM" || action === "ROLLBACK_PROGRAM") && payload.data.run.pendingProgramTransitionEventId === payload.data.mediaEvent.id)) {
        setGatewayConfirmation({ action, waitingState: payload.data.run.state, eventId: payload.data.mediaEvent.id });
        setCommandNotice(action === "END" ? "停止命令已进入队列，正在等待 Gateway 确认。请勿关闭值守。" : action === "INSERT_PROGRAM" || action === "ROLLBACK_PROGRAM" ? "节目转换已进入队列，正在等待 Gateway 受绑定回执。请勿重复点击。" : "运行时激活命令已进入队列，正在等待 Gateway 确认。请勿重复点击。");
      }
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : "命令提交失败");
    } finally {
      setPendingAction(null);
    }
  }

  async function handleSelectedInteraction() {
    if (!canOperate || !selectedInteraction || handlingInteractionId) return;
    setHandlingInteractionId(selectedInteraction.id);
    try {
      const response = await fetch(`/api/v1/live-runs/${encodeURIComponent(run.id)}/interactions/${encodeURIComponent(selectedInteraction.id)}/handle`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ resolutionNote: "场控已确认处理" }) });
      if (!response.ok) throw new Error("互动处理未提交");
      setInteractions((current) => current.filter((interaction) => interaction.id !== selectedInteraction.id));
      setSelectedQuestion(null);
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : "互动处理未提交");
    } finally {
      setHandlingInteractionId(null);
    }
  }

  async function createDraftReply() {
    if (!canOperate || !selectedInteraction || draftLoading) return;
    setDraftLoading(true);
    setCommandError(null);
    try {
      const response = await fetch(`/api/v1/live-runs/${encodeURIComponent(run.id)}/response-drafts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: selectedInteraction.text }) });
      const payload = await response.json().catch(() => null) as { data?: { status: string; text?: string } } | { error?: string } | null;
      if (!response.ok || !payload || !("data" in payload) || !payload.data) throw new Error(payload && "error" in payload ? payload.error : "回复草稿生成失败");
      setDraftReply(payload.data.status === "ready" ? payload.data.text ?? "未生成可播报文案" : "此问题需要人工接管，系统不会生成自动播报文案。");
      setSpeechStatus(null);
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : "回复草稿生成失败");
    } finally {
      setDraftLoading(false);
    }
  }

  async function dispatchGroundedSpeech() {
    if (!canOperate || !selectedInteraction || selectedInteraction.decision !== "answer" || !draftReply || speechLoading) return;
    setSpeechLoading(true);
    setCommandError(null);
    try {
      const response = await fetch(`/api/v1/live-runs/${encodeURIComponent(run.id)}/speech-dispatches`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: selectedInteraction.text, idempotencyKey: crypto.randomUUID() })
      });
      const payload = await response.json().catch(() => null) as { data?: { status: "queued" | "handoff"; event?: { id: string }; duplicate?: boolean } } | { error?: string } | null;
      if (!response.ok || !payload || !("data" in payload) || !payload.data) throw new Error(payload && "error" in payload ? payload.error : "播报未入队");
      if (payload.data.status !== "queued") {
        setSpeechStatus("策略要求人工接管，系统未自动播报。");
      } else {
        setSpeechStatus(payload.data.duplicate ? "相同播报已在队列中。" : `已进入语音投递队列：${payload.data.event?.id ?? "等待 worker 领取"}`);
      }
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : "播报未入队");
    } finally {
      setSpeechLoading(false);
    }
  }

  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><span className="brand-mark"><Radio size={16} /></span><span>Shuzhiren</span></div><nav aria-label="工作区">{navigation.map(({ icon: Icon, label, href }) => href ? <Link className={activeNav === label ? "nav-item active" : "nav-item"} href={href} key={label} onClick={() => setActiveNav(label)}><Icon size={17} />{label}</Link> : <button className={activeNav === label ? "nav-item active" : "nav-item"} key={label} onClick={() => setActiveNav(label)} type="button"><Icon size={17} />{label}</button>)}</nav><div className="sidebar-footer"><Users size={15} /> 运营组<br /><span>华东直播间</span></div></aside>
    <main className="main-content">
      <header className="topbar"><div><div className="eyebrow">{activeNav}</div><h1>{run.showName}</h1></div><div className="topbar-status"><span className={`state state-${run.state.toLowerCase()}`}>{stateLabel[run.state]} · {elapsed}</span><span className="trace">{run.traceId}</span></div></header>
      <section className="workspace" aria-label="直播指挥台">
        <div className="primary-grid">
          <section className="panel stage-panel">
            <div className="panel-header"><div><h2>直播预览</h2><span>受控 WebRTC 授权 · {telemetry?.outputFps ?? "--"} FPS</span></div><span className={telemetryHealthy && !alerts.length ? "healthy" : "unhealthy"}><span />{telemetryHealthy && !alerts.length ? "输出健康" : `待处理 ${alerts.length} 项`}</span></div>
            <ControlledPreview canOperate={canOperate} runId={run.id} />
            <div className="stage-metrics"><Metric label="视频帧率" value={telemetry ? telemetry.outputFps.toFixed(1) : "--"} unit="FPS" /><Metric label="音画同步" value={telemetry ? String(telemetry.avSyncMs) : "--"} unit="ms" /><Metric label="输出码率" value={telemetry ? String(telemetry.bitrateMbps) : "--"} unit="Mbps" /><Metric label="备用节目" value={telemetry?.fallbackReady ? "就绪" : "未就绪"} unit="" /></div>
            <div className="control-row"><CommandButton action="START" icon={Play} label="开始" run={run} pendingAction={pendingAction} onDispatch={requestDispatch} canOperate={canOperate} gatewayConfirmation={gatewayConfirmation} /><CommandButton action="PAUSE" icon={Pause} label="暂停" run={run} pendingAction={pendingAction} onDispatch={requestDispatch} canOperate={canOperate} gatewayConfirmation={gatewayConfirmation} /><CommandButton action="HANDOFF" icon={UserRoundCheck} label="人工接管" run={run} pendingAction={pendingAction} onDispatch={requestDispatch} canOperate={canOperate} gatewayConfirmation={gatewayConfirmation} /><CommandButton action="RECOVER" icon={RotateCcw} label="恢复运行" run={run} pendingAction={pendingAction} onDispatch={requestDispatch} canOperate={canOperate} gatewayConfirmation={gatewayConfirmation} /><CommandButton action="ROLLBACK_PROGRAM" icon={RotateCcw} label="回退节目" run={run} pendingAction={pendingAction} onDispatch={requestDispatch} canOperate={canOperate} gatewayConfirmation={gatewayConfirmation} /><CommandButton action="END" icon={CircleStop} label="结束" run={run} pendingAction={pendingAction} onDispatch={requestDispatch} canOperate={canOperate} gatewayConfirmation={gatewayConfirmation} danger /></div>
            {commandNotice ? <p className="command-notice" role="status">{commandNotice}</p> : null}
            {commandError ? <p className="command-error" role="alert">命令未执行：{commandError}</p> : null}
          </section>
          <section className="panel queue-panel"><div className="panel-header"><div><h2>互动与风险</h2><span>高风险问题必须人工确认</span></div><AlertTriangle size={18} className="warning-icon" /></div><div className="queue-list">{interactions.length ? interactions.map((interaction) => <button className={selectedQuestion === interaction.id ? "question selected" : "question"} key={interaction.id} onClick={() => { setSelectedQuestion(interaction.id); setDraftReply(null); setSpeechStatus(null); }} type="button"><span className={`risk ${interaction.risk}`}>{interaction.risk === "high" ? "需人工确认" : interaction.risk === "medium" ? "需商品证据" : "有证据"}</span><strong>{interaction.text}</strong><small>{interaction.detail}</small></button>) : <div className="queue-empty">暂无待处理互动</div>}</div><div className="handoff-box"><Volume2 size={16} /><div><span>{selectedInteraction ? `${selectedInteraction.decision === "handoff" ? "建议人工接管后" : "已核验策略后"}处理此问题` : alerts.length ? `有 ${alerts.length} 条运行告警待处理` : "选择一条互动查看处理建议"}</span>{draftReply ? <small className="draft-reply">{draftReply}</small> : null}{speechStatus ? <small className="speech-status">{speechStatus}</small> : null}</div>{canOperate && selectedInteraction?.decision === "answer" ? <button className="handle-interaction" disabled={draftLoading || speechLoading} onClick={createDraftReply} type="button">{draftLoading ? "生成中" : "生成草稿"}</button> : null}{canOperate && selectedInteraction?.decision === "answer" && draftReply ? <button className="handle-interaction" disabled={speechLoading} onClick={dispatchGroundedSpeech} type="button">{speechLoading ? "入队中" : "确认播报"}</button> : null}{canOperate && selectedInteraction ? <button className="handle-interaction" disabled={Boolean(handlingInteractionId)} onClick={handleSelectedInteraction} type="button">{handlingInteractionId ? "处理中" : "标记已处理"}</button> : null}</div></section>
        </div>
        <ChannelReplyWorkflow runId={run.id} canOperate={canOperate} canReview={canReview} />
        <section className="panel timeline-panel"><div className="panel-header"><div><h2>节目单与命令记录</h2><span>插播只能引用当前批准修订的冻结脚本，并等待 Gateway 受绑定回执。</span></div><Clock3 size={17} /></div><div className="timeline-content"><div className="program-track">{initialProgram?.segments.map((segment) => { const runnable = (segment.kind === "prepared_product" || segment.kind === "interactive") && Boolean(segment.runtimeScript); const active = run.activeProgramSegmentId === segment.id; return <span className={`segment ${active ? "live" : segment.fallback ? "queued" : "preset"}`} key={segment.id}><strong>{segment.position}. {segment.title}</strong><small>{segment.durationSeconds ? `${segment.durationSeconds}s` : "人工结束"}</small>{runnable ? <button type="button" className="subtle-button" disabled={!canOperate || run.state !== "LIVE" || Boolean(pendingAction) || Boolean(gatewayConfirmation)} onClick={() => requestDispatch("INSERT_PROGRAM", segment.id)} title="插播此冻结节目段落"><Send size={14} />插播</button> : null}</span>; }) ?? <span className="segment queued">节目单不可用</span>}</div><div className="command-list">{commands.slice(0, 5).map((command) => <div className="command" key={command.id}><span>{commandActionLabel[command.action]}</span><small>{command.actorName} · {new Date(command.issuedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}{command.programSegmentId ? ` · ${command.programSegmentId.slice(0, 8)}` : ""}</small><b>{command.result}</b></div>)}</div></div></section>
      </section>
    </main>
    {confirmationAction ? <div className="command-confirm-backdrop" role="presentation"><section className="command-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="command-confirm-title"><span className={`command-confirm-action ${confirmationAction === "END" ? "danger" : ""}`}>{commandActionLabel[confirmationAction]}</span><h2 id="command-confirm-title">确认派发高风险命令</h2><p>{commandConfirmationNotice[confirmationAction]}</p><dl><div><dt>场次</dt><dd>{run.showName}</dd></div><div><dt>当前状态</dt><dd>{stateLabel[run.state]}</dd></div><div><dt>追踪标识</dt><dd>{run.traceId}</dd></div></dl><label className="command-confirm-check"><input type="checkbox" checked={confirmationAcknowledged} onChange={(event) => setConfirmationAcknowledged(event.target.checked)} />我已核对当前场次和状态，确认执行此命令。</label><div className="command-confirm-actions"><button type="button" onClick={cancelCommandConfirmation}>取消</button><button className={confirmationAction === "END" ? "danger" : ""} type="button" disabled={!confirmationAcknowledged || Boolean(pendingAction)} onClick={confirmCommandDispatch}>确认派发{commandActionLabel[confirmationAction]}</button></div></section></div> : null}
  </div>;
}

function CommandButton({ action, icon: Icon, label, run, pendingAction, onDispatch, canOperate, gatewayConfirmation, danger = false }: { action: LiveCommand["action"]; icon: typeof Play; label: string; run: LiveRun; pendingAction: LiveCommand["action"] | null; onDispatch: (action: LiveCommand["action"]) => void; canOperate: boolean; gatewayConfirmation: GatewayConfirmation | null; danger?: boolean }) {
  const pending = pendingAction === action;
  const waitingForConfirmation = gatewayConfirmation?.action === action;
  const unavailableRollback = action === "ROLLBACK_PROGRAM" && !run.activeInsertProgramSegmentId;
  return <button className={danger ? "button danger" : "button"} disabled={!canOperate || !canTransition(run.state, action) || unavailableRollback || Boolean(pendingAction) || Boolean(gatewayConfirmation) || waitingForConfirmation} onClick={() => onDispatch(action)} type="button" title={!canOperate ? "当前角色仅可查看" : unavailableRollback ? "当前没有已确认的插播节目可回退" : waitingForConfirmation ? "运行时正在确认该命令" : gatewayConfirmation ? "正在等待其他运行时命令确认" : undefined}>{pending ? <LoaderCircle className="button-spinner" size={16} /> : <Icon size={16} />}{pending ? "提交中" : waitingForConfirmation ? "等待确认" : label}</button>;
}

function Metric({ label, value, unit }: { label: string; value: string; unit: string }) { return <div className="metric"><span>{label}</span><strong>{value} <small>{unit}</small></strong></div>; }

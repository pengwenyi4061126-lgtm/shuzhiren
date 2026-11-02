"use client";

import { AlertTriangle, CalendarDays, ChartNoAxesCombined, Clapperboard, CircleStop, Clock3, FileText, LoaderCircle, MonitorPlay, Package, PackageCheck, Pause, Play, Radio, RotateCcw, Send, ShieldCheck, SquareStack, UserRoundCheck, Users, Volume2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { LiveCommand, LiveRun, LiveRunState } from "@/lib/domain";
import type { RuntimeAlert, RuntimeTelemetry } from "@/lib/monitoring";
import type { LiveInteraction } from "@/lib/interactions";
import { canTransition } from "@/lib/live-run";

type Props = { initialRun: LiveRun; initialTelemetry: RuntimeTelemetry | null; initialAlerts: RuntimeAlert[]; initialInteractions: LiveInteraction[]; canOperate: boolean };
type CommandResponse = { data: { command: LiveCommand; run: LiveRun; duplicate: boolean } };

type NavigationItem = { icon: typeof MonitorPlay; label: string; href?: string };

const navigation: NavigationItem[] = [
  { icon: MonitorPlay, label: "指挥台", href: "/" },
  { icon: CalendarDays, label: "场次", href: "/shows" },
  { icon: Clapperboard, label: "内容工坊", href: "/assets" },
  { icon: Package, label: "商品中心", href: "/products" },
  { icon: PackageCheck, label: "发布治理", href: "/releases" },
  { icon: ShieldCheck, label: "知识与策略", href: "/policy" },
  { icon: ChartNoAxesCombined, label: "运行监控", href: "/monitoring" },
  { icon: Send, label: "投递队列", href: "/outbox" },
  { icon: FileText, label: "审计中心", href: "/audit" },
  { icon: SquareStack, label: "渠道设置", href: "/channels" }
];
const stateLabel: Record<LiveRunState, string> = { DRAFT: "草稿", REVIEW: "审核中", APPROVED: "已批准", PREFLIGHT: "预检", ARMED: "待开播", LIVE: "直播中", DEGRADED: "降级运行", ENDED: "已结束", ARCHIVED: "已归档" };

export function ControlRoom({ initialRun, initialTelemetry, initialAlerts, initialInteractions, canOperate }: Props) {
  const [run, setRun] = useState(initialRun);
  const [commands, setCommands] = useState<LiveCommand[]>(initialRun.commandHistory);
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
  const [activationAwaitingConfirmation, setActivationAwaitingConfirmation] = useState<Extract<LiveCommand["action"], "START" | "RECOVER"> | null>(null);
  const elapsed = useMemo(() => (run.state === "LIVE" ? "01:24:17" : run.state === "DEGRADED" ? "已降级" : "未开始"), [run.state]);
  const telemetryHealthy = Boolean(initialTelemetry?.outputConnected && initialTelemetry.outputFps >= 24 && initialTelemetry.avSyncMs <= 120 && initialTelemetry.bitrateMbps >= 2 && initialTelemetry.fallbackReady);
  const selectedInteraction = interactions.find((interaction) => interaction.id === selectedQuestion) ?? null;

  useEffect(() => {
    if (!activationAwaitingConfirmation) return;
    const waitingState = activationAwaitingConfirmation === "START" ? "ARMED" : "DEGRADED";
    let active = true;
    const refresh = async () => {
      try {
        const response = await fetch(`/api/v1/live-runs/${encodeURIComponent(run.id)}`, { cache: "no-store" });
        const payload = await response.json().catch(() => null) as { data?: LiveRun } | null;
        if (!response.ok || !payload?.data || !active) return;
        setRun(payload.data);
        if (payload.data.state !== waitingState) {
          setActivationAwaitingConfirmation(null);
          setCommandNotice(payload.data.state === "LIVE" ? "运行时已确认，场次正在直播。" : `运行时确认结束，场次当前为 ${stateLabel[payload.data.state]}。`);
        }
      } catch {
        // Keep waiting; the outbox and server-side retry policy remain authoritative.
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, [activationAwaitingConfirmation, run.id]);

  async function dispatch(action: LiveCommand["action"]) {
    if (!canOperate || !canTransition(run.state, action) || pendingAction) return;
    if (action === "END" && !window.confirm("确认结束当前直播？此命令会停止场次，不能撤销。")) return;
    setPendingAction(action);
    setCommandError(null);
    setCommandNotice(null);
    try {
      const response = await fetch(`/api/v1/live-runs/${encodeURIComponent(run.id)}/commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, expectedState: run.state, idempotencyKey: crypto.randomUUID() })
      });
      const payload = await response.json().catch(() => null) as CommandResponse | { error?: string } | null;
      if (!response.ok || !payload || !("data" in payload)) throw new Error(payload && "error" in payload ? payload.error : "命令提交失败");
      setRun(payload.data.run);
      setCommands((current) => [payload.data.command, ...current.filter((item) => item.id !== payload.data.command.id)].slice(0, 8));
      if ((action === "START" && payload.data.run.state === "ARMED") || (action === "RECOVER" && payload.data.run.state === "DEGRADED")) {
        setActivationAwaitingConfirmation(action);
        setCommandNotice("运行时激活命令已进入队列，正在等待 Gateway 确认。请勿重复点击。");
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
            <div className="panel-header"><div><h2>直播预览</h2><span>主运行时 · 720p · {initialTelemetry?.outputFps ?? "--"} FPS</span></div><span className={telemetryHealthy && !initialAlerts.length ? "healthy" : "unhealthy"}><span />{telemetryHealthy && !initialAlerts.length ? "输出健康" : `待处理 ${initialAlerts.length} 项`}</span></div>
            <div className="preview" aria-label="数字人直播预览"><div className="live-badge"><span />{run.state === "LIVE" ? "LIVE" : stateLabel[run.state]}</div><div className="avatar" aria-hidden="true" /><div className="caption">现在下单，赠旅行装三件套</div></div>
            <div className="stage-metrics"><Metric label="视频帧率" value={initialTelemetry ? initialTelemetry.outputFps.toFixed(1) : "--"} unit="FPS" /><Metric label="音画同步" value={initialTelemetry ? String(initialTelemetry.avSyncMs) : "--"} unit="ms" /><Metric label="输出码率" value={initialTelemetry ? String(initialTelemetry.bitrateMbps) : "--"} unit="Mbps" /><Metric label="备用节目" value={initialTelemetry?.fallbackReady ? "就绪" : "未就绪"} unit="" /></div>
            <div className="control-row"><CommandButton action="START" icon={Play} label="开始" run={run} pendingAction={pendingAction} onDispatch={dispatch} canOperate={canOperate} activationAwaitingConfirmation={activationAwaitingConfirmation} /><CommandButton action="PAUSE" icon={Pause} label="暂停" run={run} pendingAction={pendingAction} onDispatch={dispatch} canOperate={canOperate} activationAwaitingConfirmation={activationAwaitingConfirmation} /><CommandButton action="HANDOFF" icon={UserRoundCheck} label="人工接管" run={run} pendingAction={pendingAction} onDispatch={dispatch} canOperate={canOperate} activationAwaitingConfirmation={activationAwaitingConfirmation} /><CommandButton action="RECOVER" icon={RotateCcw} label="恢复运行" run={run} pendingAction={pendingAction} onDispatch={dispatch} canOperate={canOperate} activationAwaitingConfirmation={activationAwaitingConfirmation} /><CommandButton action="END" icon={CircleStop} label="结束" run={run} pendingAction={pendingAction} onDispatch={dispatch} canOperate={canOperate} activationAwaitingConfirmation={activationAwaitingConfirmation} danger /></div>
            {commandNotice ? <p className="command-notice" role="status">{commandNotice}</p> : null}
            {commandError ? <p className="command-error" role="alert">命令未执行：{commandError}</p> : null}
          </section>
          <section className="panel queue-panel"><div className="panel-header"><div><h2>互动与风险</h2><span>高风险问题必须人工确认</span></div><AlertTriangle size={18} className="warning-icon" /></div><div className="queue-list">{interactions.length ? interactions.map((interaction) => <button className={selectedQuestion === interaction.id ? "question selected" : "question"} key={interaction.id} onClick={() => { setSelectedQuestion(interaction.id); setDraftReply(null); setSpeechStatus(null); }} type="button"><span className={`risk ${interaction.risk}`}>{interaction.risk === "high" ? "需人工确认" : interaction.risk === "medium" ? "需商品证据" : "有证据"}</span><strong>{interaction.text}</strong><small>{interaction.detail}</small></button>) : <div className="queue-empty">暂无待处理互动</div>}</div><div className="handoff-box"><Volume2 size={16} /><div><span>{selectedInteraction ? `${selectedInteraction.decision === "handoff" ? "建议人工接管后" : "已核验策略后"}处理此问题` : initialAlerts.length ? `有 ${initialAlerts.length} 条运行告警待处理` : "选择一条互动查看处理建议"}</span>{draftReply ? <small className="draft-reply">{draftReply}</small> : null}{speechStatus ? <small className="speech-status">{speechStatus}</small> : null}</div>{canOperate && selectedInteraction?.decision === "answer" ? <button className="handle-interaction" disabled={draftLoading || speechLoading} onClick={createDraftReply} type="button">{draftLoading ? "生成中" : "生成草稿"}</button> : null}{canOperate && selectedInteraction?.decision === "answer" && draftReply ? <button className="handle-interaction" disabled={speechLoading} onClick={dispatchGroundedSpeech} type="button">{speechLoading ? "入队中" : "确认播报"}</button> : null}{canOperate && selectedInteraction ? <button className="handle-interaction" disabled={Boolean(handlingInteractionId)} onClick={handleSelectedInteraction} type="button">{handlingInteractionId ? "处理中" : "标记已处理"}</button> : null}</div></section>
        </div>
        <section className="panel timeline-panel"><div className="panel-header"><div><h2>节目单与命令记录</h2><span>命令使用幂等键与预期状态校验</span></div><Clock3 size={17} /></div><div className="timeline-content"><div className="program-track"><span className="segment preset">预制讲品 · A-102</span><span className="segment live">实时问答</span><span className="segment queued">成分讲解 · A-103</span></div><div className="command-list">{commands.slice(0, 3).map((command) => <div className="command" key={command.id}><span>{command.action}</span><small>{command.actorName} · {new Date(command.issuedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</small><b>{command.result}</b></div>)}</div></div></section>
      </section>
    </main>
  </div>;
}

function CommandButton({ action, icon: Icon, label, run, pendingAction, onDispatch, canOperate, activationAwaitingConfirmation, danger = false }: { action: LiveCommand["action"]; icon: typeof Play; label: string; run: LiveRun; pendingAction: LiveCommand["action"] | null; onDispatch: (action: LiveCommand["action"]) => void; canOperate: boolean; activationAwaitingConfirmation: Extract<LiveCommand["action"], "START" | "RECOVER"> | null; danger?: boolean }) {
  const pending = pendingAction === action;
  const waitingForActivation = activationAwaitingConfirmation === action;
  return <button className={danger ? "button danger" : "button"} disabled={!canOperate || !canTransition(run.state, action) || Boolean(pendingAction) || waitingForActivation} onClick={() => onDispatch(action)} type="button" title={!canOperate ? "当前角色仅可查看" : waitingForActivation ? "运行时正在确认激活命令" : undefined}>{pending ? <LoaderCircle className="button-spinner" size={16} /> : <Icon size={16} />}{pending ? "提交中" : waitingForActivation ? "等待确认" : label}</button>;
}

function Metric({ label, value, unit }: { label: string; value: string; unit: string }) { return <div className="metric"><span>{label}</span><strong>{value} <small>{unit}</small></strong></div>; }

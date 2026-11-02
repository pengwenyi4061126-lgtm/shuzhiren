"use client";

import { AlertTriangle, CalendarDays, ChartNoAxesCombined, Clapperboard, CircleStop, Clock3, FileText, LoaderCircle, MonitorPlay, Package, Pause, Play, Radio, RotateCcw, ShieldCheck, SquareStack, UserRoundCheck, Users, Volume2 } from "lucide-react";
import { useMemo, useState } from "react";
import type { LiveCommand, LiveRun, LiveRunState } from "@/lib/domain";
import type { RuntimeAlert, RuntimeTelemetry } from "@/lib/monitoring";
import { canTransition } from "@/lib/live-run";

type Props = { initialRun: LiveRun; initialTelemetry: RuntimeTelemetry | null; initialAlerts: RuntimeAlert[] };
type CommandResponse = { data: { command: LiveCommand; run: LiveRun; duplicate: boolean } };

const navigation = [[MonitorPlay, "指挥台"], [CalendarDays, "场次"], [Clapperboard, "内容工坊"], [Package, "商品中心"], [ShieldCheck, "知识与策略"], [ChartNoAxesCombined, "数据中心"], [FileText, "审计中心"], [SquareStack, "系统设置"]] as const;
const stateLabel: Record<LiveRunState, string> = { DRAFT: "草稿", REVIEW: "审核中", APPROVED: "已批准", PREFLIGHT: "预检", ARMED: "待开播", LIVE: "直播中", DEGRADED: "降级运行", ENDED: "已结束", ARCHIVED: "已归档" };

export function ControlRoom({ initialRun, initialTelemetry, initialAlerts }: Props) {
  const [run, setRun] = useState(initialRun);
  const [commands, setCommands] = useState<LiveCommand[]>(initialRun.commandHistory);
  const [selectedQuestion, setSelectedQuestion] = useState<string | null>(null);
  const [activeNav, setActiveNav] = useState("指挥台");
  const [pendingAction, setPendingAction] = useState<LiveCommand["action"] | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const elapsed = useMemo(() => (run.state === "LIVE" ? "01:24:17" : run.state === "DEGRADED" ? "已降级" : "未开始"), [run.state]);
  const telemetryHealthy = Boolean(initialTelemetry?.outputConnected && initialTelemetry.outputFps >= 24 && initialTelemetry.avSyncMs <= 120 && initialTelemetry.bitrateMbps >= 2 && initialTelemetry.fallbackReady);

  async function dispatch(action: LiveCommand["action"]) {
    if (!canTransition(run.state, action) || pendingAction) return;
    if (action === "END" && !window.confirm("确认结束当前直播？此命令会停止场次，不能撤销。")) return;
    setPendingAction(action);
    setCommandError(null);
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
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : "命令提交失败");
    } finally {
      setPendingAction(null);
    }
  }

  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><span className="brand-mark"><Radio size={16} /></span><span>Shuzhiren</span></div><nav aria-label="工作区">{navigation.map(([Icon, label]) => <button className={activeNav === label ? "nav-item active" : "nav-item"} key={label} onClick={() => setActiveNav(label)} type="button"><Icon size={17} />{label}</button>)}</nav><div className="sidebar-footer"><Users size={15} /> 运营组<br /><span>华东直播间</span></div></aside>
    <main className="main-content">
      <header className="topbar"><div><div className="eyebrow">{activeNav}</div><h1>{run.showName}</h1></div><div className="topbar-status"><span className={`state state-${run.state.toLowerCase()}`}>{stateLabel[run.state]} · {elapsed}</span><span className="trace">{run.traceId}</span></div></header>
      <section className="workspace" aria-label="直播指挥台">
        <div className="primary-grid">
          <section className="panel stage-panel">
            <div className="panel-header"><div><h2>直播预览</h2><span>主运行时 · 720p · {initialTelemetry?.outputFps ?? "--"} FPS</span></div><span className={telemetryHealthy && !initialAlerts.length ? "healthy" : "unhealthy"}><span />{telemetryHealthy && !initialAlerts.length ? "输出健康" : `待处理 ${initialAlerts.length} 项`}</span></div>
            <div className="preview" aria-label="数字人直播预览"><div className="live-badge"><span />{run.state === "LIVE" ? "LIVE" : stateLabel[run.state]}</div><div className="avatar" aria-hidden="true" /><div className="caption">现在下单，赠旅行装三件套</div></div>
            <div className="stage-metrics"><Metric label="视频帧率" value={initialTelemetry ? initialTelemetry.outputFps.toFixed(1) : "--"} unit="FPS" /><Metric label="音画同步" value={initialTelemetry ? String(initialTelemetry.avSyncMs) : "--"} unit="ms" /><Metric label="输出码率" value={initialTelemetry ? String(initialTelemetry.bitrateMbps) : "--"} unit="Mbps" /><Metric label="备用节目" value={initialTelemetry?.fallbackReady ? "就绪" : "未就绪"} unit="" /></div>
            <div className="control-row"><CommandButton action="START" icon={Play} label="开始" run={run} pendingAction={pendingAction} onDispatch={dispatch} /><CommandButton action="PAUSE" icon={Pause} label="暂停" run={run} pendingAction={pendingAction} onDispatch={dispatch} /><CommandButton action="HANDOFF" icon={UserRoundCheck} label="人工接管" run={run} pendingAction={pendingAction} onDispatch={dispatch} /><CommandButton action="RECOVER" icon={RotateCcw} label="恢复运行" run={run} pendingAction={pendingAction} onDispatch={dispatch} /><CommandButton action="END" icon={CircleStop} label="结束" run={run} pendingAction={pendingAction} onDispatch={dispatch} danger /></div>
            {commandError ? <p className="command-error" role="alert">命令未执行：{commandError}</p> : null}
          </section>
          <section className="panel queue-panel"><div className="panel-header"><div><h2>互动与风险</h2><span>高风险问题必须人工确认</span></div><AlertTriangle size={18} className="warning-icon" /></div><div className="queue-list">{run.questions.map((question) => <button className={selectedQuestion === question.id ? "question selected" : "question"} key={question.id} onClick={() => setSelectedQuestion(question.id)} type="button"><span className={question.risk === "high" ? "risk high" : "risk low"}>{question.risk === "high" ? "需人工确认" : "有证据"}</span><strong>{question.text}</strong><small>{question.detail}</small></button>)}</div><div className="handoff-box"><Volume2 size={16} /><span>{selectedQuestion ? "已选中问题，等待场控处理" : initialAlerts.length ? `有 ${initialAlerts.length} 条运行告警待处理` : "选择一条互动查看处理建议"}</span></div></section>
        </div>
        <section className="panel timeline-panel"><div className="panel-header"><div><h2>节目单与命令记录</h2><span>命令使用幂等键与预期状态校验</span></div><Clock3 size={17} /></div><div className="timeline-content"><div className="program-track"><span className="segment preset">预制讲品 · A-102</span><span className="segment live">实时问答</span><span className="segment queued">成分讲解 · A-103</span></div><div className="command-list">{commands.slice(0, 3).map((command) => <div className="command" key={command.id}><span>{command.action}</span><small>{command.actorName} · {new Date(command.issuedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</small><b>{command.result}</b></div>)}</div></div></section>
      </section>
    </main>
  </div>;
}

function CommandButton({ action, icon: Icon, label, run, pendingAction, onDispatch, danger = false }: { action: LiveCommand["action"]; icon: typeof Play; label: string; run: LiveRun; pendingAction: LiveCommand["action"] | null; onDispatch: (action: LiveCommand["action"]) => void; danger?: boolean }) {
  const pending = pendingAction === action;
  return <button className={danger ? "button danger" : "button"} disabled={!canTransition(run.state, action) || Boolean(pendingAction)} onClick={() => onDispatch(action)} type="button">{pending ? <LoaderCircle className="button-spinner" size={16} /> : <Icon size={16} />}{pending ? "提交中" : label}</button>;
}

function Metric({ label, value, unit }: { label: string; value: string; unit: string }) { return <div className="metric"><span>{label}</span><strong>{value} <small>{unit}</small></strong></div>; }

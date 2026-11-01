"use client";

import {
  AlertTriangle,
  CalendarDays,
  ChartNoAxesCombined,
  Clapperboard,
  CircleStop,
  Clock3,
  FileText,
  MonitorPlay,
  Package,
  Pause,
  Play,
  Radio,
  ShieldCheck,
  SquareStack,
  UserRoundCheck,
  Users,
  Volume2
} from "lucide-react";
import { useMemo, useState } from "react";
import type { LiveCommand, LiveRun, LiveRunState } from "@/lib/domain";
import { canTransition, nextStateFor } from "@/lib/live-run";

type Props = {
  initialRun: LiveRun;
};

const navigation = [
  [MonitorPlay, "指挥台"],
  [CalendarDays, "场次"],
  [Clapperboard, "内容工坊"],
  [Package, "商品中心"],
  [ShieldCheck, "知识与策略"],
  [ChartNoAxesCombined, "数据中心"],
  [FileText, "审计中心"],
  [SquareStack, "系统设置"]
] as const;

const stateLabel: Record<LiveRunState, string> = {
  DRAFT: "草稿",
  REVIEW: "审核中",
  APPROVED: "已批准",
  PREFLIGHT: "预检",
  ARMED: "待开播",
  LIVE: "直播中",
  DEGRADED: "降级运行",
  ENDED: "已结束",
  ARCHIVED: "已归档"
};

export function ControlRoom({ initialRun }: Props) {
  const [run, setRun] = useState(initialRun);
  const [commands, setCommands] = useState<LiveCommand[]>(initialRun.commandHistory);
  const [selectedQuestion, setSelectedQuestion] = useState<string | null>(null);
  const [activeNav, setActiveNav] = useState("指挥台");

  const elapsed = useMemo(() => (run.state === "LIVE" ? "01:24:17" : "未开始"), [run.state]);

  function dispatch(action: LiveCommand["action"]) {
    if (!canTransition(run.state, action)) return;

    const nextState = nextStateFor(run.state, action);
    const command: LiveCommand = {
      id: `cmd_${Date.now()}`,
      action,
      actorName: "林晓",
      issuedAt: new Date().toISOString(),
      expectedState: run.state,
      result: "accepted"
    };

    setCommands((current) => [command, ...current].slice(0, 8));
    setRun((current) => ({ ...current, state: nextState }));
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark"><Radio size={16} /></span><span>Shuzhiren</span></div>
        <nav aria-label="工作区">
          {navigation.map(([Icon, label]) => (
            <button className={activeNav === label ? "nav-item active" : "nav-item"} key={label} onClick={() => setActiveNav(label)} type="button">
              <Icon size={17} />
              {label}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer"><Users size={15} /> 运营组<br /><span>华东直播间</span></div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div>
            <div className="eyebrow">{activeNav}</div>
            <h1>{run.showName}</h1>
          </div>
          <div className="topbar-status"><span className={`state state-${run.state.toLowerCase()}`}>{stateLabel[run.state]} · {elapsed}</span><span className="trace">{run.traceId}</span></div>
        </header>

        <section className="workspace" aria-label="直播指挥台">
          <div className="primary-grid">
            <section className="panel stage-panel">
              <div className="panel-header"><div><h2>直播预览</h2><span>主运行时 · 720p · 25 FPS</span></div><span className="healthy"><span />输出质量 99.98%</span></div>
              <div className="preview" aria-label="数字人直播预览">
                <div className="live-badge"><span />LIVE</div>
                <div className="avatar" aria-hidden="true" />
                <div className="caption">现在下单，赠旅行装三件套</div>
              </div>
              <div className="stage-metrics">
                <Metric label="视频帧率" value="25.0" unit="FPS" />
                <Metric label="音画同步" value="31" unit="ms" />
                <Metric label="输出码率" value="4.2" unit="Mbps" />
                <Metric label="备用节目" value="就绪" unit="" />
              </div>
              <div className="control-row">
                <button className="button" disabled={!canTransition(run.state, "START")} onClick={() => dispatch("START")} type="button"><Play size={16} />开始</button>
                <button className="button" disabled={!canTransition(run.state, "PAUSE")} onClick={() => dispatch("PAUSE")} type="button"><Pause size={16} />暂停</button>
                <button className="button" disabled={!canTransition(run.state, "HANDOFF")} onClick={() => dispatch("HANDOFF")} type="button"><UserRoundCheck size={16} />人工接管</button>
                <button className="button danger" disabled={!canTransition(run.state, "END")} onClick={() => dispatch("END")} type="button"><CircleStop size={16} />结束</button>
              </div>
            </section>

            <section className="panel queue-panel">
              <div className="panel-header"><div><h2>互动与风险</h2><span>高风险问题必须人工确认</span></div><AlertTriangle size={18} className="warning-icon" /></div>
              <div className="queue-list">
                {run.questions.map((question) => (
                  <button className={selectedQuestion === question.id ? "question selected" : "question"} key={question.id} onClick={() => setSelectedQuestion(question.id)} type="button">
                    <span className={question.risk === "high" ? "risk high" : "risk low"}>{question.risk === "high" ? "需人工确认" : "有证据"}</span>
                    <strong>{question.text}</strong>
                    <small>{question.detail}</small>
                  </button>
                ))}
              </div>
              <div className="handoff-box"><Volume2 size={16} /><span>{selectedQuestion ? "已选中问题，等待场控处理" : "选择一条互动查看处理建议"}</span></div>
            </section>
          </div>

          <section className="panel timeline-panel">
            <div className="panel-header"><div><h2>节目单与命令记录</h2><span>命令使用幂等键与预期状态校验</span></div><Clock3 size={17} /></div>
            <div className="timeline-content">
              <div className="program-track"><span className="segment preset">预制讲品 · A-102</span><span className="segment live">实时问答</span><span className="segment queued">成分讲解 · A-103</span></div>
              <div className="command-list">
                {commands.slice(0, 3).map((command) => <div className="command" key={command.id}><span>{command.action}</span><small>{command.actorName} · {new Date(command.issuedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</small><b>{command.result}</b></div>)}
              </div>
            </div>
          </section>
        </section>
      </main>
    </div>
  );
}

function Metric({ label, value, unit }: { label: string; value: string; unit: string }) {
  return <div className="metric"><span>{label}</span><strong>{value} <small>{unit}</small></strong></div>;
}

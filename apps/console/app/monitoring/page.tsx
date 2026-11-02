import Link from "next/link";
import { Activity, Gauge, HardDrive, RadioTower, ShieldCheck } from "lucide-react";
import { AccessDenied } from "@/components/access-denied";
import { MonitoringAlertList } from "@/components/monitoring-alert-list";
import { authorizedPageRequestContext } from "@/lib/control-plane/page-context";
import { listRuns } from "@/lib/control-plane/store";
import { listIncidents } from "@/lib/incidents";
import { evaluateRuntimeReadiness, getRuntimeSamplingSlo, getTelemetry, listAlerts } from "@/lib/monitoring";

export const dynamic = "force-dynamic";

export default async function MonitoringPage() {
  const actor = await authorizedPageRequestContext(["admin", "operator", "analyst"]);
  if (!actor) return <AccessDenied />;
  const runs = await listRuns(actor);
  const run = runs.find((candidate) => candidate.state === "LIVE" || candidate.state === "DEGRADED") ?? runs[0];
  if (!run) return <main className="empty-page"><h1>暂无可监控场次</h1><Link href="/shows">前往创建场次</Link></main>;
  const telemetry = await getTelemetry(actor, run.id);
  const [allAlerts, incidents, samplingSlo] = await Promise.all([listAlerts(actor, run.id), listIncidents(actor, run.id), getRuntimeSamplingSlo(actor, run.id)]);
  const alerts = allAlerts.filter((alert) => alert.status === "open");
  if (!telemetry) return <main className="empty-page"><h1>暂无运行遥测</h1></main>;
  const readiness = await evaluateRuntimeReadiness(actor, run.id);
  const healthy = readiness.passed && alerts.length === 0;
  const sloLabel = samplingSlo.status === "met" ? "达标" : samplingSlo.status === "breached" ? "未达标" : "样本不足";
  const sloRate = samplingSlo.healthRate === null ? "--" : `${(samplingSlo.healthRate * 100).toFixed(1)}%`;
  return <main className="monitoring-page"><header className="monitoring-header"><div><p>运行监控</p><h1>直播运行健康</h1><span>{run.showName} · 阈值：输出不低于 24 FPS，音画同步不高于 120 ms，备用节目必须就绪</span></div><div className="monitoring-header-actions"><Link className="monitoring-incidents-link" href="/runbooks">运行手册</Link><Link className="monitoring-incidents-link" href="/incidents">事故单</Link><span className={healthy ? "monitoring-ok" : "monitoring-risk"}><ShieldCheck size={16} />{healthy ? "当前健康" : "需要处理"}</span></div></header><section className="monitoring-metrics"><Metric icon={Gauge} label="推理帧率" value={`${telemetry.inferenceFps}`} unit="FPS" /><Metric icon={RadioTower} label="输出帧率" value={`${telemetry.outputFps}`} unit="FPS" /><Metric icon={Activity} label="音画同步" value={`${telemetry.avSyncMs}`} unit="ms" /><Metric icon={HardDrive} label="显存占用" value={`${(telemetry.gpuMemoryMiB / 1024).toFixed(1)}`} unit="GiB" /></section><section className="monitoring-grid"><article className="monitoring-panel"><h2>输出状态</h2><dl><div><dt>推流连接</dt><dd>{telemetry.outputConnected ? "已连接" : "未连接"}</dd></div><div><dt>输出码率</dt><dd>{telemetry.bitrateMbps} Mbps</dd></div><div><dt>GPU 使用率</dt><dd>{telemetry.gpuUtilization}%</dd></div><div><dt>备用节目</dt><dd>{telemetry.fallbackReady ? "就绪" : "未就绪"}</dd></div><div><dt>最近采样</dt><dd>{new Date(telemetry.sampledAt).toLocaleString("zh-CN")}{readiness.detail.startsWith("运行时遥测已过期") ? "（已过期）" : ""}</dd></div></dl></article><article className="monitoring-panel"><h2>未解决告警</h2><MonitoringAlertList initialAlerts={alerts} initialIncidentAlertIds={incidents.flatMap((incident) => incident.alertId ? [incident.alertId] : [])} canAcknowledge={actor.role === "admin" || actor.role === "operator"} /></article><article className="monitoring-panel monitoring-slo-panel"><h2>15 分钟采样质量 SLO</h2><dl><div><dt>判定</dt><dd className={`sampling-slo-${samplingSlo.status}`}>{sloLabel}</dd></div><div><dt>健康样本</dt><dd>{samplingSlo.healthySamples}/{samplingSlo.sampleCount}</dd></div><div><dt>健康率 / 目标</dt><dd>{sloRate} / {(samplingSlo.objective * 100).toFixed(0)}%</dd></div><div><dt>说明</dt><dd className="sampling-slo-detail">{samplingSlo.detail}</dd></div></dl><p className="sampling-slo-note">这是遥测采样质量指标，不代表平台端到端可用性 SLA。</p></article></section><Link className="catalog-back" href="/">返回指挥台</Link></main>;
}

function Metric({ icon: Icon, label, value, unit }: { icon: typeof Gauge; label: string; value: string; unit: string }) { return <article className="monitoring-metric"><Icon size={18} /><span>{label}</span><strong>{value} <small>{unit}</small></strong></article>; }

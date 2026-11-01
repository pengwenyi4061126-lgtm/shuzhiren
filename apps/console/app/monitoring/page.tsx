import Link from "next/link";
import { Activity, Gauge, HardDrive, RadioTower, ShieldCheck } from "lucide-react";
import { demoRequestContext } from "@/lib/control-plane/auth-context";
import { getTelemetry, listAlerts } from "@/lib/monitoring";

export default function MonitoringPage() {
  const telemetry = getTelemetry(demoRequestContext, "run_20261101_001");
  const alerts = listAlerts(demoRequestContext, "run_20261101_001");
  if (!telemetry) return <main className="empty-page"><h1>暂无运行遥测</h1></main>;
  return <main className="monitoring-page"><header className="monitoring-header"><div><p>运行监控</p><h1>直播运行健康</h1><span>阈值：输出不低于 24 FPS，音画同步不高于 120 ms，备用节目必须就绪</span></div><span className="monitoring-ok"><ShieldCheck size={16} />当前健康</span></header><section className="monitoring-metrics"><Metric icon={Gauge} label="推理帧率" value={`${telemetry.inferenceFps}`} unit="FPS" /><Metric icon={RadioTower} label="输出帧率" value={`${telemetry.outputFps}`} unit="FPS" /><Metric icon={Activity} label="音画同步" value={`${telemetry.avSyncMs}`} unit="ms" /><Metric icon={HardDrive} label="显存占用" value={`${(telemetry.gpuMemoryMiB / 1024).toFixed(1)}`} unit="GiB" /></section><section className="monitoring-grid"><article className="monitoring-panel"><h2>输出状态</h2><dl><div><dt>推流连接</dt><dd>{telemetry.outputConnected ? "已连接" : "未连接"}</dd></div><div><dt>输出码率</dt><dd>{telemetry.bitrateMbps} Mbps</dd></div><div><dt>GPU 使用率</dt><dd>{telemetry.gpuUtilization}%</dd></div><div><dt>备用节目</dt><dd>{telemetry.fallbackReady ? "就绪" : "未就绪"}</dd></div><div><dt>最近采样</dt><dd>{new Date(telemetry.sampledAt).toLocaleString("zh-CN")}</dd></div></dl></article><article className="monitoring-panel"><h2>未解决告警</h2>{alerts.length ? <ul className="alert-list">{alerts.map((alert) => <li key={alert.id}><strong>{alert.code}</strong><span>{alert.message}</span></li>)}</ul> : <div className="no-alerts"><ShieldCheck size={20} />没有未解决告警</div>}</article></section><Link className="catalog-back" href="/">返回指挥台</Link></main>;
}

function Metric({ icon: Icon, label, value, unit }: { icon: typeof Gauge; label: string; value: string; unit: string }) { return <article className="monitoring-metric"><Icon size={18} /><span>{label}</span><strong>{value} <small>{unit}</small></strong></article>; }

import Link from "next/link";
import { Archive, ArrowLeft } from "lucide-react";
import { AccessDenied } from "@/components/access-denied";
import { authorizedPageRequestContext } from "@/lib/control-plane/page-context";
import { listRecordings } from "@/lib/recordings";

export const dynamic = "force-dynamic";

export default async function RecordingsPage() {
  const actor = await authorizedPageRequestContext(["admin", "operator", "analyst"]);
  if (!actor) return <AccessDenied />;
  const recordings = await listRecordings(actor);
  return <main className="recordings-page"><header className="recordings-header"><div><Link className="back-link" href="/"><ArrowLeft size={16} />返回指挥台</Link><p>留存证据</p><h1>录制归档</h1><span>仅显示已由私网归档服务完成校验并登记的对象存储证据；本页不暴露下载地址或存储凭据。</span></div><Archive size={24} /></header>{recordings.length ? <section className="recordings-table"><div className="recordings-row recordings-labels"><span>录制对象</span><span>场次</span><span>时长</span><span>大小</span><span>留存至</span></div>{recordings.map((recording) => <div className="recordings-row" key={recording.id}><div><strong>{recording.objectKey}</strong><small>SHA-256 {recording.checksumSha256}</small></div><code>{recording.runId}</code><span>{formatDuration(recording.durationSeconds)}</span><span>{formatBytes(recording.bytes)}</span><div><span>{recording.retentionUntil ?? "按存储策略"}</span><small>{new Date(recording.recordedAt).toLocaleString("zh-CN")}</small></div></div>)}</section> : <section className="recordings-empty"><Archive size={22} /><strong>尚无已登记的录制证据</strong><span>运行时完成站外对象存储复制和 SHA-256 校验后，会以私网凭据登记对象键、时长与校验和。</span></section>}<Link className="catalog-back" href="/monitoring">返回运行监控</Link></main>;
}

function formatDuration(seconds: number) { const minutes = Math.floor(seconds / 60); return `${minutes}:${String(seconds % 60).padStart(2, "0")}`; }
function formatBytes(bytes: number) { return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GiB` : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MiB` : `${bytes} B`; }

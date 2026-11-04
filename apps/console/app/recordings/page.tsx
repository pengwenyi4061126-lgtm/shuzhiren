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
  return <main className="recordings-page"><header className="recordings-header"><div><Link className="back-link" href="/"><ArrowLeft size={16} />返回指挥台</Link><p>留存证据</p><h1>录制归档</h1><span>仅显示取得独立私网 verifier 版本、内容和留存证明后登记的对象存储证据；本页不暴露下载地址或存储凭据。</span></div><Archive size={24} /></header>{recordings.length ? <section className="recordings-table"><div className="recordings-row recordings-labels"><span>录制对象</span><span>场次</span><span>时长</span><span>大小</span><span>留存至</span></div>{recordings.map((recording) => <div className="recordings-row" key={recording.id}><div><strong>{recording.objectKey}</strong><small>SHA-256 {recording.checksumSha256}</small><small>版本 {recording.contentVerification.objectVersion} · {recording.contentVerification.evidenceRef}</small></div><code>{recording.runId}</code><span>{formatDuration(recording.durationSeconds)}</span><span>{formatBytes(recording.bytes)}</span><div><span>{recording.retentionUntil ?? "按存储策略"}</span><small>{new Date(recording.contentVerification.verifiedAt).toLocaleString("zh-CN")} 已验证</small></div></div>)}</section> : <section className="recordings-empty"><Archive size={22} /><strong>尚无已验证的录制证据</strong><span>归档服务复制对象后，独立 verifier 必须确认对象版本、实际 SHA-256、大小和留存策略，再以私网凭据登记。</span></section>}<Link className="catalog-back" href="/monitoring">返回运行监控</Link></main>;
}

function formatDuration(seconds: number) { const minutes = Math.floor(seconds / 60); return `${minutes}:${String(seconds % 60).padStart(2, "0")}`; }
function formatBytes(bytes: number) { return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GiB` : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MiB` : `${bytes} B`; }

import Link from "next/link";
import { BookOpenCheck } from "lucide-react";
import { AccessDenied } from "@/components/access-denied";
import { authorizedPageRequestContext } from "@/lib/control-plane/page-context";
import { runbooks, runbookSeverityLabel } from "@/lib/runbooks";

export const dynamic = "force-dynamic";

export default async function RunbooksPage() {
  const actor = await authorizedPageRequestContext(["admin", "operator", "analyst"]);
  if (!actor) return <AccessDenied />;

  return <main className="runbooks-page"><header className="runbooks-header"><div><p>运行手册</p><h1>直播值班处置</h1><span>只读的受控处置标准。执行动作、事故单和发布证据仍会在各自的审计链路中留痕。</span></div><BookOpenCheck size={26} aria-hidden="true" /></header><section className="runbook-summary" aria-label="手册响应标准"><span><strong>P1</strong> 先止损再排障</span><span><strong>P2</strong> 先停止错误承诺</span><span><strong>留证</strong> 原始日志与冻结版本不可覆盖</span></section><section className="runbook-list" aria-label="值班运行手册">{runbooks.map((runbook) => <article className="runbook-card" key={runbook.id}><header><div><span className={`runbook-severity ${runbook.severity.toLowerCase()}`}>{runbookSeverityLabel[runbook.severity]}</span><h2>{runbook.title}</h2></div><span className="runbook-target">{runbook.responseTarget}</span></header><dl><div><dt>触发条件</dt><dd>{runbook.trigger}</dd></div><div><dt>责任人</dt><dd>{runbook.owner}</dd></div></dl><div className="runbook-actions"><h3>处置顺序</h3><ol>{runbook.steps.map((step) => <li key={step}>{step}</li>)}</ol></div><div className="runbook-evidence"><h3>必须留存</h3><ul>{runbook.evidence.map((item) => <li key={item}>{item}</li>)}</ul></div></article>)}</section><div className="runbook-footer"><Link className="catalog-back" href="/monitoring">返回运行监控</Link><Link className="monitoring-incidents-link" href="/incidents">前往事故单</Link></div></main>;
}

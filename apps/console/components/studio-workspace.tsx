"use client";

import Link from "next/link";
import { useMemo, useState, type FormEvent } from "react";
import { ArrowDownToLine, ArrowRight, Check, CircleAlert, Clapperboard, FileText, FolderOpen, Paperclip, Radio, Save, Sparkles } from "lucide-react";
import type { ChannelConnection } from "@/lib/channels";
import type { Product } from "@/lib/catalog";
import type { CreationOutputMode, CreationProject } from "@/lib/creation-projects";
import { splitNarrationScript } from "@/lib/shared/content-script.mjs";
import { clientFetch } from "@/lib/client-request";
import { PhotoRecordingComposer } from "@/components/photo-recording-composer";
import styles from "./studio-workspace.module.css";

type AssetOption = { id: string; kind: string; name: string; approval: string; expiresAt?: string; rightsScope: string; contentType: string; checksum: string };
type Props = { products: Product[]; channels: ChannelConnection[]; assets: AssetOption[]; initialProjects: CreationProject[]; canCreate: boolean };
type OutputMode = "recording" | "live" | "both";
type LiveRun = { id: string; showName: string };

export function StudioWorkspace({ products, channels, assets, initialProjects, canCreate }: Props) {
  const versions = useMemo(() => products.flatMap((product) => product.versions.filter((version) => version.status === "approved").map((version) => ({ product, version }))), [products]);
  const connectedChannels = channels.filter((channel) => channel.status === "connected");
  const firstProject = initialProjects[0];
  const [projects, setProjects] = useState(initialProjects);
  const [projectId, setProjectId] = useState(firstProject?.id ?? "");
  const [projectRevision, setProjectRevision] = useState(firstProject?.revision ?? 0);
  const [productVersionId, setProductVersionId] = useState(firstProject?.productVersionId ?? versions[0]?.version.id ?? "");
  const selected = versions.find(({ version }) => version.id === productVersionId) ?? versions[0];
  const [projectName, setProjectName] = useState(firstProject?.name ?? "");
  const [goal, setGoal] = useState(firstProject?.goal ?? "介绍商品特点与使用方式");
  const [audience, setAudience] = useState(firstProject?.audience ?? "第一次了解这类产品的用户");
  const [output, setOutput] = useState<OutputMode>(firstProject?.outputMode ?? "both");
  const [channelId, setChannelId] = useState(connectedChannels[0]?.id ?? "");
  const [scheduledAt, setScheduledAt] = useState("");
  const [assetIds, setAssetIds] = useState<string[]>(firstProject?.assetIds ?? []);
  const [script, setScript] = useState(firstProject?.script ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [createdRun, setCreatedRun] = useState<LiveRun | null>(null);

  const facts = selected?.version.facts;
  const activeProject = projects.find((project) => project.id === projectId);
  const selectedPhotoPortrait = assets.some((asset) => asset.kind === "portrait_photo" && assetIds.includes(asset.id));
  const projectPhotos = assets.filter((asset) => asset.kind === "portrait_photo" && asset.approval === "approved" && assetIds.includes(asset.id));
  const starterScript = useMemo(() => {
    if (!selected || !facts) return "请先在商品中心准备并审核商品事实。";
    const highlights = facts.highlights.filter(Boolean).join("、");
    const price = Number.isFinite(facts.priceCent) ? `已审核商品信息中的价格为 ${(facts.priceCent / 100).toFixed(2)} 元。` : "价格以已审核商品卡为准。";
    const faq = facts.faq.filter(Boolean).slice(0, 2).join("；");
    return `欢迎来到直播间，今天我们介绍${selected.product.name}。${highlights ? `已审核资料提到：${highlights}。` : "具体特点请查看已审核商品资料。"}${price}${faq ? `常见信息：${faq}。` : "下单与售后信息请以商品页为准。"}如果你刚接触这类产品，可以先根据自己的需求查看商品详情，再决定是否适合。`;
  }, [selected, facts]);

  function projectPayload() {
    if (!selected) throw new Error("请先选择已审核的商品事实版本");
    return {
      name: projectName.trim() || selected.product.name,
      goal: goal.trim(),
      audience: audience.trim(),
      outputMode: output as CreationOutputMode,
      productVersionId: selected.version.id,
      assetIds,
      script: script.trim() || starterScript
    };
  }

  async function persistProject() {
    const response = await clientFetch(projectId ? `/api/v1/studio/projects/${encodeURIComponent(projectId)}` : "/api/v1/studio/projects", {
      method: projectId ? "PUT" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(projectPayload())
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "保存内容项目失败");
    const saved = result.data as CreationProject;
    setProjectId(saved.id);
    setProjectRevision(saved.revision);
    setProjectName(saved.name);
    setScript(saved.script);
    setProjects((current) => [saved, ...current.filter((project) => project.id !== saved.id)]);
    setNotice(`项目已保存 · 第 ${saved.revision} 次保存`);
    return saved;
  }

  function startNewProject() {
    setProjectId("");
    setProjectRevision(0);
    setProjectName("");
    setGoal("介绍商品特点与使用方式");
    setAudience("第一次了解这类产品的用户");
    setOutput("both");
    setProductVersionId(versions[0]?.version.id ?? "");
    setAssetIds([]);
    setScript("");
    setCreatedRun(null);
    setError("");
    setNotice("");
  }

  function selectProject(id: string) {
    const project = projects.find((item) => item.id === id);
    if (!project) { startNewProject(); return; }
    setProjectId(project.id);
    setProjectRevision(project.revision);
    setProjectName(project.name);
    setGoal(project.goal);
    setAudience(project.audience);
    setOutput(project.outputMode);
    setProductVersionId(project.productVersionId);
    setAssetIds(project.assetIds);
    setScript(project.script);
    setCreatedRun(null);
    setError("");
    setNotice("");
  }

  async function saveProject() {
    setBusy(true);
    setError("");
    try { await persistProject(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "保存失败，请重试"); }
    finally { setBusy(false); }
  }

  async function downloadRecordingPack() {
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      const saved = await persistProject();
      const selectedAssets = assets.filter((asset) => saved.assetIds.includes(asset.id));
      const content = [
        `# ${saved.name}｜录播制作包`,
        "",
        `- 项目编号：${saved.id}`,
        `- 项目修订：${saved.revision}`,
        `- 目标：${saved.goal}`,
        `- 受众：${saved.audience}`,
        `- 商品事实版本：${selected.product.name} v${selected.version.revision}（${selected.version.id}）`,
        `- 事实来源：${facts?.sourceRef ?? "未提供"}`,
        `- 关联素材：${selectedAssets.map((asset) => asset.name).join("、") || "未选择"}`,
        "",
        "## 口播脚本草稿",
        "",
        saved.script,
        "",
        "## 制作检查",
        "",
        "- 使用已授权素材；人物形象与声音在发布前完成人工审核。",
        "- 逐项核对商品事实有效期、价格、库存与平台要求。",
        "- 当前导出为脚本制作包，不是已渲染的视频文件。"
      ].join("\n");
      const url = URL.createObjectURL(new Blob([content], { type: "text/markdown;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `${saved.name.replace(/[\\/:*?"<>|]/g, "-")}-录播制作包.md`;
      link.click();
      URL.revokeObjectURL(url);
      setNotice("项目已保存并导出录播脚本包；照片播报视频可在输出区单独生成。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "导出失败，请重试");
    } finally {
      setBusy(false);
    }
  }

  async function createLiveOutput(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !channelId || !canCreate) return;
    setBusy(true);
    setError("");
    setNotice("");
    setCreatedRun(null);
    try {
      const project = await persistProject();
      const scriptChunks = splitNarrationScript(project.script);
      const showName = project.name;
      const response = await clientFetch("/api/v1/live-runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ showName, ...(scheduledAt ? { scheduledAt: new Date(scheduledAt).toISOString() } : {}), channelConnectionId: channelId, productVersionId: selected.version.id, mediaAssetIds: project.assetIds, aiDisclosureEnabled: true })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "创建直播场次失败");
      const run = result.data as LiveRun;
      setCreatedRun(run);
      const segments = [
        ...scriptChunks.map((runtimeScript, index) => ({ kind: "prepared_product", title: index === 0 ? "开场与项目介绍" : `商品内容 ${index + 1}`, durationSeconds: index === 0 ? 90 : 180, purpose: "基于项目脚本和审核通过的商品事实进行介绍", runtimeScript })),
        { kind: "interactive", title: "受控互动答疑", durationSeconds: 120, purpose: "仅回答审核资料覆盖的问题，其他问题转人工", runtimeScript: "现在进入互动答疑。对于已审核商品资料中有明确依据的问题，我会按资料回答；资料未覆盖的内容会为你转交人工确认。" },
        { kind: "fallback", title: "安全兜底", durationSeconds: 60, purpose: "互动异常时停止自动回答" },
        { kind: "human_handoff", title: "人工接管", durationSeconds: 60, purpose: "争议、投诉或资料缺失时转人工处理" }
      ];
      const programResponse = await clientFetch(`/api/v1/live-runs/${encodeURIComponent(run.id)}/program`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ segments })
      });
      const programResult = await programResponse.json();
      if (!programResponse.ok) throw new Error(programResult.error ?? "场次已创建，但节目单写入失败。可从下方链接继续编辑。");
      const linkResponse = await clientFetch(`/api/v1/studio/projects/${encodeURIComponent(project.id)}/live-outputs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId: run.id })
      });
      const linkResult = await linkResponse.json();
      if (!linkResponse.ok) throw new Error(linkResult.error ?? "节目单已创建，但项目输出关联失败。");
      setProjects((current) => [linkResult.data as CreationProject, ...current.filter((item) => item.id !== project.id)]);
      setNotice("直播草稿场次与节目单已创建。发布前仍需完成审核、渠道与运行时预检。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败，请重试");
    } finally {
      setBusy(false);
    }
  }

  const canCreateLive = canCreate && versions.length > 0 && connectedChannels.length > 0;

  return <main className={styles.page}>
    <header className={styles.header}>
      <div><div className={styles.eyebrow}>内容项目 / 双输出</div><h1>内容工坊</h1><p>先准备一份内容，再生成照片播报视频、直播场次，或两者兼有。</p></div>
      <Link className={styles.secondaryAction} href="/assets"><FileText size={16} />素材资产</Link>
    </header>

    <div className={styles.progress} aria-label="内容创建步骤">
      <span className={styles.current}><b>1</b> 内容项目</span><i /><span><b>2</b> 脚本与素材</span><i /><span><b>3</b> 输出与审核</span>
    </div>

    <form className={styles.layout} onSubmit={createLiveOutput}>
      <section className={styles.editor}>
        <div className={styles.sectionHead}><div><span className={styles.kicker}>PROJECT</span><h2>一个内容项目</h2></div><div className={styles.projectActions}>{projects.length ? <label className={styles.projectSelect}><FolderOpen size={14} /><select aria-label="打开已保存项目" value={projectId} onChange={(event) => selectProject(event.target.value)}><option value="">新建项目</option>{projects.map((project) => <option value={project.id} key={project.id}>{project.name} · r{project.revision}</option>)}</select></label> : null}<button className={styles.newProject} type="button" onClick={startNewProject}>新建</button><span className={styles.projectBadge}><Clapperboard size={15} />{projectId ? `已保存 r${projectRevision}` : "新草稿"}</span></div></div>
        <label className={styles.field}>项目名称<input value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder={selected?.product.name ?? "例：周末护肤专题"} /></label>
        <label className={styles.field}>商品与已审核事实<select value={productVersionId} onChange={(event) => { setProductVersionId(event.target.value); setScript(""); }} disabled={!versions.length}>{versions.map(({ product, version }) => <option key={version.id} value={version.id}>{product.name} · v{version.revision} · 已审核</option>)}</select></label>
        <div className={styles.twoFields}>
          <label className={styles.field}>本次内容目标<input value={goal} onChange={(event) => setGoal(event.target.value)} maxLength={120} /></label>
          <label className={styles.field}>面向受众<input value={audience} onChange={(event) => setAudience(event.target.value)} maxLength={120} /></label>
        </div>
        {selected ? <div className={styles.factStrip}><span>事实版本 {selected.version.id}</span><span>¥{(selected.version.facts.priceCent / 100).toFixed(2)}</span><span>库存 {selected.version.facts.stock}</span><span>{selected.version.facts.highlights.slice(0, 2).join(" · ") || "未录入卖点"}</span></div> : <div className={styles.empty}>暂无已审核商品。请先到 <Link href="/products">商品中心</Link> 完成商品资料审核。</div>}
        <div className={styles.assetPicker}><div className={styles.assetPickerHead}><span><Paperclip size={14} />项目素材</span><small>选择已有的已批准素材，原文件由素材资产管理</small></div>{assets.some((asset) => asset.approval === "approved") ? <div className={styles.assetList}>{assets.filter((asset) => asset.approval === "approved").map((asset) => <label className={styles.assetOption} key={asset.id}><input type="checkbox" checked={assetIds.includes(asset.id)} onChange={(event) => setAssetIds((current) => event.target.checked ? [...new Set([...current, asset.id])] : current.filter((id) => id !== asset.id))} /><span><strong>{asset.name}</strong><small>{asset.kind === "portrait_photo" ? "照片形象 · 仅录播" : asset.kind === "portrait" ? "肖像视频" : asset.kind}{asset.contentType ? ` · ${asset.contentType}` : ""} · {asset.rightsScope}</small></span></label>)}</div> : <p className={styles.noAssets}>暂无已批准素材，可先保存项目并稍后补充。</p>}{selectedPhotoPortrait && output !== "recording" ? <p className={styles.assetBoundary}>已选照片只进入录播制作素材；直播输出不会把照片当作可直播 Avatar。</p> : null}</div>
        <div className={styles.scriptHeader}><div><span className={styles.kicker}>SHARED SCRIPT</span><h3>同一份脚本草稿</h3></div><button type="button" className={styles.textAction} onClick={() => setScript(starterScript)} disabled={!selected}><Sparkles size={15} />按审核资料起草</button></div>
        <textarea className={styles.script} value={script || starterScript} onChange={(event) => setScript(event.target.value)} maxLength={4000} aria-label="内容脚本草稿" />
        <p className={styles.helper}>脚本草稿由已审核商品事实整理，可直接修改；发布前仍需人工复核。素材授权与人物形象审核在素材资产中管理。</p>
      </section>

      <aside className={styles.outputPanel}>
        <div className={styles.sectionHead}><div><span className={styles.kicker}>OUTPUTS</span><h2>两个输出</h2></div></div>
        <div className={styles.outputChoices} role="group" aria-label="选择输出方式">
          {([ ["both", "双输出", "照片播报视频 + 直播场次"], ["recording", "录播", "照片播报视频"], ["live", "直播", "创建直播草稿场次"] ] as const).map(([value, label, detail]) => <button className={output === value ? styles.outputSelected : ""} key={value} onClick={() => setOutput(value)} type="button" aria-pressed={output === value}><span>{label}</span><small>{detail}</small></button>)}
        </div>

        {(output === "recording" || output === "both") ? <><div className={styles.outputRow}><span className={styles.outputIcon}><Clapperboard size={18} /></span><span><strong>照片播报视频</strong><small>静态照片 + 口播 + 字幕，可预览并下载 WebM</small></span></div><PhotoRecordingComposer key={`${projectId}:${projectPhotos.map((photo) => photo.id).join(",")}`} photos={projectPhotos.map(({ id, name, checksum }) => ({ id, name, checksum }))} selectedPhotoIds={assetIds} script={script || starterScript} projectName={projectName || selected?.product.name || "内容项目"} canCreate={canCreate} /><div className={styles.outputRow}><span className={styles.outputIcon}><FileText size={17} /></span><span><strong>录播制作包</strong><small>项目简报与共享脚本 Markdown</small></span><button type="button" className={styles.iconAction} aria-label="导出录播制作包" title="导出录播制作包" onClick={downloadRecordingPack}><ArrowDownToLine size={17} /></button></div></> : null}
        {(output === "live" || output === "both") ? <>
          <label className={styles.field}>直播渠道<select value={channelId} onChange={(event) => setChannelId(event.target.value)} disabled={!connectedChannels.length}>{connectedChannels.map((channel: ChannelConnection) => <option value={channel.id} key={channel.id}>{channel.name} · {channel.outputProtocol.toUpperCase()}</option>)}</select></label>
          <label className={styles.field}>计划开播时间 <span className={styles.optional}>可稍后排期</span><input type="datetime-local" value={scheduledAt} onChange={(event) => setScheduledAt(event.target.value)} /></label>
          <div className={styles.disclosure}><Check size={15} />创建时默认启用 AI 数字人标识</div>
        </> : null}

        {notice ? <div className={styles.success} role="status"><Check size={17} /><span>{notice}</span></div> : null}
        {error ? <div className={styles.error} role="alert"><CircleAlert size={17} /><span>{error}</span></div> : null}
        {createdRun ? <div className={styles.runLinks}><strong>已创建：{createdRun.showName}</strong><Link href={`/shows/${createdRun.id}/program`}>打开节目单 <ArrowRight size={14} /></Link><Link href={`/shows/${createdRun.id}/preflight`}>查看开播预检 <ArrowRight size={14} /></Link></div> : null}
        {activeProject?.liveRunIds.length ? <div className={styles.runLinks}><strong>该项目已关联的直播输出</strong>{activeProject.liveRunIds.map((runId) => <span key={runId}><Link href={`/shows/${runId}/program`}>节目单 {runId.slice(0, 8)} <ArrowRight size={14} /></Link><Link href={`/shows/${runId}/preflight`}>预检 <ArrowRight size={14} /></Link></span>)}</div> : null}

        <div className={styles.outputFooter}>
          <button type="button" className={styles.saveAction} onClick={saveProject} disabled={busy || !canCreate || !selected}><Save size={15} />{busy ? "保存中…" : projectId ? "保存项目更改" : "保存内容项目"}</button>
          {output !== "live" ? <button type="button" className={styles.primaryAction} onClick={downloadRecordingPack} disabled={busy || !selected}><ArrowDownToLine size={16} />导出录播制作包</button> : null}
          {output !== "recording" ? <button type="submit" className={styles.primaryAction} disabled={busy || !canCreateLive || !selected}>{busy ? "正在创建…" : "创建直播草稿场次"}<ArrowRight size={16} /></button> : null}
          {!canCreate && output !== "recording" ? <p className={styles.helper}>当前账号只有查看权限。</p> : null}
          {!connectedChannels.length && output !== "recording" ? <p className={styles.helper}>还没有已连接渠道，请先到 <Link href="/channels">渠道设置</Link> 完成配置。</p> : null}
        </div>
      </aside>
    </form>
    <footer className={styles.limitNote}><Radio size={16} /><span><strong>生成边界</strong>照片播报视频在浏览器本地生成；动态口型 Avatar、服务端成片保存和 4090 实机验收仍未接入。直播场次不会自动开播，仍须经过脚本审核和预检。</span></footer>
  </main>;
}

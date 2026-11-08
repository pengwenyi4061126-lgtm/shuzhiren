"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ArrowDownToLine, ArrowRight, Check, CircleAlert, Clapperboard, FileText, FolderOpen, Paperclip, Radio, RefreshCw, Save, Sparkles, Upload } from "lucide-react";
import type { ChannelConnection } from "@/lib/channels";
import type { Product } from "@/lib/catalog";
import type { CreationOutputMode, CreationProject } from "@/lib/creation-projects";
import { generateProductScript, splitNarrationScript } from "@/lib/shared/content-script.mjs";
import { canResumeLiveOutput, clearLiveOutputCheckpoint, readLiveOutputCheckpoint, saveLiveOutputCheckpoint, type PendingLiveOutput } from "@/lib/shared/live-output-resume.mjs";
import { clientFetch } from "@/lib/client-request";
import { PhotoRecordingComposer } from "@/components/photo-recording-composer";
import { ProhibitedTermHints } from "@/components/prohibited-term-hints";
import { listProjectRecordings } from "@/lib/project-recording-vault";
import styles from "./studio-workspace.module.css";

type AssetOption = { id: string; kind: string; name: string; approval: string; expiresAt?: string; rightsScope: string; contentType: string; checksum: string; runtimeVoiceId?: string };
type Props = { products: Product[]; channels: ChannelConnection[]; assets: AssetOption[]; initialProjects: CreationProject[]; canCreate: boolean };
type OutputMode = "recording" | "live" | "both";
type LiveRun = { id: string; showName: string };
type PendingOutput = PendingLiveOutput;
type ScriptStyle = "friendly" | "professional" | "faq";
type ScriptLength = "short" | "standard" | "detailed";

export function StudioWorkspace({ products, channels, assets: initialAssets, initialProjects, canCreate }: Props) {
  const versions = useMemo(() => products.flatMap((product) => product.versions.filter((version) => version.status === "approved").map((version) => ({ product, version }))), [products]);
  const connectedChannels = channels.filter((channel) => channel.status === "connected");
  const firstProject = initialProjects[0];
  const [projects, setProjects] = useState(initialProjects);
  const [assets, setAssets] = useState(initialAssets);
  const [projectId, setProjectId] = useState(firstProject?.id ?? "");
  const [recordingComposerKey, setRecordingComposerKey] = useState(0);
  const [scriptReviewEpoch, setScriptReviewEpoch] = useState(0);
  const [scriptReviewMark, setScriptReviewMark] = useState<{ epoch: number; productVersionId: string; text: string } | null>(() => firstProject?.scriptReview ? { epoch: 0, productVersionId: firstProject.scriptReview.productVersionId, text: firstProject.script } : null);
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
  const [scriptStyle, setScriptStyle] = useState<ScriptStyle>("friendly");
  const [scriptLength, setScriptLength] = useState<ScriptLength>("standard");
  const [busy, setBusy] = useState(false);
  const [scriptReviewBusy, setScriptReviewBusy] = useState(false);
  const [activeStep, setActiveStep] = useState<1 | 2 | 3>(1);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [assetNotice, setAssetNotice] = useState("");
  const [refreshingAssets, setRefreshingAssets] = useState(false);
  const [createdRun, setCreatedRun] = useState<LiveRun | null>(null);
  const [pendingOutput, setPendingOutput] = useState<PendingOutput | null>(null);
  const [recordingOutputState, setRecordingOutputState] = useState<{ projectId: string; count: number; serverCount: number | null }>({ projectId: "", count: 0, serverCount: null });

  useEffect(() => {
    let active = true;
    if (!projectId) return () => { active = false; };
    listProjectRecordings(projectId).then((outputs) => {
      if (active) setRecordingOutputState((state) => ({ projectId, count: outputs.length, serverCount: state.projectId === projectId ? state.serverCount : null }));
    }).catch(() => {
      if (active) setRecordingOutputState({ projectId, count: 0, serverCount: null });
    });
    clientFetch(`/api/v1/studio/projects/${encodeURIComponent(projectId)}/recordings`)
      .then(async (response) => {
        if (!response.ok) throw new Error("server_archive_unavailable");
        const result = await response.json() as { data?: unknown[] };
        if (active && Array.isArray(result.data)) setRecordingOutputState((state) => ({ projectId, count: state.projectId === projectId ? state.count : 0, serverCount: result.data!.length }));
      })
      .catch(() => { if (active) setRecordingOutputState((state) => ({ projectId, count: state.projectId === projectId ? state.count : 0, serverCount: null })); });
    return () => { active = false; };
  }, [projectId]);

  useEffect(() => {
    const restore = () => {
      if (!projectId) { setPendingOutput(null); return; }
      const pending = readLiveOutputCheckpoint(window.localStorage, projectId);
      setPendingOutput(pending);
      if (pending) {
        setChannelId(pending.request.channelConnectionId);
        setScheduledAt(pending.request.scheduledAt ? toLocalDateTime(pending.request.scheduledAt) : "");
      }
    };
    const frame = window.requestAnimationFrame(restore);
    return () => window.cancelAnimationFrame(frame);
  }, [projectId]);

  const facts = selected?.version.facts;
  const activeProject = projects.find((project) => project.id === projectId);
  const selectedPhotoPortrait = assets.some((asset) => asset.kind === "portrait_photo" && assetIds.includes(asset.id));
  const selectedLivePortrait = assets.some((asset) => asset.kind === "portrait" && asset.approval === "approved" && assetIds.includes(asset.id)
    && (!asset.expiresAt || asset.expiresAt >= new Date().toISOString().slice(0, 10))
    && /^video\//i.test(asset.contentType) && /^sha256:[a-f0-9]{64}$/i.test(asset.checksum));
  const projectPhotos = assets.filter((asset) => asset.kind === "portrait_photo" && asset.approval === "approved" && assetIds.includes(asset.id));
  const starterScript = useMemo(() => {
    if (!selected || !facts) return "请先在商品中心准备并审核商品事实。";
    return generateProductScript({ name: selected.product.name, goal, audience, priceCent: facts.priceCent, highlights: facts.highlights, faq: facts.faq, style: scriptStyle, length: scriptLength });
  }, [selected, facts, goal, audience, scriptStyle, scriptLength]);
  const currentScript = script || starterScript;
  const scriptReviewed = scriptReviewMark?.epoch === scriptReviewEpoch && scriptReviewMark.productVersionId === productVersionId && scriptReviewMark.text === currentScript;
  const hasUnsavedChanges = activeProject
    ? projectName.trim() !== activeProject.name || goal.trim() !== activeProject.goal || audience.trim() !== activeProject.audience || output !== activeProject.outputMode || productVersionId !== activeProject.productVersionId || JSON.stringify([...new Set(assetIds)].sort()) !== JSON.stringify([...activeProject.assetIds].sort()) || (script.trim() || starterScript) !== activeProject.script
    : Boolean(projectName.trim() || script.trim() || assetIds.length || goal !== "介绍商品特点与使用方式" || audience !== "第一次了解这类产品的用户" || output !== "both" || productVersionId !== (firstProject?.productVersionId ?? versions[0]?.version.id ?? ""));

  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeLeaving);
    return () => window.removeEventListener("beforeunload", warnBeforeLeaving);
  }, [hasUnsavedChanges]);

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
    setScriptReviewMark(saved.scriptReview ? { epoch: scriptReviewEpoch, productVersionId: saved.scriptReview.productVersionId, text: saved.script } : null);
    setNotice(`项目已保存 · 第 ${saved.revision} 次保存`);
    return saved;
  }

  async function refreshProjectAssets() {
    if (refreshingAssets) return;
    setRefreshingAssets(true);
    setAssetNotice("");
    try {
      const response = await clientFetch("/api/v1/assets", { cache: "no-store" });
      const result = await response.json() as { data?: Array<{ id: string; kind: string; name: string; approval: string; expiresAt?: string; rightsScope: string; checksum: string; runtimeVoiceId?: string; contentVerification?: { contentType: string } }> ; error?: string };
      if (!response.ok || !Array.isArray(result.data)) throw new Error(result.error ?? "刷新素材列表失败");
      const refreshed: AssetOption[] = result.data.map((asset) => ({ id: asset.id, kind: asset.kind, name: asset.name, approval: asset.approval, expiresAt: asset.expiresAt, rightsScope: asset.rightsScope, checksum: asset.checksum, contentType: asset.contentVerification?.contentType ?? "", ...(asset.runtimeVoiceId ? { runtimeVoiceId: asset.runtimeVoiceId } : {}) }));
      setAssets(refreshed);
      const approvedCount = refreshed.filter((asset) => asset.approval === "approved").length;
      const pendingCount = refreshed.filter((asset) => asset.approval === "pending").length;
      setAssetNotice(`素材已更新：${approvedCount} 项可加入项目${pendingCount ? `，${pendingCount} 项待审核` : ""}。`);
    } catch (cause) {
      setAssetNotice(cause instanceof Error ? cause.message : "刷新素材列表失败，请重试。");
    } finally {
      setRefreshingAssets(false);
    }
  }

  function startNewProject() {
    if (hasUnsavedChanges && !window.confirm("当前项目有尚未保存的更改。放弃更改并新建项目吗？")) return;
    setRecordingComposerKey((key) => key + 1);
    setScriptReviewEpoch((epoch) => epoch + 1);
    setScriptReviewMark(null);
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
    if (id === projectId) return;
    const project = projects.find((item) => item.id === id);
    if (!project) { startNewProject(); return; }
    if (hasUnsavedChanges && !window.confirm("当前项目有尚未保存的更改。放弃更改并切换项目吗？")) return;
    setRecordingComposerKey((key) => key + 1);
    const nextReviewEpoch = scriptReviewEpoch + 1;
    setScriptReviewEpoch(nextReviewEpoch);
    setScriptReviewMark(project.scriptReview ? { epoch: nextReviewEpoch, productVersionId: project.scriptReview.productVersionId, text: project.script } : null);
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

  async function updateScriptReview(checked: boolean) {
    if (!checked) {
      setScriptReviewMark(null);
      if (!projectId) return;
      setScriptReviewBusy(true); setError("");
      try {
        const response = await clientFetch(`/api/v1/studio/projects/${encodeURIComponent(projectId)}/script-review`, { method: "DELETE" });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? "撤销脚本审核失败");
        const project = result.data as CreationProject;
        setProjects((current) => [project, ...current.filter((item) => item.id !== project.id)]);
        setNotice("当前脚本审核已撤销。");
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "撤销脚本审核失败");
        const project = projects.find((item) => item.id === projectId);
        if (project?.scriptReview) setScriptReviewMark({ epoch: scriptReviewEpoch, productVersionId: project.scriptReview.productVersionId, text: project.script });
      } finally { setScriptReviewBusy(false); }
      return;
    }
    if (!canCreate || !selected) return;
    setScriptReviewBusy(true); setError(""); setNotice("");
    try {
      const saved = await persistProject();
      const response = await clientFetch(`/api/v1/studio/projects/${encodeURIComponent(saved.id)}/script-review`, { method: "POST" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "脚本审核未通过");
      const reviewedProject = result.data as CreationProject;
      setProjects((current) => [reviewedProject, ...current.filter((item) => item.id !== reviewedProject.id)]);
      setScriptReviewMark({ epoch: scriptReviewEpoch, productVersionId: reviewedProject.productVersionId, text: reviewedProject.script });
      setNotice("脚本检查通过，人工审核已记录到项目审计。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "脚本审核失败");
    } finally { setScriptReviewBusy(false); }
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
    if (!selected || !channelId || !canCreate || !scriptReviewed || scriptReviewBusy) return;
    setBusy(true);
    setError("");
    setNotice("");
    setCreatedRun(null);
    try {
      const project = await persistProject();
      const scriptChunks = splitNarrationScript(project.script);
      const request = { showName: project.name, ...(scheduledAt ? { scheduledAt: new Date(scheduledAt).toISOString() } : {}), channelConnectionId: channelId, productVersionId: selected.version.id, creationProjectId: project.id, mediaAssetIds: project.assetIds, aiDisclosureEnabled: true as const };
      const requestFingerprint = JSON.stringify(request);
      const resume = canResumeLiveOutput(pendingOutput, project.id, requestFingerprint);
      const idempotencyKey = resume ? pendingOutput!.idempotencyKey : crypto.randomUUID();
      const checkpoint: PendingOutput = { projectId: project.id, requestFingerprint, idempotencyKey, request, run: null };
      let run: LiveRun;
      if (resume && pendingOutput?.run) {
        run = pendingOutput.run;
      } else {
        saveLiveOutputCheckpoint(window.localStorage, checkpoint);
        setPendingOutput(checkpoint);
        const response = await clientFetch("/api/v1/live-runs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...request, idempotencyKey })
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? "创建直播场次失败");
        run = result.data as LiveRun;
        const createdCheckpoint = { ...checkpoint, run };
        saveLiveOutputCheckpoint(window.localStorage, createdCheckpoint);
        setPendingOutput(createdCheckpoint);
      }
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
      clearLiveOutputCheckpoint(window.localStorage, project.id);
      setPendingOutput(null);
      setNotice("直播草稿场次与节目单已创建。发布前仍需完成审核、渠道与运行时预检。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败，请重试");
    } finally {
      setBusy(false);
    }
  }

  const channelReady = connectedChannels.some((channel) => channel.id === channelId);
  const canCreateLive = canCreate && versions.length > 0 && channelReady && scriptReviewed;
  const pendingRequest = selected && projectId ? { showName: projectName.trim() || selected.product.name, ...(scheduledAt ? { scheduledAt: new Date(scheduledAt).toISOString() } : {}), channelConnectionId: channelId, productVersionId: selected.version.id, creationProjectId: projectId, mediaAssetIds: assetIds, aiDisclosureEnabled: true as const } : null;
  const canResumePending = Boolean(pendingRequest && canResumeLiveOutput(pendingOutput, projectId, JSON.stringify(pendingRequest)));

  function navigateStep(step: 1 | 2 | 3, targetId: string) {
    setActiveStep(step);
    const target = document.getElementById(targetId);
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  return <main className={styles.page}>
    <header className={styles.header}>
      <div><div className={styles.eyebrow}>内容项目 / 双输出</div><h1>内容工坊</h1><p>先准备一份内容，再生成照片播报视频、直播场次，或两者兼有。</p></div>
      <Link className={styles.secondaryAction} href="/assets" target="_blank" rel="noreferrer"><FileText size={16} />素材资产</Link>
    </header>

    <nav className={styles.progress} aria-label="内容创建步骤">
      <button type="button" className={`${styles.progressStep} ${activeStep === 1 ? styles.current : ""}`} aria-current={activeStep === 1 ? "step" : undefined} onClick={() => navigateStep(1, "studio-project-step")}><b>1</b> 内容项目</button><i />
      <button type="button" className={`${styles.progressStep} ${activeStep === 2 ? styles.current : ""}`} aria-current={activeStep === 2 ? "step" : undefined} onClick={() => navigateStep(2, "studio-script-step")}><b>2</b> 脚本与素材</button><i />
      <button type="button" className={`${styles.progressStep} ${activeStep === 3 ? styles.current : ""}`} aria-current={activeStep === 3 ? "step" : undefined} onClick={() => navigateStep(3, "studio-output-step")}><b>3</b> 输出与审核</button>
    </nav>

    <form className={styles.layout} onSubmit={createLiveOutput}>
      <section className={styles.editor} id="studio-project-step" tabIndex={-1} onFocusCapture={() => setActiveStep(1)}>
        <div className={styles.sectionHead}><div><span className={styles.kicker}>PROJECT</span><h2>一个内容项目</h2></div><div className={styles.projectActions}>{projects.length ? <label className={styles.projectSelect}><FolderOpen size={14} /><select aria-label="打开已保存项目" value={projectId} onChange={(event) => selectProject(event.target.value)}><option value="">新建项目</option>{projects.map((project) => <option value={project.id} key={project.id}>{project.name} · r{project.revision}</option>)}</select></label> : null}<button className={styles.newProject} type="button" onClick={startNewProject}>新建</button><span className={`${styles.projectBadge} ${hasUnsavedChanges ? styles.projectDirty : ""}`}><Clapperboard size={15} />{hasUnsavedChanges ? "有未保存更改" : projectId ? `已保存 r${projectRevision}` : "新草稿"}</span></div></div>
        <label className={styles.field}>项目名称<input value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder={selected?.product.name ?? "例：周末护肤专题"} /></label>
        <label className={styles.field}>商品与已审核事实<select value={productVersionId} onChange={(event) => { setProductVersionId(event.target.value); setScript(""); }} disabled={!versions.length}>{versions.map(({ product, version }) => <option key={version.id} value={version.id}>{product.name} · v{version.revision} · 已审核</option>)}</select></label>
        <div className={styles.twoFields}>
          <label className={styles.field}>本次内容主题（用于生成开场）<input value={goal} onChange={(event) => setGoal(event.target.value)} maxLength={120} placeholder="例：第一次选购时重点看哪些信息" /></label>
          <label className={styles.field}>面向受众<input value={audience} onChange={(event) => setAudience(event.target.value)} maxLength={120} /></label>
        </div>
        {selected ? <div className={styles.factStrip}><span>事实版本 {selected.version.id}</span><span>¥{(selected.version.facts.priceCent / 100).toFixed(2)}</span><span>库存 {selected.version.facts.stock}</span><span>{selected.version.facts.highlights.slice(0, 2).join(" · ") || "未录入卖点"}</span></div> : <div className={styles.empty}>暂无已审核商品。请先到 <Link href="/products">商品中心</Link> 完成商品资料审核。</div>}
        <div className={styles.assetPicker} onFocusCapture={() => setActiveStep(2)}><div className={styles.assetPickerHead}><span><Paperclip size={14} />项目素材</span><div className={styles.assetTools}><small>只选择已审核通过的素材</small><Link href="/assets" target="_blank" rel="noreferrer" title="在新标签页管理和审核素材"><Upload size={13} />上传素材</Link><button type="button" onClick={() => void refreshProjectAssets()} disabled={refreshingAssets} aria-label="刷新项目素材" title="刷新已审核素材"> <RefreshCw size={14} className={refreshingAssets ? styles.spinning : undefined} />{refreshingAssets ? "刷新中" : "刷新"}</button></div></div>{assetNotice ? <p className={styles.assetNotice} role="status">{assetNotice}</p> : null}{assets.some((asset) => asset.approval === "approved") ? <div className={styles.assetList}>{assets.filter((asset) => asset.approval === "approved").map((asset) => <label className={styles.assetOption} key={asset.id}><input type="checkbox" checked={assetIds.includes(asset.id)} onChange={(event) => setAssetIds((current) => event.target.checked ? [...new Set([...current, asset.id])] : current.filter((id) => id !== asset.id))} /><span><strong>{asset.name}</strong><small>{asset.kind === "portrait_photo" ? "照片形象 · 仅录播" : asset.kind === "portrait" ? "肖像视频" : asset.kind === "voice" ? "声音" : asset.kind}{asset.contentType ? ` · ${asset.contentType}` : ""} · {asset.rightsScope}</small></span></label>)}</div> : <p className={styles.noAssets}>暂无已审核素材；可上传并提交审核，通过后点“刷新”加入项目。</p>}{selectedPhotoPortrait && output !== "recording" ? <p className={styles.assetBoundary}>已选照片只进入录播制作素材；直播输出不会把照片当作可直播 Avatar。</p> : null}</div>
        <div className={styles.scriptHeader} id="studio-script-step" tabIndex={-1} onFocusCapture={() => setActiveStep(2)}><div><span className={styles.kicker}>SHARED SCRIPT</span><h3>同一份脚本草稿</h3></div><div className={styles.scriptTools}><label>篇幅<select aria-label="脚本篇幅" value={scriptLength} onChange={(event) => setScriptLength(event.target.value as ScriptLength)}><option value="short">简短</option><option value="standard">标准</option><option value="detailed">详细</option></select></label><label>表达<select aria-label="脚本表达方式" value={scriptStyle} onChange={(event) => setScriptStyle(event.target.value as ScriptStyle)}><option value="friendly">亲切讲解</option><option value="professional">专业说明</option><option value="faq">问题优先</option></select></label><button type="button" className={styles.textAction} onClick={() => setScript(starterScript)} disabled={!selected}><Sparkles size={15} />生成口播草稿</button></div></div>
        <textarea className={styles.script} value={currentScript} onFocusCapture={() => setActiveStep(2)} onChange={(event) => setScript(event.target.value)} maxLength={4000} aria-label="内容脚本草稿" />
        <div onFocusCapture={() => setActiveStep(2)}><ProhibitedTermHints text={currentScript} context="script" onChange={setScript} /></div>
        <label className={styles.scriptReview} onFocusCapture={() => setActiveStep(2)}><input type="checkbox" checked={scriptReviewed} disabled={!canCreate || scriptReviewBusy} onChange={(event) => void updateScriptReview(event.target.checked)} /><span><strong>{scriptReviewBusy ? "正在保存审核记录…" : "我已核对当前脚本"}</strong><small>请对照已审核的商品资料，检查价格、卖点和口播表达。确认会写入项目审计；修改脚本、切换商品或切换项目后，需要重新确认。</small></span></label>
        <p className={styles.helper}>脚本草稿由已审核商品事实整理，可直接修改；发布前仍需人工复核。素材授权与人物形象审核在素材资产中管理。</p>
      </section>

      <aside className={styles.outputPanel} id="studio-output-step" tabIndex={-1} onFocusCapture={() => setActiveStep(3)}>
        <div className={styles.sectionHead}><div><span className={styles.kicker}>OUTPUTS</span><h2>两个输出</h2></div></div>
        <div className={styles.outputChoices} role="group" aria-label="选择输出方式">
          {([ ["both", "双输出", "照片播报视频 + 直播场次"], ["recording", "录播", "照片播报视频"], ["live", "直播", "创建直播草稿场次"] ] as const).map(([value, label, detail]) => <button className={output === value ? styles.outputSelected : ""} key={value} onClick={() => setOutput(value)} type="button" aria-pressed={output === value}><span>{label}</span><small>{detail}</small></button>)}
        </div>

        <div className={styles.outputStatus} aria-label="项目输出状态">
          <span><Clapperboard size={14} />录播成片 <strong>{recordingOutputState.projectId !== projectId ? "读取中" : recordingOutputState.count || (recordingOutputState.serverCount ?? 0) ? `${recordingOutputState.count ? `本机 ${recordingOutputState.count} 版` : ""}${recordingOutputState.count && recordingOutputState.serverCount !== null ? " · " : ""}${recordingOutputState.serverCount === null ? "" : `服务端 ${recordingOutputState.serverCount} 版`}` : "尚未生成"}</strong></span>
          <span><Radio size={14} />直播场次 <strong>{activeProject?.liveRunIds.length ? `已关联 ${activeProject.liveRunIds.length} 场` : "尚未创建"}</strong></span>
        </div>
        {(output === "recording" || output === "both") ? <><div className={styles.outputRow}><span className={styles.outputIcon}><Clapperboard size={18} /></span><span><strong>照片播报视频</strong><small>静态照片 + 口播 + 字幕，可恢复预览并下载 WebM</small></span></div><PhotoRecordingComposer key={recordingComposerKey} photos={projectPhotos.map(({ id, name, checksum }) => ({ id, name, checksum }))} voiceAssets={assets.filter((asset) => asset.kind === "voice" && asset.approval === "approved" && assetIds.includes(asset.id) && asset.runtimeVoiceId && /^sha256:[a-f0-9]{64}$/i.test(asset.checksum)).map(({ id, name, runtimeVoiceId, checksum }) => ({ id, name, runtimeVoiceId: runtimeVoiceId!, checksum }))} selectedPhotoIds={assetIds} script={currentScript} projectName={projectName || selected?.product.name || "内容项目"} projectId={projectId} productVersionId={productVersionId} onEnsureProject={persistProject} onRecordingSaved={(result) => setRecordingOutputState((current) => ({ projectId, count: current.count + Number(result.localSaved), serverCount: result.serverArchived ? (current.projectId === projectId ? (current.serverCount ?? 0) + 1 : 1) : current.serverCount }))} canCreate={canCreate && scriptReviewed && !scriptReviewBusy} /><div className={styles.outputRow}><span className={styles.outputIcon}><FileText size={17} /></span><span><strong>录播制作包</strong><small>项目简报与共享脚本 Markdown</small></span><button type="button" className={styles.iconAction} aria-label="导出录播制作包" title="导出录播制作包" onClick={downloadRecordingPack}><ArrowDownToLine size={17} /></button></div></> : null}
        {(output === "live" || output === "both") ? <>
          <label className={styles.field}>直播渠道<select value={channelId} onChange={(event) => setChannelId(event.target.value)} disabled={!connectedChannels.length}>{connectedChannels.map((channel: ChannelConnection) => <option value={channel.id} key={channel.id}>{channel.name} · {channel.outputProtocol.toUpperCase()}</option>)}</select></label>
          <label className={styles.field}>计划开播时间 <span className={styles.optional}>可稍后排期</span><input type="datetime-local" value={scheduledAt} onChange={(event) => setScheduledAt(event.target.value)} /></label>
          <div className={styles.liveReadiness} aria-label="直播输出准备状态">
            <div><span className={styles.readinessLabel}>已审核脚本</span><strong className={scriptReviewed ? styles.readinessReady : styles.readinessPending}>{scriptReviewed ? "就绪" : "待审核"}</strong></div>
            <div><span className={styles.readinessLabel}>直播渠道</span><strong className={channelReady ? styles.readinessReady : styles.readinessPending}>{channelReady ? "已连接" : "待连接或选择"}</strong></div>
            <div><span className={styles.readinessLabel}>直播形象视频</span><strong className={selectedLivePortrait ? styles.readinessReady : styles.readinessPending}>{selectedLivePortrait ? "已选可用形象" : "尚未选择"}</strong></div>
            <p>运行容量：当前部署最多支持 1 路实时数字人直播；直播期间暂停离线语音预览。</p>
            {!selectedLivePortrait ? <p>{selectedPhotoPortrait ? "项目中的照片只用于照片播报录播，不能作为实时直播形象。" : "直播需要已审核、授权有效且内容核验通过的肖像视频素材。"} <Link href="/assets" target="_blank" rel="noreferrer">管理形象素材</Link></p> : null}
            {!channelReady ? <p>选择一个仍处于已连接状态的直播渠道，或前往 <Link href="/channels">渠道设置</Link> 完成连接。</p> : null}
            <small>此处可先创建直播草稿；正式开播仍以运行时与场次预检结果为准。</small>
          </div>
          <div className={styles.disclosure}><Check size={15} />创建时默认启用 AI 数字人标识</div>
        </> : null}

        {notice ? <div className={styles.success} role="status"><Check size={17} /><span>{notice}</span></div> : null}
        {error ? <div className={styles.error} role="alert"><CircleAlert size={17} /><span>{error}</span></div> : null}
        {createdRun ? <div className={styles.runLinks}><strong>已创建：{createdRun.showName}</strong><Link href={`/shows/${createdRun.id}/program`}>打开节目单 <ArrowRight size={14} /></Link><Link href={`/shows/${createdRun.id}/preflight`}>查看开播预检 <ArrowRight size={14} /></Link></div> : null}
        {activeProject?.liveRunIds.length ? <div className={styles.runLinks}><strong>该项目已关联的直播输出</strong>{activeProject.liveRunIds.map((runId) => <span key={runId}><Link href={`/shows/${runId}/program`}>节目单 {runId.slice(0, 8)} <ArrowRight size={14} /></Link><Link href={`/shows/${runId}/preflight`}>预检 <ArrowRight size={14} /></Link></span>)}</div> : null}

        <div className={styles.outputFooter}>
          <button type="button" className={styles.saveAction} onClick={saveProject} disabled={busy || !canCreate || !selected}><Save size={15} />{busy ? "保存中…" : projectId ? "保存项目更改" : "保存内容项目"}</button>
          {output !== "live" ? <button type="button" className={styles.primaryAction} onClick={downloadRecordingPack} disabled={busy || !selected}><ArrowDownToLine size={16} />导出录播制作包</button> : null}
          {output !== "recording" ? <button type="submit" className={styles.primaryAction} disabled={busy || scriptReviewBusy || !canCreateLive || !selected}>{busy ? "正在处理…" : canResumePending ? "继续完成直播输出" : "创建直播草稿场次"}<ArrowRight size={16} /></button> : null}
          {!canCreate && output !== "recording" ? <p className={styles.helper}>当前账号只有查看权限。</p> : null}
          {!scriptReviewed ? <p className={styles.helper}>完成当前脚本审核后，才能生成录播视频或直播草稿输出。</p> : null}
          {!connectedChannels.length && output !== "recording" ? <p className={styles.helper}>还没有已连接渠道，请先到 <Link href="/channels">渠道设置</Link> 完成配置。</p> : null}
        </div>
      </aside>
    </form>
    <footer className={styles.limitNote}><Radio size={16} /><span><strong>生成边界</strong>照片播报视频在浏览器本地生成，并可登记为项目服务端版本；演示模式仍只保存本机副本。服务端跨设备播放下载、动态口型 Avatar 和 4090 实机验收尚未完成。直播场次不会自动开播，仍须经过脚本审核和预检。</span></footer>
  </main>;
}

function toLocalDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

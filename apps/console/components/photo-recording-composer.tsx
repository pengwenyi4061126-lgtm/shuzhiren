"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AudioLines, CircleAlert, CloudUpload, Download, Mic, Square } from "lucide-react";
import type { CreationProject } from "@/lib/creation-projects";
import { clientFetch } from "@/lib/client-request";
import { listProjectRecordings, saveProjectRecording, updateProjectRecordingArchive, type ProjectRecordingOutput } from "@/lib/project-recording-vault";
import { getPhotoSource } from "@/lib/photo-source-vault";
import { splitNarrationScript } from "@/lib/shared/content-script.mjs";
import styles from "./photo-recording-composer.module.css";

type PhotoAsset = { id: string; name: string; checksum: string };
type VoiceAsset = { id: string; name: string; runtimeVoiceId: string; checksum: string };
type ServerRecording = { id: string; fileName: string; bytes: number; createdAt: string };

export function PhotoRecordingComposer({ photos, voiceAssets, selectedPhotoIds, script, projectName, projectId, productVersionId, onEnsureProject, onRecordingSaved, canCreate }: { photos: PhotoAsset[]; voiceAssets: VoiceAsset[]; selectedPhotoIds: string[]; script: string; projectName: string; projectId: string; productVersionId: string; onEnsureProject: () => Promise<CreationProject>; onRecordingSaved: (result: { localSaved: boolean; serverArchived: boolean }) => void; canCreate: boolean }) {
  const preferred = photos.find((photo) => selectedPhotoIds.includes(photo.id)) ?? photos[0];
  const [photoId, setPhotoId] = useState(preferred?.id ?? "");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [photoSourceStatus, setPhotoSourceStatus] = useState(preferred ? "正在查找此设备上的照片副本…" : "请先选择一张项目照片。");
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [recordedAudio, setRecordedAudio] = useState<Blob | null>(null);
  const [generatedAudio, setGeneratedAudio] = useState<{ blob: Blob; script: string; voiceAssetId: string } | null>(null);
  const [voiceAssetId, setVoiceAssetId] = useState(voiceAssets[0]?.id ?? "");
  const [recording, setRecording] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [archiveNotice, setArchiveNotice] = useState("");
  const [videoBlob, setVideoBlob] = useState<Blob | null>(null);
  const [videoProjectId, setVideoProjectId] = useState(projectId);
  const [videoSnapshot, setVideoSnapshot] = useState<{ script: string; photoAssetId: string; projectName: string; productVersionId?: string; voiceAssetId: string | null } | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [audioUrl, setAudioUrl] = useState("");
  const [videoUrl, setVideoUrl] = useState("");
  const [savedOutputs, setSavedOutputs] = useState<ProjectRecordingOutput[]>([]);
  const [serverOutputs, setServerOutputs] = useState<ServerRecording[]>([]);
  const [selectedOutputId, setSelectedOutputId] = useState("");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const microphoneRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const audioUrlRef = useRef("");
  const videoUrlRef = useRef("");
  const activePhotoId = photos.some((item) => item.id === photoId) ? photoId : (preferred?.id ?? "");
  const photo = photos.find((item) => item.id === activePhotoId);
  const selectedVoice = voiceAssets.find((item) => item.id === voiceAssetId) ?? voiceAssets[0];
  const generatedAudioMatches = Boolean(generatedAudio && generatedAudio.script === script && generatedAudio.voiceAssetId === selectedVoice?.id);
  const audioBlob = recordedAudio ?? audioFile ?? (generatedAudioMatches ? generatedAudio?.blob ?? null : null);
  const savedOutput = savedOutputs.find((output) => output.id === selectedOutputId) ?? savedOutputs[0] ?? null;
  const selectedSavedOutput = Boolean(savedOutput && savedOutput.projectId === projectId && savedOutput.blob === videoBlob);
  const previewDiffersFromProject = Boolean(videoSnapshot && (videoSnapshot.script !== script || videoSnapshot.photoAssetId !== activePhotoId || videoSnapshot.projectName !== projectName || videoSnapshot.productVersionId !== productVersionId || (videoSnapshot.voiceAssetId !== null && videoSnapshot.voiceAssetId !== selectedVoice?.id)));

  useEffect(() => () => {
    microphoneRef.current?.getTracks().forEach((track) => track.stop());
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current);
  }, []);

  useEffect(() => {
    let active = true;
    if (!projectId) return () => { active = false; };
    listProjectRecordings(projectId).then((outputs) => {
      if (!active) return;
      setSavedOutputs(outputs);
      const output = outputs[0];
      setSelectedOutputId(output?.id ?? "");
      if (!output) return;
      setVideoBlob(output.blob); setVideoProjectId(projectId); setVideoSnapshot({ script: output.scriptSnapshot, photoAssetId: output.photoAssetId, projectName: output.projectName, productVersionId: output.productVersionId, voiceAssetId: output.voiceAssetId ?? null }); setVideoPreview(output.blob); setReviewed(false);
    }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : "读取本机项目输出失败。");
    });
    return () => { active = false; };
  }, [projectId]);

  useEffect(() => {
    let active = true;
    clientFetch(`/api/v1/studio/projects/${encodeURIComponent(projectId)}/recordings`)
      .then((response) => response.json())
      .then((result: { data?: ServerRecording[] }) => { if (active && Array.isArray(result.data)) setServerOutputs(result.data); })
      .catch(() => { if (active) setServerOutputs([]); });
    return () => { active = false; };
  }, [projectId]);

  useEffect(() => {
    let active = true;
    if (!activePhotoId) return () => { active = false; };
    getPhotoSource(activePhotoId).then((file) => {
      if (!active) return;
      setImageFile(file);
      setPhotoSourceStatus(file ? `已自动载入本机副本：${file.name}` : "此设备没有本机副本；请重新选择与已批准素材完全相同的照片。");
    }).catch(() => {
      if (active) setPhotoSourceStatus("本机照片读取失败；请重新选择与已批准素材完全相同的照片。");
    });
    return () => { active = false; };
  }, [activePhotoId]);

  function setAudioPreview(blob: Blob | null) {
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    audioUrlRef.current = blob ? URL.createObjectURL(blob) : ""; setAudioUrl(audioUrlRef.current);
  }

  function setVideoPreview(blob: Blob | null) {
    if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current);
    videoUrlRef.current = blob ? URL.createObjectURL(blob) : ""; setVideoUrl(videoUrlRef.current);
  }

  async function startMicrophone() {
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const type = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "";
      const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      microphoneRef.current = stream; chunksRef.current = []; recorderRef.current = recorder;
      recorder.ondataavailable = (event) => { if (event.data.size) chunksRef.current.push(event.data); };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        setRecordedAudio(blob); setAudioPreview(blob);
        setAudioFile(null); setGeneratedAudio(null); setVideoBlob(null); setReviewed(false); setRecording(false);
        stream.getTracks().forEach((track) => track.stop()); microphoneRef.current = null; recorderRef.current = null;
      };
      recorder.start(250); setRecordedAudio(null); setAudioFile(null); setGeneratedAudio(null); setAudioPreview(null); setVideoBlob(null); setVideoPreview(null); setReviewed(false); setRecording(true);
    } catch (cause) { setError(cause instanceof Error ? `无法开始录音：${cause.message}` : "无法开始录音，请检查麦克风权限"); }
  }

  async function generateSpeechPreview() {
    if (!selectedVoice || !canCreate || !script.trim() || script.length > 12000) return;
    setWorking(true); setError(""); setArchiveNotice("");
    try {
      const project = await onEnsureProject();
      const response = await clientFetch(`/api/v1/studio/projects/${encodeURIComponent(project.id)}/speech-preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ voiceAssetId: selectedVoice.id })
      });
      if (!response.ok) {
        const result = await response.json().catch(() => null) as { error?: string } | null;
        const reason = result?.error;
        throw new Error(reason === "runtime_gateway_demo_mode"
          ? "语音合成运行时尚未连接；可先录制本人声音或上传配音。"
          : reason === "offline_speech_preview_busy"
            ? "直播运行期间暂不生成录播配音，请结束直播后重试。"
            : reason === "creation_project_script_not_reviewed"
              ? "请先完成当前脚本审核，再生成配音。"
              : reason === "approved_runtime_voice_required" || reason === "voice_asset_not_attached"
                ? "请为项目选择一条有效的已批准声线。"
                : "语音生成失败，请检查运行时配置和项目审核状态。");
      }
      const blob = await response.blob();
      if (blob.size < 44 || blob.size > 4_400_000 || blob.type !== "audio/wav") throw new Error("语音服务返回了无效或超长音频。");
      setGeneratedAudio({ blob, script, voiceAssetId: selectedVoice.id });
      setRecordedAudio(null); setAudioFile(null); setAudioPreview(blob); setVideoBlob(null); setVideoPreview(null); setReviewed(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "语音生成失败，请重试。"); }
    finally { setWorking(false); }
  }

  async function renderVideo() {
    setError(""); setVideoBlob(null); setVideoPreview(null); setReviewed(false);
    setVideoProjectId(projectId);
    if (!photo || !imageFile || !audioBlob) { setError("请选择项目中的已批准照片，并录制或选择口播音频。"); return; }
    if (!script.trim()) { setError("请先补齐项目脚本。"); return; }
    if (!/^image\/(jpeg|png)$/.test(imageFile.type) || imageFile.size > 25 * 1024 * 1024) { setError("照片需为 JPEG 或 PNG，且不超过 25 MB。"); return; }
    if (audioBlob.size > 100 * 1024 * 1024) { setError("口播音频不能超过 100 MB。"); return; }
    setWorking(true);
    try {
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await imageFile.arrayBuffer()));
      const checksum = `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
      const demo = photo.checksum.startsWith("demo-");
      if (!demo && checksum !== photo.checksum.toLowerCase()) throw new Error("照片文件与已批准素材校验和不一致。");
      if (!demo && !/^sha256:[a-f0-9]{64}$/.test(photo.checksum)) throw new Error("照片素材缺少有效 SHA-256，不能用于成片。");
      const result = await renderPhotoNarration(imageFile, audioBlob, script, projectName);
      if (result.size < 1024) throw new Error("生成的视频文件为空，请检查音频后重试。");
      setVideoBlob(result); setVideoSnapshot({ script, photoAssetId: photo.id, projectName, productVersionId, voiceAssetId: generatedAudioMatches ? selectedVoice?.id ?? null : null }); setVideoPreview(result);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "视频生成失败，请重试。"); }
    finally { setWorking(false); }
  }

  async function downloadVideo() {
    if (!videoBlob || !reviewed || (!selectedSavedOutput && (!canCreate || previewDiffersFromProject))) return;
    setWorking(true); setError("");
    let fileName = `${safeName(projectName || "内容项目")}-照片播报.webm`;
    try {
      if (savedOutput?.id && savedOutput.blob === videoBlob && savedOutput.projectId === projectId) {
        fileName = savedOutput.fileName;
      } else {
        const project = await onEnsureProject();
        fileName = `${safeName(project.name)}-照片播报-r${savedOutputs.length + 1}.webm`;
        if (!videoSnapshot || videoSnapshot.productVersionId !== project.productVersionId || videoSnapshot.script !== project.script || !project.scriptReview || project.scriptReview.productVersionId !== project.productVersionId) throw new Error("项目商品资料或脚本审核已变化，请重新预览并审核后再保存成片。");
        const archiveStatus = await archiveProjectRecording(project, videoBlob, {
          projectRevision: project.revision,
          productVersionId: project.productVersionId,
          scriptSnapshot: videoSnapshot.script,
          photoAssetId: videoSnapshot.photoAssetId,
          ...(videoSnapshot.voiceAssetId ? { voiceAssetId: videoSnapshot.voiceAssetId } : {}),
          fileName
        });
        fileName = `${safeName(project.name)}-照片播报-r${savedOutputs.length + 1}.webm`;
        const output = await saveProjectRecording({ projectId: project.id, projectName: project.name, projectRevision: project.revision, productVersionId: project.productVersionId, scriptSnapshot: videoSnapshot.script, photoAssetId: videoSnapshot.photoAssetId, ...(videoSnapshot.voiceAssetId && generatedAudio ? { voiceAssetId: generatedAudio.voiceAssetId, voiceAssetName: selectedVoice?.name } : {}), fileName, createdAt: new Date().toISOString(), size: videoBlob.size, contentType: videoBlob.type || "video/webm", blob: videoBlob, serverArchive: archiveStatus });
        setSavedOutputs((current) => [output, ...current]);
        setSelectedOutputId(output.id);
        setVideoProjectId(project.id);
        onRecordingSaved({ localSaved: true, serverArchived: archiveStatus.status === "archived" });
        if (archiveStatus.status === "archived") { refreshServerRecordings(); setArchiveNotice("已保存到本机项目空间并完成服务端归档。"); }
        else setError(`本机项目版本已保存并可下载；${archiveStatus.message ?? "服务端归档待重试"}`);
      }
    } catch (cause) {
      setError(cause instanceof Error ? `本机项目保存失败，仍将下载成片：${cause.message}` : "本机项目保存失败，仍将下载成片。");
    } finally {
      const url = URL.createObjectURL(videoBlob); const link = document.createElement("a");
      link.href = url; link.download = fileName; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setWorking(false);
    }
  }

  async function retryArchive(output: ProjectRecordingOutput) {
    if (working) return;
    setWorking(true); setError(""); setArchiveNotice("");
    try {
      const project = await onEnsureProject();
      if (!output.productVersionId || output.productVersionId !== project.productVersionId || output.scriptSnapshot !== project.script || !project.scriptReview || project.scriptReview.productVersionId !== project.productVersionId) {
        throw new Error("当前商品版本或脚本审核已变化；请按当前内容重新审核并生成成片。");
      }
      const result = await archiveProjectRecording(project, output.blob, {
        projectRevision: project.revision,
        productVersionId: project.productVersionId,
        scriptSnapshot: output.scriptSnapshot,
        photoAssetId: output.photoAssetId,
        ...(output.voiceAssetId ? { voiceAssetId: output.voiceAssetId } : {}),
        fileName: output.fileName
      });
      const updated = await updateProjectRecordingArchive(project.id, output.id, result);
      setSavedOutputs((current) => current.map((item) => item.id === updated.id ? updated : item));
      if (result.status === "archived") {
        refreshServerRecordings();
        onRecordingSaved({ localSaved: false, serverArchived: true });
        setArchiveNotice("服务端归档完成。");
      } else {
        setError(result.message ?? "服务端归档仍未完成。");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "服务端归档重试失败。");
    } finally {
      setWorking(false);
    }
  }

  function refreshServerRecordings() {
    void clientFetch(`/api/v1/studio/projects/${encodeURIComponent(projectId)}/recordings`)
      .then((response) => response.json())
      .then((result: { data?: ServerRecording[] }) => { if (Array.isArray(result.data)) setServerOutputs(result.data); })
      .catch(() => setError("服务端成片列表暂时无法刷新。"));
  }

  async function downloadServerRecording(recording: ServerRecording) {
    setWorking(true); setError("");
    try {
      const response = await clientFetch(`/api/v1/studio/projects/${encodeURIComponent(projectId)}/recordings/${encodeURIComponent(recording.id)}/download-grant`, { method: "POST" });
      const result = await response.json().catch(() => null) as { data?: { downloadUrl: string }; error?: string } | null;
      if (!response.ok || !result?.data?.downloadUrl) throw new Error(result?.error ?? "获取成片下载授权失败。");
      const link = document.createElement("a");
      link.href = result.data.downloadUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.click();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "服务端成片下载失败。");
    } finally {
      setWorking(false);
    }
  }

  return <section className={styles.composer} aria-labelledby="photo-recording-title">
    <div className={styles.heading}><div><span>PHOTO NARRATION</span><h3 id="photo-recording-title">照片播报视频</h3></div><small>720 × 1280 · WebM</small></div>
    {!photos.length ? <div className={styles.empty}>先把一张已批准照片加入当前项目。<Link href="/assets">打开素材资产</Link></div> : <div className={styles.fields}>
      <label>项目照片<select value={activePhotoId} onChange={(event) => { setPhotoId(event.target.value); setImageFile(null); setPhotoSourceStatus("正在查找此设备上的照片副本…"); setVideoBlob(null); setVideoPreview(null); setReviewed(false); }}>{photos.map((item) => <option key={item.id} value={item.id}>{item.name}{selectedPhotoIds.includes(item.id) ? " · 项目已选" : ""}</option>)}</select></label>
      <label>照片原文件（可自动使用本机副本）<input type="file" accept="image/jpeg,image/png" onChange={(event) => { const file = event.target.files?.[0] ?? null; setImageFile(file); setPhotoSourceStatus(file ? `已选择：${file.name}` : "未选择本机文件。"); setVideoBlob(null); setVideoPreview(null); setReviewed(false); }} /></label>
      <p className={styles.hint} role="status">{photoSourceStatus}</p>
      <div className={styles.recordingActions}><label>口播音频<input type="file" accept="audio/*" onChange={(event) => { const file = event.target.files?.[0] ?? null; setAudioFile(file); setAudioPreview(file); setRecordedAudio(null); setGeneratedAudio(null); setVideoBlob(null); setVideoPreview(null); setReviewed(false); }} /></label>
        {recording ? <button type="button" onClick={() => recorderRef.current?.stop()} className={styles.stop}><Square size={14} />结束录音</button> : <button type="button" onClick={startMicrophone} disabled={!canCreate || working} className={styles.mic}><Mic size={14} />录制口播</button>}</div>
      {voiceAssets.length ? <div className={styles.voicePreview}><label>审核通过的配音声线<select aria-label="选择配音声线" value={selectedVoice?.id ?? ""} onChange={(event) => { setVoiceAssetId(event.target.value); setVideoBlob(null); setVideoPreview(null); setReviewed(false); }}><option value="" disabled>选择项目声线</option>{voiceAssets.map((voice) => <option value={voice.id} key={voice.id}>{voice.name}</option>)}</select></label><button type="button" onClick={generateSpeechPreview} disabled={!canCreate || !selectedVoice || !script.trim() || working}><AudioLines size={14} />{working ? "正在生成配音…" : generatedAudioMatches ? "重新生成配音" : "用审核声线生成配音"}</button></div> : <p className={styles.hint}>要使用审核声线生成配音，请在项目素材中选择已批准的声音。</p>}
      {generatedAudio && !generatedAudioMatches && !audioFile && !recordedAudio ? <p className={styles.demo}>脚本或声线已变化，请重新生成配音后再制作视频。</p> : null}
      {audioBlob ? <audio className={styles.audio} controls src={audioUrl} /> : <p className={styles.hint}>也可上传音频，或照着共享脚本录制本人声音。</p>}
      {photo?.checksum.startsWith("demo-") ? <p className={styles.demo}>演示素材只用于本地试做，不代表正式授权核验。</p> : <p className={styles.hint}>正式照片会比对已批准素材 SHA-256；不匹配时不会生成视频。</p>}
      <button type="button" onClick={renderVideo} disabled={!canCreate || working || recording || !imageFile || !audioBlob} className={styles.render}>{working ? "正在生成本地预览…" : "生成并预览视频"}</button>
    </div>}
    {error ? <div className={styles.error} role="alert"><CircleAlert size={15} />{error}</div> : null}{archiveNotice ? <p className={styles.archiveNotice} role="status">{archiveNotice}</p> : null}
    {serverOutputs.length ? <div className={styles.serverArchive}><strong>项目服务端成片</strong>{serverOutputs.map((recording) => <div key={recording.id}><span>{recording.fileName}<small>{(recording.bytes / (1024 * 1024)).toFixed(1)} MB · {new Date(recording.createdAt).toLocaleString()}</small></span><button type="button" className={styles.serverDownload} disabled={working} title="下载服务端归档成片" aria-label={`下载 ${recording.fileName}`} onClick={() => void downloadServerRecording(recording)}><Download size={15} /></button></div>)}</div> : null}
    {videoUrl && videoProjectId === projectId ? <div className={styles.review}>{savedOutputs.length > 1 ? <label className={styles.versionPicker}>项目成片版本<select value={savedOutput?.id ?? ""} onChange={(event) => { const output = savedOutputs.find((item) => item.id === event.target.value); if (!output) return; setSelectedOutputId(output.id); setVideoBlob(output.blob); setVideoProjectId(projectId); setVideoSnapshot({ script: output.scriptSnapshot, photoAssetId: output.photoAssetId, projectName: output.projectName, productVersionId: output.productVersionId, voiceAssetId: output.voiceAssetId ?? null }); setVideoPreview(output.blob); setReviewed(false); }} aria-label="选择项目成片版本">{savedOutputs.map((output, index) => <option key={output.id} value={output.id}>第 {savedOutputs.length - index} 版 · {new Date(output.createdAt).toLocaleString()}</option>)}</select></label> : null}<video className={styles.video} controls playsInline src={videoUrl} /><label><input type="checkbox" checked={reviewed} onChange={(event) => setReviewed(event.target.checked)} />我已检查画面、字幕和口播音频</label><button type="button" disabled={!reviewed || (!selectedSavedOutput && (!canCreate || previewDiffersFromProject)) || working} onClick={downloadVideo} className={styles.download}><Download size={15} />{working ? "正在保存…" : selectedSavedOutput ? "下载已保存版本" : `保存为第 ${savedOutputs.length + 1} 版并下载`}</button>{savedOutput?.projectId === projectId ? <><p className={styles.hint}>项目成片第 {savedOutputs.findIndex((output) => output.id === savedOutput.id) >= 0 ? savedOutputs.length - savedOutputs.findIndex((output) => output.id === savedOutput.id) : 1} 版 · {(savedOutput.size / (1024 * 1024)).toFixed(1)} MB · {new Date(savedOutput.createdAt).toLocaleString()}{savedOutput.voiceAssetName ? ` · 配音 ${savedOutput.voiceAssetName}` : ""}</p><p className={styles.archiveState}>{savedOutput.serverArchive?.status === "archived" ? "服务端已归档" : savedOutput.serverArchive?.status === "failed" ? `服务端归档待重试：${savedOutput.serverArchive.message ?? "暂时失败"}` : savedOutput.serverArchive?.status === "local-only" ? `仅本机保存：${savedOutput.serverArchive.message ?? "演示模式"}` : "本机项目版本"}</p>{savedOutput.serverArchive?.status === "failed" ? <button type="button" className={styles.retry} title="重试服务端归档" aria-label="重试服务端归档" disabled={working} onClick={() => void retryArchive(savedOutput)}><CloudUpload size={15} />重试归档</button> : null}</> : null}{previewDiffersFromProject && !selectedSavedOutput ? <p className={styles.demo}>当前项目脚本、商品版本、照片、标题或配音声线已变化；此预览不能保存为当前成片，请重新预览并完成脚本审核。</p> : !canCreate && !selectedSavedOutput ? <p className={styles.demo}>当前项目的脚本审核已失效；重新审核后才能保存新成片。</p> : null}</div> : null}
    <p className={styles.note}>输出为静态照片配口播字幕，不是动态口型 Avatar。项目服务端归档列表可从其他设备下载；本机副本用于离线预览。</p>
  </section>;
}

async function archiveProjectRecording(project: CreationProject, blob: Blob, metadata: { projectRevision: number; productVersionId: string; scriptSnapshot: string; photoAssetId: string; voiceAssetId?: string; fileName: string }): Promise<NonNullable<ProjectRecordingOutput["serverArchive"]>> {
  try {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
    const checksum = `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    let binary = "";
    for (const byte of digest) binary += String.fromCharCode(byte);
    const grantResponse = await clientFetch("/api/v1/media-uploads/grant", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "product_clip", checksum, checksumBase64: btoa(binary), contentType: "video/webm", bytes: blob.size })
    });
    const grantResult = await grantResponse.json().catch(() => null) as { data?: { objectKey: string; uploadUrl?: string; headers?: Record<string, string>; demoMode: boolean }; error?: string } | null;
    if (!grantResponse.ok || !grantResult?.data) throw new Error(grantResult?.error ?? "获取录播上传授权失败");
    if (grantResult.data.demoMode) return { status: "local-only", message: "演示模式未上传文件字节" };
    if (!grantResult.data.uploadUrl || !grantResult.data.headers) throw new Error("录播上传授权缺少直传参数");
    const upload = await fetch(grantResult.data.uploadUrl, { method: "PUT", headers: grantResult.data.headers, body: blob });
    if (!upload.ok) throw new Error("WebM 直传对象存储失败");
    const response = await clientFetch(`/api/v1/studio/projects/${encodeURIComponent(project.id)}/recordings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...metadata, objectKey: grantResult.data.objectKey, checksum, bytes: blob.size })
    });
    const result = await response.json().catch(() => null) as { data?: { id?: string }; error?: string } | null;
    if (!response.ok) throw new Error(result?.error ?? "录播服务端校验登记失败");
    if (!result?.data?.id) throw new Error("录播服务端未返回归档编号");
    return { status: "archived", recordingId: result.data.id };
  } catch (cause) {
    return { status: "failed", message: cause instanceof Error ? cause.message : "服务端录播归档失败" };
  }
}

async function renderPhotoNarration(imageFile: File, audioBlob: Blob, script: string, title: string) {
  if (typeof MediaRecorder === "undefined" || !HTMLCanvasElement.prototype.captureStream) throw new Error("请使用最新版桌面 Chrome 或 Edge 生成视频。");
  const mimeType = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find((type) => MediaRecorder.isTypeSupported(type));
  if (!mimeType) throw new Error("此浏览器没有可用的 WebM 编码器。");
  const imageUrl = URL.createObjectURL(imageFile); const image = new Image();
  try { image.src = imageUrl; await image.decode(); } catch { URL.revokeObjectURL(imageUrl); throw new Error("照片读取失败，请换一张 JPEG 或 PNG。"); }
  URL.revokeObjectURL(imageUrl);
  const canvas = document.createElement("canvas"); canvas.width = 720; canvas.height = 1280;
  const context = canvas.getContext("2d"); if (!context) throw new Error("无法初始化视频画布。");
  const canvasStream = canvas.captureStream(30); const audioContext = new AudioContext();
  const audioUrl = URL.createObjectURL(audioBlob); const audio = new Audio(audioUrl); audio.preload = "auto";
  let recorder: MediaRecorder | null = null;
  try {
    await new Promise<void>((resolve, reject) => { audio.onloadedmetadata = () => resolve(); audio.onerror = () => reject(new Error("口播音频读取失败，请更换文件。")); audio.load(); });
    if (!Number.isFinite(audio.duration) || audio.duration < 1 || audio.duration > 300) throw new Error("口播音频时长需在 1 秒到 5 分钟之间。");
    const destination = audioContext.createMediaStreamDestination();
    audioContext.createMediaElementSource(audio).connect(destination);
    const stream = new MediaStream([...canvasStream.getVideoTracks(), ...destination.stream.getAudioTracks()]);
    recorder = new MediaRecorder(stream, { mimeType }); const chunks: BlobPart[] = [];
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    const finished = new Promise<Blob>((resolve, reject) => {
      recorder!.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
      recorder!.onerror = () => reject(new Error("浏览器编码失败，请缩短音频后重试。"));
      audio.onended = () => { if (recorder?.state === "recording") recorder.stop(); };
    });
    const captions = splitNarrationScript(script, 42); const startedAt = performance.now();
    const draw = (now: number) => {
      const elapsed = Math.min((now - startedAt) / 1000, audio.duration);
      drawPhotoFrame(context, image, title, captions, elapsed, audio.duration);
      if (elapsed < audio.duration && recorder?.state === "recording") requestAnimationFrame(draw);
    };
    draw(startedAt); recorder.start(250); await audioContext.resume(); await audio.play();
    return await finished;
  } finally {
    if (recorder?.state === "recording") recorder.stop();
    canvasStream.getTracks().forEach((track) => track.stop()); audio.pause(); URL.revokeObjectURL(audioUrl);
    await audioContext.close().catch(() => undefined);
  }
}

function drawPhotoFrame(context: CanvasRenderingContext2D, image: HTMLImageElement, title: string, captions: string[], elapsed: number, duration: number) {
  const canvas = context.canvas; const scale = Math.max(canvas.width / image.width, canvas.height / image.height);
  const width = image.width * scale; const height = image.height * scale;
  context.fillStyle = "#15211e"; context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
  context.fillStyle = "rgba(11, 22, 19, .66)"; context.fillRect(0, 0, canvas.width, 154);
  context.fillStyle = "#ffffff"; context.textAlign = "left"; context.font = "700 22px system-ui, sans-serif"; context.fillText("AI 辅助内容", 44, 54);
  context.font = "600 28px system-ui, sans-serif"; context.fillText(fitCanvasText(context, title || "内容项目", 620), 44, 108);
  const length = captions.reduce((sum, caption) => sum + caption.length, 0);
  let cursor = Math.min(length - 1, Math.floor(elapsed / duration * length)); let caption = captions[0] ?? "";
  for (const value of captions) { if (cursor < value.length) { caption = value; break; } cursor -= value.length; }
  context.fillStyle = "rgba(10, 18, 16, .84)"; context.fillRect(28, 865, 664, 300);
  context.fillStyle = "#ffffff"; context.textAlign = "center"; context.font = "600 34px system-ui, sans-serif";
  wrapCanvasText(context, caption, 600).slice(0, 4).forEach((line, index) => context.fillText(line, 360, 955 + index * 48));
  context.fillStyle = "rgba(255, 255, 255, .3)"; context.fillRect(48, 1110, 624, 5);
  context.fillStyle = "#52d2a9"; context.fillRect(48, 1110, 624 * Math.min(1, elapsed / duration), 5);
}

function wrapCanvasText(context: CanvasRenderingContext2D, text: string, maxWidth: number) {
  const lines: string[] = []; let line = "";
  for (const character of text) { if (line && context.measureText(line + character).width > maxWidth) { lines.push(line); line = character; } else line += character; }
  if (line) lines.push(line); return lines;
}

function fitCanvasText(context: CanvasRenderingContext2D, text: string, maxWidth: number) {
  let value = text; while (value && context.measureText(value).width > maxWidth) value = `${value.slice(0, -1)}…`; return value;
}

function safeName(value: string) { return value.replace(/[\/:*?"<>|]/g, "-").slice(0, 80); }

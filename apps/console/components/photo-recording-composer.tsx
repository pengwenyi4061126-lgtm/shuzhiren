"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { CircleAlert, Download, Mic, Square } from "lucide-react";
import type { CreationProject } from "@/lib/creation-projects";
import { listProjectRecordings, saveProjectRecording, type ProjectRecordingOutput } from "@/lib/project-recording-vault";
import { getPhotoSource } from "@/lib/photo-source-vault";
import { splitNarrationScript } from "@/lib/shared/content-script.mjs";
import styles from "./photo-recording-composer.module.css";

type PhotoAsset = { id: string; name: string; checksum: string };

export function PhotoRecordingComposer({ photos, selectedPhotoIds, script, projectName, projectId, onEnsureProject, canCreate }: { photos: PhotoAsset[]; selectedPhotoIds: string[]; script: string; projectName: string; projectId: string; onEnsureProject: () => Promise<CreationProject>; canCreate: boolean }) {
  const preferred = photos.find((photo) => selectedPhotoIds.includes(photo.id)) ?? photos[0];
  const [photoId, setPhotoId] = useState(preferred?.id ?? "");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [photoSourceStatus, setPhotoSourceStatus] = useState(preferred ? "正在查找此设备上的照片副本…" : "请先选择一张项目照片。");
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [recordedAudio, setRecordedAudio] = useState<Blob | null>(null);
  const [recording, setRecording] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [videoBlob, setVideoBlob] = useState<Blob | null>(null);
  const [videoProjectId, setVideoProjectId] = useState(projectId);
  const [videoSnapshot, setVideoSnapshot] = useState<{ script: string; photoAssetId: string; projectName: string } | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [audioUrl, setAudioUrl] = useState("");
  const [videoUrl, setVideoUrl] = useState("");
  const [savedOutputs, setSavedOutputs] = useState<ProjectRecordingOutput[]>([]);
  const [selectedOutputId, setSelectedOutputId] = useState("");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const microphoneRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const audioUrlRef = useRef("");
  const videoUrlRef = useRef("");
  const photo = photos.find((item) => item.id === photoId);
  const audioBlob = recordedAudio ?? audioFile;
  const savedOutput = savedOutputs.find((output) => output.id === selectedOutputId) ?? savedOutputs[0] ?? null;
  const previewDiffersFromProject = Boolean(videoSnapshot && (videoSnapshot.script !== script || videoSnapshot.photoAssetId !== photoId || videoSnapshot.projectName !== projectName));

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
      setVideoBlob(output.blob); setVideoProjectId(projectId); setVideoSnapshot({ script: output.scriptSnapshot, photoAssetId: output.photoAssetId, projectName: output.projectName }); setVideoPreview(output.blob); setReviewed(false);
    }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : "读取本机项目输出失败。");
    });
    return () => { active = false; };
  }, [projectId]);

  useEffect(() => {
    let active = true;
    if (!photoId) return () => { active = false; };
    getPhotoSource(photoId).then((file) => {
      if (!active) return;
      setImageFile(file);
      setPhotoSourceStatus(file ? `已自动载入本机副本：${file.name}` : "此设备没有本机副本；请重新选择与已批准素材完全相同的照片。");
    }).catch(() => {
      if (active) setPhotoSourceStatus("本机照片读取失败；请重新选择与已批准素材完全相同的照片。");
    });
    return () => { active = false; };
  }, [photoId]);

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
        setAudioFile(null); setVideoBlob(null); setReviewed(false); setRecording(false);
        stream.getTracks().forEach((track) => track.stop()); microphoneRef.current = null; recorderRef.current = null;
      };
      recorder.start(250); setRecordedAudio(null); setAudioFile(null); setAudioPreview(null); setVideoBlob(null); setVideoPreview(null); setReviewed(false); setRecording(true);
    } catch (cause) { setError(cause instanceof Error ? `无法开始录音：${cause.message}` : "无法开始录音，请检查麦克风权限"); }
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
      setVideoBlob(result); setVideoSnapshot({ script, photoAssetId: photo.id, projectName }); setVideoPreview(result);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "视频生成失败，请重试。"); }
    finally { setWorking(false); }
  }

  async function downloadVideo() {
    if (!videoBlob || !reviewed) return;
    setWorking(true); setError("");
    let fileName = `${safeName(projectName || "内容项目")}-照片播报.webm`;
    try {
      if (savedOutput?.id && savedOutput.blob === videoBlob && savedOutput.projectId === projectId) {
        fileName = savedOutput.fileName;
      } else {
        const project = await onEnsureProject();
        fileName = `${safeName(project.name)}-照片播报-r${savedOutputs.length + 1}.webm`;
        const output = await saveProjectRecording({ projectId: project.id, projectName: project.name, projectRevision: project.revision, scriptSnapshot: videoSnapshot?.script ?? script, photoAssetId: videoSnapshot?.photoAssetId ?? photoId, fileName, createdAt: new Date().toISOString(), size: videoBlob.size, contentType: videoBlob.type || "video/webm", blob: videoBlob });
        setSavedOutputs((current) => [output, ...current]);
        setSelectedOutputId(output.id);
        setVideoProjectId(project.id);
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

  return <section className={styles.composer} aria-labelledby="photo-recording-title">
    <div className={styles.heading}><div><span>PHOTO NARRATION</span><h3 id="photo-recording-title">照片播报视频</h3></div><small>720 × 1280 · WebM</small></div>
    {!photos.length ? <div className={styles.empty}>先把一张已批准照片加入当前项目。<Link href="/assets">打开素材资产</Link></div> : <div className={styles.fields}>
      <label>项目照片<select value={photoId} onChange={(event) => { setPhotoId(event.target.value); setImageFile(null); setPhotoSourceStatus("正在查找此设备上的照片副本…"); setVideoBlob(null); setVideoPreview(null); setReviewed(false); }}>{photos.map((item) => <option key={item.id} value={item.id}>{item.name}{selectedPhotoIds.includes(item.id) ? " · 项目已选" : ""}</option>)}</select></label>
      <label>照片原文件（可自动使用本机副本）<input type="file" accept="image/jpeg,image/png" onChange={(event) => { const file = event.target.files?.[0] ?? null; setImageFile(file); setPhotoSourceStatus(file ? `已选择：${file.name}` : "未选择本机文件。"); setVideoBlob(null); setVideoPreview(null); setReviewed(false); }} /></label>
      <p className={styles.hint} role="status">{photoSourceStatus}</p>
      <div className={styles.recordingActions}><label>口播音频<input type="file" accept="audio/*" onChange={(event) => { const file = event.target.files?.[0] ?? null; setAudioFile(file); setAudioPreview(file); setRecordedAudio(null); setVideoBlob(null); setVideoPreview(null); setReviewed(false); }} /></label>
        {recording ? <button type="button" onClick={() => recorderRef.current?.stop()} className={styles.stop}><Square size={14} />结束录音</button> : <button type="button" onClick={startMicrophone} disabled={!canCreate || working} className={styles.mic}><Mic size={14} />录制口播</button>}</div>
      {audioBlob ? <audio className={styles.audio} controls src={audioUrl} /> : <p className={styles.hint}>可上传配音文件，或照着共享脚本录制本人声音。</p>}
      {photo?.checksum.startsWith("demo-") ? <p className={styles.demo}>演示素材只用于本地试做，不代表正式授权核验。</p> : <p className={styles.hint}>正式照片会比对已批准素材 SHA-256；不匹配时不会生成视频。</p>}
      <button type="button" onClick={renderVideo} disabled={!canCreate || working || recording || !imageFile || !audioBlob} className={styles.render}>{working ? "正在生成本地预览…" : "生成并预览视频"}</button>
    </div>}
    {error ? <div className={styles.error} role="alert"><CircleAlert size={15} />{error}</div> : null}
    {videoUrl && videoProjectId === projectId ? <div className={styles.review}>{savedOutputs.length > 1 ? <label className={styles.versionPicker}>项目成片版本<select value={savedOutput?.id ?? ""} onChange={(event) => { const output = savedOutputs.find((item) => item.id === event.target.value); if (!output) return; setSelectedOutputId(output.id); setVideoBlob(output.blob); setVideoProjectId(projectId); setVideoSnapshot({ script: output.scriptSnapshot, photoAssetId: output.photoAssetId, projectName: output.projectName }); setVideoPreview(output.blob); setReviewed(false); }} aria-label="选择项目成片版本">{savedOutputs.map((output, index) => <option key={output.id} value={output.id}>第 {savedOutputs.length - index} 版 · {new Date(output.createdAt).toLocaleString()}</option>)}</select></label> : null}<video className={styles.video} controls playsInline src={videoUrl} /><label><input type="checkbox" checked={reviewed} onChange={(event) => setReviewed(event.target.checked)} />我已检查画面、字幕和口播音频</label><button type="button" disabled={!reviewed || working || previewDiffersFromProject} onClick={downloadVideo} className={styles.download}><Download size={15} />{working ? "正在保存…" : savedOutput?.blob === videoBlob ? "下载已保存版本" : `保存为第 ${savedOutputs.length + 1} 版并下载`}</button>{savedOutput?.projectId === projectId ? <p className={styles.hint}>项目成片第 {savedOutputs.findIndex((output) => output.id === savedOutput.id) >= 0 ? savedOutputs.length - savedOutputs.findIndex((output) => output.id === savedOutput.id) : 1} 版 · {(savedOutput.size / (1024 * 1024)).toFixed(1)} MB · {new Date(savedOutput.createdAt).toLocaleString()}</p> : null}{previewDiffersFromProject ? <p className={styles.demo}>当前项目脚本、照片或标题已变化；此成片对应旧内容，请重新生成后再用于发布。</p> : null}</div> : null}
    <p className={styles.note}>输出为静态照片配口播字幕，不是动态口型 Avatar。成片保存在此浏览器的本机项目空间，可重新打开预览；清理浏览器数据会删除它，服务端归档尚未接入。</p>
  </section>;
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

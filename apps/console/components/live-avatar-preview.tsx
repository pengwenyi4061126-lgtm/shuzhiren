"use client";

import { useEffect, useRef, useState } from "react";
import { CircleStop, LoaderCircle, Video } from "lucide-react";
import { clientFetch } from "@/lib/client-request";
import styles from "./live-avatar-preview.module.css";

type Props = { projectId: string; runId: string; initialSessionId?: string };

export function LiveAvatarPreview({ projectId, runId, initialSessionId }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const peer = useRef<RTCPeerConnection | null>(null);
  const [busy, setBusy] = useState(false);
  const [sessionId, setSessionId] = useState(initialSessionId ?? "");
  const [error, setError] = useState("");

  useEffect(() => () => { peer.current?.close(); }, []);

  async function connect() {
    if (busy || sessionId) return;
    setBusy(true);
    setError("");
    const connection = new RTCPeerConnection();
    peer.current = connection;
    connection.addTransceiver("video", { direction: "recvonly" });
    connection.addTransceiver("audio", { direction: "recvonly" });
    connection.ontrack = (event) => { if (video.current && event.streams[0]) video.current.srcObject = event.streams[0]; };
    connection.onconnectionstatechange = () => { if (connection.connectionState === "failed" || connection.connectionState === "closed") setSessionId(""); };
    try {
      const offer = await connection.createOffer();
      await connection.setLocalDescription(offer);
      await waitForIce(connection);
      const response = await clientFetch(`/api/v1/studio/projects/${encodeURIComponent(projectId)}/live-outputs/${encodeURIComponent(runId)}/runtime-session`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "offer", sdp: connection.localDescription?.sdp })
      });
      const result = await response.json() as { data?: { sdp: string; type: "answer"; sessionId: string }; error?: string };
      if (!response.ok || !result.data) throw new Error(previewError(result.error));
      await connection.setRemoteDescription({ sdp: result.data.sdp, type: result.data.type });
      setSessionId(result.data.sessionId);
    } catch (cause) {
      connection.close();
      if (peer.current === connection) peer.current = null;
      setError(cause instanceof Error ? cause.message : "预览连接失败，请重试。");
    } finally { setBusy(false); }
  }

  function stop() {
    peer.current?.close();
    peer.current = null;
    if (video.current) video.current.srcObject = null;
    setSessionId("");
  }

  return <section className={styles.preview} aria-label="直播形象预览">
    <div className={styles.heading}><div><strong>直播形象预览</strong><small>{sessionId ? "当前项目 Avatar 已连接" : "确认形象后，再进入开播预检"}</small></div>
      {sessionId ? <button type="button" onClick={stop} aria-label="停止预览" title="停止预览"><CircleStop size={16} />停止</button> : <button type="button" onClick={() => void connect()} disabled={busy} aria-label="连接直播形象预览">{busy ? <LoaderCircle className={styles.spinner} size={16} /> : <Video size={16} />}{busy ? "连接中…" : "连接预览"}</button>}
    </div>
    {sessionId ? <video ref={video} className={styles.video} autoPlay playsInline controls /> : <div className={styles.empty}>{busy ? "正在创建受控预览会话…" : "预览画面将在这里显示"}</div>}
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
  </section>;
}

function waitForIce(connection: RTCPeerConnection) {
  if (connection.iceGatheringState === "complete") return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const onState = () => { if (connection.iceGatheringState === "complete") finish(); };
    const timeout = window.setTimeout(() => finish(new Error("网络协商超时，请检查浏览器网络后重试。")), 15000);
    const finish = (error?: Error) => {
      window.clearTimeout(timeout);
      connection.removeEventListener("icegatheringstatechange", onState);
      if (error) reject(error);
      else resolve();
    };
    connection.addEventListener("icegatheringstatechange", onState);
  });
}

function previewError(code?: string) {
  if (code === "runtime_preview_capacity_occupied") return "运行时当前已有活动会话（单路 GPU 限制），请先结束现有预览或场次。";
  if (code === "avatar_selection_not_ready") return "项目 Avatar 尚未完成审核与发布，请返回形象步骤处理。";
  if (code === "runtime_session_already_bound") return "该直播场次已绑定运行会话，请从节目单页面查看现有预览。";
  return "预览会话创建失败，请确认运行时服务已就绪后重试。";
}

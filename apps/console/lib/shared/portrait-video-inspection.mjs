export function inspectPortraitVideoMetadata(metadata) {
  const durationSeconds = Number(metadata.durationSeconds);
  const width = Number(metadata.width);
  const height = Number(metadata.height);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || !Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    return { state: "invalid", reason: "无法读取视频时长、分辨率或首帧" };
  }
  return {
    state: "ready",
    durationSeconds,
    width,
    height,
    orientation: height > width ? "portrait" : "landscape",
    audioTrackCount: Number.isInteger(metadata.audioTrackCount) && metadata.audioTrackCount >= 0 ? metadata.audioTrackCount : null
  };
}

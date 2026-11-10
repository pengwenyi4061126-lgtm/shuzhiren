const WIDTH = 720;
const HEIGHT = 1280;
const MAX_DURATION_SECONDS = 300;
const DURATION_TOLERANCE_SECONDS = 2;

const ARCHIVE_QUALITY_ERRORS = new Map([
  ["recording_quality_probe_busy", "服务器正在检查其他录播，请稍后重试；本机成片仍保留。"],
  ["recording_quality_probe_unavailable", "录播质检服务未就绪，请稍后重试或联系管理员。"],
  ["recording_quality_probe_timeout", "录播质检耗时过长，请稍后重试；本机成片仍保留。"],
  ["recording_quality_decode_failed", "服务端无法解码成片，请重新生成后再归档。"],
  ["recording_quality_invalid_probe_output", "服务端质检没有得到有效结果，请稍后重试。"],
  ["recording_quality_video_track_missing", "成片缺少可识别的视频流，请重新生成。"],
  ["recording_quality_dimensions_invalid", "服务端检测到画幅不是 720 × 1280，请重新生成。"],
  ["recording_quality_audio_track_missing", "成片缺少口播音轨，请重新制作。"],
  ["recording_quality_duration_invalid", "服务端检测到成片时长不在 1 秒到 5 分钟范围内，请重新生成。"]
]);

export function photoRecordingArchiveQualityError(code) {
  return ARCHIVE_QUALITY_ERRORS.get(code) ?? "服务端录播质检失败，请稍后重试或重新生成。";
}

export function photoNarrationQualityProblems({ width, height, hasDecodedFrame, duration }, expectedDuration) {
  const problems = [];
  if (width !== WIDTH || height !== HEIGHT) problems.push("成片画面尺寸不正确，请重新生成。");
  if (!hasDecodedFrame) problems.push("浏览器无法解码成片首帧，请检查照片或重新生成。");
  if (!Number.isFinite(duration)) problems.push("无法读取成片时长，请重新生成或更换桌面浏览器。");
  else if (duration < 1 || duration > MAX_DURATION_SECONDS) problems.push("成片时长不在 1 秒到 5 分钟范围内。");
  if (!Number.isFinite(expectedDuration) || expectedDuration < 1 || expectedDuration > MAX_DURATION_SECONDS) {
    problems.push("无法读取有效的口播音频时长，请更换音频后重试。");
  } else if (Number.isFinite(duration) && duration >= 1 && duration <= MAX_DURATION_SECONDS && Math.abs(duration - expectedDuration) > DURATION_TOLERANCE_SECONDS) {
    problems.push("成片时长与口播音频不一致，请重新生成。");
  }
  return problems;
}

const WIDTH = 720;
const HEIGHT = 1280;
const MAX_DURATION_SECONDS = 300;
const DURATION_TOLERANCE_SECONDS = 2;

export function photoNarrationQualityProblems({ width, height, hasDecodedFrame, duration }, expectedDuration) {
  const problems = [];
  if (width !== WIDTH || height !== HEIGHT) problems.push("成片画面尺寸不正确，请重新生成。");
  if (!hasDecodedFrame) problems.push("浏览器无法解码成片首帧，请检查照片或重新生成。");
  if (Number.isFinite(duration)) {
    if (duration < 1 || duration > MAX_DURATION_SECONDS) problems.push("成片时长不在 1 秒到 5 分钟范围内。");
    else if (Number.isFinite(expectedDuration) && Math.abs(duration - expectedDuration) > DURATION_TOLERANCE_SECONDS) problems.push("成片时长与口播音频不一致，请重新生成。");
  }
  return problems;
}

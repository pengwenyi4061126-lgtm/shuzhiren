export function photoMotionAt(elapsedSeconds, durationSeconds) {
  if (!Number.isFinite(elapsedSeconds) || !Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new TypeError("Photo motion timing must be finite and duration must be positive");
  const progress = Math.max(0, Math.min(1, elapsedSeconds / durationSeconds));
  return {
    progress,
    scale: 1 + progress * 0.065,
    panX: progress - 0.5,
    panY: 0.5 - progress
  };
}

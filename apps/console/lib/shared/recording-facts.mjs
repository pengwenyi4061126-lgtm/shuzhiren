export function formatCnyPrice(priceCent) {
  if (!Number.isSafeInteger(priceCent) || priceCent < 0) return null;
  const yuan = Math.floor(priceCent / 100).toLocaleString("zh-CN");
  const cents = String(priceCent % 100).padStart(2, "0");
  return `¥${yuan}.${cents}`;
}

export function recordingHighlights(values) {
  if (!Array.isArray(values)) return [];
  return values.filter((value) => typeof value === "string" && value.trim()).slice(0, 2).map((value) => value.trim());
}

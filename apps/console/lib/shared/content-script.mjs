export function splitNarrationScript(source, maxLength = 800) {
  if (typeof source !== "string" || !Number.isSafeInteger(maxLength) || maxLength < 1) throw new TypeError("source and a positive maxLength are required");
  let rest = source.trim();
  if (!rest) return [];
  const chunks = [];
  while (rest.length > maxLength) {
    let boundary = 0;
    for (const punctuation of ["。", "！", "？", "；", ". ", "! ", "? ", "; ", "\n"]) {
      const index = rest.lastIndexOf(punctuation, maxLength - punctuation.length);
      if (index >= 0) boundary = Math.max(boundary, index + punctuation.length);
    }
    if (boundary < Math.floor(maxLength * 0.55)) boundary = maxLength;
    chunks.push(rest.slice(0, boundary));
    rest = rest.slice(boundary);
  }
  if (rest) chunks.push(rest);
  return chunks;
}

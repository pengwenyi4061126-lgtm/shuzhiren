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

export function generateProductScript({ name, goal, audience, priceCent, highlights, faq, style = "friendly", length = "standard" }) {
  if (typeof name !== "string" || !name.trim() || !Array.isArray(highlights) || !Array.isArray(faq)) {
    throw new TypeError("an approved product name and fact lists are required");
  }
  const counts = { short: [1, 1], standard: [3, 2], detailed: [5, 4] };
  if (!counts[length] || !["friendly", "professional", "faq"].includes(style)) throw new TypeError("a supported script style and length are required");
  const [highlightLimit, faqLimit] = counts[length];
  const productName = name.trim().slice(0, 200);
  const topic = typeof goal === "string" && goal.trim() ? goal.trim().slice(0, 120) : "了解商品信息";
  const target = typeof audience === "string" && audience.trim() ? audience.trim().slice(0, 120) : "正在了解这类商品的朋友";
  const approvedHighlights = highlights.filter((item) => typeof item === "string" && item.trim()).slice(0, highlightLimit).map((item) => item.trim().slice(0, 240));
  const approvedFaq = faq.filter((item) => typeof item === "string" && item.trim()).slice(0, faqLimit).map((item) => item.trim().slice(0, 300));
  const opening = style === "professional"
    ? `本次围绕${topic}介绍${productName}。面向${target}，以下内容仅依据已审核的商品资料整理。`
    : style === "faq"
      ? `大家好，今天我们围绕${productName}回答一些常见问题，也会结合已审核资料介绍${topic}。如果你是${target}，可以按需参考。`
      : `你好，欢迎来到直播间。今天我们一起了解${productName}，重点聊聊${topic}。如果你是${target}，可以听听下面这些已确认的信息。`;
  const factLines = approvedHighlights.length
    ? approvedHighlights.map((item, index) => `${index + 1}. ${item}`)
    : ["目前已审核资料没有填写商品特点，这部分先不作补充说明。"];
  if (Number.isSafeInteger(priceCent) && priceCent >= 0) factLines.push(`已审核资料记录的价格为${(priceCent / 100).toFixed(2)}元，具体展示以当前商品页面为准。`);
  const faqLines = approvedFaq.map((item) => `常见信息：${item}`);
  const closing = style === "professional"
    ? "以上为已审核资料中的信息。请结合商品详情和自身需求判断是否适合。"
    : "以上信息供你参考，是否适合请结合商品详情和自身需求判断。想进一步了解，可以查看商品页面。";
  return [opening, ...factLines, ...faqLines, closing].join("\n\n");
}

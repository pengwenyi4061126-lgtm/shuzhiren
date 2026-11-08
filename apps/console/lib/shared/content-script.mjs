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
    ? `本次围绕“${topic}”介绍${productName}，面向${target}整理重点。以下内容仅依据已审核的商品资料。`
    : style === "faq"
      ? `关于${productName}，如果你是${target}，今天先围绕“${topic}”看看已审核资料里有哪些信息。`
      : `你好，今天我们来聊聊${productName}。如果你是${target}，可以先从“${topic}”这个方向了解。下面的内容都来自已审核资料。`;
  const transitions = style === "professional"
    ? ["已审核资料显示：", "资料还记录：", "另外，资料列出："]
    : style === "faq"
      ? ["先看一个商品信息：", "再来看一项已确认的特点：", "还有一项资料提到："]
      : ["先说这个特点：", "再补充一点：", "另外，已审核资料还提到："];
  const factLines = approvedHighlights.length
    ? approvedHighlights.map((item, index) => `${transitions[index % transitions.length]}${item}`)
    : ["目前已审核资料没有填写商品特点，这部分先不作补充说明。"];
  if (Number.isSafeInteger(priceCent) && priceCent >= 0) {
    const price = `${(priceCent / 100).toFixed(2)}元`;
    factLines.push(style === "professional"
      ? `已审核资料中的价格为${price}；实际展示以商品页面为准。`
      : `价格方面，已审核资料记录为${price}，实际展示以商品页面为准。`);
  }
  const faqLines = approvedFaq.map((item) => style === "professional" ? `常见问题补充：${item}` : `你可能还关心：${item}`);
  const closing = style === "professional"
    ? "以上为已审核资料中的信息，请结合商品详情和自身需求判断是否适合。"
    : style === "faq"
      ? "以上是这次整理的商品信息，是否适合请结合商品详情和自身需求判断。"
      : "这些信息供你参考。想进一步了解，可以查看商品详情，再按自己的需要判断。";
  return [opening, ...factLines, ...faqLines, closing].join("\n\n");
}

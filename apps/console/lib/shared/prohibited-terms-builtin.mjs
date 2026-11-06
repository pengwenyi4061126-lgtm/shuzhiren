// 内置违禁词表（design.md 模块 E，E.1）。
//
// 示例词表，未经法务审定。 本表只用来演示词表机制、测试拦截与改写建议，不是对广告法、直播电商规范或任何平台规则的
// 完整或权威解读；上线前必须由具备资质的法务人员审定、增删，并更新 BUILTIN_LEXICON_VERSION。
//
// 维护规则：
//   - 词条 ID 为 `builtin:<类别>:NNN`，NNN 是该词在本类别数组中的序号（从 001 起）。租户的停用与建议覆盖按 ID
//     引用词条，所以只能在类别数组末尾追加；不要删除、重排或改写已有词条的词。
//   - 任何词条或建议变化都要提高 BUILTIN_LEXICON_VERSION，并写入 docs/VERIFICATION_LOG.md 与 DEPLOYMENT_RUNBOOK.md。
//   - 每条替换建议本身不得包含任何 block 词（scripts/test-prohibited-terms.mjs 与 policy:red-team 会检查）。
//   - 本模块是纯数据，不导入任何文件；apps/console/lib/shared 与 runtime-worker 镜像共用它。
export const BUILTIN_LEXICON_VERSION = "sample-1";

const price = ["活动价", "优惠价"];
const quality = ["高品质"];
const popular = ["热门", "受欢迎"];
const removeClaim = ["删除该表述", "以产品备案信息为准"];
const afterSales = ["以平台售后规则为准"];
const orderInRoom = ["请在直播间购物车下单"];

// [词, 级别, 替换建议]。block：播报前拦截；warn：只标出。
const sections = {
  extreme: [
    ["全网最低", "block", price],
    ["最低价", "block", price],
    ["第一", "warn", popular],
    ["顶级", "block", quality],
    ["国家级", "block", quality],
    ["史无前例", "block", ["备受关注"]],
    ["最好", "block", ["优质"]],
    ["最佳", "block", ["优质"]],
    ["最强", "block", ["表现出色"]],
    ["最先进", "block", ["先进"]],
    ["唯一", "warn", ["少见"]],
    ["独一无二", "block", ["特色鲜明"]],
    ["绝无仅有", "block", ["少见"]],
    ["万能", "block", ["多用途"]],
    ["极致", "warn", ["出色"]],
    ["世界领先", "block", ["表现出色"]],
    ["全球首发", "block", ["新品上市"]],
    ["销量冠军", "block", ["热销"]],
    ["全网第一", "block", popular],
    ["最高级", "block", quality]
  ],
  medical: [
    ["治疗", "block", removeClaim],
    ["治愈", "block", removeClaim],
    ["根治", "block", removeClaim],
    ["药效", "block", removeClaim],
    ["消炎", "block", removeClaim],
    ["抗癌", "block", removeClaim],
    ["降血压", "block", removeClaim],
    ["降血糖", "block", removeClaim],
    ["降血脂", "block", removeClaim],
    ["抗病毒", "block", removeClaim],
    ["疗效", "block", removeClaim],
    ["特效药", "block", removeClaim],
    ["包治百病", "block", removeClaim],
    ["药到病除", "block", removeClaim],
    ["防癌", "block", removeClaim],
    ["抗炎", "block", removeClaim],
    ["消肿", "block", removeClaim],
    ["止痛", "block", removeClaim],
    ["增强免疫力", "block", removeClaim],
    ["功效", "warn", ["以产品备案信息为准"]],
    ["调理", "warn", ["以产品备案信息为准"]],
    ["排毒", "warn", removeClaim],
    ["瘦身", "warn", removeClaim],
    ["延缓衰老", "warn", removeClaim],
    ["抑菌", "warn", ["以产品备案信息为准"]]
  ],
  false_claim: [
    ["假一赔十", "block", afterSales],
    ["假一赔百", "block", afterSales],
    ["假一罚十", "block", afterSales],
    ["永久有效", "block", ["活动期内有效"]],
    ["终身有效", "block", ["活动期内有效"]],
    ["零风险", "block", ["请理性消费"]],
    ["无风险", "block", ["请理性消费"]],
    ["无效退款", "block", ["按平台售后规则处理"]],
    ["秒杀全网", "block", ["限时活动价"]],
    ["百分百有效", "block", ["效果因人而异"]],
    ["100%有效", "block", ["效果因人而异"]],
    ["绝对安全", "block", ["请按产品说明使用"]],
    ["稳赚不赔", "block", ["请理性消费"]],
    ["保证有效", "block", ["效果因人而异"]],
    ["无副作用", "block", ["请按产品说明使用"]],
    ["央视推荐", "block", ["以实际报道为准"]],
    ["专家推荐", "warn", ["以实际资质说明为准"]],
    ["明星同款", "warn", ["以实际授权为准"]],
    ["纯天然", "warn", ["以产品成分表为准"]],
    ["包退包换", "warn", ["按平台售后规则处理"]]
  ],
  offsite_trade: [
    ["加微信", "block", orderInRoom],
    ["加V", "block", orderInRoom],
    ["vx", "block", orderInRoom],
    ["私下转账", "block", orderInRoom],
    ["扫码付款", "block", orderInRoom],
    ["淘宝搜", "block", orderInRoom],
    ["微信号", "block", orderInRoom],
    ["加我微信", "block", orderInRoom],
    ["私聊下单", "block", orderInRoom],
    ["私下交易", "block", orderInRoom],
    ["站外下单", "block", orderInRoom],
    ["转账给我", "block", orderInRoom],
    ["加qq", "block", orderInRoom],
    ["威信", "block", orderInRoom],
    ["薇信", "block", orderInRoom],
    ["v信", "block", orderInRoom],
    ["支付宝转账", "block", orderInRoom],
    ["线下交易", "block", orderInRoom],
    ["拼多多搜", "block", orderInRoom],
    ["京东搜", "block", orderInRoom],
    ["qq群", "warn", orderInRoom],
    ["扫码", "warn", orderInRoom],
    ["二维码", "warn", orderInRoom],
    ["加群", "warn", orderInRoom]
  ]
};

export const BUILTIN_LEXICON = Object.freeze(
  Object.entries(sections).flatMap(([category, rows]) =>
    rows.map(([term, severity, suggestions], index) =>
      Object.freeze({ id: `builtin:${category}:${String(index + 1).padStart(3, "0")}`, term, category, severity, suggestions: Object.freeze([...suggestions]) })
    )
  )
);

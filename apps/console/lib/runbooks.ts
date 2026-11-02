export type RunbookSeverity = "P1" | "P2" | "P3";

export type Runbook = {
  id: string;
  severity: RunbookSeverity;
  title: string;
  trigger: string;
  owner: string;
  responseTarget: string;
  steps: string[];
  evidence: string[];
};

export const runbooks: Runbook[] = [
  {
    id: "gpu-oom",
    severity: "P1",
    title: "GPU 显存耗尽或推理异常退出",
    trigger: "显存使用持续超过容量 95%，推理进程退出，或输出帧率连续 30 秒低于 24 FPS。",
    owner: "直播值班员；平台工程师升级处理",
    responseTarget: "5 分钟内止损，30 分钟内形成事故结论",
    steps: ["立即确认备用节目已就绪，并停止新增高显存任务。", "切换至已批准的低显存模型配置或备用节目，保持输出链路不断流。", "保存 GPU 指标、运行时日志和当前发布清单哈希；不得覆盖原始证据。", "若恢复后仍触发阈值，创建 P1 事故单并停止该场次继续扩容。"],
    evidence: ["GPU 利用率、显存曲线与进程退出日志", "切换命令及执行人审计记录", "冻结发布清单哈希与恢复后健康采样"]
  },
  {
    id: "model-tts-timeout",
    severity: "P1",
    title: "模型或语音合成超时",
    trigger: "推理、口型或 TTS 请求超出运行时超时阈值，或静音连续超过告警阈值。",
    owner: "直播值班员；语音/模型工程师升级处理",
    responseTarget: "3 分钟内恢复可听、可看输出",
    steps: ["确认超时范围是单句、单模型还是运行时网关，暂停新的互动回复。", "重试只允许使用已冻结模型与已批准音色；禁止临场更换未审核资产。", "超过一次重试仍失败时，切换备用话术或备用节目，并创建事故单。", "恢复后抽检音画同步与话术完整性，再解除降级状态。"],
    evidence: ["请求关联 ID、超时日志与响应耗时", "冻结模型版本、音色资产与备用内容 ID", "恢复前后静音、音画同步采样"]
  },
  {
    id: "black-frame",
    severity: "P1",
    title: "黑屏、花屏或视频合成失效",
    trigger: "探针检测到黑帧、画面冻结或合成链路无有效视频帧。",
    owner: "直播值班员；媒体运行工程师升级处理",
    responseTarget: "2 分钟内切入可用画面",
    steps: ["确认推流端仍连接后，立即切换备用节目画面，避免持续黑屏。", "检查渲染进程、摄像头/合成输入和编码器状态，不重启整机作为首选操作。", "保留黑帧探针截图、输出时间线和进程日志。", "恢复主画面后，连续观察 5 分钟并记录确认结果。"],
    evidence: ["黑帧探针结果或截图", "输出视频时间线与编码器状态", "备用节目切换与恢复审计记录"]
  },
  {
    id: "rtmp-rejected",
    severity: "P1",
    title: "RTMP 连接被拒绝或推流中断",
    trigger: "平台返回鉴权失败、流密钥失效、连接拒绝，或输出连接中断。",
    owner: "直播值班员；渠道管理员升级处理",
    responseTarget: "5 分钟内恢复或明确降级",
    steps: ["核对当前渠道、目的地与已批准的凭据版本，不在日志或聊天中暴露流密钥。", "执行一次受控重连；失败后停止重复重试并切换至备用目的地或结束场次。", "将平台响应码、连接时间和渠道配置版本附入事故单。", "凭据轮换只能由渠道管理员执行，完成后重新进行输出探针。"],
    evidence: ["平台响应码、断连时间与重连次数", "渠道配置和凭据版本标识", "重连后的输出探针结果"]
  },
  {
    id: "inventory-unsynced",
    severity: "P2",
    title: "库存、价格或商品事实不同步",
    trigger: "商品事实已过期、库存同步失败，或平台商品状态与已批准版本不一致。",
    owner: "商品运营；直播值班员负责止损",
    responseTarget: "10 分钟内停止错误承诺",
    steps: ["立即停止涉及异常 SKU 的成交引导和限量、到手价等强事实话术。", "将该商品切换为不可讲解或切入备用商品，不修改冻结版本来掩盖差异。", "由商品运营修正上游事实并走审核发布，生成新的批准版本后才可恢复。", "对已产生的订单承诺建立追溯清单并交由售后处置。"],
    evidence: ["异常 SKU、原始同步响应与商品版本", "停止讲解、替换商品的时间线", "新批准事实版本和影响订单清单"]
  },
  {
    id: "policy-violation",
    severity: "P1",
    title: "违规回答、虚假承诺或越权话术",
    trigger: "策略命中拒答、人工发现超出证据的话术，或平台提示内容合规风险。",
    owner: "直播值班员；合规负责人升级处理",
    responseTarget: "1 分钟内中止风险表达，15 分钟内完成初判",
    steps: ["立即中止当前回答，使用已批准的澄清或拒答话术；必要时切换备用节目。", "锁定关联互动、语音输出、字幕和发布清单，禁止删除或事后改写。", "创建 P1 事故单，标明被触发的策略、影响范围和初步纠正措施。", "仅在合规负责人确认新的事实或策略版本已批准后，才可恢复相关品类的话术。"],
    evidence: ["互动原文、音频/字幕片段与命中策略", "操作人、时间线及事故单结论", "恢复使用的批准策略和事实版本"]
  }
];

export const runbookSeverityLabel: Record<RunbookSeverity, string> = {
  P1: "P1 立即处置",
  P2: "P2 优先处理",
  P3: "P3 计划修复"
};

const alertRunbookIds: Record<string, Runbook["id"]> = {
  output_disconnected: "rtmp-rejected",
  output_fps_low: "black-frame",
  av_sync_high: "model-tts-timeout",
  bitrate_low: "rtmp-rejected",
  fallback_not_ready: "black-frame"
};

export function runbookForAlertCode(code: string) {
  const id = alertRunbookIds[code];
  return id ? runbooks.find((runbook) => runbook.id === id) : undefined;
}

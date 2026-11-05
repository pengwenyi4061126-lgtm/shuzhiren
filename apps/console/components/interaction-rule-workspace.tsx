"use client";

import { ArrowLeft, BadgeCheck, ClipboardCheck, ListChecks, Lock, Pencil, Plus, Power, Sparkles, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import type { InteractionRule, InteractionRuleAction, InteractionRuleFiring, InteractionRuleFiringOutcome, InteractionRuleTrigger, TemplatePolicyFailure } from "@/lib/interaction-rules";
import { clientFetch } from "@/lib/client-request";
import styles from "./interaction-rule-workspace.module.css";

type RunOption = { id: string; showName: string; state: string };
type Draft = { name: string; triggerType: InteractionRuleTrigger; action: InteractionRuleAction; keywords: string; minGiftYuan: string; intervalSeconds: string; cooldownSeconds: string; priority: string; liveRunId: string; templates: string };
type ApiError = { error?: string; detail?: string; failures?: TemplatePolicyFailure[] };

const triggerLabel: Record<InteractionRuleTrigger, string> = { viewer_enter: "欢迎进场", follow: "感谢关注", gift: "礼物答谢", keyword: "关键词回复", timed: "定时口播", idle_comment: "冷场互动" };
const actionLabel: Record<InteractionRuleAction, string> = { speak: "语音播报", reply_draft: "生成回复草稿（需人工审批发送）" };
const outcomeLabel: Record<InteractionRuleFiringOutcome, string> = { speech_queued: "已排队播报", reply_drafted: "已生成草稿", policy_blocked: "策略拦截", suppressed: "限流跳过", unavailable: "条件不满足" };
const reasonLabel: Record<string, string> = {
  rule_cooldown: "规则冷却中", viewer_cooldown: "同一观众冷却中", global_speech_interval: "距上次播报不足最小间隔", speech_pending: "上一条语音尚未送达", media_command_pending: "节目指令待送达",
  program_transition_pending: "节目切换待确认", speech_budget_used: "本轮已播报一条", no_reply_channel: "互动不来自渠道", reply_draft_exists: "该互动已有回复草稿",
  policy_profile_inactive: "场次策略包未生效", product_unavailable: "冻结商品版本不可用", voice_unavailable: "冻结声线不可用"
};
const slotHints = [
  { slot: "{nickname}", label: "观众昵称（清洗后；不通过时读作“这位朋友”）" },
  { slot: "{product_name}", label: "场次冻结的已批准商品名" },
  { slot: "{price}", label: "已批准商品价格（元）" }
];
const timerTriggers: InteractionRuleTrigger[] = ["timed", "idle_comment"];
const aiDisclosureBounds = { min: 60, max: 1800 };
const emptyDraft: Draft = { name: "", triggerType: "viewer_enter", action: "speak", keywords: "", minGiftYuan: "", intervalSeconds: "300", cooldownSeconds: "60", priority: "100", liveRunId: "", templates: "" };
const errorText: Record<string, string> = {
  invalid_interaction_rule: "规则字段不完整或格式不正确", interaction_rule_template_policy_blocked: "模板未通过策略检查", ai_disclosure_rule_protected: "AI 身份提示规则不可停用，只能调整间隔",
  live_run_not_found: "所选场次不存在", interaction_rule_rejected: "规则操作被拒绝", interaction_rule_approval_rejected: "规则审批被拒绝", interaction_rule_defaults_rejected: "默认规则创建被拒绝", rule_firings_rejected: "触发记录读取被拒绝"
};

export function InteractionRuleWorkspace({ initialRules, runs, canManage, canApprove }: { initialRules: InteractionRule[]; runs: RunOption[]; canManage: boolean; canApprove: boolean }) {
  const [rules, setRules] = useState(initialRules);
  const [editing, setEditing] = useState<InteractionRule | "new" | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [runId, setRunId] = useState(runs.find((run) => run.state === "LIVE")?.id ?? runs[0]?.id ?? "");
  const [firings, setFirings] = useState<InteractionRuleFiring[]>([]);
  const [firingsError, setFiringsError] = useState<string | null>(null);
  const ruleNames = new Map(rules.map((rule) => [rule.id, rule.name]));
  const aiDisclosure = editing !== "new" && editing?.defaultKey === "ai_disclosure";
  const timer = timerTriggers.includes(draft.triggerType);

  useEffect(() => {
    if (!runId) return;
    let active = true;
    clientFetch(`/api/v1/live-runs/${encodeURIComponent(runId)}/rule-firings`)
      .then(async (response) => {
        const payload = await response.json().catch(() => null) as { data?: InteractionRuleFiring[] } & ApiError | null;
        if (!active) return;
        if (!response.ok || !payload?.data) { setFiringsError(describe(payload)); setFirings([]); return; }
        setFiringsError(null);
        setFirings(payload.data);
      })
      .catch((cause) => { if (active) setFiringsError(cause instanceof Error ? cause.message : "触发记录读取失败"); });
    return () => { active = false; };
  }, [runId]);

  async function request<T>(url: string, init: RequestInit) {
    const response = await clientFetch(url, init);
    const payload = await response.json().catch(() => null) as ({ data?: T } & ApiError) | null;
    if (!response.ok || !payload?.data) throw new Error(describe(payload));
    return payload.data;
  }

  function startEdit(rule: InteractionRule | "new") {
    setError(null);
    setNotice(null);
    setEditing(rule);
    setDraft(rule === "new" ? emptyDraft : {
      name: rule.name, triggerType: rule.triggerType, action: rule.action, keywords: (rule.matchConfig.keywords ?? []).join("，"),
      minGiftYuan: rule.matchConfig.minGiftValueCents !== undefined ? String(rule.matchConfig.minGiftValueCents / 100) : "", intervalSeconds: String(rule.intervalSeconds ?? 300),
      cooldownSeconds: String(rule.cooldownSeconds), priority: String(rule.priority), liveRunId: rule.liveRunId ?? "", templates: rule.templates.join("\n")
    });
  }

  function body() {
    if (aiDisclosure) return { intervalSeconds: Number(draft.intervalSeconds) };
    const keywords = draft.keywords.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean);
    const matchConfig = draft.triggerType === "keyword" ? { keywords } : draft.triggerType === "gift" && draft.minGiftYuan.trim() ? { minGiftValueCents: Math.round(Number(draft.minGiftYuan) * 100) } : {};
    return {
      name: draft.name, triggerType: draft.triggerType, action: timer ? "speak" : draft.action, matchConfig,
      templates: draft.templates.split("\n").map((line) => line.trim()).filter(Boolean),
      cooldownSeconds: Number(draft.cooldownSeconds), priority: Number(draft.priority),
      ...(timer ? { intervalSeconds: Number(draft.intervalSeconds) } : {}),
      ...(editing === "new" ? (draft.liveRunId ? { liveRunId: draft.liveRunId } : {}) : { liveRunId: draft.liveRunId || null })
    };
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("save");
    setError(null);
    try {
      if (editing === "new") {
        const rule = await request<InteractionRule>("/api/v1/interaction-rules", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body()) });
        setRules((items) => [rule, ...items]);
        setNotice("规则已登记，审批通过后生效。");
      } else if (editing) {
        const rule = await request<InteractionRule>(`/api/v1/interaction-rules/${encodeURIComponent(editing.id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body()) });
        setRules((items) => items.map((item) => item.id === rule.id ? rule : item));
        setNotice(rule.approval === "pending" ? "规则内容已修改，需重新审批后生效。" : "规则已更新。");
      }
      setEditing(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "规则保存失败");
    } finally {
      setBusy(null);
    }
  }

  async function act(rule: InteractionRule, action: "approve" | "disable" | "enable") {
    setBusy(rule.id);
    setError(null);
    setNotice(null);
    try {
      const url = `/api/v1/interaction-rules/${encodeURIComponent(rule.id)}${action === "approve" ? "/approve" : ""}`;
      const init: RequestInit = action === "approve" ? { method: "POST" } : action === "disable" ? { method: "DELETE" } : { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true }) };
      const updated = await request<InteractionRule>(url, init);
      setRules((items) => items.map((item) => item.id === updated.id ? updated : item));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "规则操作失败");
    } finally {
      setBusy(null);
    }
  }

  async function createDefaults() {
    setBusy("defaults");
    setError(null);
    setNotice(null);
    try {
      const result = await request<{ created: InteractionRule[]; existing: number }>("/api/v1/interaction-rules/defaults", { method: "POST" });
      setRules((items) => [...result.created, ...items].sort((left, right) => right.priority - left.priority));
      setNotice(result.created.length ? `已创建 ${result.created.length} 条默认规则，审批通过后生效。` : "默认规则均已存在。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "默认规则创建失败");
    } finally {
      setBusy(null);
    }
  }

  return <main className={styles.page}>
    <Link className="back-link" href="/"><ArrowLeft size={16} />返回指挥台</Link>
    <header className={styles.top}>
      <div><p>直播互动</p><h1>互动规则</h1><span>按观众进场、关注、礼物、评论关键词和定时器自动生成话术。规则模板经审批后生效；每次触发都会再次通过策略检查，只使用场次冻结的商品版本和声线，并受全局播报间隔、观众冷却和规则冷却限制。</span></div>
      {canManage ? <div className={styles.toolbar}>
        <button className={styles.secondary} type="button" disabled={busy === "defaults"} onClick={createDefaults}><Sparkles size={16} />{busy === "defaults" ? "创建中" : "一键创建默认规则"}</button>
        <button className={styles.primary} type="button" onClick={() => startEdit("new")}><Plus size={16} />新建规则</button>
      </div> : null}
    </header>
    {error ? <p className="catalog-error" role="alert">{error}</p> : null}
    {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
    {editing ? <form className={styles.form} onSubmit={save}>
      <div className={styles.formHead}><strong>{editing === "new" ? "新建规则" : aiDisclosure ? "调整 AI 身份提示间隔" : `编辑：${editing.name}`}</strong><button className="icon-button" type="button" aria-label="关闭" onClick={() => setEditing(null)}><X size={16} /></button></div>
      {aiDisclosure ? <>
        <p className={`${styles.wide} ${styles.locked}`}>AI 身份提示是 AIGC 合规的语音部分，不可停用或修改话术，只能在 {aiDisclosureBounds.min} 到 {aiDisclosureBounds.max} 秒之间调整播报间隔。</p>
        <label>播报间隔（秒）<input type="number" min={aiDisclosureBounds.min} max={aiDisclosureBounds.max} value={draft.intervalSeconds} onChange={(event) => setDraft({ ...draft, intervalSeconds: event.target.value })} required /></label>
      </> : <>
        <label>规则名称<input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} required maxLength={80} /></label>
        <label>触发方式<select value={draft.triggerType} onChange={(event) => setDraft({ ...draft, triggerType: event.target.value as InteractionRuleTrigger })}>{(Object.keys(triggerLabel) as InteractionRuleTrigger[]).map((trigger) => <option key={trigger} value={trigger}>{triggerLabel[trigger]}</option>)}</select></label>
        <label>动作<select value={timer ? "speak" : draft.action} disabled={timer} onChange={(event) => setDraft({ ...draft, action: event.target.value as InteractionRuleAction })}>{(Object.keys(actionLabel) as InteractionRuleAction[]).map((action) => <option key={action} value={action}>{actionLabel[action]}</option>)}</select></label>
        {draft.triggerType === "keyword" ? <label className={styles.wide}>关键词（逗号分隔，命中任一即触发；只回复策略判定为可回答的评论）<input value={draft.keywords} onChange={(event) => setDraft({ ...draft, keywords: event.target.value })} required placeholder="例如：发货，几天到" /></label> : null}
        {draft.triggerType === "gift" ? <label>礼物最低价值（元，可选）<input type="number" min={0} step="0.01" value={draft.minGiftYuan} onChange={(event) => setDraft({ ...draft, minGiftYuan: event.target.value })} /></label> : null}
        {timer ? <label>{draft.triggerType === "timed" ? "播报间隔（秒）" : "无评论多久后提示（秒）"}<input type="number" min={60} max={86400} value={draft.intervalSeconds} onChange={(event) => setDraft({ ...draft, intervalSeconds: event.target.value })} required /></label> : null}
        <label>规则冷却（秒）<input type="number" min={0} max={86400} value={draft.cooldownSeconds} onChange={(event) => setDraft({ ...draft, cooldownSeconds: event.target.value })} required /></label>
        <label>优先级（0–999，越大越优先）<input type="number" min={0} max={999} value={draft.priority} onChange={(event) => setDraft({ ...draft, priority: event.target.value })} required /></label>
        <label>作用范围<select value={draft.liveRunId} onChange={(event) => setDraft({ ...draft, liveRunId: event.target.value })}><option value="">全部场次</option>{runs.map((run) => <option key={run.id} value={run.id}>{run.showName}（{run.state}）</option>)}</select></label>
        <label className={styles.wide}>话术模板（每行一条，最多 10 条，运行时随机轮换、不连续重复）<textarea value={draft.templates} onChange={(event) => setDraft({ ...draft, templates: event.target.value })} required placeholder={timer ? "例如：正在为大家介绍{product_name}，当前价格{price}元，以结算页为准。" : "例如：欢迎{nickname}来到直播间！"} /></label>
        <div className={`${styles.wide} ${styles.slots}`}>可用槽位：{slotHints.filter((hint) => !(timer && hint.slot === "{nickname}")).map((hint) => <button key={hint.slot} type="button" title={hint.label} onClick={() => setDraft({ ...draft, templates: `${draft.templates}${hint.slot}` })}>{hint.slot}</button>)}<span>{timer ? "定时与冷场规则没有观众，不能使用 {nickname}。" : "昵称会去除控制字符、截断并做违禁检查。"}</span></div>
      </>}
      <div className={styles.wide}><button className={styles.primary} disabled={busy === "save"} type="submit">{busy === "save" ? "保存中" : editing === "new" ? "提交待审批规则" : "保存"}</button></div>
    </form> : null}
    <section className={styles.list} aria-label="互动规则列表">
      {rules.map((rule) => <article className={styles.rule} key={rule.id}>
        <div>
          <strong>{rule.name}</strong>
          <div className={styles.meta}>
            <span>{triggerLabel[rule.triggerType]}</span><span>{actionLabel[rule.action]}</span>
            {rule.intervalSeconds ? <span>每 {rule.intervalSeconds} 秒</span> : null}<span>冷却 {rule.cooldownSeconds} 秒</span><span>优先级 {rule.priority}</span>
            {rule.matchConfig.keywords ? <span>关键词：{rule.matchConfig.keywords.join("、")}</span> : null}
            {rule.matchConfig.minGiftValueCents ? <span>礼物 ≥ ¥{(rule.matchConfig.minGiftValueCents / 100).toFixed(2)}</span> : null}
            <span>{rule.liveRunId ? `仅场次 ${runs.find((run) => run.id === rule.liveRunId)?.showName ?? rule.liveRunId.slice(0, 8)}` : "全部场次"}</span>
            {rule.defaultKey === "ai_disclosure" ? <span className={styles.locked}><Lock size={11} /> AIGC 合规 · 不可停用</span> : null}
          </div>
        </div>
        <div className={styles.actions}>
          <span className={`${styles.badge} ${rule.approval === "approved" ? styles.approved : ""}`}>{rule.approval === "approved" ? <BadgeCheck size={14} /> : <ClipboardCheck size={14} />}{rule.approval === "approved" ? "已批准" : "待审批"}</span>
          <span className={`${styles.badge} ${rule.enabled ? styles.approved : styles.disabled}`}>{rule.enabled ? "启用" : "已停用"}</span>
          {canApprove && rule.approval === "pending" ? <button className={styles.primary} type="button" disabled={busy === rule.id} onClick={() => act(rule, "approve")}>{busy === rule.id ? "处理中" : "批准"}</button> : null}
          {canManage ? <button className={styles.secondary} type="button" onClick={() => startEdit(rule)}><Pencil size={14} />{rule.defaultKey === "ai_disclosure" ? "调整间隔" : "编辑"}</button> : null}
          {canManage && rule.defaultKey !== "ai_disclosure" ? <button className={styles.secondary} type="button" disabled={busy === rule.id} onClick={() => act(rule, rule.enabled ? "disable" : "enable")}><Power size={14} />{rule.enabled ? "停用" : "启用"}</button> : null}
        </div>
        <ol className={styles.templates}>{rule.templates.map((template, index) => <li key={index}>{template}</li>)}</ol>
      </article>)}
      {!rules.length ? <div className={styles.empty}>尚无互动规则。可以一键创建欢迎、关注感谢、礼物答谢、定时商品口播和 AI 身份提示等默认规则，审批后生效。</div> : null}
    </section>
    <section className={styles.firings} aria-label="触发记录">
      <div className={styles.firingsHead}><h2><ListChecks size={16} /> 触发记录</h2>
        <select value={runId} onChange={(event) => setRunId(event.target.value)} aria-label="选择场次">{runs.length ? runs.map((run) => <option key={run.id} value={run.id}>{run.showName}（{run.state}）</option>) : <option value="">暂无场次</option>}</select>
      </div>
      {firingsError ? <p className="catalog-error" role="alert">{firingsError}</p> : null}
      {firings.length ? <table className={styles.table}>
        <thead><tr><th>时间</th><th>规则</th><th>触发</th><th>结果</th><th>原因</th><th>模板 / 文本哈希</th></tr></thead>
        <tbody>{firings.map((firing) => <tr key={firing.id}>
          <td>{new Date(firing.createdAt).toLocaleString("zh-CN")}</td>
          <td>{firing.ruleName || ruleNames.get(firing.ruleId) || firing.ruleId.slice(0, 8)}</td>
          <td><code>{firing.triggerKey.startsWith("interaction:") ? "互动" : firing.triggerKey.startsWith("idle:") ? "冷场" : "定时"}</code></td>
          <td>{outcomeLabel[firing.outcome]}</td>
          <td>{firing.outcomeReason ? reasonLabel[firing.outcomeReason] ?? firing.outcomeReason : "—"}</td>
          <td>{firing.templateIndex !== undefined ? `#${firing.templateIndex + 1}` : "—"} {firing.renderedTextSha256 ? <code>{firing.renderedTextSha256.slice(0, 12)}</code> : null}</td>
        </tr>)}</tbody>
      </table> : <div className={styles.empty}>{runId ? "该场次暂无触发记录。" : "选择场次后查看触发记录。"}</div>}
    </section>
  </main>;
}

function describe(payload: ApiError | null) {
  if (!payload) return "请求失败";
  if (payload.failures?.length) return `模板未通过策略检查：${payload.failures.map((failure) => `第 ${failure.index + 1} 条（${failure.reasons.join("、") || failure.decision}）`).join("；")}`;
  const base = payload.error ? errorText[payload.error] ?? payload.error : "请求失败";
  return payload.detail ? `${base}：${payload.detail}` : base;
}

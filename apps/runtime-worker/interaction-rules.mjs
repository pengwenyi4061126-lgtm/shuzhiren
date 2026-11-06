// Live interaction rules (migration 084). The runtime worker already owns the long-running loops (scheduled
// starts, telemetry watchdog, outbox delivery) and is the only service that queues runtime commands without a
// human request, so the rule evaluator runs here too. Each pass looks at LIVE runs that have approved, enabled
// rules, answers recent channel interactions (viewer_enter, follow, gift, keyword comments) and fills due timer
// slots (timed, idle_comment). A line is spoken only through a speech.dispatch outbox event bound to the run's
// frozen voice and frozen product version, the same payload the console's grounded speech queues, or it becomes a
// channel reply draft that still needs human submission and approval.
//
// Every rendered line passes the policy engine with the run's bound policy profile rules. Rate limits: one
// automatic line per run per pass, a minimum interval after any speech.dispatch of the run, no automatic speech
// while a speech or media command or a program transition is pending, a cooldown per rule and per viewer.
// Every decision on a matched trigger is recorded once in interaction_rule_firings; the unique keys of that table
// keep evaluation idempotent when several workers run.
import { createHash, randomUUID } from "node:crypto";
import { evaluatePolicy, normalizePolicyText, parsePolicyRules } from "../console/lib/shared/policy-engine.mjs";

export const TRIGGER_TYPES = Object.freeze(["viewer_enter", "follow", "gift", "keyword", "timed", "idle_comment"]);
export const TIMER_TRIGGERS = Object.freeze(["timed", "idle_comment"]);
export const RULE_ACTIONS = Object.freeze(["speak", "reply_draft"]);
export const TEMPLATE_SLOTS = Object.freeze(["nickname", "product_name", "price"]);
export const NEUTRAL_NICKNAME = "这位朋友";
export const MAX_TEMPLATE_LENGTH = 200;
export const MAX_SPEECH_TEXT_LENGTH = 800;
export const MAX_REPLY_TEXT_LENGTH = 1000;
const SUCCESS_OUTCOMES = ["speech_queued", "reply_drafted"];
const INTERACTION_TRIGGER = { viewer_enter: "viewer_enter", follow: "follow", gift: "gift", comment: "keyword" };
const CONTACT_OR_LINK = /https?|www\.|\.com|\.cn|\.net|微信|weixin|v信|vx|wx|qq|加我|私聊|私信|电话|手机|\d{5,}/i;
const IMPERSONATION = /官方|客服|管理员|平台|主播|抖音|系统/;
const CONTROLLED_EVIDENCE_REF = /^(?:evidence:\/\/[A-Za-z0-9][A-Za-z0-9._/-]{0,255}|urn:[A-Za-z0-9][A-Za-z0-9:._/-]{0,255})$/;

/** Reads the evaluator settings from the environment; an invalid value stops the worker at startup. */
export function interactionRuleConfig(env = process.env) {
  const bounded = (name, minimum, maximum, fallback) => {
    const value = env[name];
    if (value === undefined || value === "") return fallback;
    const parsed = Number.parseInt(value, 10);
    if (!/^\d+$/.test(value) || !Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
    return parsed;
  };
  const enabled = env.INTERACTION_RULES_ENABLED ?? "true";
  if (enabled !== "true" && enabled !== "false") throw new Error("INTERACTION_RULES_ENABLED must be true or false");
  return {
    enabled: enabled === "true",
    pollMs: bounded("INTERACTION_RULE_POLL_MS", 500, 60_000, 2_000),
    minSpeechIntervalSeconds: bounded("INTERACTION_RULE_MIN_SPEECH_INTERVAL_SECONDS", 5, 3_600, 30),
    viewerCooldownSeconds: bounded("INTERACTION_RULE_VIEWER_COOLDOWN_SECONDS", 0, 86_400, 600),
    maxEventAgeSeconds: bounded("INTERACTION_RULE_MAX_EVENT_AGE_SECONDS", 5, 3_600, 60),
    batchSize: bounded("INTERACTION_RULE_BATCH_SIZE", 1, 200, 20),
    nicknameMaxLength: bounded("INTERACTION_RULE_NICKNAME_MAX_LENGTH", 2, 32, 12)
  };
}

export function normalizeMatchText(text) {
  return typeof text === "string" ? normalizePolicyText(text) : "";
}

/** A rule row as read from interaction_rules, or null when a stored value is outside what the console accepts. */
export function parseRule(row) {
  if (!row || !TRIGGER_TYPES.includes(row.trigger_type) || !RULE_ACTIONS.includes(row.action)) return null;
  const templates = Array.isArray(row.templates) ? row.templates : null;
  if (!templates || templates.length < 1 || templates.length > 10 || !templates.every(isValidTemplate)) return null;
  const match = row.match_config && typeof row.match_config === "object" && !Array.isArray(row.match_config) ? row.match_config : {};
  const keywords = Array.isArray(match.keywords) ? match.keywords.filter((keyword) => typeof keyword === "string" && normalizeMatchText(keyword).length > 0).map(normalizeMatchText) : [];
  if (row.trigger_type === "keyword" && keywords.length === 0) return null;
  const minGiftValueCents = Number.isSafeInteger(match.minGiftValueCents) && match.minGiftValueCents >= 0 ? match.minGiftValueCents : 0;
  if (TIMER_TRIGGERS.includes(row.trigger_type) && !(Number.isInteger(row.interval_seconds) && row.interval_seconds >= 60)) return null;
  if (row.action === "reply_draft" && TIMER_TRIGGERS.includes(row.trigger_type)) return null;
  return {
    id: row.id,
    name: row.name,
    triggerType: row.trigger_type,
    action: row.action,
    templates,
    keywords,
    minGiftValueCents,
    cooldownSeconds: Number.isInteger(row.cooldown_seconds) && row.cooldown_seconds >= 0 ? row.cooldown_seconds : 60,
    intervalSeconds: row.interval_seconds ?? null,
    priority: Number.isInteger(row.priority) ? row.priority : 100,
    defaultKey: row.default_key ?? null
  };
}

/** A template is 1 to 200 characters and uses no braces other than the three slots. */
export function isValidTemplate(template) {
  if (typeof template !== "string") return false;
  const trimmed = template.trim();
  if (!trimmed || template.length > MAX_TEMPLATE_LENGTH) return false;
  return !/[{}]/.test(trimmed.replace(/\{(nickname|product_name|price)\}/g, ""));
}

export function templateSlots(template) {
  return new Set([...String(template).matchAll(/\{(nickname|product_name|price)\}/g)].map((match) => match[1]));
}

/** Whether a rule answers this interaction (kind, keywords, gift value, the interaction's own policy decision). */
export function ruleMatchesInteraction(rule, interaction) {
  if (INTERACTION_TRIGGER[interaction.interaction_kind] !== rule.triggerType) return false;
  if (rule.triggerType === "gift") return Number(interaction.gift_value_cents ?? -1) >= rule.minGiftValueCents;
  if (rule.triggerType === "keyword") {
    // A comment the policy engine sent to a human or refused is never answered automatically.
    if (interaction.policy_action !== "answer") return false;
    const text = normalizeMatchText(interaction.question_text);
    return rule.keywords.some((keyword) => text.includes(keyword));
  }
  return true;
}

/**
 * Cleans a platform nickname for speech. Control, format and private-use characters, combining marks, symbols and
 * pictographs and brace or markup characters are removed, whitespace is collapsed and the result is cut to
 * `maxLength` characters. A nickname that is empty afterwards, carries a link or contact detail, impersonates the
 * host or platform, or matches any policy rule is replaced by a neutral form of address.
 */
export function sanitizeNickname(raw, policyRules = [], maxLength = 12) {
  const neutral = (reason) => ({ nickname: NEUTRAL_NICKNAME, neutral: true, reason });
  if (typeof raw !== "string") return neutral("missing");
  const cleaned = raw.normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}\p{M}\p{So}\p{Sk}\p{Extended_Pictographic}]/gu, "")
    .replace(/[{}<>[\]\\`$@#|^~*_=+"']/g, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (!cleaned) return neutral("empty");
  const normalized = normalizePolicyText(cleaned);
  if (CONTACT_OR_LINK.test(normalized)) return neutral("contact_or_link");
  if (IMPERSONATION.test(normalized)) return neutral("impersonation");
  const decision = evaluatePolicy(cleaned, ["product_version"], policyRules);
  if (decision.action !== "answer" || decision.reasons.length > 0) return neutral("policy");
  const nickname = Array.from(cleaned).slice(0, maxLength).join("").trim();
  return nickname ? { nickname, neutral: false } : neutral("empty");
}

export function formatPrice(priceCent) {
  return Number.isSafeInteger(priceCent) && priceCent >= 0 ? (priceCent / 100).toFixed(2) : null;
}

/** Replaces the slots in one pass, so a slot value is never expanded again. Missing values are reported. */
export function renderTemplate(template, slots) {
  const missing = new Set();
  const text = String(template).replace(/\{(nickname|product_name|price)\}/g, (match, name) => {
    const value = slots[name];
    if (typeof value !== "string" || !value) { missing.add(name); return match; }
    return value;
  });
  return { text: text.replace(/\s+/g, " ").trim(), missing: [...missing] };
}

/** Picks a template at random, never the one used last for this rule in this run when there is another. */
export function chooseTemplateIndex(count, lastIndex, random = Math.random) {
  if (count <= 1) return 0;
  const choices = [...Array(count).keys()].filter((index) => index !== lastIndex);
  const pick = Math.floor(Math.min(0.999999999, Math.max(0, random())) * choices.length);
  return choices[pick];
}

export function timerSlot(nowEpochSeconds, intervalSeconds) { return Math.floor(nowEpochSeconds / intervalSeconds); }
export function cooldownBucket(nowEpochSeconds, cooldownSeconds) { return cooldownSeconds > 0 ? Math.floor(nowEpochSeconds / cooldownSeconds) : null; }
/** Timers also wait half an interval after their last line, so a late slot is not followed at once by the next. */
export function effectiveCooldownSeconds(rule) { return TIMER_TRIGGERS.includes(rule.triggerType) ? Math.max(rule.cooldownSeconds, Math.floor(rule.intervalSeconds / 2)) : rule.cooldownSeconds; }

/** Why automatic speech must wait now, or null. Mirrors the run's program and speech priority: commands first. */
export function speechGateReason({ run, pendingSpeech, pendingMedia, lastSpeechAgeSeconds, minSpeechIntervalSeconds, spokenThisPass }) {
  if (spokenThisPass) return "speech_budget_used";
  if (run.pending_program_transition_event_id || run.pending_media_event_id || run.scheduled_start_event_id) return "program_transition_pending";
  if (pendingMedia) return "media_command_pending";
  if (pendingSpeech) return "speech_pending";
  if (lastSpeechAgeSeconds !== null && lastSpeechAgeSeconds !== undefined && lastSpeechAgeSeconds < minSpeechIntervalSeconds) return "global_speech_interval";
  return null;
}

/** Same rule as apps/console/lib/catalog.ts isProductFactsCurrent, on the fields interaction_rule_product_context returns. */
export function isProductContextCurrent(product, nowMs = Date.now()) {
  if (!product || typeof product.source_ref !== "string" || !product.source_ref.trim()) return false;
  const syncedAt = Date.parse(product.source_synced_at ?? "");
  const validFrom = Date.parse(product.valid_from ?? "");
  if (!Number.isFinite(syncedAt) || !Number.isFinite(validFrom)) return false;
  if (syncedAt > nowMs + 5 * 60_000 || nowMs - syncedAt > 24 * 60 * 60_000) return false;
  if (validFrom > nowMs) return false;
  if (product.valid_until === null || product.valid_until === undefined) return true;
  const validUntil = Date.parse(product.valid_until);
  return Number.isFinite(validUntil) && validUntil > nowMs;
}

/** Policy check of the final line: only an "answer" decision with the product version as evidence may be said. */
export function checkRenderedText(text, policyRules, maxLength) {
  if (!text || text.length > maxLength) return { allowed: false, reasons: ["渲染文本为空或超过长度限制"] };
  const decision = evaluatePolicy(text, ["product_version"], policyRules);
  return decision.action === "answer" ? { allowed: true, decision } : { allowed: false, decision, reasons: decision.reasons };
}

export function speechCommandId(firingId) { return `rule_${firingId.replaceAll("-", "")}`; }
export function sha256Hex(value) { return createHash("sha256").update(value).digest("hex"); }
function isControlledEvidenceRef(value) { return typeof value === "string" && value.length > 0 && value.length <= 300 && CONTROLLED_EVIDENCE_REF.test(value); }
function voiceIdValid(value) { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value); }
function voiceChecksumValid(value) { return typeof value === "string" && /^sha256:[0-9a-f]{64}$/i.test(value); }
function reason(text) { return String(text).replace(/[\r\n\t]+/g, " ").slice(0, 300); }

/**
 * @param {{ tenantIds: () => Promise<string[]>, inTenantTransaction: (tenantId: string, operation: (client) => Promise<any>) => Promise<any>,
 *   log?: (event: string, fields?: object) => void, config: ReturnType<typeof interactionRuleConfig>, maxOutboxAttempts: number, random?: () => number }} options
 */
export function createInteractionRuleEvaluator({ tenantIds, inTenantTransaction, log = () => {}, config, maxOutboxAttempts, random = Math.random }) {
  async function runOnce() {
    const summary = { runs: 0, speechQueued: 0, replyDrafted: 0, recorded: 0 };
    for (const tenantId of await tenantIds()) {
      const runIds = await inTenantTransaction(tenantId, async (client) => (await client.query(`select r.id from live_runs r
        where r.state = 'LIVE' and r.runtime_session_id is not null
          and exists (select 1 from interaction_rules rule where rule.enabled and rule.approval_status = 'approved' and (rule.live_run_id is null or rule.live_run_id = r.id))
        order by r.id limit 100`)).rows.map((row) => row.id));
      for (const runId of runIds) {
        try {
          const result = await inTenantTransaction(tenantId, (client) => evaluateRun(client, tenantId, runId));
          if (!result) continue;
          summary.runs += 1;
          summary.speechQueued += result.speechQueued;
          summary.replyDrafted += result.replyDrafted;
          summary.recorded += result.recorded;
        } catch (error) {
          log("interaction_rules.run_failed", { tenantId, runId, error: error instanceof Error ? error.message : "unknown" });
        }
      }
    }
    return summary;
  }

  async function evaluateRun(client, tenantId, runId) {
    // The row lock serializes evaluation of one run across workers, so the cooldown and interval reads below see
    // every earlier firing. A run another transaction holds is skipped for this pass.
    const run = (await client.query(`select id, tenant_id, show_revision_id, trace_id, runtime_session_id, pending_program_transition_event_id, pending_media_event_id, scheduled_start_event_id,
        extract(epoch from now())::float8 as now_epoch
      from live_runs where id = $1 and state = 'LIVE' and runtime_session_id is not null for no key update skip locked`, [runId])).rows[0];
    if (!run) return null;
    const rules = (await client.query(`select id, name, trigger_type, match_config, templates, action, cooldown_seconds, interval_seconds, priority, default_key
      from interaction_rules where enabled and approval_status = 'approved' and (live_run_id is null or live_run_id = $1)
      order by priority desc, id`, [runId])).rows.map((row) => {
      const rule = parseRule(row);
      if (!rule) log("interaction_rules.rule_invalid", { tenantId, ruleId: row.id });
      return rule;
    }).filter(Boolean);
    const result = { speechQueued: 0, replyDrafted: 0, recorded: 0 };
    if (!rules.length) return result;
    const nowEpoch = Number(run.now_epoch);
    const context = runContext(client, tenantId, run);
    const state = { spokenThisPass: false };

    const interactions = (await client.query(`select id, interaction_kind, question_text, policy_action, viewer_ref, viewer_nickname, gift_value_cents, channel_connection_id
      from live_interactions
      where live_run_id = $1 and rules_evaluated_at is null and created_at >= now() - make_interval(secs => $2)
      order by created_at, id limit $3 for no key update skip locked`, [runId, config.maxEventAgeSeconds, config.batchSize])).rows;

    // Timers first when they outrank the interactions: the AI identity disclosure (priority 1000) must not wait
    // behind a stream of welcomes.
    const candidates = [];
    for (const rule of rules.filter((candidate) => TIMER_TRIGGERS.includes(candidate.triggerType))) {
      const slot = timerSlot(nowEpoch, rule.intervalSeconds);
      candidates.push({ kind: "timer", rule, triggerKey: `${rule.triggerType === "timed" ? "slot" : "idle"}:${slot}`, priority: rule.priority, order: 0 });
    }
    interactions.forEach((interaction, index) => {
      const matching = rules.filter((rule) => !TIMER_TRIGGERS.includes(rule.triggerType) && ruleMatchesInteraction(rule, interaction));
      if (matching.length) candidates.push({ kind: "interaction", interaction, matching, triggerKey: `interaction:${interaction.id}`, priority: matching[0].priority, order: index + 1 });
    });
    candidates.sort((left, right) => right.priority - left.priority || left.order - right.order);

    for (const candidate of candidates) {
      const outcome = candidate.kind === "timer"
        ? await evaluateTimer(client, run, candidate, context, state, nowEpoch)
        : await evaluateInteraction(client, run, candidate, context, state, nowEpoch);
      if (!outcome) continue;
      result.recorded += 1;
      if (outcome === "speech_queued") result.speechQueued += 1;
      if (outcome === "reply_drafted") result.replyDrafted += 1;
    }
    if (interactions.length) await client.query("update live_interactions set rules_evaluated_at = now() where id = any($1::uuid[]) and rules_evaluated_at is null", [interactions.map((interaction) => interaction.id)]);
    return result;
  }

  async function evaluateTimer(client, run, candidate, context, state, nowEpoch) {
    const { rule, triggerKey } = candidate;
    const existing = await client.query("select 1 from interaction_rule_firings where live_run_id = $1 and rule_id = $2 and trigger_key = $3", [run.id, rule.id, triggerKey]);
    if (existing.rows[0]) return null;
    const last = await lastSuccess(client, run.id, rule.id);
    if (last && last.age_seconds < effectiveCooldownSeconds(rule)) return null;
    if (rule.triggerType === "idle_comment") {
      const recentComment = await client.query("select 1 from live_interactions where live_run_id = $1 and interaction_kind = 'comment' and created_at > now() - make_interval(secs => $2) limit 1", [run.id, rule.intervalSeconds]);
      if (recentComment.rows[0]) return null;
    }
    // A timer waits for the speech gate inside its slot instead of recording a suppression.
    if (await speechGate(client, run, state)) return null;
    return speakOrDraft(client, run, { rule, triggerKey, interaction: null, last, nickname: null }, context, state, nowEpoch);
  }

  async function evaluateInteraction(client, run, candidate, context, state, nowEpoch) {
    const { interaction, triggerKey } = candidate;
    const recordSuppressed = (rule, why) => recordFiring(client, run, { rule, triggerKey, interaction, outcome: "suppressed", outcomeReason: why });
    // The first matching rule (by priority) outside its cooldown answers; when all are cooling down the
    // suppression is recorded on the highest-priority rule.
    let chosen = null;
    let chosenLast = null;
    for (const rule of candidate.matching) {
      const last = await lastSuccess(client, run.id, rule.id);
      if (!last || last.age_seconds >= effectiveCooldownSeconds(rule)) { chosen = rule; chosenLast = last; break; }
    }
    if (!chosen) return recordSuppressed(candidate.matching[0], "rule_cooldown");
    if (interaction.viewer_ref && config.viewerCooldownSeconds > 0) {
      const recent = await client.query(`select 1 from interaction_rule_firings where live_run_id = $1 and viewer_ref = $2 and outcome = any($3::text[])
        and created_at > now() - make_interval(secs => $4) limit 1`, [run.id, interaction.viewer_ref, SUCCESS_OUTCOMES, config.viewerCooldownSeconds]);
      if (recent.rows[0]) return recordSuppressed(chosen, "viewer_cooldown");
    }
    if (chosen.action === "speak") {
      const gate = await speechGate(client, run, state);
      if (gate) return recordSuppressed(chosen, gate);
    } else if (!interaction.channel_connection_id) {
      return recordSuppressed(chosen, "no_reply_channel");
    }
    const policy = await context.policy();
    const nickname = sanitizeNickname(interaction.viewer_nickname, policy.active ? policy.rules : [], config.nicknameMaxLength);
    return speakOrDraft(client, run, { rule: chosen, triggerKey, interaction, last: chosenLast, nickname }, context, state, nowEpoch);
  }

  async function speakOrDraft(client, run, firing, context, state, nowEpoch) {
    const { rule, interaction } = firing;
    const policy = await context.policy();
    if (!policy.active) return recordFiring(client, run, { ...firing, outcome: "unavailable", outcomeReason: "policy_profile_inactive" });
    const product = await context.product();
    const templateIndex = chooseTemplateIndex(rule.templates.length, firing.last?.template_index ?? null, random);
    const template = rule.templates[templateIndex];
    const slots = templateSlots(template);
    const needsProduct = rule.action === "speak" || slots.has("product_name") || slots.has("price");
    if (needsProduct && !product) return recordFiring(client, run, { ...firing, outcome: "unavailable", outcomeReason: "product_unavailable" });
    const voice = rule.action === "speak" ? await context.voice() : null;
    if (rule.action === "speak" && !voice) return recordFiring(client, run, { ...firing, outcome: "unavailable", outcomeReason: "voice_unavailable" });
    const rendered = renderTemplate(template, {
      nickname: firing.nickname?.nickname ?? NEUTRAL_NICKNAME,
      product_name: product?.product_name ?? undefined,
      price: product ? formatPrice(Number(product.price_cent)) ?? undefined : undefined
    });
    if (rendered.missing.length) return recordFiring(client, run, { ...firing, outcome: "unavailable", outcomeReason: `missing_slot:${rendered.missing.join(",")}`, templateIndex });
    const maxLength = rule.action === "speak" ? MAX_SPEECH_TEXT_LENGTH : MAX_REPLY_TEXT_LENGTH;
    const textSha256 = sha256Hex(rendered.text);
    const check = checkRenderedText(rendered.text, policy.rules, maxLength);
    if (!check.allowed) return recordFiring(client, run, { ...firing, outcome: "policy_blocked", outcomeReason: `policy:${(check.reasons ?? []).join(";") || "blocked"}`, templateIndex, textSha256, product });
    const firingId = randomUUID();
    const bucket = cooldownBucket(nowEpoch, effectiveCooldownSeconds(rule));
    if (rule.action === "speak") {
      // The same command shape as createSpeechCommand in apps/console/lib/speech-protocol.ts.
      const command = { id: speechCommandId(firingId), runId: run.id, issuedAt: new Date().toISOString(), traceId: run.trace_id, text: rendered.text, voice: voice.runtime_voice_id, voiceChecksum: voice.checksum, interrupt: false, productVersionId: product.product_version_id, productRevision: Number(product.product_revision) };
      const event = await client.query("insert into outbox_events (tenant_id, event_type, aggregate_type, aggregate_id, payload) values ($1, 'speech.dispatch', 'live_run', $2, $3::jsonb) returning id", [run.tenant_id, run.id, JSON.stringify({ sessionId: run.runtime_session_id, command })]);
      const outboxEventId = event.rows[0].id;
      await insertFiring(client, run, { ...firing, id: firingId, outcome: "speech_queued", templateIndex, textSha256, cooldownBucket: bucket, outboxEventId, product });
      state.spokenThisPass = true;
      await audit(client, run, "interaction_rule.speech_queued", firingId, { runId: run.id, ruleId: rule.id, triggerKey: firing.triggerKey, outboxEventId, speechCommandId: command.id, textSha256, templateIndex, productVersionId: product.product_version_id, neutralNickname: firing.nickname?.neutral ?? null });
      log("interaction_rules.speech_queued", { tenantId: run.tenant_id, runId: run.id, ruleId: rule.id, triggerKey: firing.triggerKey, outboxEventId });
      return "speech_queued";
    }
    const actor = (await client.query("select runtime_worker_actor($1::uuid, 'runtime-worker') as id", [run.tenant_id])).rows[0].id;
    const evidenceSnapshot = [{ type: "interaction_rule", ruleId: rule.id, templateIndex }, ...(product ? [{ type: "product_version", id: product.product_version_id, revision: Number(product.product_revision) }] : [])];
    const draft = await client.query(`insert into channel_reply_drafts (tenant_id, live_run_id, interaction_id, channel_connection_id, body, body_sha256, policy_action, evidence_snapshot, product_version_id, product_revision, created_by)
      values ($1, $2, $3, $4, $5, $6, 'answer', $7::jsonb, $8::uuid, $9, $10) on conflict (interaction_id) do nothing returning id`,
    [run.tenant_id, run.id, interaction.id, interaction.channel_connection_id, rendered.text, textSha256, JSON.stringify(evidenceSnapshot), product?.product_version_id ?? null, product ? Number(product.product_revision) : null, actor]);
    if (!draft.rows[0]) return recordFiring(client, run, { ...firing, outcome: "suppressed", outcomeReason: "reply_draft_exists" });
    await insertFiring(client, run, { ...firing, id: firingId, outcome: "reply_drafted", templateIndex, textSha256, cooldownBucket: bucket, product });
    await audit(client, run, "channel_reply.draft_created", draft.rows[0].id, { runId: run.id, interactionId: interaction.id, channelConnectionId: interaction.channel_connection_id, bodySha256: textSha256, policyAction: "answer", ruleId: rule.id, firingId }, "channel_reply_draft");
    log("interaction_rules.reply_drafted", { tenantId: run.tenant_id, runId: run.id, ruleId: rule.id, triggerKey: firing.triggerKey, replyDraftId: draft.rows[0].id });
    return "reply_drafted";
  }

  async function speechGate(client, run, state) {
    if (state.spokenThisPass) return "speech_budget_used";
    state.gate ??= (async () => {
      const row = (await client.query(`select
          exists (select 1 from outbox_events where event_type = 'speech.dispatch' and aggregate_id = $1
            and (state in ('pending', 'delivering') or (state = 'failed' and attempts < $2 and outcome_uncertain_at is null))) as pending_speech,
          exists (select 1 from outbox_events where event_type = 'media.dispatch' and aggregate_id = $1
            and (state in ('pending', 'delivering') or (state = 'failed' and attempts < $2 and outcome_uncertain_at is null))) as pending_media,
          (select extract(epoch from now() - max(created_at))::float8 from outbox_events
            where event_type = 'speech.dispatch' and aggregate_id = $1 and created_at > now() - make_interval(secs => $3)) as last_speech_age_seconds`,
      [run.id, maxOutboxAttempts, config.minSpeechIntervalSeconds])).rows[0];
      return { pendingSpeech: row.pending_speech, pendingMedia: row.pending_media, lastSpeechAgeSeconds: row.last_speech_age_seconds === null ? null : Number(row.last_speech_age_seconds) };
    })();
    const gate = await state.gate;
    return speechGateReason({ run, ...gate, minSpeechIntervalSeconds: config.minSpeechIntervalSeconds, spokenThisPass: state.spokenThisPass });
  }

  async function lastSuccess(client, runId, ruleId) {
    const row = (await client.query(`select template_index, extract(epoch from now() - created_at)::float8 as age_seconds from interaction_rule_firings
      where live_run_id = $1 and rule_id = $2 and outcome = any($3::text[]) order by created_at desc limit 1`, [runId, ruleId, SUCCESS_OUTCOMES])).rows[0];
    return row ? { template_index: row.template_index, age_seconds: Number(row.age_seconds) } : null;
  }

  /** Records a terminal decision that queued nothing. A concurrent identical record wins; nothing is overwritten. */
  async function recordFiring(client, run, firing) {
    const id = randomUUID();
    const inserted = await client.query(`insert into interaction_rule_firings (id, tenant_id, rule_id, live_run_id, interaction_id, trigger_key, viewer_ref, template_index, rendered_text_sha256, outcome, outcome_reason, product_version_id, product_revision)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      on conflict (tenant_id, live_run_id, rule_id, trigger_key) do nothing returning id`,
    [id, run.tenant_id, firing.rule.id, run.id, firing.interaction?.id ?? null, firing.triggerKey, firing.interaction?.viewer_ref ?? null, firing.templateIndex ?? null, firing.textSha256 ?? null, firing.outcome, firing.outcomeReason ? reason(firing.outcomeReason) : null, firing.product?.product_version_id ?? null, firing.product ? Number(firing.product.product_revision) : null]);
    if (!inserted.rows[0]) return null;
    log("interaction_rules.recorded", { tenantId: run.tenant_id, runId: run.id, ruleId: firing.rule.id, triggerKey: firing.triggerKey, outcome: firing.outcome, reason: firing.outcomeReason ?? null });
    if (firing.outcome === "policy_blocked") await audit(client, run, "interaction_rule.policy_blocked", id, { runId: run.id, ruleId: firing.rule.id, triggerKey: firing.triggerKey, textSha256: firing.textSha256 ?? null, reason: firing.outcomeReason ?? null });
    return firing.outcome;
  }

  /** Records a firing that queued speech or a draft; a conflict rolls back the whole transaction with the command. */
  async function insertFiring(client, run, firing) {
    await client.query(`insert into interaction_rule_firings (id, tenant_id, rule_id, live_run_id, interaction_id, trigger_key, viewer_ref, template_index, rendered_text_sha256, outcome, cooldown_bucket, outbox_event_id, product_version_id, product_revision)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [firing.id, run.tenant_id, firing.rule.id, run.id, firing.interaction?.id ?? null, firing.triggerKey, firing.interaction?.viewer_ref ?? null, firing.templateIndex, firing.textSha256, firing.outcome, firing.cooldownBucket, firing.outboxEventId ?? null, firing.product?.product_version_id ?? null, firing.product ? Number(firing.product.product_revision) : null]);
  }

  async function audit(client, run, eventType, resourceId, detail, resourceType = "interaction_rule_firing") {
    const actor = (await client.query("select runtime_worker_actor($1::uuid, 'runtime-worker') as id", [run.tenant_id])).rows[0].id;
    await client.query(`insert into audit_events (tenant_id, actor_id, event_type, resource_type, resource_id, resource_key, detail)
      values ($1, $2, $3, $4, $5::uuid, $5, $6::jsonb)`, [run.tenant_id, actor, eventType, resourceType, resourceId, JSON.stringify(detail)]);
  }

  function runContext(client, tenantId, run) {
    const memo = (load) => { let value; return () => (value ??= load()); };
    return {
      policy: memo(async () => {
        const profile = (await client.query(`select profile.rules, profile.evidence_ref, profile.validation_summary, profile.approval_status
          from show_revision_policy_profiles binding join policy_profiles profile on profile.id = binding.policy_profile_id
          where binding.show_revision_id = $1`, [run.show_revision_id])).rows[0];
        const active = Boolean(profile && profile.approval_status === "approved" && isControlledEvidenceRef(profile.evidence_ref) && String(profile.validation_summary ?? "").trim());
        const rules = active ? parsePolicyRules(profile.rules) : [];
        return { active, rules };
      }),
      product: memo(async () => {
        const product = (await client.query("select * from interaction_rule_product_context($1::uuid, $2::uuid)", [tenantId, run.id])).rows[0];
        if (!product || !product.product_name || formatPrice(Number(product.price_cent)) === null || !isProductContextCurrent(product)) return null;
        return product;
      }),
      voice: memo(async () => {
        // The query of scheduleDueRun in index.mjs: the revision's frozen approved voice and its checksum.
        const rows = (await client.query(`select asset.runtime_voice_id, asset.checksum
        from show_revision_media_assets binding join media_assets asset on asset.id = binding.media_asset_id
        where binding.tenant_id = $1 and binding.show_revision_id = $2 and binding.kind = 'voice'
          and asset.approval_status = 'approved' and (asset.expires_at is null or asset.expires_at >= current_date)`, [tenantId, run.show_revision_id])).rows;
        const voice = rows.length === 1 ? rows[0] : null;
        return voice && voiceIdValid(voice.runtime_voice_id) && voiceChecksumValid(voice.checksum) ? voice : null;
      })
    };
  }

  return { runOnce, evaluateRun };
}

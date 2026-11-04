import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { recordAuditEvent, recordAuditEventInTransaction } from "@/lib/audit";
import { getChannelConnection } from "@/lib/channels";
import type { RequestContext } from "@/lib/control-plane/auth-context";
import { assertLiveRunAccess } from "@/lib/control-plane/run-access";
import { databasePool, withTenantTransaction } from "@/lib/database";
import { listInteractions, type LiveInteraction } from "@/lib/interactions";

export type ChannelReplyStatus = "draft" | "pending_approval" | "approved" | "sending" | "sent" | "failed" | "rejected";
export type ChannelReplyDraft = {
  id: string; tenantId: string; runId: string; interactionId: string; channelConnectionId: string;
  body: string; bodySha256: string; status: ChannelReplyStatus; policyAction: LiveInteraction["decision"];
  evidenceSnapshot: unknown[]; productVersionId?: string; productRevision?: number; createdBy: string; editedBy?: string;
  submittedAt?: string; approvedBy?: string; approvedAt?: string; rejectedBy?: string; rejectedAt?: string;
  rejectionReason?: string; sentAt?: string; providerMessageId?: string; outboxEventId?: string; failureReason?: string;
  createdAt: string; updatedAt: string;
};
type PersistentReplyRow = {
  id: string; tenant_id: string; live_run_id: string; interaction_id: string; channel_connection_id: string;
  body: string; body_sha256: string; status: ChannelReplyStatus; policy_action: LiveInteraction["decision"]; evidence_snapshot: unknown;
  product_version_id: string | null; product_revision: number | null; created_by_subject: string; edited_by_subject: string | null;
  submitted_at: Date | string | null; approved_by_subject: string | null; approved_at: Date | string | null;
  rejected_by_subject: string | null; rejected_at: Date | string | null; rejection_reason: string | null;
  sent_at: Date | string | null; provider_message_id: string | null; outbox_event_id: string | null; failure_reason: string | null;
  created_at: Date | string; updated_at: Date | string;
};
type ReplyStore = { drafts: Map<string, ChannelReplyDraft> };
type DraftInput = { body: string; channelConnectionId?: string };
declare global { var shuzhirenChannelReplyStore: ReplyStore | undefined; }
function replyStore() { globalThis.shuzhirenChannelReplyStore ??= { drafts: new Map() }; return globalThis.shuzhirenChannelReplyStore; }

export async function listChannelReplyDrafts(context: RequestContext, runId: string) {
  await assertLiveRunAccess(context, runId);
  if (!databasePool()) return [...replyStore().drafts.values()].filter((item) => item.tenantId === context.tenantId && item.runId === runId).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return withTenantTransaction(context.tenantId, async (client) => {
    const result = await client.query<PersistentReplyRow>(`${replySelect()} where draft.live_run_id = $1 order by draft.created_at desc`, [runId]);
    return result.rows.map(persistentReply);
  });
}

function replySelect() { return `select ${replyReturning()} from channel_reply_drafts draft`; }
function replyReturning() { return `draft.id, draft.tenant_id, draft.live_run_id, draft.interaction_id, draft.channel_connection_id, draft.body, draft.body_sha256, draft.status, draft.policy_action, draft.evidence_snapshot, draft.product_version_id, draft.product_revision, draft.created_by::text as created_by_subject, draft.edited_by::text as edited_by_subject, draft.submitted_at, draft.approved_by::text as approved_by_subject, draft.approved_at, draft.rejected_by::text as rejected_by_subject, draft.rejected_at, draft.rejection_reason, draft.sent_at, draft.provider_message_id, draft.outbox_event_id, draft.failure_reason, draft.created_at, draft.updated_at`; }
function persistentReply(row: PersistentReplyRow): ChannelReplyDraft { return { id: row.id, tenantId: row.tenant_id, runId: row.live_run_id, interactionId: row.interaction_id, channelConnectionId: row.channel_connection_id, body: row.body, bodySha256: row.body_sha256, status: row.status, policyAction: row.policy_action, evidenceSnapshot: asArray(row.evidence_snapshot), productVersionId: row.product_version_id ?? undefined, productRevision: row.product_revision ?? undefined, createdBy: row.created_by_subject, editedBy: row.edited_by_subject ?? undefined, submittedAt: at(row.submitted_at), approvedBy: row.approved_by_subject ?? undefined, approvedAt: at(row.approved_at), rejectedBy: row.rejected_by_subject ?? undefined, rejectedAt: at(row.rejected_at), rejectionReason: row.rejection_reason ?? undefined, sentAt: at(row.sent_at), providerMessageId: row.provider_message_id ?? undefined, outboxEventId: row.outbox_event_id ?? undefined, failureReason: row.failure_reason ?? undefined, createdAt: at(row.created_at)!, updatedAt: at(row.updated_at)! }; }
function sha256(value: string) { return createHash("sha256").update(value).digest("hex"); }
function at(value: Date | string | null) { return value ? new Date(value).toISOString() : undefined; }
function asArray(value: unknown) { if (Array.isArray(value)) return value; if (typeof value === "string") { try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; } } return []; }
function jsonStringArray(value: unknown) { return asArray(value).filter((item): item is string => typeof item === "string"); }
function normalizedBody(value: string) { const body = value.trim(); if (!body || body.length > 1000) throw new Response("Channel reply body must be between 1 and 1000 characters", { status: 400 }); return body; }
function normalizedRejectionReason(value: string) { const reason = value.trim(); if (!reason || reason.length > 1000) throw new Response("Rejection reason must be between 1 and 1000 characters", { status: 400 }); return reason; }

export async function createChannelReplyDraft(context: RequestContext, runId: string, interactionId: string, input: DraftInput) {
  await assertLiveRunAccess(context, runId);
  const body = normalizedBody(input.body);
  if (!databasePool()) return createDemoDraft(context, runId, interactionId, { ...input, body });
  return withTenantTransaction(context.tenantId, async (client) => {
    const interaction = await lockedInteraction(client, runId, interactionId);
    const channelConnectionId = input.channelConnectionId ?? interaction.channel_connection_id ?? undefined;
    const channel = await assertReplyChannel(client, channelConnectionId, interaction.channel_connection_id ?? undefined);
    const product = await productEvidence(client, runId);
    const actorId = await actorDatabaseId(client, context);
    const evidenceSnapshot = [{ type: "interaction_evidence", ids: jsonStringArray(interaction.evidence_ids) }, ...(product.id ? [{ type: "product_version", id: product.id, revision: product.revision }] : [])];
    const inserted = await client.query<{ id: string }>(
      `insert into channel_reply_drafts (tenant_id, live_run_id, interaction_id, channel_connection_id, body, body_sha256, policy_action, evidence_snapshot, product_version_id, product_revision, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::uuid, $10, $11::uuid) returning id`,
      [context.tenantId, runId, interactionId, channel.id, body, sha256(body), interaction.policy_action, JSON.stringify(evidenceSnapshot), product.id, product.revision, actorId]
    );
    if (!inserted.rows[0]) throw new Error("Channel reply draft was not created");
    const draft = await replyForUpdate(client, runId, inserted.rows[0].id);
    await recordAuditEventInTransaction(client, context, { type: "channel_reply.draft_created", resource: "channel_reply_draft", resourceId: draft.id, detail: { runId, interactionId, channelConnectionId: draft.channelConnectionId, bodySha256: draft.bodySha256, policyAction: draft.policyAction } });
    return draft;
  });
}

export async function updateChannelReplyDraft(context: RequestContext, runId: string, draftId: string, body: string) {
  await assertLiveRunAccess(context, runId);
  const normalized = normalizedBody(body);
  if (!databasePool()) return updateDemoDraft(context, runId, draftId, normalized);
  return withTenantTransaction(context.tenantId, async (client) => {
    const actorId = await actorDatabaseId(client, context);
    const result = await client.query<PersistentReplyRow>(
      `update channel_reply_drafts draft set body = $4, body_sha256 = $5, edited_by = $6, updated_at = now()
       where draft.id = $1 and draft.live_run_id = $2 and draft.tenant_id = $3 and draft.status = 'draft'
       returning ${replyReturning()}`,
      [draftId, runId, context.tenantId, normalized, sha256(normalized), actorId]
    );
    if (!result.rows[0]) throw new Response("Channel reply draft is not editable", { status: 409 });
    const draft = persistentReply(result.rows[0]);
    await recordAuditEventInTransaction(client, context, { type: "channel_reply.draft_edited", resource: "channel_reply_draft", resourceId: draft.id, detail: { runId, bodySha256: draft.bodySha256 } });
    return draft;
  });
}

export async function submitChannelReplyDraft(context: RequestContext, runId: string, draftId: string) { return transitionReply(context, runId, draftId, "submit"); }
export async function approveChannelReplyDraft(context: RequestContext, runId: string, draftId: string) { return transitionReply(context, runId, draftId, "approve"); }

export async function rejectChannelReplyDraft(context: RequestContext, runId: string, draftId: string, reason: string) {
  await assertLiveRunAccess(context, runId);
  const normalizedReason = normalizedRejectionReason(reason);
  if (!databasePool()) return rejectDemoDraft(context, runId, draftId, normalizedReason);
  return withTenantTransaction(context.tenantId, async (client) => {
    const existing = await replyForUpdate(client, runId, draftId);
    if (existing.status !== "pending_approval") throw new Response("Channel reply draft is not pending approval", { status: 409 });
    const actorId = await actorDatabaseId(client, context);
    const result = await client.query<PersistentReplyRow>(
      `update channel_reply_drafts draft set status = 'rejected', rejected_by = $4, rejected_at = now(), rejection_reason = $5, updated_at = now()
       where draft.id = $1 and draft.live_run_id = $2 and draft.tenant_id = $3 returning ${replyReturning()}`,
      [draftId, runId, context.tenantId, actorId, normalizedReason]
    );
    const draft = persistentReply(result.rows[0]);
    await recordAuditEventInTransaction(client, context, { type: "channel_reply.rejected", resource: "channel_reply_draft", resourceId: draft.id, detail: { runId, rejectionReason: normalizedReason } });
    return draft;
  });
}

export async function retryChannelReplyDraft(context: RequestContext, runId: string, draftId: string) {
  await assertLiveRunAccess(context, runId);
  if (!databasePool()) return retryDemoDraft(context, runId, draftId);
  return withTenantTransaction(context.tenantId, async (client) => {
    const existing = await replyForUpdate(client, runId, draftId);
    if (existing.status !== "failed") throw new Response("Only a failed channel reply can be retried", { status: 409 });
    const result = await client.query<PersistentReplyRow>(
      `update channel_reply_drafts draft set status = 'approved', outbox_event_id = null, failure_reason = null, updated_at = now()
       where draft.id = $1 and draft.live_run_id = $2 and draft.tenant_id = $3 returning ${replyReturning()}`,
      [draftId, runId, context.tenantId]
    );
    const draft = persistentReply(result.rows[0]);
    await recordAuditEventInTransaction(client, context, { type: "channel_reply.retry_authorized", resource: "channel_reply_draft", resourceId: draft.id, detail: { runId, bodySha256: draft.bodySha256 } });
    return draft;
  });
}

export async function enqueueChannelReplyDelivery(context: RequestContext, runId: string, draftId: string) {
  await assertLiveRunAccess(context, runId);
  if (!databasePool()) return enqueueDemoDelivery(context, runId, draftId);
  return withTenantTransaction(context.tenantId, async (client) => {
    const draft = await replyForUpdate(client, runId, draftId);
    if (draft.status !== "approved") throw new Response("Channel reply draft is not approved", { status: 409 });
    await assertReplyChannel(client, draft.channelConnectionId, draft.channelConnectionId);
    const event = await client.query<{ id: string }>(
      `insert into outbox_events (tenant_id, event_type, aggregate_type, aggregate_id, payload)
       values ($1, 'channel.reply.dispatch', 'channel_reply_draft', $2::uuid, $3::jsonb) returning id`,
      [context.tenantId, draft.id, JSON.stringify({ replyId: draft.id, runId, interactionId: draft.interactionId, channelConnectionId: draft.channelConnectionId, body: draft.body, bodySha256: draft.bodySha256, idempotencyKey: `channel_reply_${draft.id}` })]
    );
    const result = await client.query<PersistentReplyRow>(
      `update channel_reply_drafts draft set status = 'sending', outbox_event_id = $4::uuid, updated_at = now()
       where draft.id = $1 and draft.live_run_id = $2 and draft.tenant_id = $3 returning ${replyReturning()}`,
      [draftId, runId, context.tenantId, event.rows[0].id]
    );
    const sending = persistentReply(result.rows[0]);
    await recordAuditEventInTransaction(client, context, { type: "channel_reply.delivery_enqueued", resource: "channel_reply_draft", resourceId: sending.id, detail: { runId, interactionId: sending.interactionId, channelConnectionId: sending.channelConnectionId, outboxEventId: event.rows[0].id, bodySha256: sending.bodySha256 } });
    return { draft: sending, outboxEventId: event.rows[0].id };
  });
}

async function transitionReply(context: RequestContext, runId: string, draftId: string, action: "submit" | "approve") {
  await assertLiveRunAccess(context, runId);
  if (!databasePool()) return transitionDemoReply(context, runId, draftId, action);
  return withTenantTransaction(context.tenantId, async (client) => {
    const existing = await replyForUpdate(client, runId, draftId);
    if (action === "submit" && existing.status !== "draft") throw new Response("Channel reply draft is not a draft", { status: 409 });
    const actorId = await actorDatabaseId(client, context);
    if (action === "approve") {
      if (existing.status !== "pending_approval") throw new Response("Channel reply draft is not pending approval", { status: 409 });
      if (existing.createdBy === actorId) throw new Response("Reply creator cannot approve the same reply", { status: 409 });
    }
    const result = action === "submit"
      ? await client.query<PersistentReplyRow>(`update channel_reply_drafts draft set status = 'pending_approval', submitted_at = now(), updated_at = now() where draft.id = $1 and draft.live_run_id = $2 and draft.tenant_id = $3 returning ${replyReturning()}`, [draftId, runId, context.tenantId])
      : await client.query<PersistentReplyRow>(`update channel_reply_drafts draft set status = 'approved', approved_by = $4, approved_at = now(), updated_at = now() where draft.id = $1 and draft.live_run_id = $2 and draft.tenant_id = $3 returning ${replyReturning()}`, [draftId, runId, context.tenantId, actorId]);
    const draft = persistentReply(result.rows[0]);
    await recordAuditEventInTransaction(client, context, { type: action === "submit" ? "channel_reply.submitted" : "channel_reply.approved", resource: "channel_reply_draft", resourceId: draft.id, detail: { runId, bodySha256: draft.bodySha256, ...(action === "approve" ? { approvedBy: context.actorId } : {}) } });
    return draft;
  });
}

async function lockedInteraction(client: PoolClient, runId: string, interactionId: string) {
  const result = await client.query<{ id: string; channel_connection_id: string | null; policy_action: LiveInteraction["decision"]; evidence_ids: unknown; status: LiveInteraction["status"] }>("select id, channel_connection_id, policy_action, evidence_ids, status from live_interactions where id = $1 and live_run_id = $2 for update", [interactionId, runId]);
  const interaction = result.rows[0];
  if (!interaction) throw new Response("Interaction not found", { status: 404 });
  if (interaction.status !== "queued") throw new Response("Interaction is already handled", { status: 409 });
  if (!interaction.channel_connection_id) throw new Response("Only channel-sourced interactions can receive a channel reply", { status: 409 });
  return interaction;
}

async function assertReplyChannel(client: PoolClient, requested: string | undefined, source: string | undefined) {
  if (!requested || requested !== source) throw new Response("Channel reply must use the interaction source channel", { status: 409 });
  const result = await client.query<{ id: string; status: string; capabilities: unknown }>("select id, status, capabilities from channel_connections where id = $1", [requested]);
  const channel = result.rows[0];
  if (!channel) throw new Response("Channel connection not found", { status: 404 });
  if (channel.status !== "connected" || !supportsOutboundReplyCapability(channel.capabilities)) throw new Response("Channel does not support outbound replies", { status: 409 });
  return channel;
}

async function productEvidence(client: PoolClient, runId: string) {
  const result = await client.query<{ id: string | null; revision: number | null }>("select run.product_version_id as id, version.revision from live_runs run left join product_versions version on version.id = run.product_version_id where run.id = $1", [runId]);
  if (!result.rows[0]) throw new Response("Live run not found", { status: 404 });
  return result.rows[0];
}
async function replyForUpdate(client: PoolClient, runId: string, draftId: string) { const result = await client.query<PersistentReplyRow>(`${replySelect()} where draft.id = $1 and draft.live_run_id = $2 for update`, [draftId, runId]); if (!result.rows[0]) throw new Response("Channel reply draft not found", { status: 404 }); return persistentReply(result.rows[0]); }
async function actorDatabaseId(client: PoolClient, context: RequestContext) { const result = await client.query<{ id: string }>("select sync_control_plane_actor($1::uuid, $2, $3, $4::membership_role) as id", [context.tenantId, context.actorId, context.actorName, context.role]); return result.rows[0].id; }
function supportsOutboundReplyCapability(value: unknown) { return Boolean(value && typeof value === "object" && (value as Record<string, unknown>).supportsOutboundReplies === true); }

async function createDemoDraft(context: RequestContext, runId: string, interactionId: string, input: DraftInput) {
  const interaction = (await listInteractions(context, runId)).find((item) => item.id === interactionId);
  if (!interaction) throw new Response("Interaction not found", { status: 404 });
  if (interaction.status !== "queued") throw new Response("Interaction is already handled", { status: 409 });
  const channelConnectionId = input.channelConnectionId ?? interaction.channelConnectionId;
  const channel = await assertDemoReplyChannel(context, channelConnectionId, interaction.channelConnectionId);
  if ([...replyStore().drafts.values()].some((item) => item.interactionId === interactionId && item.tenantId === context.tenantId)) throw new Response("Interaction already has a channel reply draft", { status: 409 });
  const now = new Date().toISOString();
  const draft: ChannelReplyDraft = { id: `reply_${crypto.randomUUID()}`, tenantId: context.tenantId, runId, interactionId, channelConnectionId: channel.id, body: input.body, bodySha256: sha256(input.body), status: "draft", policyAction: interaction.decision, evidenceSnapshot: [{ type: "interaction_evidence", ids: interaction.evidenceIds }], createdBy: context.actorId, createdAt: now, updatedAt: now };
  replyStore().drafts.set(draft.id, draft);
  await recordAuditEvent(context, { type: "channel_reply.draft_created", resource: "channel_reply_draft", resourceId: draft.id, detail: { runId, interactionId, channelConnectionId: draft.channelConnectionId, bodySha256: draft.bodySha256, policyAction: draft.policyAction } });
  return draft;
}

async function updateDemoDraft(context: RequestContext, runId: string, draftId: string, body: string) {
  const draft = demoReply(context, runId, draftId);
  if (draft.status !== "draft") throw new Response("Channel reply draft is not editable", { status: 409 });
  const updated = { ...draft, body, bodySha256: sha256(body), editedBy: context.actorId, updatedAt: new Date().toISOString() };
  replyStore().drafts.set(draftId, updated);
  await recordAuditEvent(context, { type: "channel_reply.draft_edited", resource: "channel_reply_draft", resourceId: draftId, detail: { runId, bodySha256: updated.bodySha256 } });
  return updated;
}

async function transitionDemoReply(context: RequestContext, runId: string, draftId: string, action: "submit" | "approve") {
  const draft = demoReply(context, runId, draftId);
  if (action === "submit" && draft.status !== "draft") throw new Response("Channel reply draft is not a draft", { status: 409 });
  if (action === "approve" && (draft.status !== "pending_approval" || draft.createdBy === context.actorId)) throw new Response("Channel reply approval is not allowed", { status: 409 });
  const now = new Date().toISOString();
  const updated = action === "submit" ? { ...draft, status: "pending_approval" as const, submittedAt: now, updatedAt: now } : { ...draft, status: "approved" as const, approvedBy: context.actorId, approvedAt: now, updatedAt: now };
  replyStore().drafts.set(draftId, updated);
  await recordAuditEvent(context, { type: action === "submit" ? "channel_reply.submitted" : "channel_reply.approved", resource: "channel_reply_draft", resourceId: draftId, detail: { runId, bodySha256: updated.bodySha256 } });
  return updated;
}

async function rejectDemoDraft(context: RequestContext, runId: string, draftId: string, reason: string) {
  const draft = demoReply(context, runId, draftId);
  if (draft.status !== "pending_approval") throw new Response("Channel reply draft is not pending approval", { status: 409 });
  const now = new Date().toISOString();
  const updated = { ...draft, status: "rejected" as const, rejectedBy: context.actorId, rejectedAt: now, rejectionReason: reason, updatedAt: now };
  replyStore().drafts.set(draftId, updated);
  await recordAuditEvent(context, { type: "channel_reply.rejected", resource: "channel_reply_draft", resourceId: draftId, detail: { runId, rejectionReason: reason } });
  return updated;
}

async function retryDemoDraft(context: RequestContext, runId: string, draftId: string) {
  const draft = demoReply(context, runId, draftId);
  if (draft.status !== "failed") throw new Response("Only a failed channel reply can be retried", { status: 409 });
  const updated = { ...draft, status: "approved" as const, outboxEventId: undefined, failureReason: undefined, updatedAt: new Date().toISOString() };
  replyStore().drafts.set(draftId, updated);
  await recordAuditEvent(context, { type: "channel_reply.retry_authorized", resource: "channel_reply_draft", resourceId: draftId, detail: { runId, bodySha256: updated.bodySha256 } });
  return updated;
}

async function enqueueDemoDelivery(context: RequestContext, runId: string, draftId: string) {
  const draft = demoReply(context, runId, draftId);
  if (draft.status !== "approved") throw new Response("Channel reply draft is not approved", { status: 409 });
  const updated = { ...draft, status: "sending" as const, outboxEventId: `outbox_${crypto.randomUUID()}`, updatedAt: new Date().toISOString() };
  replyStore().drafts.set(draftId, updated);
  await recordAuditEvent(context, { type: "channel_reply.delivery_enqueued", resource: "channel_reply_draft", resourceId: draftId, detail: { runId, interactionId: draft.interactionId, channelConnectionId: draft.channelConnectionId, outboxEventId: updated.outboxEventId, bodySha256: draft.bodySha256 } });
  return { draft: updated, outboxEventId: updated.outboxEventId };
}

function demoReply(context: RequestContext, runId: string, draftId: string) { const draft = replyStore().drafts.get(draftId); if (!draft || draft.tenantId !== context.tenantId || draft.runId !== runId) throw new Response("Channel reply draft not found", { status: 404 }); return draft; }
async function assertDemoReplyChannel(context: RequestContext, requested: string | undefined, source: string | undefined) { if (!requested || requested !== source) throw new Response("Channel reply must use the interaction source channel", { status: 409 }); const channel = await getChannelConnection(context, requested); if (!channel || channel.status !== "connected" || !supportsOutboundReplyCapability(channel.capability)) throw new Response("Channel does not support outbound replies", { status: 409 }); return channel; }

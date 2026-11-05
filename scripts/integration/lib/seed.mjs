// Generic fixture builders for integration tests (design part 8, section 1.3 `Seed`). Every method writes only
// along legal paths (draft or pending first, then the governed transition to approved), so it works on the
// schema both before and after an audit fix; field values follow scripts/test-control-plane-postgres.mjs and
// scripts/verify-postgres-schema.mjs. Every method takes an optional `client` (default: the harness admin
// connection) and returns the generated ID, or an object of IDs for composite fixtures.
//
// channelConnection() fails on a schema without the C1 fix (069), so C1 regression tests must not call it
// in a before hook.
import { createHash, randomUUID } from "node:crypto";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const short = () => randomUUID().slice(0, 8);
export const MODEL_COMPONENTS = Object.freeze(["runtime", "lip_sync", "voice"]);
export const MEDIA_KINDS = Object.freeze(["portrait", "voice", "product_clip", "music"]);
const CONTENT_TYPES = Object.freeze({ portrait: "video/mp4", product_clip: "video/mp4", voice: "audio/wav", music: "audio/wav" });

export function createSeed(defaultClient) {
  const q = (client, sql, params) => (client ?? defaultClient).query(sql, params);
  const seed = {
    async tenant({ slug, name = "Integration tenant", client } = {}) {
      const id = randomUUID();
      await q(client, "insert into tenants (id, slug, name) values ($1, $2, $3)", [id, slug ?? `it-${id}`, name]);
      return id;
    },

    /** Returns the user id (the value approval and verifier columns reference). */
    async member({ tenantId, subject = `it-subject-${short()}`, displayName = "Integration member", role = "admin", accessScope = "tenant", status = "active", client } = {}) {
      await q(client, "insert into users (external_subject, display_name) values ($1, $2) on conflict (external_subject) do nothing", [subject, displayName]);
      const user = await q(client, "select id from users where external_subject = $1", [subject]);
      const userId = user.rows[0].id;
      await q(client, "insert into memberships (tenant_id, user_id, role, access_scope, status) values ($1, $2, $3::membership_role, $4::membership_access_scope, $5)", [tenantId, userId, role, accessScope, status]);
      return userId;
    },

    async productVersion({ tenantId, approver, productId, facts = { priceCent: 9900, stock: 20 }, approve = true, client } = {}) {
      const product = productId ?? randomUUID();
      if (!productId) await q(client, "insert into products (id, tenant_id, external_sku, name) values ($1, $2, $3, 'Integration product')", [product, tenantId, `it-sku-${product}`]);
      const id = randomUUID();
      const revision = (await q(client, "select coalesce(max(revision), 0) + 1 as next from product_versions where product_id = $1", [product])).rows[0].next;
      await q(client, "insert into product_versions (id, tenant_id, product_id, revision, facts, approval_status) values ($1, $2, $3, $4, $5::jsonb, 'draft')", [id, tenantId, product, revision, JSON.stringify(facts)]);
      if (approve) await q(client, "update product_versions set approval_status = 'approved', approved_by = $2, approved_at = now() where id = $1", [id, approver]);
      return id;
    },

    async modelRelease({ tenantId, approver, component = "runtime", approve = true, client } = {}) {
      const id = randomUUID();
      await q(client, "insert into model_releases (id, tenant_id, name, version, component, source_commit, image_digest, artifact_hash, driver_version, license, rights_scope, evidence_ref, validation_summary, approval_status) values ($1, $2, $3, $4, $5::model_release_component, 'integration-commit', 'sha256:integration-image', 'sha256:integration-artifact', 'integration-driver', 'Apache-2.0', 'Integration validation only', 'evidence://integration/model-release', 'Integration release', 'pending')", [id, tenantId, `Integration ${component}`, `it-${id}`, component]);
      if (approve) await q(client, "update model_releases set approval_status = 'approved', approved_by = $2, approved_at = now() where id = $1", [id, approver]);
      return id;
    },

    async policyProfile({ tenantId, approver, rules = [], approve = true, client } = {}) {
      const id = randomUUID();
      await q(client, "insert into policy_profiles (id, tenant_id, name, version, rules, evidence_ref, validation_summary) values ($1, $2, $3, '1.0.0', $4::jsonb, 'evidence://integration/policy', 'Integration policy')", [id, tenantId, `Integration policy ${id}`, JSON.stringify(rules)]);
      if (approve) await q(client, "update policy_profiles set approval_status = 'approved', approved_by = $2, approved_at = now() where id = $1", [id, approver]);
      return id;
    },

    /** Pending first; approval writes the verified_* columns and verification_evidence_ref together. */
    async mediaAsset({ tenantId, approver, kind = "portrait", approve = true, client } = {}) {
      const id = randomUUID();
      const voiceId = kind === "voice" ? `it_voice_${id.slice(0, 8)}` : null;
      await q(client, "insert into media_assets (id, tenant_id, kind, name, object_key, checksum, rights_scope, source_ref, approval_status, runtime_voice_id) values ($1, $2, $3::media_asset_kind, $4, $5, $6, 'Integration approved rights', 'evidence://integration/media-asset', 'pending', $7)", [id, tenantId, kind, `Integration ${kind}`, `assets/${tenantId}/${kind}-${id}`, `sha256:${sha256(`integration-${kind}-${id}`)}`, voiceId]);
      if (approve) {
        await q(client, "update media_assets set approval_status = 'approved', approved_by = $2, approved_at = now(), verified_object_version = 'integration-seed-v1', verified_bytes = 1024, verified_content_type = $3, verification_evidence_ref = 'evidence://integration/media-content', verified_at = now() where id = $1", [id, approver, CONTENT_TYPES[kind] ?? "application/octet-stream"]);
      }
      return id;
    },

    /**
     * shows → show_revisions(draft) → bindings (product, 3 model releases, 4 media kinds, policy) → segments →
     * approved. `bindings: "none"` skips the bindings; `approve: false` leaves the revision in draft.
     */
    async revision({ tenantId, approver, segments = [{ kind: "prepared_product", runtimeScript: "本段仅播报已批准的商品事实。" }], bindings = "full", approve = true, client } = {}) {
      const showId = randomUUID();
      const revisionId = randomUUID();
      await q(client, "insert into shows (id, tenant_id, name) values ($1, $2, $3)", [showId, tenantId, `Integration show ${showId}`]);
      await q(client, "insert into show_revisions (id, tenant_id, show_id, revision, plan, approval_status) values ($1, $2, $3, 1, '{}'::jsonb, 'draft')", [revisionId, tenantId, showId]);
      const result = { showId, revisionId, productVersionId: null, modelReleaseIds: {}, mediaAssetIds: {}, policyProfileId: null, segmentIds: [] };
      if (bindings === "full") {
        result.productVersionId = await seed.productVersion({ tenantId, approver, client });
        await q(client, "insert into show_revision_product_versions (tenant_id, show_revision_id, product_version_id, slot_key) values ($1, $2, $3, 'primary')", [tenantId, revisionId, result.productVersionId]);
        for (const component of MODEL_COMPONENTS) {
          const releaseId = await seed.modelRelease({ tenantId, approver, component, client });
          result.modelReleaseIds[component] = releaseId;
          await q(client, "insert into show_revision_model_releases (tenant_id, show_revision_id, model_release_id, component) values ($1, $2, $3, $4::model_release_component)", [tenantId, revisionId, releaseId, component]);
        }
        for (const kind of MEDIA_KINDS) {
          const assetId = await seed.mediaAsset({ tenantId, approver, kind, client });
          result.mediaAssetIds[kind] = assetId;
          await q(client, "insert into show_revision_media_assets (tenant_id, show_revision_id, media_asset_id, kind) values ($1, $2, $3, $4::media_asset_kind)", [tenantId, revisionId, assetId, kind]);
        }
        result.policyProfileId = await seed.policyProfile({ tenantId, approver, client });
        await q(client, "insert into show_revision_policy_profiles (tenant_id, show_revision_id, policy_profile_id) values ($1, $2, $3)", [tenantId, revisionId, result.policyProfileId]);
      } else if (bindings !== "none") {
        throw new Error(`seed.revision bindings must be "full" or "none", found ${JSON.stringify(bindings)}`);
      }
      for (const [index, segment] of segments.entries()) {
        const segmentId = randomUUID();
        await q(client, "insert into show_revision_segments (id, tenant_id, show_revision_id, position, kind, title, purpose, duration_seconds, runtime_script, is_fallback) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)", [segmentId, tenantId, revisionId, index + 1, segment.kind, segment.title ?? `Segment ${index + 1}`, segment.purpose ?? "Integration segment", segment.durationSeconds ?? 60, segment.runtimeScript ?? null, segment.kind === "fallback"]);
        result.segmentIds.push(segmentId);
      }
      if (approve) await q(client, "update show_revisions set approval_status = 'approved', approved_by = $2, approved_at = now() where id = $1", [revisionId, approver]);
      return result;
    },

    /** Inserted as disabled; `status: "connected"` then records verification evidence (059/061 rules). */
    async channelConnection({ tenantId, verifier, status = "connected", provider = "normalized-webhook-rtmp", capabilities = { supportsOutboundReplies: true }, client } = {}) {
      const id = randomUUID();
      await q(client, "insert into channel_connections (id, tenant_id, name, provider, status, output_protocol, secret_ref, capabilities) values ($1, $2, $3, $4, 'disabled', 'rtmp', $5, $6::jsonb)", [id, tenantId, `Integration channel ${id}`, provider, `secret://integration/${id}`, JSON.stringify(capabilities)]);
      if (status === "connected") {
        await q(client, "update channel_connections set status = 'connected', last_verified_at = now(), verification_evidence_ref = 'evidence://integration/channel-verification', verified_by = $2 where id = $1", [id, verifier]);
      } else if (status !== "disabled") {
        throw new Error(`seed.channelConnection status must be "connected" or "disabled", found ${JSON.stringify(status)}`);
      }
      return id;
    },

    async liveRun({ tenantId, revisionId, state = "DRAFT", sessionId, channelId = null, productVersionId = null, client } = {}) {
      const id = randomUUID();
      await q(client, "insert into live_runs (id, tenant_id, show_revision_id, state, trace_id, runtime_session_id, channel_connection_id, product_version_id) values ($1, $2, $3, $4::live_run_state, $5, $6, $7, $8)", [id, tenantId, revisionId, state, `trace_${id}`, sessionId ?? `it_${id.slice(0, 8)}`, channelId, productVersionId]);
      return id;
    },

    async healthSample({ tenantId, liveRunId, sampledAt = new Date(), outputConnected = true, client } = {}) {
      const result = await q(client, "insert into runtime_health_samples (tenant_id, live_run_id, output_connected, inference_fps, output_fps, av_sync_ms, bitrate_mbps, gpu_utilization, gpu_memory_mib, audio_active, fallback_ready, sampled_at) values ($1, $2, $3, 30, 25, 20, 4, 70, 12000, true, true, $4) returning id", [tenantId, liveRunId, outputConnected, sampledAt]);
      return result.rows[0].id;
    },

    async runtimeAlert({ tenantId, liveRunId, severity = "warning", code = `it_alert_${short()}`, message = "Integration alert", client } = {}) {
      const result = await q(client, "insert into runtime_alerts (tenant_id, live_run_id, severity, code, message) values ($1, $2, $3, $4, $5) returning id", [tenantId, liveRunId, severity, code, message]);
      return result.rows[0].id;
    },

    async outboxEvent({ tenantId, aggregateId, eventType = "media.dispatch", aggregateType = "live_run", payload, client } = {}) {
      const body = payload ?? { sessionId: `it_${aggregateId}`, command: { id: `it_command_${randomUUID()}`, runId: aggregateId, type: "switch_to_human", issuedAt: new Date().toISOString(), traceId: `it_trace_${aggregateId}`, payload: { reason: "integration" } } };
      const result = await q(client, "insert into outbox_events (tenant_id, event_type, aggregate_type, aggregate_id, payload) values ($1, $2, $3, $4, $5::jsonb) returning id", [tenantId, eventType, aggregateType, aggregateId, JSON.stringify(body)]);
      return result.rows[0].id;
    },

    async interaction({ tenantId, liveRunId, channelId, question = "Can this be sent?", client } = {}) {
      const id = randomUUID();
      await q(client, "insert into live_interactions (id, tenant_id, live_run_id, source, channel_connection_id, question_text, risk_level, policy_action, evidence_ids) values ($1, $2, $3, 'channel:integration', $4, $5, 'low', 'answer', '[\"product_version\"]'::jsonb)", [id, tenantId, liveRunId, channelId, question]);
      return id;
    },

    async replyDraft({ tenantId, liveRunId, interactionId, channelId, createdBy, body = "Integration reply", client } = {}) {
      const id = randomUUID();
      await q(client, "insert into channel_reply_drafts (id, tenant_id, live_run_id, interaction_id, channel_connection_id, body, body_sha256, policy_action, evidence_snapshot, created_by) values ($1, $2, $3, $4, $5, $6, $7, 'answer', '[{\"type\":\"product_version\",\"id\":\"evidence\"}]'::jsonb, $8)", [id, tenantId, liveRunId, interactionId, channelId, body, sha256(body), createdBy]);
      return id;
    }
  };
  return seed;
}

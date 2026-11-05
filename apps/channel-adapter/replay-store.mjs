// Durable webhook replay leases in channel_webhook_replays.
//
// Lease ownership without a schema change: every claim (insert or reclaim) writes a new row version, and the
// row version's `xmin` system column is the id of the claiming transaction. The claim returns it as an opaque
// lease token, and release only matches a row whose current version still carries that token. Any later
// claim, release or delivery mark writes a new version with a different `xmin`, so a holder whose lease
// expired and was reclaimed by another instance releases nothing. `select ... for update` only locks the row
// and does not change `xmin`. If the token can no longer match for another reason, release is a no-op and the
// lease simply runs until lease_expires_at, which is the behaviour before release existed.
//
// All lease time comparisons use the database clock (`now()`), never the adapter clock.

export function createPgReplayStore(pool, { leaseSeconds }) {
  if (!Number.isInteger(leaseSeconds) || leaseSeconds <= 0) throw new Error("leaseSeconds must be a positive integer");

  async function inTenantTransaction(tenantId, operation) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
      const result = await operation(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    /** @returns {Promise<{kind:"claimed",leaseToken:string}|{kind:"delivered"}|{kind:"processing",retryAfterSeconds:number}>} */
    reserve(target, eventId, payloadSha256) {
      const key = [target.tenantId, target.channelConnectionId, eventId];
      return inTenantTransaction(target.tenantId, async (client) => {
        const inserted = await client.query(
          "insert into channel_webhook_replays (tenant_id, channel_connection_id, external_event_id, payload_sha256, state, lease_expires_at) values ($1, $2, $3, $4, 'delivering', now() + ($5 * interval '1 second')) on conflict (tenant_id, channel_connection_id, external_event_id) do nothing returning xmin::text as lease_token",
          [...key, payloadSha256, leaseSeconds]
        );
        if (inserted.rows[0]) return { kind: "claimed", leaseToken: inserted.rows[0].lease_token };
        const existing = await client.query(
          "select state, payload_sha256, (state = 'delivering' and lease_expires_at is not null and lease_expires_at > now()) as lease_active, greatest(1, ceil(extract(epoch from (lease_expires_at - now()))))::int as retry_after_seconds from channel_webhook_replays where tenant_id = $1 and channel_connection_id = $2 and external_event_id = $3 for update",
          key
        );
        const row = existing.rows[0];
        if (!row) throw new Error("webhook_replay_conflict_unresolved");
        if (row.payload_sha256 !== payloadSha256) throw new Error("event_id_reused_with_different_payload");
        if (row.state === "delivered") return { kind: "delivered" };
        if (row.lease_active) return { kind: "processing", retryAfterSeconds: Math.max(1, Number(row.retry_after_seconds) || 1) };
        const reclaimed = await client.query(
          "update channel_webhook_replays set state = 'delivering', lease_expires_at = now() + ($4 * interval '1 second') where tenant_id = $1 and channel_connection_id = $2 and external_event_id = $3 and state <> 'delivered' returning xmin::text as lease_token",
          [...key, leaseSeconds]
        );
        if (!reclaimed.rows[0]) throw new Error("webhook_replay_conflict_unresolved");
        return { kind: "claimed", leaseToken: reclaimed.rows[0].lease_token };
      });
    },

    /** Releases the lease only if it is still the one claimed with `leaseToken`. @returns {Promise<boolean>} */
    release(target, eventId, leaseToken) {
      if (typeof leaseToken !== "string" || !/^\d+$/.test(leaseToken)) return Promise.resolve(false);
      return inTenantTransaction(target.tenantId, async (client) => {
        const released = await client.query(
          "update channel_webhook_replays set state = 'pending', lease_expires_at = null where tenant_id = $1 and channel_connection_id = $2 and external_event_id = $3 and state = 'delivering' and xmin = $4::xid",
          [target.tenantId, target.channelConnectionId, eventId, leaseToken]
        );
        return released.rowCount === 1;
      });
    },

    /** Records a Control_Plane 2xx. It does not require the lease token: the delivery happened either way. */
    markDelivered(target, eventId) {
      return inTenantTransaction(target.tenantId, async (client) => {
        await client.query(
          "update channel_webhook_replays set state = 'delivered', delivered_at = now(), lease_expires_at = null where tenant_id = $1 and channel_connection_id = $2 and external_event_id = $3 and state <> 'delivered'",
          [target.tenantId, target.channelConnectionId, eventId]
        );
      });
    }
  };
}

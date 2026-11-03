import { createHmac, timingSafeEqual } from "node:crypto";

const severities = new Set(["warning", "critical"]);

export function parseTargets(value, { allowInsecureHttp = false } = {}) {
  const parsed = JSON.parse(value ?? "[]");
  if (!Array.isArray(parsed) || !parsed.length) throw new Error("ALERT_NOTIFIER_TARGETS must contain at least one target");
  const targets = new Map();
  for (const item of parsed) {
    if (!item || typeof item !== "object") throw new Error("Invalid alert notifier target");
    const { id, tenantId, webhookUrl, signingSecret, minimumSeverity = "critical" } = item;
    if (![id, tenantId, webhookUrl, signingSecret].every((entry) => typeof entry === "string" && entry.length)) throw new Error("Each alert notifier target requires id, tenantId, webhookUrl and signingSecret");
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(id)) throw new Error("Alert notifier target id is invalid");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(tenantId)) throw new Error("Alert notifier tenantId must be a UUID");
    if (signingSecret.length < 32 || /\s/.test(signingSecret)) throw new Error("Alert notifier signingSecret must be at least 32 non-whitespace characters");
    if (!severities.has(minimumSeverity)) throw new Error("Alert notifier minimumSeverity is invalid");
    const url = new URL(webhookUrl);
    if (url.protocol !== "https:" && !(allowInsecureHttp && url.protocol === "http:")) throw new Error("Alert notifier webhookUrl must use HTTPS");
    const key = `${tenantId}:${id}`;
    if (targets.has(key)) throw new Error(`Duplicate alert notifier target: ${key}`);
    targets.set(key, { id, tenantId, webhookUrl: url.toString(), signingSecret, minimumSeverity });
  }
  return [...targets.values()];
}

export function alertPayload(delivery) {
  return {
    eventId: delivery.id,
    eventType: "runtime_alert.opened",
    alert: {
      id: delivery.alert_id,
      runId: delivery.live_run_id,
      severity: delivery.severity,
      code: delivery.code,
      message: delivery.message,
      openedAt: new Date(delivery.opened_at).toISOString()
    }
  };
}

export function signWebhook(rawBody, secret, timestamp = Math.floor(Date.now() / 1000).toString()) {
  return { timestamp, signature: `sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}` };
}

export function verifyWebhook(rawBody, secret, timestamp, signature) {
  const expected = signWebhook(rawBody, secret, timestamp).signature;
  const actualBuffer = Buffer.from(signature ?? "");
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function retryDelayMs(attempts, baseMs, maxMs) {
  return Math.min(maxMs, baseMs * (2 ** Math.max(0, attempts - 1)));
}

export function matchingSeverities(minimumSeverity) {
  return minimumSeverity === "warning" ? ["warning", "critical"] : ["critical"];
}

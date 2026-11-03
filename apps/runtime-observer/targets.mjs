export function parseObserverTargets(rawText, source) {
  let parsed;
  try { parsed = JSON.parse(rawText); } catch { throw new Error(`${source} must be valid JSON`); }
  if (!Array.isArray(parsed)) throw new Error(`${source} must be a JSON array`);
  return parsed.map((target, index) => {
    if (!target || typeof target !== "object" || Array.isArray(target)) throw new Error(`${source}[${index}] must be an object`);
    const value = target;
    for (const key of ["tenantId", "runId", "sessionId", "telemetryToken", "outputProbeUrl"]) if (typeof value[key] !== "string" || value[key].length === 0 || value[key].length > 2000) throw new Error(`${source}[${index}].${key} is invalid`);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value.sessionId)) throw new Error(`${source}[${index}].sessionId is invalid`);
    if (value.telemetryToken.length < 32 || /\s/.test(value.telemetryToken)) throw new Error(`${source}[${index}].telemetryToken is too short or contains whitespace`);
    if (value.outputProbeToken !== undefined && (typeof value.outputProbeToken !== "string" || value.outputProbeToken.length < 32 || value.outputProbeToken.length > 2000 || /\s/.test(value.outputProbeToken))) throw new Error(`${source}[${index}].outputProbeToken is invalid`);
    const probeUrl = new URL(value.outputProbeUrl);
    if (!/^https?:$/.test(probeUrl.protocol) || probeUrl.username || probeUrl.password) throw new Error(`${source}[${index}].outputProbeUrl is invalid`);
    return { tenantId: value.tenantId, runId: value.runId, sessionId: value.sessionId, telemetryToken: value.telemetryToken, outputProbeUrl: probeUrl.toString(), outputProbeToken: value.outputProbeToken };
  });
}

export function requireOutputProbeToken(targets, expectedToken) {
  if (typeof expectedToken !== "string" || expectedToken.length < 32 || /\s/.test(expectedToken)) throw new Error("OUTPUT_PROBE_SHARED_TOKEN is missing, too short, or contains whitespace");
  if (!targets.every((target) => target.outputProbeToken === expectedToken)) throw new Error("every observer target must provide the configured OUTPUT_PROBE_SHARED_TOKEN");
}

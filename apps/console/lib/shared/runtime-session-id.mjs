const RUNTIME_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function isRuntimeSessionId(value) {
  return typeof value === "string" && RUNTIME_SESSION_ID_PATTERN.test(value);
}

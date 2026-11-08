"use client";

const clientRequestTimeoutMs = 20_000;

export async function clientFetch(input: RequestInfo | URL, init?: RequestInit, timeoutMs = clientRequestTimeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5 * 60_000) throw new RangeError("invalid_client_request_timeout");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error("请求超时，请检查网络或稍后重试");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

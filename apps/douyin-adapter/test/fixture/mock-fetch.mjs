export function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

export function createMockFetch(handler) {
  if (typeof handler !== "function") throw new TypeError("handler must be a function");
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const call = { url: String(url), init };
    calls.push(call);
    return handler(call, calls.length);
  };
  return { fetchImpl, calls };
}

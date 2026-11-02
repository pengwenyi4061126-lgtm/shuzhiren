import { headers } from "next/headers";
import { type ActorRole, requestContextFrom } from "@/lib/control-plane/auth-context";

export async function pageRequestContext() {
  const requestHeaders = await headers();
  return requestContextFrom(new Request("http://shuzhiren.internal", { headers: requestHeaders }));
}

export async function authorizedPageRequestContext(allowed: ActorRole[]) {
  const context = await pageRequestContext();
  return allowed.includes(context.role) ? context : null;
}

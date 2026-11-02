import { headers } from "next/headers";
import { requestContextFrom } from "@/lib/control-plane/auth-context";

export async function pageRequestContext() {
  const requestHeaders = await headers();
  return requestContextFrom(new Request("http://shuzhiren.internal", { headers: requestHeaders }));
}

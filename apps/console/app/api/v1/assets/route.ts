import { requestContextFrom } from "@/lib/control-plane/auth-context";
import { listAssets } from "@/lib/assets";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return Response.json({ data: listAssets(await requestContextFrom(request)) });
}

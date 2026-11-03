import { databaseHealth } from "@/lib/database";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const database = await databaseHealth();
    return Response.json({
      status: "ok",
      service: "shuzhiren-console",
      timestamp: new Date().toISOString(),
      dependencies: {
        controlPlane: database.status,
        mediaRuntime: "not-checked",
        aiRuntime: "not-checked"
      }
    });
  } catch {
    return Response.json({
      status: "unavailable",
      service: "shuzhiren-console",
      timestamp: new Date().toISOString(),
      dependencies: {
        controlPlane: "unavailable",
        mediaRuntime: "not-checked",
        aiRuntime: "not-checked"
      }
    }, { status: 503 });
  }
}

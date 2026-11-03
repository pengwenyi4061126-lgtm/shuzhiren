import { databaseHealth } from "@/lib/database";
import { controlPlaneReadiness } from "@/lib/control-plane/config";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const readiness = controlPlaneReadiness();
    const database = await databaseHealth();
    return Response.json({
      status: "ok",
      service: "shuzhiren-console",
      releaseRevision: readiness.releaseRevision,
      timestamp: new Date().toISOString(),
      dependencies: {
        controlPlane: database.status,
        authentication: readiness.authentication,
        mediaRuntime: "not-checked",
        aiRuntime: "not-checked"
      }
    });
  } catch {
    return Response.json({
      status: "unavailable",
      service: "shuzhiren-console",
      releaseRevision: null,
      timestamp: new Date().toISOString(),
      dependencies: {
        controlPlane: "unavailable",
        authentication: "unavailable",
        mediaRuntime: "not-checked",
        aiRuntime: "not-checked"
      }
    }, { status: 503 });
  }
}

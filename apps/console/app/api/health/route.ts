export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({
    status: "ok",
    service: "shuzhiren-console",
    timestamp: new Date().toISOString(),
    dependencies: {
      controlPlane: "demo",
      mediaRuntime: "not-configured",
      aiRuntime: "not-configured"
    }
  });
}

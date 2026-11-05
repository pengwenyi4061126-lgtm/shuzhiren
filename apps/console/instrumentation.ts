// Runs once per server process before Next.js handles the first request.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { enforceDevIdentityStartupGuard } = await import("./lib/control-plane/dev-identity");
  enforceDevIdentityStartupGuard();
  const { enforceTenantTokenEnvironment } = await import("./lib/runtime-service-auth");
  enforceTenantTokenEnvironment();
}

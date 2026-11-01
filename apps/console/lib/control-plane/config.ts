export type ControlPlaneConfig = {
  databaseUrl?: string;
  demoMode: boolean;
};

export function controlPlaneConfig(): ControlPlaneConfig {
  const isProduction = process.env.NODE_ENV === "production";
  const databaseUrl = process.env.DATABASE_URL;
  const demoMode = process.env.CONTROL_PLANE_DEMO_MODE === "true" || (!isProduction && !databaseUrl);

  if (isProduction && (!databaseUrl || demoMode)) {
    throw new Error("Production control plane requires DATABASE_URL and disabled demo mode");
  }

  return { databaseUrl, demoMode };
}

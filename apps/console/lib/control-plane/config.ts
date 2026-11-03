export type ControlPlaneConfig = {
  databaseUrl?: string;
  demoMode: boolean;
};

export type ControlPlaneReadiness = {
  authentication: "demo" | "oidc";
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

export function controlPlaneReadiness(): ControlPlaneReadiness {
  const config = controlPlaneConfig();
  if (process.env.NODE_ENV !== "production" || config.demoMode) return { authentication: "demo" };

  for (const [name, value] of [["OIDC_ISSUER_URL", process.env.OIDC_ISSUER_URL], ["OIDC_JWKS_URL", process.env.OIDC_JWKS_URL]] as const) {
    if (!value) throw new Error(`${name} is required in production`);
    const url = new URL(value);
    const loopbackHttp = url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
    if (url.username || url.password || (url.protocol !== "https:" && !loopbackHttp)) throw new Error(`${name} must use HTTPS outside a loopback integration environment`);
  }
  if (!process.env.OIDC_AUDIENCE?.trim()) throw new Error("OIDC_AUDIENCE is required in production");
  return { authentication: "oidc" };
}

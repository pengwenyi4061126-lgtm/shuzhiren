import { writeSync } from "node:fs";
import net from "node:net";

// The development request-header identity (x-tenant-id, x-actor-*) and the
// built-in development service tokens are available only behind this switch.
// Only the exact value "true" enables it; NODE_ENV no longer decides.
export function devHeaderIdentityEnabled(env: NodeJS.ProcessEnv = process.env) {
  return env.CONTROL_PLANE_DEV_HEADER_IDENTITY === "true";
}

const loopbackAddresses = new net.BlockList();
loopbackAddresses.addSubnet("127.0.0.0", 8, "ipv4");
loopbackAddresses.addAddress("::1", "ipv6");

export function isLoopbackAddress(host: string) {
  const value = host.trim().replace(/^\[(.*)\]$/, "$1");
  if (value.toLowerCase() === "localhost") return true;
  const family = net.isIP(value);
  if (family === 4) return loopbackAddresses.check(value, "ipv4");
  if (family === 6) return loopbackAddresses.check(value, "ipv6");
  return false;
}

// Recognises -H v, -Hv, --hostname v and --hostname=v.
export function hostnameFromArgv(argv: readonly string[]) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-H" || arg === "--hostname") return argv[index + 1];
    if (arg.startsWith("--hostname=")) return arg.slice("--hostname=".length);
    if (arg.startsWith("-H") && arg.length > 2) return arg.slice(2);
  }
  return undefined;
}

export function devIdentityViolation(input: { env: NodeJS.ProcessEnv; argv: readonly string[]; listening?: readonly string[] }) {
  if (!devHeaderIdentityEnabled(input.env)) return null;
  if (input.env.NODE_ENV === "production") return "CONTROL_PLANE_DEV_HEADER_IDENTITY=true conflicts with NODE_ENV=production";
  const declared = [input.env.HOSTNAME?.trim(), hostnameFromArgv(input.argv)?.trim()].filter((value): value is string => Boolean(value));
  if (!declared.length) return "CONTROL_PLANE_DEV_HEADER_IDENTITY=true requires a loopback HOSTNAME or --hostname; neither is set, so the server listens on all interfaces";
  for (const address of [...declared, ...(input.listening ?? [])]) {
    if (!isLoopbackAddress(address)) return `CONTROL_PLANE_DEV_HEADER_IDENTITY=true but the listening address ${address} is not a loopback address`;
  }
  return null;
}

// Addresses of the net.Server instances this process is listening on, or
// undefined when the runtime does not expose its active handles.
export function listeningAddresses(): string[] | undefined {
  const getActiveHandles = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles;
  if (typeof getActiveHandles !== "function") return undefined;
  return getActiveHandles.call(process).flatMap((handle) => {
    if (!(handle instanceof net.Server) || !handle.listening) return [];
    const address = handle.address();
    return address && typeof address === "object" ? [address.address] : [];
  });
}

// Called from instrumentation register(), before the first request is handled.
export function enforceDevIdentityStartupGuard() {
  const violation = devIdentityViolation({ env: process.env, argv: process.argv, listening: listeningAddresses() });
  if (!violation) return;
  writeSync(2, `FATAL ${violation}\n`);
  process.exit(1);
}

// Request-time defence in depth for the same rule.
export function assertDevIdentityPermitted() {
  if (devIdentityViolation({ env: process.env, argv: process.argv })) throw new Response("Development header identity is not permitted in this process", { status: 503, statusText: "dev_identity_forbidden" });
}

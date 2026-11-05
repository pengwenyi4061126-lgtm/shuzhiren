// `npm run dev`: runs `next dev` bound to a loopback address and, unless the
// caller set it explicitly, enables the development request-header identity
// (CONTROL_PLANE_DEV_HEADER_IDENTITY=true). The control plane refuses to start
// with that switch on a non-loopback address, so `npm run dev -- -H 0.0.0.0`
// requires CONTROL_PLANE_DEV_HEADER_IDENTITY=false and a configured OIDC issuer.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const args = process.argv.slice(2);
const forwarded = [];
let hostname = "127.0.0.1";
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "-H" || arg === "--hostname") hostname = args[(index += 1)] ?? hostname;
  else if (arg.startsWith("--hostname=")) hostname = arg.slice("--hostname=".length);
  else if (arg.startsWith("-H") && arg.length > 2) hostname = arg.slice(2);
  else forwarded.push(arg);
}

const env = { ...process.env, HOSTNAME: hostname };
if (env.CONTROL_PLANE_DEV_HEADER_IDENTITY === undefined) env.CONTROL_PLANE_DEV_HEADER_IDENTITY = "true";

const nextBin = createRequire(import.meta.url).resolve("next/dist/bin/next");
const child = spawn(process.execPath, [nextBin, "dev", "-H", hostname, ...forwarded], { stdio: "inherit", env });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));

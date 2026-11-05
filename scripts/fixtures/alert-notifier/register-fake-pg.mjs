// Loaded with `node --import` by scripts/test-alert-notifier.mjs. It resolves the `pg` package to fake-pg.mjs,
// so apps/alert-notifier/index.mjs runs unchanged against an in-process stand-in for PostgreSQL.
import { register } from "node:module";

const fakePg = new URL("./fake-pg.mjs", import.meta.url).href;
const hooks = `export async function resolve(specifier, context, nextResolve) {
  return specifier === "pg" ? { url: ${JSON.stringify(fakePg)}, shortCircuit: true } : nextResolve(specifier, context);
}`;
register(`data:text/javascript,${encodeURIComponent(hooks)}`);

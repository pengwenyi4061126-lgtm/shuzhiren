// Loaded with `node --import` so that `import pg from "pg"` inside apps/channel-adapter resolves to the
// in-memory fake. This lets scripts/test-channel-adapter.mjs start the real index.mjs without PostgreSQL.
import { register } from "node:module";

register(new URL("./fake-pg-hooks.mjs", import.meta.url));

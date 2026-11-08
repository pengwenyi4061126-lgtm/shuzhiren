import { readFile } from "node:fs/promises";
import { configFromEnv, initializeDevelopmentBucket } from "./server.mjs";

if (process.env.NODE_ENV !== "development" || process.env.MEDIA_EVIDENCE_ALLOW_INSECURE_INTERNAL_ENDPOINT !== "true") {
  throw new Error("development_bucket_initializer_requires_explicit_development_mode");
}

const config = configFromEnv();
const corsConfiguration = await readFile("/etc/minio/dev-media-cors.xml", "utf8");
let lastError;
for (let attempt = 0; attempt < 30; attempt++) {
  try {
    await initializeDevelopmentBucket(config, fetch, corsConfiguration);
    console.log("Development media bucket is versioned and ready");
    process.exit(0);
  } catch (error) {
    lastError = error;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}
console.error(lastError instanceof Error ? lastError.message : "development_media_bucket_initialization_failed");
process.exit(1);

import { readFile } from "node:fs/promises";

const files = {
  workflow: "../.github/workflows/release.yml",
  cosyvoice: "../runtime/cosyvoice/Dockerfile",
  cosyvoiceIgnore: "../runtime/cosyvoice/Dockerfile.dockerignore",
  assembler: "../scripts/assemble-release-evidence.mjs",
  result: "../scripts/write-release-image-result.mjs"
};
const contents = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([name, file]) => [name, await readFile(new URL(file, import.meta.url), "utf8")])));
for (const source of ["workflow_dispatch:", "github.ref_protected", "docker/login-action@v3", "docker/setup-buildx-action@v3", "docker/build-push-action@v6", "platforms: linux/amd64", "push: true", "sbom: true", "provenance: mode=max", "org.opencontainers.image.revision=${{ github.sha }}", "actions/upload-artifact@v4", "actions/download-artifact@v4", "self-hosted", "shuzhiren-release", "create-deployment-release-manifest.mjs"]) {
  if (!contents.workflow.includes(source)) throw new Error(`Release workflow must retain protected ten-image publishing and signing control: ${source}`);
}
for (const key of ["CONTROL_PLANE_IMAGE", "CONTROL_PLANE_MIGRATOR_IMAGE", "RUNTIME_GATEWAY_IMAGE", "RUNTIME_WORKER_IMAGE", "RUNTIME_OBSERVER_IMAGE", "OUTPUT_PROBE_IMAGE", "CHANNEL_ADAPTER_IMAGE", "ALERT_NOTIFIER_IMAGE", "LIVETALKING_IMAGE", "COSYVOICE_IMAGE"]) {
  if (!contents.workflow.includes(`key: ${key}`)) throw new Error(`Release workflow must publish ${key}`);
}
for (const source of ["COPY --chown=cosyvoice:cosyvoice vendor/CosyVoice /opt/CosyVoice/CosyVoice", "MINIFORGE_SHA256", "sha256sum -c", "USER cosyvoice", "org.opencontainers.image.revision"]) {
  if (!contents.cosyvoice.includes(source)) throw new Error(`CosyVoice release image must retain controlled source and non-root execution: ${source}`);
}
for (const source of ["vendor/*", "!vendor/CosyVoice", "vendor/CosyVoice/.git", "models", "weights", "secrets"]) {
  if (!contents.cosyvoiceIgnore.includes(source)) throw new Error(`CosyVoice build context must exclude unsafe local content: ${source}`);
}
for (const source of ["oci-buildx-sbom-index", "oci-buildx-provenance-index", "release image results must contain exactly ten files"]) {
  if (!contents.assembler.includes(source)) throw new Error(`Release evidence assembly must bind all Buildx attestations: ${source}`);
}
for (const source of ["oci-buildx-attached", "--digest", "--revision"]) {
  if (!contents.result.includes(source)) throw new Error(`Release image result must bind pushed digest and revision: ${source}`);
}

console.log("PASS  protected release workflow publishes ten attested image targets and a signed release envelope");

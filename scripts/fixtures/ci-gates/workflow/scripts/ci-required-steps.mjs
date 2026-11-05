// Fixture CI_ONLY_STEPS for scripts/check-ci-workflow.mjs tests (data only;
// rule W6 imports it from <root>/scripts/).
const NO_DOCKER = "fixture: no Docker";
const NO_POSTGRES = "fixture: no PostgreSQL";

export const CI_ONLY_STEPS = Object.freeze([
  { job: "static-gates", command: "bash -n scripts/backup.sh", localReason: "fixture: bash checks are CI-only", label: "static" },
  { job: "python-gateway", command: "python3 -m pip install --disable-pip-version-check --no-cache-dir --require-hashes -r runtime/gateway/requirements.lock", localReason: "fixture: no Python", label: "static" },
  { job: "postgres-integration", command: "npm run db:migrate", localReason: NO_POSTGRES, label: "behavioral" },
  { job: "postgres-integration", command: "npm run db:migrate:integrity:test", localReason: NO_POSTGRES, label: "behavioral" },
  { job: "postgres-integration", command: "npm run service-principals:integration", localReason: NO_POSTGRES, label: "behavioral" },
  { job: "postgres-integration", command: "npm run db:migrate:lock:test", localReason: NO_POSTGRES, label: "behavioral" },
  { job: "postgres-integration", command: "npm run db:verify -- --allow-privileged", localReason: NO_POSTGRES, label: "behavioral" },
  { job: "postgres-integration", command: "npm run control-plane:integration", localReason: NO_POSTGRES, label: "behavioral" },
  { job: "compose-render", command: "docker compose --env-file config/control-plane-compose.example.env -f infra/compose/docker-compose.control-plane.yml config", localReason: NO_DOCKER, label: "static" },
  { job: "compose-render", command: "docker compose --env-file config/runtime.example.env --env-file config/runtime-gateway.example.env --env-file config/channel-adapter.example.env --env-file config/alert-notifier.example.env --profile output-probe --profile channel-adapter --profile alert-notifier --profile cosyvoice -f infra/compose/docker-compose.runtime.yml config", localReason: NO_DOCKER, label: "static" },
  { job: "docker-build", command: "docker build --file apps/console/Dockerfile --tag fixture-console-ci .", localReason: NO_DOCKER, label: "static" },
  { job: "docker-build", command: "docker build --file apps/console/Dockerfile --target migrator --tag fixture-console-migrator-ci .", localReason: NO_DOCKER, label: "static" },
  { job: "docker-build", command: "docker build --file apps/worker/Dockerfile --tag fixture-worker-ci .", localReason: NO_DOCKER, label: "static" },
  { job: "docker-build", command: "docker build --file runtime/gateway/Dockerfile --tag fixture-gateway-ci runtime/gateway", localReason: NO_DOCKER, label: "static" },
  { job: "docker-build", command: "docker build --load --file runtime/livetalking/Dockerfile --tag fixture/livetalking:ci .", localReason: NO_DOCKER, label: "static" },
  { job: "docker-build", command: "docker build --file runtime/cosyvoice/Dockerfile --build-arg MINIFORGE_URL=\"$url\" --build-arg MINIFORGE_SHA256=\"$sha\" --tag fixture-cosyvoice-ci .", localReason: NO_DOCKER, label: "static" }
]);

// CI verification steps that no Local_Verification check covers, with the
// reason each one does not run on the Windows development machine
// (Requirement 1.13, 4.5) and its static/behavioral label (Requirement 36.13).
// `job` is the ci.yml job id that contains the step; `command` is the step's
// command line with runs of whitespace collapsed.
import { CHECK_LABELS, covers } from "./verify-local-checks.mjs";
import { commands, jobs, steps } from "./lib/workflow-model.mjs";

/** @typedef {{ job: string, command: string, localReason: string, label: "static"|"behavioral" }} CiOnlyStep */

const NOT_A_LOCAL_CHECK_KIND = "Local_Verification 只收录 Requirement 2.2 定义了覆盖判定的 npm、node --check、Python 与 py_compile 检查，不含 bash 检查";
const NO_DOCKER = "本机缺少 Docker";
const NO_POSTGRES = "本机缺少 PostgreSQL";

/** @type {readonly CiOnlyStep[]} */
export const CI_ONLY_STEPS = Object.freeze([
  { job: "static-gates", command: "npm run ci:action-pins:verify", localReason: "需要访问 github.com 的网络（Local_Verification 不访问网络）", label: "static" },
  { job: "static-gates", command: "bash -n scripts/check-runtime-host.sh", localReason: NOT_A_LOCAL_CHECK_KIND, label: "static" },
  { job: "static-gates", command: "bash -n scripts/backup-postgres.sh", localReason: NOT_A_LOCAL_CHECK_KIND, label: "static" },
  { job: "static-gates", command: "bash -n scripts/test-postgres-backup-direct.sh", localReason: NOT_A_LOCAL_CHECK_KIND, label: "static" },
  { job: "static-gates", command: "bash -n scripts/restore-postgres-drill.sh", localReason: NOT_A_LOCAL_CHECK_KIND, label: "static" },
  { job: "static-gates", command: "bash -n scripts/test-postgres-restore-drill.sh", localReason: NOT_A_LOCAL_CHECK_KIND, label: "static" },
  { job: "static-gates", command: "bash -n scripts/backup-runtime-gateway-state.sh", localReason: NOT_A_LOCAL_CHECK_KIND, label: "static" },
  { job: "static-gates", command: "bash -n scripts/restore-runtime-gateway-state-drill.sh", localReason: NOT_A_LOCAL_CHECK_KIND, label: "static" },
  { job: "static-gates", command: "bash -n scripts/verify-postgres-backup.sh", localReason: NOT_A_LOCAL_CHECK_KIND, label: "static" },
  { job: "static-gates", command: "bash -n scripts/verify-runtime-gateway-state-backup.sh", localReason: NOT_A_LOCAL_CHECK_KIND, label: "static" },
  { job: "static-gates", command: "bash scripts/check-runtime-host.sh --help", localReason: NOT_A_LOCAL_CHECK_KIND, label: "static" },
  { job: "node-unit", command: "bash scripts/test-postgres-backup-direct.sh", localReason: "本机缺少 Linux shell 环境（flock）", label: "behavioral" },
  { job: "python-gateway", command: "python3 -m pip install --disable-pip-version-check --no-cache-dir --require-hashes -r runtime/gateway/requirements.lock", localReason: "本机缺少 Python 3", label: "static" },
  { job: "postgres-integration", command: "npm run db:migrate", localReason: NO_POSTGRES, label: "behavioral" },
  { job: "postgres-integration", command: "npm run db:migrate:integrity:test", localReason: NO_POSTGRES, label: "behavioral" },
  { job: "postgres-integration", command: "npm run service-principals:integration", localReason: NO_POSTGRES, label: "behavioral" },
  { job: "postgres-integration", command: "npm run db:migrate:lock:test", localReason: NO_POSTGRES, label: "behavioral" },
  { job: "postgres-integration", command: "npm run db:migrate:owner-model:test", localReason: NO_POSTGRES, label: "behavioral" },
  { job: "postgres-integration", command: "npm run postgres:integration", localReason: NO_POSTGRES, label: "behavioral" },
  { job: "postgres-integration", command: "npm run db:verify -- --allow-privileged", localReason: NO_POSTGRES, label: "behavioral" },
  { job: "postgres-integration", command: "npm run control-plane:integration", localReason: NO_POSTGRES, label: "behavioral" },
  { job: "compose-render", command: "docker compose --env-file config/control-plane-compose.example.env -f infra/compose/docker-compose.control-plane.yml config", localReason: NO_DOCKER, label: "static" },
  { job: "compose-render", command: "docker compose --env-file config/runtime.example.env --env-file config/runtime-gateway.example.env --env-file config/channel-adapter.example.env --env-file config/alert-notifier.example.env --profile output-probe --profile channel-adapter --profile alert-notifier --profile cosyvoice -f infra/compose/docker-compose.runtime.yml config", localReason: NO_DOCKER, label: "static" },
  { job: "docker-build", command: "docker build --file apps/console/Dockerfile --tag shuzhiren-control-plane-ci .", localReason: NO_DOCKER, label: "static" },
  { job: "docker-build", command: "docker build --file apps/console/Dockerfile --target migrator --tag shuzhiren-control-plane-migrator-ci .", localReason: NO_DOCKER, label: "static" },
  { job: "docker-build", command: "docker build --file apps/runtime-worker/Dockerfile --tag shuzhiren-runtime-worker-ci .", localReason: NO_DOCKER, label: "static" },
  // Requirement 2.8 (live-commerce-p1-features): the worker image resolves ../console/lib/shared/ at run time.
  { job: "docker-build", command: "docker run --rm --entrypoint node shuzhiren-runtime-worker-ci --input-type=module -e \"await import('/app/apps/runtime-worker/interaction-rules.mjs')\"", localReason: NO_DOCKER, label: "behavioral" },
  { job: "docker-build", command: "docker build --file apps/runtime-observer/Dockerfile --tag shuzhiren-runtime-observer-ci .", localReason: NO_DOCKER, label: "static" },
  { job: "docker-build", command: "docker build --file apps/output-probe/Dockerfile --tag shuzhiren-output-probe-ci .", localReason: NO_DOCKER, label: "static" },
  { job: "docker-build", command: "docker build --file apps/channel-adapter/Dockerfile --tag shuzhiren-channel-adapter-ci .", localReason: NO_DOCKER, label: "static" },
  { job: "docker-build", command: "docker build --file apps/alert-notifier/Dockerfile --tag shuzhiren-alert-notifier-ci .", localReason: NO_DOCKER, label: "static" },
  { job: "docker-build", command: "docker build --file runtime/gateway/Dockerfile --tag shuzhiren-runtime-gateway-ci runtime/gateway", localReason: NO_DOCKER, label: "static" },
  { job: "docker-build", command: "docker build --load --file runtime/livetalking/Dockerfile --tag shuzhiren/livetalking:ci .", localReason: NO_DOCKER, label: "static" },
  // Requirement 6.19 (live-commerce-p1-features): the image built from the patch series imports the overlay module.
  { job: "docker-build", command: "docker run --rm --entrypoint python3 shuzhiren/livetalking:ci -c \"import shuzhiren_overlay\"", localReason: NO_DOCKER, label: "behavioral" },
  // L18 (Requirement 39.10, 39.12-39.14): license, NOTICE and modification notice files inside the built images.
  { job: "docker-build", command: "node scripts/check-runtime-image-licenses.mjs --livetalking-image shuzhiren/livetalking:ci", localReason: NO_DOCKER, label: "static" },
  { job: "docker-build", command: "docker build --file runtime/cosyvoice/Dockerfile --build-arg MINIFORGE_URL=\"$url\" --build-arg MINIFORGE_SHA256=\"$sha\" --tag shuzhiren-cosyvoice-ci .", localReason: NO_DOCKER, label: "static" },
  { job: "docker-build", command: "node scripts/check-runtime-image-licenses.mjs --cosyvoice-image shuzhiren-cosyvoice-ci", localReason: NO_DOCKER, label: "static" }
].map((step) => Object.freeze(step)));

const isNonEmptyString = (value) => typeof value === "string" && value.trim() !== "";
const collapse = (command) => command.replace(/\s+/g, " ").trim();

/**
 * Structural validation: non-empty `job`, `command` and `localReason`, exactly
 * one `label` from CHECK_LABELS, and no repeated (job, command) pair.
 * @returns {string[]} one message per problem; empty when the list is valid.
 */
export function validateCiOnlySteps(list) {
  if (!Array.isArray(list)) return ["CI_ONLY_STEPS is not an array"];
  const errors = [];
  const seen = new Set();
  list.forEach((step, index) => {
    const where = `CI_ONLY_STEPS[${index}]`;
    if (step === null || typeof step !== "object") {
      errors.push(`${where} is not an object`);
      return;
    }
    for (const field of ["job", "command", "localReason"]) {
      if (!isNonEmptyString(step[field])) errors.push(`${where} has no ${field}`);
    }
    if (!CHECK_LABELS.includes(step.label)) errors.push(`${where} label must be exactly one of ${CHECK_LABELS.join(", ")}`);
    if (isNonEmptyString(step.job) && isNonEmptyString(step.command)) {
      const key = `${step.job}\u0000${collapse(step.command)}`;
      if (seen.has(key)) errors.push(`${where} duplicates ${step.job} ${step.command}`);
      seen.add(key);
    }
  });
  return errors;
}

/** The CI_ONLY_STEPS entry registered for a step of `jobId` with the given command lines. */
export function findCiOnlyStep(jobId, stepCommands, list = CI_ONLY_STEPS) {
  return list.find((entry) => entry.job === jobId && stepCommands.includes(collapse(entry.command)));
}

export const GATEWAY_NOT_ENABLED = "未启用 --with-gateway";
export const UNREGISTERED_REASON = "未在 scripts/ci-required-steps.mjs 登记本机未执行原因";

/**
 * CI verification steps that none of `executedChecks` covers, in workflow
 * order. The reason is "未启用 --with-gateway" when the step covers one of
 * `skippedChecks`, otherwise the registered localReason.
 * @returns {Array<{ job: string, index: number, command: string, reason: string }>}
 */
export function notRunCiSteps({ workflow, executedChecks, skippedChecks = [], ciOnlySteps = CI_ONLY_STEPS, scripts = {}, root = process.cwd() }) {
  const context = { scripts, root };
  const coveredBy = (lines, checks) => checks.find((check) => lines.some((line) => covers(line, check, context)));
  const result = [];
  for (const job of jobs(workflow)) {
    for (const step of steps(job)) {
      if (step.isPreparation) continue;
      const lines = commands(step);
      if (lines.length === 0 || coveredBy(lines, executedChecks)) continue;
      const registered = findCiOnlyStep(job.id, lines, ciOnlySteps);
      const reason = coveredBy(lines, skippedChecks) ? GATEWAY_NOT_ENABLED : registered ? registered.localReason : UNREGISTERED_REASON;
      const command = registered ? collapse(registered.command) : lines.length === 1 ? lines[0] : step.name ?? lines.join(" ; ");
      result.push({ job: job.id, index: step.index, command, reason });
    }
  }
  return result;
}

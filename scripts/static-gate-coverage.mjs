// Which Behavioral_Tests cover each Static_Gate (Requirement 36.14; design
// part 8 §2.1 "Verification_Report 中的标签与静态门禁覆盖").
//
// Data only: scripts/lib/verification-log.mjs evaluates this file as it was in
// a given commit (`git show <sha>:scripts/static-gate-coverage.mjs`) from a
// data: URL, so it must not import anything.
//
// Keys: every LOCAL_CHECKS check labeled static whose package.json script runs
// `node scripts/check-*.mjs`. Values: { test, case } where `test` is an npm
// script name or a test file path of a behavioral check (LOCAL_CHECKS or
// CI_ONLY_STEPS) and `case` names what the test executes. A test is listed
// only when it runs the function or code path whose text the gate matches (or
// the gate itself) and asserts the result. `[]` means no such test exists yet;
// the commit that adds one updates the entry. scripts/check-test-registries.mjs
// checks the keys and values.
export const STATIC_GATE_COVERAGE = Object.freeze({
  "deploy:check": [{ test: "deploy:check:test", case: "spawns scripts/check-deployment-config.mjs on generated valid and invalid deployment trees and asserts its exit code and errors" }],
  "release:workflow:check": [{ test: "release:workflow:gate:test", case: "runs the scripts/check-release-workflow.mjs rules on fixture workflows (RUN_INPUT_INTERPOLATION and the other release gate errors)" }],
  "backup:automation:check": [
    { test: "backup:restore:drill:test", case: "executes scripts/restore-postgres-drill.sh with PostgreSQL client stand-ins and asserts its guardrails" },
    { test: "scripts/test-postgres-backup-direct.sh", case: "executes scripts/backup-postgres.sh with PostgreSQL client stand-ins and asserts its outputs and refusals" }
  ],
  "control-plane:compose:check": [],
  "runtime:compose:check": [{ test: "deploy:check:test", case: "asserts checkComposePorts, checkObserverCredentials, checkRuntimeComposeIsolation, checkTemplateRequirements and liveTalkingTtsComposeProblems of scripts/lib/runtime-compose-consistency.mjs, which the gate calls" }],
  "console:page-auth:check": [],
  "console:security-headers:check": [],
  "console:client-requests:check": [],
  "membership:authz:check": [],
  "membership:scopes:check": [],
  "governance:tenant-scope:check": [],
  "governance:immutability:check": [{ test: "db:verify", case: "verifyGovernedEvidenceImmutability updates and deletes governed evidence rows in PostgreSQL and asserts the triggers reject them" }],
  "program:revisions:check": [],
  "program:runtime-scripts:check": [],
  "runtime:program-transition:check": [],
  "control-room:program-transition:check": [],
  "runtime:program-output:check": [],
  "preflight:check": [],
  "shared:modules:check": [],
  "lifecycle:authz:check": [],
  "command:confirmation:check": [],
  "service-ingest:auth:check": [],
  "service-principals:check": [{ test: "service-principals:integration", case: "applies infra/postgres/service-principals.sql to PostgreSQL and asserts has_table_privilege for each service principal" }],
  "start:ack:check": [],
  "runtime:watchdog:check": [{ test: "control-plane:integration", case: "stale runtime telemetry opens a runtime_telemetry_stale alert and writes a runtime_guard.degraded audit event" }],
  "runtime:outbox:check": [],
  "runtime:telemetry-alerts:check": [],
  "entitlement:check": [],
  "runtime:media:check": [],
  "runtime:voice:check": [],
  "runtime:journal:check": [{ test: "scripts/test-runtime-gateway-concurrency.py", case: "drives runtime/gateway/app.py through reserved, completed, failed_definite and uncertain journal states and asserts the replies and the SQLite rows" }],
  "runtime:preview:check": [],
  "media:evidence:check": [{ test: "media:evidence:service:test", case: "issues tenant-bound upload grants, verifies stored bytes and versioned evidence, and binds signed downloads to the exact object version" }],
  "recording:evidence:check": [],
  "runtime:images:check": [{ test: "deploy:images:test", case: "asserts the dockerfile-refs, node-runtime and npm-lock functions that scripts/check-runtime-service-images.mjs calls" }],
  "runtime:images:licenses:check": [{ test: "runtime:images:licenses:test", case: "runs scripts/check-runtime-image-licenses.mjs --static and asserts scripts/lib/runtime-image-licenses.mjs on throw-away fixture trees and in-memory image readers" }],
  "output-probe:response:check": [],
  "channel:verification:check": [],
  "settlement:reconciliation:check": [],
  "alert-notifier:health:check": [
    { test: "alert-notifier:test", case: "starts apps/alert-notifier/index.mjs on a fake pg and asserts /healthz is 503 before and 200 after a successful polling cycle" },
    { test: "control-plane:integration", case: "the notifier on PostgreSQL reports lastSuccessfulTickAt on its health endpoint" }
  ],
  "ci:coverage:check": [{ test: "ci:gates:test", case: "runs the scripts/check-ci-coverage.mjs rules on fixture workflows and check lists" }],
  "ci:workflow:check": [{ test: "ci:gates:test", case: "runs the scripts/check-ci-workflow.mjs rules W1–W12 on fixture workflows" }],
  "docs:governance:check": [{ test: "docs:governance:test", case: "runs scripts/check-governance-docs.mjs and its libraries on fixture registers and verification logs" }],
  "db:migrations:lint": [{ test: "db:migrations:lint:test", case: "runs scripts/check-migration-lint.mjs rules on fixture migrations" }],
  "db:migrations:lint:extra": [{ test: "db:migrations:lint:test", case: "runs scripts/check-migration-lint.mjs --rules datafix,before-delete-return on fixture migrations and asserts deleteReachesReturnNew" }],
  "regression:registry:check": [{ test: "regression:registry:test", case: "runs scripts/check-test-registries.mjs on registries, coverage maps and workflows that each violate one rule and asserts the exit code and error code" }]
});

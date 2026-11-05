// Machine-readable map from audit issues to their regression tests
// (Requirement 7.11–7.13, 36.1–36.4; design part 8 §2.1 "回归测试登记表").
// scripts/regression-evidence.mjs reads it to produce the "修复前失败" and
// "修复后通过" evidence; scripts/check-test-registries.mjs checks it.
//
// One entry per (issue, regression test) for every docs/AUDIT_REGISTER.md record
// whose 修复 has a 提交 and a 回归测试 that can run on the fix's first parent:
// the test imports only modules that exist in the parent plus the files in
// `files`. Tests that need product code introduced by the fix (for example a
// new scripts/lib module or a new apps/** module) are not registered.
//
// RegressionEntry fields:
//   issue         audit id (C/H/M/L/N + number), as in docs/AUDIT_REGISTER.md
//   requirement   the record's 对应需求, comma separated
//   fixCommit     full SHA of the record's 修复.提交
//   registerTest  the exact 修复.回归测试 item this entry runs
//   label         static | behavioral (LOCAL_CHECKS / CI_ONLY_STEPS label of the check)
//   run.kind      node | integration | python | npm
//                   node        node <target> [args]; node:test files run with --test and the regression reporter
//                   integration as node, needs DATABASE_URL; run.prepare runs first, run.env is added
//                   python      python3 <target> [args]
//                   npm         npm run <target> [-- args]
//   run.nodeModules "install": npm ci in the worktree instead of linking node_modules
//                 (entries whose preparation runs next build)
//   run.target    repository-relative test file (npm: script name)
//   assertion     substring of the failing test name / assertion message expected on
//                 the parent; null when not pinned yet (the run is reported, but an
//                 assertion failure without a pinned assertion is not evidence)
//   files         the test and the fixtures that the fix added or changed; parent mode
//                 overlays them from fixCommit
//   job           ci.yml job that runs the test on every commit (Requirement 36.4)
//
// New entries are added in the commit that fixes the issue.

function deepFreeze(value) {
  if (value && typeof value === "object") for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

export const REGRESSIONS = Object.freeze([
  {
    issue: "C1", requirement: "8, 10, 36", fixCommit: "f35eb3053ee468adfcd79a151ec2e5fc887b572d",
    registerTest: "npm run db:verify -- --allow-privileged", label: "behavioral", job: "postgres-integration",
    run: { kind: "integration", target: "scripts/verify-postgres-schema.mjs", args: ["--allow-privileged"], prepare: [["npm","run","db:migrate"]] },
    assertion: null,
    files: ["scripts/verify-postgres-schema.mjs"]
  },
  {
    issue: "C2", requirement: "9, 10, 36", fixCommit: "416df392aa1c574b7f4a04a640752a1c297dce61",
    registerTest: "npm run db:verify -- --allow-privileged", label: "behavioral", job: "postgres-integration",
    run: { kind: "integration", target: "scripts/verify-postgres-schema.mjs", args: ["--allow-privileged"], prepare: [["npm","run","db:migrate"]] },
    assertion: null,
    files: ["scripts/verify-postgres-schema.mjs"]
  },
  {
    issue: "C3", requirement: "11, 36", fixCommit: "39ebbc000f1604be0748ac038516d6e560dca575",
    registerTest: "npm run alert-notifier:test", label: "behavioral", job: "node-unit",
    run: { kind: "node", target: "scripts/test-alert-notifier.mjs" },
    assertion: "/healthz to return 200 after a polling cycle",
    files: ["scripts/test-alert-notifier.mjs","scripts/fixtures/alert-notifier/fake-pg.mjs","scripts/fixtures/alert-notifier/register-fake-pg.mjs"]
  },
  {
    issue: "H1", requirement: "13", fixCommit: "2e010f0ed958a6096f46bf439a1e1be21034e502",
    registerTest: "npm run release:workflow:gate:test", label: "behavioral", job: "node-unit",
    run: { kind: "node", target: "scripts/test-release-workflow-gate.mjs" },
    assertion: "fails with RUN_INPUT_INTERPOLATION when a run: step interpolates a workflow input",
    files: ["scripts/test-release-workflow-gate.mjs","scripts/fixtures/release-workflow/pinned.yml"]
  },
  {
    issue: "H3", requirement: "15", fixCommit: "261e260a219168760439f426365943d7342ada3a",
    registerTest: "npm run deploy:check:test", label: "behavioral", job: "node-unit",
    run: { kind: "node", target: "scripts/test-deployment-config.mjs" },
    assertion: null,
    files: ["scripts/test-deployment-config.mjs"]
  },
  {
    issue: "H3", requirement: "15", fixCommit: "261e260a219168760439f426365943d7342ada3a",
    registerTest: "npm run control-plane:integration", label: "behavioral", job: "postgres-integration",
    run: { kind: "integration", target: "scripts/test-control-plane-postgres.mjs", prepare: [["npm","run","db:migrate"],["npm","run","build"]], env: {"RUN_CONTROL_PLANE_INTEGRATION_TESTS":"true"}, nodeModules: "install" },
    assertion: null,
    files: ["scripts/test-control-plane-postgres.mjs"]
  },
  {
    issue: "H4", requirement: "16", fixCommit: "a9c34203781318158b1a2795e430435f55dca6e4",
    registerTest: "npm run control-plane:integration", label: "behavioral", job: "postgres-integration",
    run: { kind: "integration", target: "scripts/test-control-plane-postgres.mjs", prepare: [["npm","run","db:migrate"],["npm","run","build"]], env: {"RUN_CONTROL_PLANE_INTEGRATION_TESTS":"true"}, nodeModules: "install" },
    assertion: null,
    files: ["scripts/test-control-plane-postgres.mjs"]
  },
  {
    issue: "H5", requirement: "17", fixCommit: "1f1846fccd5fa68fd9b90eab93dd9a381f1f5c47",
    registerTest: "npm run output-probe:config:test", label: "behavioral", job: "node-unit",
    run: { kind: "node", target: "scripts/test-output-probe-config.mjs" },
    assertion: "GET // (anonymous) must receive a complete response",
    files: ["scripts/test-output-probe-config.mjs"]
  },
  {
    issue: "H7", requirement: "19", fixCommit: "333f685994f3304862160511c9cd2bb8f71ddc2c",
    registerTest: "python3 scripts/test-runtime-gateway-concurrency.py", label: "behavioral", job: "python-gateway",
    run: { kind: "python", target: "scripts/test-runtime-gateway-concurrency.py" },
    assertion: null,
    files: ["scripts/test-runtime-gateway-concurrency.py"]
  },
  {
    issue: "H7", requirement: "19", fixCommit: "333f685994f3304862160511c9cd2bb8f71ddc2c",
    registerTest: "npm run control-plane:integration", label: "behavioral", job: "postgres-integration",
    run: { kind: "integration", target: "scripts/test-control-plane-postgres.mjs", prepare: [["npm","run","db:migrate"],["npm","run","build"]], env: {"RUN_CONTROL_PLANE_INTEGRATION_TESTS":"true"}, nodeModules: "install" },
    assertion: null,
    files: ["scripts/test-control-plane-postgres.mjs"]
  },
  {
    issue: "M1", requirement: "20", fixCommit: "34236ef4bcc65292dbb4d1f53d0ade3c9ffaaf96",
    registerTest: "npm run control-plane:integration", label: "behavioral", job: "postgres-integration",
    run: { kind: "integration", target: "scripts/test-control-plane-postgres.mjs", prepare: [["npm","run","db:migrate"],["npm","run","build"]], env: {"RUN_CONTROL_PLANE_INTEGRATION_TESTS":"true"}, nodeModules: "install" },
    assertion: null,
    files: ["scripts/test-control-plane-postgres.mjs"]
  },
  {
    issue: "M2", requirement: "21", fixCommit: "3da13246827be11c20adf7df7e86836e2d5be254",
    registerTest: "npm run preflight:check", label: "static", job: "static-gates",
    run: { kind: "node", target: "scripts/check-preflight-runtime-readiness.mjs" },
    assertion: "preflight took a second pooled connection",
    files: ["scripts/check-preflight-runtime-readiness.mjs"]
  },
  {
    issue: "M3", requirement: "22", fixCommit: "2e6a81acc316e58a6905441986e36587fa704ca2",
    registerTest: "npm run channel-adapter:test", label: "behavioral", job: "node-unit",
    run: { kind: "node", target: "scripts/test-channel-adapter.mjs" },
    assertion: "channel adapter must survive the termination of an idle database connection",
    files: ["scripts/test-channel-adapter.mjs","scripts/fixtures/channel-adapter/fake-pg.mjs","scripts/fixtures/fake-postgres-server.mjs","scripts/fixtures/pool-error-scenario.mjs"]
  },
  {
    issue: "M3", requirement: "22", fixCommit: "2e6a81acc316e58a6905441986e36587fa704ca2",
    registerTest: "npm run alert-notifier:test", label: "behavioral", job: "node-unit",
    run: { kind: "node", target: "scripts/test-alert-notifier.mjs" },
    assertion: "alert notifier must survive the termination of an idle database connection",
    files: ["scripts/test-alert-notifier.mjs","scripts/fixtures/alert-notifier/fake-pg.mjs","scripts/fixtures/fake-postgres-server.mjs","scripts/fixtures/pool-error-scenario.mjs"]
  },
  {
    issue: "M3", requirement: "22", fixCommit: "2e6a81acc316e58a6905441986e36587fa704ca2",
    registerTest: "npm run preflight:check", label: "static", job: "static-gates",
    run: { kind: "node", target: "scripts/check-preflight-runtime-readiness.mjs" },
    assertion: null,
    files: ["scripts/check-preflight-runtime-readiness.mjs"]
  },
  {
    issue: "M3", requirement: "22", fixCommit: "2e6a81acc316e58a6905441986e36587fa704ca2",
    registerTest: "npm run control-plane:integration", label: "behavioral", job: "postgres-integration",
    run: { kind: "integration", target: "scripts/test-control-plane-postgres.mjs", prepare: [["npm","run","db:migrate"],["npm","run","build"]], env: {"RUN_CONTROL_PLANE_INTEGRATION_TESTS":"true"}, nodeModules: "install" },
    assertion: null,
    files: ["scripts/test-control-plane-postgres.mjs"]
  },
  {
    issue: "M4", requirement: "23", fixCommit: "234265fdb3178727d7975e67578c2b3f71d0e318",
    registerTest: "npm run db:migrate:integrity:test", label: "behavioral", job: "postgres-integration",
    run: { kind: "integration", target: "scripts/test-migration-integrity.mjs", prepare: [["npm","run","db:migrate"]] },
    assertion: null,
    files: ["scripts/test-migration-integrity.mjs"]
  },
  {
    issue: "M5", requirement: "24", fixCommit: "e3bad9bcb3027a8041d8f854328537d5628adea4",
    registerTest: "npm run db:migrate:integrity:test", label: "behavioral", job: "postgres-integration",
    run: { kind: "integration", target: "scripts/test-migration-integrity.mjs", prepare: [["npm","run","db:migrate"]] },
    assertion: null,
    files: ["scripts/test-migration-integrity.mjs"]
  },
  {
    issue: "M6", requirement: "25", fixCommit: "20c79361a8ba3da49a8df943c3d700d0fa4df89d",
    registerTest: "npm run deploy:check:test", label: "behavioral", job: "node-unit",
    run: { kind: "node", target: "scripts/test-deployment-config.mjs" },
    assertion: null,
    files: ["scripts/test-deployment-config.mjs"]
  },
  {
    issue: "M8", requirement: "36", fixCommit: "fb763f5c9a491e45967d4e0e6ede2d84dcdb6363",
    registerTest: "npm run output-probe:response:check", label: "static", job: "static-gates",
    run: { kind: "node", target: "scripts/check-output-probe-response.mjs" },
    assertion: null,
    files: ["scripts/check-output-probe-response.mjs"]
  },
  {
    issue: "M8", requirement: "36", fixCommit: "fb763f5c9a491e45967d4e0e6ede2d84dcdb6363",
    registerTest: "npm run console:client-requests:check", label: "static", job: "static-gates",
    run: { kind: "node", target: "scripts/check-console-client-requests.mjs" },
    assertion: null,
    files: ["scripts/check-console-client-requests.mjs"]
  },
  {
    issue: "M10", requirement: "28", fixCommit: "2d9706653a081482210bfb4bac0d83244cf2bc93",
    registerTest: "npm run control-plane:integration", label: "behavioral", job: "postgres-integration",
    run: { kind: "integration", target: "scripts/test-control-plane-postgres.mjs", prepare: [["npm","run","db:migrate"],["npm","run","build"]], env: {"RUN_CONTROL_PLANE_INTEGRATION_TESTS":"true"}, nodeModules: "install" },
    assertion: null,
    files: ["scripts/test-control-plane-postgres.mjs"]
  },
  {
    issue: "M10", requirement: "28", fixCommit: "2d9706653a081482210bfb4bac0d83244cf2bc93",
    registerTest: "npm run runtime:worker:config:test", label: "static", job: "node-unit",
    run: { kind: "node", target: "scripts/test-runtime-worker-config.mjs" },
    assertion: "runtime worker must bound Gateway command delivery",
    files: ["scripts/test-runtime-worker-config.mjs"]
  },
  {
    issue: "M11", requirement: "28", fixCommit: "f627116550e61d52d62817e5c1417c4783c59e02",
    registerTest: "npm run control-plane:integration", label: "behavioral", job: "postgres-integration",
    run: { kind: "integration", target: "scripts/test-control-plane-postgres.mjs", prepare: [["npm","run","db:migrate"],["npm","run","build"]], env: {"RUN_CONTROL_PLANE_INTEGRATION_TESTS":"true"}, nodeModules: "install" },
    assertion: null,
    files: ["scripts/test-control-plane-postgres.mjs"]
  },
  {
    issue: "M12", requirement: "30", fixCommit: "ba28eabe6a1a5472ca52057db3d52411bf072dcb",
    registerTest: "npm run db:migrate:integrity:test", label: "behavioral", job: "postgres-integration",
    run: { kind: "integration", target: "scripts/test-migration-integrity.mjs", prepare: [["npm","run","db:migrate"]] },
    assertion: null,
    files: ["scripts/test-migration-integrity.mjs"]
  },
  {
    issue: "M13", requirement: "29", fixCommit: "f9bf8dcb3ad2dc44d54d40e62179725fe7d6ea74",
    registerTest: "npm run db:verify -- --allow-privileged", label: "behavioral", job: "postgres-integration",
    run: { kind: "integration", target: "scripts/verify-postgres-schema.mjs", args: ["--allow-privileged"], prepare: [["npm","run","db:migrate"]] },
    assertion: null,
    files: ["scripts/verify-postgres-schema.mjs"]
  },
  {
    issue: "M14", requirement: "29", fixCommit: "13282e5a2f782588daf82312d5336bcd5e5d7ab4",
    registerTest: "npm run control-plane:integration", label: "behavioral", job: "postgres-integration",
    run: { kind: "integration", target: "scripts/test-control-plane-postgres.mjs", prepare: [["npm","run","db:migrate"],["npm","run","build"]], env: {"RUN_CONTROL_PLANE_INTEGRATION_TESTS":"true"}, nodeModules: "install" },
    assertion: null,
    files: ["scripts/test-control-plane-postgres.mjs"]
  },
  {
    issue: "M15", requirement: "30", fixCommit: "806d24a764a797d0afae7d1d1907d8725b061dd3",
    registerTest: "npm run db:verify -- --allow-privileged", label: "behavioral", job: "postgres-integration",
    run: { kind: "integration", target: "scripts/verify-postgres-schema.mjs", args: ["--allow-privileged"], prepare: [["npm","run","db:migrate"]] },
    assertion: null,
    files: ["scripts/verify-postgres-schema.mjs"]
  },
  {
    issue: "M18", requirement: "15, 32", fixCommit: "261e260a219168760439f426365943d7342ada3a",
    registerTest: "npm run deploy:check:test", label: "behavioral", job: "node-unit",
    run: { kind: "node", target: "scripts/test-deployment-config.mjs" },
    assertion: null,
    files: ["scripts/test-deployment-config.mjs"]
  },
  {
    issue: "M19", requirement: "32", fixCommit: "14afbe2f642955509ec244679f7cf2d405422296",
    registerTest: "python3 scripts/test-runtime-gateway-state-backup.py", label: "behavioral", job: "python-gateway",
    run: { kind: "python", target: "scripts/test-runtime-gateway-state-backup.py" },
    assertion: null,
    files: ["scripts/test-runtime-gateway-state-backup.py"]
  },
  {
    issue: "M21", requirement: "34", fixCommit: "4672ebc6b728cfc57d98c07e59c4999e6aeef11c",
    registerTest: "npm run deploy:check:test", label: "behavioral", job: "node-unit",
    run: { kind: "node", target: "scripts/test-deployment-config.mjs" },
    assertion: null,
    files: ["scripts/test-deployment-config.mjs"]
  },
  {
    issue: "M25", requirement: "38", fixCommit: "b80ce32500c72e0f23636d5031736a0234b06636",
    registerTest: "python3 scripts/test-runtime-gateway-concurrency.py", label: "behavioral", job: "python-gateway",
    run: { kind: "python", target: "scripts/test-runtime-gateway-concurrency.py" },
    assertion: "/healthz must answer while a command waits for the journal write lock",
    files: ["scripts/test-runtime-gateway-concurrency.py"]
  },
  {
    issue: "L1", requirement: "17, 37", fixCommit: "38665a8439328f7b7d54a3c906af0203c9e1495a",
    registerTest: "npm run service-ingest:auth:check", label: "static", job: "static-gates",
    run: { kind: "node", target: "scripts/check-service-ingest-auth.mjs" },
    assertion: "tenant service tokens must be compared in constant time",
    files: ["scripts/check-service-ingest-auth.mjs"]
  },
  {
    issue: "L1", requirement: "17, 37", fixCommit: "38665a8439328f7b7d54a3c906af0203c9e1495a",
    registerTest: "npm run output-probe:config:test", label: "behavioral", job: "node-unit",
    run: { kind: "node", target: "scripts/test-output-probe-config.mjs" },
    assertion: null,
    files: ["scripts/test-output-probe-config.mjs"]
  },
  {
    issue: "L2", requirement: "37", fixCommit: "b1f113817fb40dd7a4563a17ccfaef4294ef9d5c",
    registerTest: "npm run control-plane:integration", label: "behavioral", job: "postgres-integration",
    run: { kind: "integration", target: "scripts/test-control-plane-postgres.mjs", prepare: [["npm","run","db:migrate"],["npm","run","build"]], env: {"RUN_CONTROL_PLANE_INTEGRATION_TESTS":"true"}, nodeModules: "install" },
    assertion: null,
    files: ["scripts/test-control-plane-postgres.mjs"]
  },
  {
    issue: "L3", requirement: "37", fixCommit: "c3314791bb03fa7903910a89cbe82bd05fe4268e",
    registerTest: "npm run control-plane:integration", label: "behavioral", job: "postgres-integration",
    run: { kind: "integration", target: "scripts/test-control-plane-postgres.mjs", prepare: [["npm","run","db:migrate"],["npm","run","build"]], env: {"RUN_CONTROL_PLANE_INTEGRATION_TESTS":"true"}, nodeModules: "install" },
    assertion: null,
    files: ["scripts/test-control-plane-postgres.mjs"]
  },
  {
    issue: "L4", requirement: "37", fixCommit: "13f4dd408e95e6a5dbab8e16d73399fe1311316f",
    registerTest: "npm run console:security-headers:check", label: "static", job: "static-gates",
    run: { kind: "node", target: "scripts/check-console-security-headers.mjs" },
    assertion: "a 500 response must not leak its cause to the client",
    files: ["scripts/check-console-security-headers.mjs"]
  },
  {
    issue: "L5", requirement: "34", fixCommit: "c0763c3bbf77a7d62dcff93fa9fcbce20cae7e56",
    registerTest: "npm run deploy:check:test", label: "behavioral", job: "node-unit",
    run: { kind: "node", target: "scripts/test-deployment-config.mjs" },
    assertion: null,
    files: ["scripts/test-deployment-config.mjs"]
  },
  {
    issue: "L6", requirement: "34", fixCommit: "b662f72d54379859f0dbdfb82056b6b9e42bd05d",
    registerTest: "npm run deploy:check:test", label: "behavioral", job: "node-unit",
    run: { kind: "node", target: "scripts/test-deployment-config.mjs" },
    assertion: "a manifest valid for more than 30 days must be rejected",
    files: ["scripts/test-deployment-config.mjs"]
  },
  {
    issue: "L6", requirement: "34", fixCommit: "b662f72d54379859f0dbdfb82056b6b9e42bd05d",
    registerTest: "npm run deploy:manifest:test", label: "behavioral", job: "node-unit",
    run: { kind: "node", target: "scripts/test-deployment-release-manifest.mjs" },
    assertion: null,
    files: ["scripts/test-deployment-release-manifest.mjs"]
  },
  {
    issue: "L8", requirement: "29", fixCommit: "5e1ef6e1e002baf5a80dee96aad471eba0a03261",
    registerTest: "npm run control-plane:integration", label: "behavioral", job: "postgres-integration",
    run: { kind: "integration", target: "scripts/test-control-plane-postgres.mjs", prepare: [["npm","run","db:migrate"],["npm","run","build"]], env: {"RUN_CONTROL_PLANE_INTEGRATION_TESTS":"true"}, nodeModules: "install" },
    assertion: null,
    files: ["scripts/test-control-plane-postgres.mjs"]
  },
  {
    issue: "L9", requirement: "37", fixCommit: "eed87dfce824aa426659dbb8993c18cbdb3c3afa",
    registerTest: "npm run runtime:gateway:config:test", label: "behavioral", job: "python-gateway",
    run: { kind: "python", target: "scripts/test-runtime-gateway-config.py" },
    assertion: "/docs must not be served by Runtime Gateway",
    files: ["scripts/test-runtime-gateway-config.py"]
  },
  {
    issue: "L9", requirement: "37", fixCommit: "eed87dfce824aa426659dbb8993c18cbdb3c3afa",
    registerTest: "npm run runtime:gateway:errors:test", label: "behavioral", job: "python-gateway",
    run: { kind: "python", target: "scripts/test-runtime-gateway-errors.py" },
    assertion: null,
    files: ["scripts/test-runtime-gateway-errors.py"]
  },
  {
    issue: "L13", requirement: "38", fixCommit: "c9f3b683d440c86e7c4a9f4e435dcc7f3fa4c0c8",
    registerTest: "npm run control-plane:compose:check", label: "static", job: "static-gates",
    run: { kind: "node", target: "scripts/check-control-plane-compose.mjs" },
    assertion: "does not name a Compose service",
    files: ["scripts/check-control-plane-compose.mjs"]
  },
  {
    issue: "L14", requirement: "38", fixCommit: "6a6de3c57bd2dca5f1d96e346b9b4fda18f49415",
    registerTest: "npm run backup:automation:check", label: "static", job: "static-gates",
    run: { kind: "node", target: "scripts/check-backup-automation.mjs" },
    assertion: "PostgreSQL backup must support the private production database path",
    files: ["scripts/check-backup-automation.mjs","scripts/test-postgres-backup-direct.sh","scripts/test-postgres-restore-drill.sh"]
  },
  {
    issue: "L15", requirement: "38", fixCommit: "8e97b0f374e5a8c19c7f4efa040bf6f3d6862642",
    registerTest: "npm run db:migrate:lock:test", label: "behavioral", job: "postgres-integration",
    run: { kind: "integration", target: "scripts/test-migration-lock.mjs", prepare: [["npm","run","db:migrate"]] },
    assertion: null,
    files: ["scripts/test-migration-lock.mjs"]
  },
  {
    issue: "L16", requirement: "30", fixCommit: "3fd7235866802e1d36cee8fbc3501f8ef810392f",
    registerTest: "npm run service-principals:integration", label: "behavioral", job: "postgres-integration",
    run: { kind: "integration", target: "scripts/test-service-principal-privileges.mjs", prepare: [["npm","run","db:migrate"]] },
    assertion: null,
    files: ["scripts/test-service-principal-privileges.mjs"]
  },
  {
    issue: "L17", requirement: "39", fixCommit: "013d65d8f32b08653852307d7bb419bcb7e62ed0",
    registerTest: "npm run deploy:check:test", label: "behavioral", job: "node-unit",
    run: { kind: "node", target: "scripts/test-deployment-config.mjs" },
    assertion: null,
    files: ["scripts/test-deployment-config.mjs"]
  },
  {
    issue: "N2", requirement: "8", fixCommit: "e427a45384439d703d02ad22932b40b06602c3db",
    registerTest: "npm run control-plane:integration", label: "behavioral", job: "postgres-integration",
    run: { kind: "integration", target: "scripts/test-control-plane-postgres.mjs", prepare: [["npm","run","db:migrate"],["npm","run","build"]], env: {"RUN_CONTROL_PLANE_INTEGRATION_TESTS":"true"}, nodeModules: "install" },
    assertion: null,
    files: ["scripts/test-control-plane-postgres.mjs"]
  },
  {
    issue: "N3", requirement: "11", fixCommit: "9be485d75569af0a7b13725ba7fec46c12212ddc",
    registerTest: "npm run alert-notifier:test", label: "behavioral", job: "node-unit",
    run: { kind: "node", target: "scripts/test-alert-notifier.mjs" },
    assertion: "/healthz must answer within DATABASE_QUERY_TIMEOUT_MS",
    files: ["scripts/test-alert-notifier.mjs","scripts/fixtures/alert-notifier/fake-pg.mjs"]
  },
  {
    issue: "N4", requirement: "11", fixCommit: "50a36ff56ed7fabcfc34b0cb12ac5a665c06bbb9",
    registerTest: "npm run alert-notifier:test", label: "behavioral", job: "node-unit",
    run: { kind: "node", target: "scripts/test-alert-notifier.mjs" },
    assertion: "a delivery whose final attempt's lease expired must not stay delivering",
    files: ["scripts/test-alert-notifier.mjs","scripts/fixtures/alert-notifier/fake-pg.mjs"]
  },
  {
    issue: "N5", requirement: "无：不属于 Requirement 1 至 40 的验收标准", fixCommit: "ac33f61228207d3a6927635d545622a89d04c2d4",
    registerTest: "npm run control-plane:integration", label: "behavioral", job: "postgres-integration",
    run: { kind: "integration", target: "scripts/test-control-plane-postgres.mjs", prepare: [["npm","run","db:migrate"],["npm","run","build"]], env: {"RUN_CONTROL_PLANE_INTEGRATION_TESTS":"true"}, nodeModules: "install" },
    assertion: null,
    files: ["scripts/test-control-plane-postgres.mjs"]
  },
  {
    issue: "N5", requirement: "无：不属于 Requirement 1 至 40 的验收标准", fixCommit: "ac33f61228207d3a6927635d545622a89d04c2d4",
    registerTest: "npm run media:evidence:check", label: "static", job: "static-gates",
    run: { kind: "node", target: "scripts/check-media-evidence-verification.mjs" },
    assertion: "must audit verifier evidence in their transaction",
    files: ["scripts/check-media-evidence-verification.mjs","scripts/test-control-plane-postgres.mjs"]
  },
  {
    issue: "N5", requirement: "无：不属于 Requirement 1 至 40 的验收标准", fixCommit: "ac33f61228207d3a6927635d545622a89d04c2d4",
    registerTest: "npm run recording:evidence:check", label: "static", job: "static-gates",
    run: { kind: "node", target: "scripts/check-recording-evidence-verification.mjs" },
    assertion: "must not write its audit event outside the registration transaction",
    files: ["scripts/check-recording-evidence-verification.mjs","scripts/test-control-plane-postgres.mjs"]
  },
  {
    issue: "N7", requirement: "1, 2", fixCommit: "16572549bb72d718ad898248fc27e7b74e284e35",
    registerTest: "npm run observer:runtime:test", label: "behavioral", job: "node-unit",
    run: { kind: "node", target: "scripts/test-runtime-observer.mjs" },
    assertion: null,
    files: ["scripts/test-runtime-observer.mjs"]
  },
  {
    issue: "N9", requirement: "40", fixCommit: "734ee8e877723f4042d3a6e1b45ce7548c578671",
    registerTest: "npm run channel-adapter:test", label: "behavioral", job: "node-unit",
    run: { kind: "node", target: "scripts/test-channel-adapter.mjs" },
    assertion: "a malformed reply must be answered instead of dropping the connection",
    files: ["scripts/test-channel-adapter.mjs"]
  },
  {
    issue: "N10", requirement: "无：不属于 Requirement 1 至 40 的验收标准", fixCommit: "4576a01eb4f459919845ad4b7f14c43875bf9ce5",
    registerTest: "npm run control-plane:integration", label: "behavioral", job: "postgres-integration",
    run: { kind: "integration", target: "scripts/test-control-plane-postgres.mjs", prepare: [["npm","run","db:migrate"],["npm","run","build"]], env: {"RUN_CONTROL_PLANE_INTEGRATION_TESTS":"true"}, nodeModules: "install" },
    assertion: null,
    files: ["scripts/test-control-plane-postgres.mjs"]
  },
  {
    issue: "N11", requirement: "无：不属于 Requirement 1 至 40 的验收标准", fixCommit: "e68a3ee24488ac1ba394f58be680c6c1f14c7391",
    registerTest: "npm run control-plane:integration", label: "behavioral", job: "postgres-integration",
    run: { kind: "integration", target: "scripts/test-control-plane-postgres.mjs", prepare: [["npm","run","db:migrate"],["npm","run","build"]], env: {"RUN_CONTROL_PLANE_INTEGRATION_TESTS":"true"}, nodeModules: "install" },
    assertion: null,
    files: ["scripts/test-control-plane-postgres.mjs"]
  },
  {
    issue: "N12", requirement: "无：不属于 Requirement 1 至 40 的验收标准", fixCommit: "8aee413a1a79d1b273993f3588a4dc3f47333117",
    registerTest: "npm run preflight:check", label: "static", job: "static-gates",
    run: { kind: "node", target: "scripts/check-preflight-runtime-readiness.mjs" },
    assertion: "the console pool must return a PostgreSQL date as its YYYY-MM-DD text under TZ=Asia/Shanghai",
    files: ["scripts/check-preflight-runtime-readiness.mjs"]
  },
  {
    issue: "N12", requirement: "无：不属于 Requirement 1 至 40 的验收标准", fixCommit: "8aee413a1a79d1b273993f3588a4dc3f47333117",
    registerTest: "npm run control-plane:integration", label: "behavioral", job: "postgres-integration",
    run: { kind: "integration", target: "scripts/test-control-plane-postgres.mjs", prepare: [["npm","run","db:migrate"],["npm","run","build"]], env: {"RUN_CONTROL_PLANE_INTEGRATION_TESTS":"true"}, nodeModules: "install" },
    assertion: null,
    files: ["scripts/test-control-plane-postgres.mjs"]
  }
].map(deepFreeze));

/** Issues whose 修复 has a commit and a regression test that is not registered, with the reason (kept for reports and the registry gate). */
export const UNREGISTERED = Object.freeze([
  { issue: "C4", registerTest: null, reason: "登记表没有回归测试" },
  { issue: "H2", registerTest: "npm run deploy:check:test", reason: "测试导入或读取父提交 c0763c3 中不存在、且不是测试或夹具的文件：scripts/lib/livetalking-patches.mjs、runtime/patches/livetalking.series" },
  { issue: "H3", registerTest: "python3 scripts/test-runtime-gateway-concurrency.py", reason: "测试调用 runtime/gateway/app.py 中修复提交才加入的 split_script，在父提交 013d65d 上以 AttributeError 结束" },
  { issue: "H3", registerTest: "npm run runtime:gateway:errors:test", reason: "测试使用 runtime/gateway/app.py 中修复提交才加入的 CommandFailure，在父提交 013d65d 上以 AttributeError 结束" },
  { issue: "H5", registerTest: "npm run output-probe:test", reason: "测试导入或读取父提交 39ebbc0 中不存在、且不是测试或夹具的文件：apps/output-probe/handler.mjs" },
  { issue: "H6", registerTest: "npm run channel-adapter:test", reason: "测试导入或读取父提交 50a36ff 中不存在、且不是测试或夹具的文件：apps/channel-adapter/webhook.mjs、apps/channel-adapter/replay-store.mjs" },
  { issue: "M3", registerTest: "npm run runtime:worker:health:test", reason: "测试读取 apps/runtime-worker/db.mjs、apps/channel-adapter/db.mjs、apps/alert-notifier/db.mjs（修复提交新增的产品模块），在父提交 5c67f88 上以 ENOENT 结束" },
  { issue: "M6", registerTest: "npm run console:page-auth:check", reason: "测试导入或读取父提交 41f7591 中不存在、且不是测试或夹具的文件：apps/console/lib/control-plane/dev-identity.ts" },
  { issue: "M7", registerTest: "npm run deploy:check:test", reason: "测试导入或读取父提交 3fd7235 中不存在、且不是测试或夹具的文件：scripts/lib/runtime-compose-consistency.mjs" },
  { issue: "M9", registerTest: "npm run runtime:images:check", reason: "测试导入或读取父提交 39f844c 中不存在、且不是测试或夹具的文件：scripts/lib/dockerfile-refs.mjs、scripts/lib/node-runtime.mjs" },
  { issue: "M9", registerTest: "npm run deploy:images:test", reason: "测试导入或读取父提交 39f844c 中不存在、且不是测试或夹具的文件：scripts/lib/dockerfile-refs.mjs、scripts/lib/node-runtime.mjs" },
  { issue: "M16", registerTest: "npm run console:page-auth:check", reason: "测试导入或读取父提交 13282e5 中不存在、且不是测试或夹具的文件：apps/console/lib/control-plane/oidc.ts" },
  { issue: "M17", registerTest: "npm run runtime:compose:check", reason: "测试导入的 scripts/lib/runtime-compose-consistency.mjs 在父提交 f9bf8dc 中没有 checkRuntimeComposeIsolation 导出（该导出由修复提交加入），在父提交上以 SyntaxError 结束" },
  { issue: "M18", registerTest: "python3 scripts/test-runtime-gateway-concurrency.py", reason: "测试调用 runtime/gateway/app.py 中修复提交才加入的 split_script，在父提交 013d65d 上以 AttributeError 结束" },
  { issue: "M21", registerTest: "npm run release:evidence:test", reason: "测试导入或读取父提交 8e0a644 中不存在、且不是测试或夹具的文件：scripts/lib/release-evidence.mjs" },
  { issue: "M22", registerTest: "npm run control-plane:compose:check", reason: "测试导入或读取父提交 e427a45 中不存在、且不是测试或夹具的文件：config/dev-compose.example.env" },
  { issue: "M23", registerTest: "npm run deploy:check:test", reason: "测试导入或读取父提交 b80ce32 中不存在、且不是测试或夹具的文件：scripts/lib/dockerignore.mjs" },
  { issue: "M23", registerTest: "npm run runtime:images:check", reason: "测试导入或读取父提交 b80ce32 中不存在、且不是测试或夹具的文件：scripts/lib/dockerignore.mjs" },
  { issue: "M23", registerTest: "docker build --load --file runtime/livetalking/Dockerfile --tag shuzhiren/livetalking:ci .", reason: "docker build，不是可在工作树中运行的测试文件" },
  { issue: "M24", registerTest: "npm run runtime:images:check", reason: "测试导入或读取父提交 2c7d5d9 中不存在、且不是测试或夹具的文件：runtime/gateway/requirements.lock" },
  { issue: "M24", registerTest: "npm run ci:workflow:check", reason: "测试导入或读取父提交 2c7d5d9 中不存在、且不是测试或夹具的文件：runtime/gateway/requirements.lock" },
  { issue: "M24", registerTest: "npm run deploy:images:test", reason: "测试导入或读取父提交 2c7d5d9 中不存在、且不是测试或夹具的文件：runtime/gateway/requirements.lock" },
  { issue: "L2", registerTest: "npm run service-ingest:auth:check", reason: "测试导入或读取父提交 14afbe2 中不存在、且不是测试或夹具的文件：apps/console/instrumentation.ts" },
  { issue: "L3", registerTest: "npm run console:security-headers:check", reason: "测试导入或读取父提交 86f90bf 中不存在、且不是测试或夹具的文件：apps/console/lib/csp.ts" },
  { issue: "L5", registerTest: "npm run runtime:program-output:check", reason: "测试导入或读取父提交 d7ac789 中不存在、且不是测试或夹具的文件：apps/console/lib/canonical-json.mjs" },
  { issue: "L7", registerTest: "npm run channel-adapter:test", reason: "夹具 scripts/fixtures/graceful-shutdown-scenarios.mjs 调用修复提交才加入的 installGracefulShutdown（产品模块的新导出），在父提交 a21e0c7 上以 TypeError 结束" },
  { issue: "L7", registerTest: "npm run output-probe:test", reason: "夹具 scripts/fixtures/graceful-shutdown-scenarios.mjs 调用修复提交才加入的 installGracefulShutdown（产品模块的新导出），在父提交 a21e0c7 上以 TypeError 结束" },
  { issue: "L10", registerTest: "npm run runtime:compose:check", reason: "测试导入的 scripts/lib/runtime-compose-consistency.mjs 在父提交 1977e2c 中没有 checkComposePorts 导出（该导出由修复提交加入），在父提交上以 SyntaxError 结束" },
  { issue: "L10", registerTest: "npm run deploy:check:test", reason: "测试导入的 scripts/lib/runtime-compose-consistency.mjs 在父提交 1977e2c 中没有 checkComposePorts 导出（该导出由修复提交加入），在父提交上以 SyntaxError 结束" },
  { issue: "L11", registerTest: "npm run runtime:compose:check", reason: "测试导入的 scripts/lib/runtime-compose-consistency.mjs 在父提交 20c7936 中没有 checkTemplateRequirements 导出（该导出由修复提交加入），在父提交上以 SyntaxError 结束" },
  { issue: "L11", registerTest: "npm run deploy:check:test", reason: "测试导入的 scripts/lib/runtime-compose-consistency.mjs 在父提交 20c7936 中没有 checkTemplateRequirements 导出（该导出由修复提交加入），在父提交上以 SyntaxError 结束" },
  { issue: "L12", registerTest: "npm run backup:automation:check", reason: "测试导入或读取父提交 6a6de3c 中不存在、且不是测试或夹具的文件：config/runtime-gateway-backup.example.env" },
  { issue: "L14", registerTest: "bash scripts/test-postgres-backup-direct.sh", reason: "bash 脚本（需要 Linux shell 与 flock），不在 node/python/integration 类型中" },
  { issue: "L14", registerTest: "bash scripts/test-postgres-restore-drill.sh", reason: "bash 脚本（需要 Linux shell 与 flock），不在 node/python/integration 类型中" },
  { issue: "L17", registerTest: "npm run runtime:images:check", reason: "测试导入或读取父提交 ba28eab 中不存在、且不是测试或夹具的文件：scripts/lib/npm-lock.mjs" },
  { issue: "L17", registerTest: "npm run deploy:images:test", reason: "测试导入或读取父提交 ba28eab 中不存在、且不是测试或夹具的文件：scripts/lib/npm-lock.mjs" },
  { issue: "L18", registerTest: "npm run runtime:images:licenses:test", reason: "测试导入或读取父提交 2109ab8 中不存在、且不是测试或夹具的文件：scripts/lib/runtime-image-licenses.mjs、scripts/check-runtime-image-licenses.mjs" },
  { issue: "N1", registerTest: null, reason: "登记表没有回归测试" },
  { issue: "N6", registerTest: "docker build --load --file runtime/livetalking/Dockerfile --tag shuzhiren/livetalking:ci .", reason: "docker build，不是可在工作树中运行的测试文件" },
  { issue: "N8", registerTest: "docker build runtime/cosyvoice (committed Miniforge pin)", reason: "docker build，不是可在工作树中运行的测试文件" }
].map(deepFreeze));

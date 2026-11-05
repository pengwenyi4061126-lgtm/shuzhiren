// For each Requirement 2.2 rule (a)-(e), one check that ./rules.yml covers
// and one it does not. The npm and Python checks use real package.json
// scripts; the py_compile checks use real files under runtime/gateway/.
export const LOCAL_CHECKS = Object.freeze([
  { id: "a-covered", kind: "npm", script: "deploy:check", args: ["--", "--allow-placeholders"], label: "static" },
  { id: "a-uncovered", kind: "npm", script: "lint", label: "static" },
  { id: "b-covered", kind: "npm", script: "backup:restore:drill:test", label: "behavioral" },
  { id: "b-uncovered", kind: "npm", script: "release:workflow:check", label: "static" },
  { id: "c-covered", kind: "node-check", entry: "apps/runtime-worker/index.mjs", label: "static" },
  { id: "c-uncovered", kind: "node-check", entry: "apps/runtime-observer/index.mjs", label: "static" },
  { id: "d-covered", kind: "python", file: "scripts/test-runtime-gateway-config.py", label: "behavioral", gatewayOnly: true },
  { id: "d-uncovered", kind: "python", file: "scripts/test-runtime-gateway-errors.py", label: "behavioral", gatewayOnly: true },
  { id: "e-covered", kind: "py-compile", files: ["runtime/gateway/app.py", "runtime/gateway/audio.py", "scripts/test-runtime-gateway-config.py"], label: "static", gatewayOnly: true },
  { id: "e-uncovered", kind: "py-compile", files: ["runtime/gateway/app.py", "scripts/test-runtime-gateway-errors.py"], label: "static", gatewayOnly: true }
]);

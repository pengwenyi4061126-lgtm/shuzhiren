// Fixture Local_Verification check list for scripts/check-ci-workflow.mjs
// tests (data only; rule W6 imports it from <root>/scripts/).
export const LOCAL_CHECKS = Object.freeze([
  { id: "ci:coverage:check", kind: "npm", script: "ci:coverage:check", label: "static" },
  { id: "membership:scopes:check", kind: "npm", script: "membership:scopes:check", label: "static" },
  { id: "governance:tenant-scope:check", kind: "npm", script: "governance:tenant-scope:check", label: "static" },
  { id: "lint", kind: "npm", script: "lint", label: "static" },
  { id: "unit:test", kind: "npm", script: "unit:test", label: "behavioral" },
  { id: "py_compile", kind: "py-compile", files: ["runtime/gateway/app.py", "scripts/test-runtime-gateway-config.py"], label: "static", gatewayOnly: true },
  { id: "scripts/test-runtime-gateway-config.py", kind: "python", file: "scripts/test-runtime-gateway-config.py", label: "behavioral", gatewayOnly: true },
  { id: "scripts/test-runtime-gateway-audio.py", kind: "python", file: "scripts/test-runtime-gateway-audio.py", label: "behavioral", gatewayOnly: true }
]);

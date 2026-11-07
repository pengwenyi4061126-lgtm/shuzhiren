// Entry point of the trigger case framework (design part 8, section 2.1 "触发器覆盖"). Case modules are the
// other *.mjs files in this directory; each default-exports a TriggerCase[] (shape: section 2.3, checked by
// validateTriggerCases). scripts/integration/trigger-coverage.test.mjs runs every case with runTriggerCase.
// A test of another requirement may import a module here and run the same case objects again.
export { caseCovers, decodeTgtype, decodeTriggerRows, loadTriggerCases, missingTriggerCases, runTriggerCase, staleTriggerCases, TRIGGER_CATALOGUE_SQL, validateTriggerCases } from "../lib/trigger-coverage.mjs";
export { default as overlays } from "./overlays.mjs";

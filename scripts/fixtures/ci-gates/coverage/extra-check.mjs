// The repository check list plus one npm check that no ci.yml step runs.
import { LOCAL_CHECKS as REPOSITORY_CHECKS } from "../../../verify-local-checks.mjs";

export const LOCAL_CHECKS = Object.freeze([...REPOSITORY_CHECKS, { id: "x:new", kind: "npm", script: "x:new", label: "static" }]);

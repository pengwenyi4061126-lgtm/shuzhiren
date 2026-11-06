import { greet } from "../console/lib/greeting.mjs";
const { evaluatePolicy } = await import("../console/lib/policy-engine.ts");

export const decide = (text) => [greet(text), evaluatePolicy(text)];

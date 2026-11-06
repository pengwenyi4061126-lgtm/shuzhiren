import { evaluatePolicy } from "./policy-engine.mjs";

export const decide = (text) => evaluatePolicy(text);

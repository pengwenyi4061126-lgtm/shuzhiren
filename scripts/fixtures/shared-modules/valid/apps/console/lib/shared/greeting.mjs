import path from "node:path";
import { shout } from "./helper.mjs";
export const greeting = "hello";
export function greet(name) {
  return shout(path.basename(greeting + name));
}

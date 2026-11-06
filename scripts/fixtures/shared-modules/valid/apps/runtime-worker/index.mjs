import { greet } from "../console/lib/shared/greeting.mjs";
import { createServer } from "node:http";

console.log(greet("worker"), typeof createServer);

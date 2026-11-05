// Structural cross-check between infra/compose/docker-compose.runtime.yml and
// the four runtime env files passed to it with --env-file. Compose merges the
// files into one interpolation namespace (later files win), so a variable
// defined differently in two files, a referenced variable defined nowhere, or
// an environment value hard-coded in Compose while an env file also sets it
// all make the deployed value differ from what Deploy_Check validated.
// Messages carry variable, service and file names, never values.
import { interpolate, parseInterpolations } from "./compose-interpolation.mjs";

export { parseInterpolations } from "./compose-interpolation.mjs";

/** Same order as the `--env-file` arguments of the runtime render; later files override earlier ones. */
export const RUNTIME_ENV_ORDER = Object.freeze(["runtime", "gateway", "channelAdapter", "alertNotifier"]);

function isMapping(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function visitStrings(value, keys, callback) {
  if (typeof value === "string") callback(value, keys);
  else if (Array.isArray(value)) value.forEach((item, index) => visitStrings(item, [...keys, String(index)], callback));
  else if (isMapping(value)) for (const [key, item] of Object.entries(value)) visitStrings(item, [...keys, key], callback);
}

/** Removes one pair of matching surrounding quotes, as the Compose dotenv parser does. */
export function normalizeEnvValue(raw) {
  const value = String(raw ?? "").trim();
  if (value.length >= 2 && (value[0] === "\"" || value[0] === "'") && value.at(-1) === value[0]) return value.slice(1, -1);
  return value;
}

/** name -> [{ service, path, operator, argument }] for every interpolation in a string value of the document. */
export function collectComposeReferences(composeDoc) {
  const references = new Map();
  visitStrings(composeDoc, [], (text, keys) => {
    const service = keys[0] === "services" ? keys[1] : null;
    for (const reference of parseInterpolations(text)) {
      if (!references.has(reference.name)) references.set(reference.name, []);
      references.get(reference.name).push({ service, path: keys.join("."), operator: reference.operator, argument: reference.argument });
    }
  });
  return references;
}

/** Service environment entries whose value contains no interpolation; null (pass-through) entries are skipped. */
export function collectLiteralEnvironment(composeDoc) {
  const literals = [];
  const services = isMapping(composeDoc?.services) ? composeDoc.services : {};
  for (const [service, definition] of Object.entries(services)) {
    const environment = definition?.environment;
    const entries = Array.isArray(environment)
      ? environment.filter((item) => typeof item === "string" && item.includes("=")).map((item) => [item.slice(0, item.indexOf("=")), item.slice(item.indexOf("=") + 1)])
      : isMapping(environment) ? Object.entries(environment) : [];
    for (const [key, value] of entries) {
      if (value === null || value === undefined) continue;
      const text = String(value);
      if (parseInterpolations(text).length > 0) continue;
      literals.push({ service, key, value: interpolate(text, new Map()) });
    }
  }
  return literals;
}

/** Value Compose would use: the last env file that defines `name`, otherwise the single `:-`/`-` default in Compose. */
export function effectiveValue(name, envFiles, references) {
  for (const file of [...envFiles].reverse()) if (file.values.has(name)) return normalizeEnvValue(file.values.get(name));
  const defaults = new Set((references.get(name) ?? []).filter((use) => use.operator === ":-" || use.operator === "-").map((use) => use.argument));
  return defaults.size === 1 ? [...defaults][0] : undefined;
}

function servicesOf(uses) {
  const names = [...new Set(uses.map((use) => use.service ?? use.path.split(".")[0]))];
  return names.join("、");
}

/**
 * @param {{ composeDoc: object, envFiles: Array<{ id: string, path: string, values: Map<string, string> }> }} input
 *   envFiles in RUNTIME_ENV_ORDER.
 * @returns {{ errors: Array<{ code: string, message: string }> }}
 */
export function checkRuntimeComposeConsistency({ composeDoc, envFiles }) {
  const errors = [];
  const references = collectComposeReferences(composeDoc);
  for (const [name, uses] of references) {
    const defining = envFiles.filter((file) => file.values.has(name));
    if (defining.length === 0) {
      errors.push({ code: "RC-UNDEFINED", message: `运行时 Compose 的 ${servicesOf(uses)} 引用了 ${name}，但四份运行时 env 文件都没有定义它` });
      continue;
    }
    if (new Set(defining.map((file) => normalizeEnvValue(file.values.get(name)))).size > 1) {
      errors.push({ code: "RC-CONFLICT", message: `${name} 在 ${defining.map((file) => file.path).join("、")} 中取值不同；Compose 只使用最后一份文件的值` });
    }
  }
  for (const { service, key, value } of collectLiteralEnvironment(composeDoc)) {
    for (const file of envFiles) {
      if (file.values.has(key) && normalizeEnvValue(file.values.get(key)) !== value) {
        errors.push({ code: "RC-LITERAL", message: `服务 ${service} 的 environment.${key} 在运行时 Compose 中写死，与 ${file.path} 中的定义不同；修改 env 文件不会生效` });
      }
    }
  }
  return { errors };
}

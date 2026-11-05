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
  // L10: the worker reaches the adapter on CHANNEL_ADAPTER_URL, the adapter listens on CHANNEL_ADAPTER_PORT.
  const adapterPort = effectiveValue("CHANNEL_ADAPTER_PORT", envFiles, references);
  for (const file of envFiles.filter((item) => item.values.has("CHANNEL_ADAPTER_URL"))) {
    let url;
    try {
      url = new URL(normalizeEnvValue(file.values.get("CHANNEL_ADAPTER_URL")));
    } catch {
      errors.push({ code: "RC-CHANNEL-PORT", message: `${file.path} 的 CHANNEL_ADAPTER_URL 无法解析为 URL` });
      continue;
    }
    if (url.hostname !== "channel-adapter") continue;
    const urlPort = url.port || (url.protocol === "https:" ? "443" : url.protocol === "http:" ? "80" : "");
    if (urlPort !== adapterPort) errors.push({ code: "RC-CHANNEL-PORT", message: `${file.path} 的 CHANNEL_ADAPTER_URL 使用端口 ${urlPort || "未知"}，而 channel-adapter 监听 CHANNEL_ADAPTER_PORT=${adapterPort ?? "未定义"}` });
  }
  return { errors };
}

const MEDIA_SERVICES = Object.freeze(["livetalking", "cosyvoice"]);
const MEDIA_PEERS = new Set([...MEDIA_SERVICES, "runtime-gateway"]);

function serviceNetworks(service) {
  const networks = service?.networks;
  if (networks === undefined || networks === null) return ["default"];
  return Array.isArray(networks) ? networks.map(String) : Object.keys(networks);
}

/**
 * M17: LiveTalking and CosyVoice have no authentication, so only runtime-gateway may share a network
 * with them. The shared media network is internal (no egress); LiveTalking alone gets an egress bridge
 * for RTMP; neither publishes host ports, and no service bypasses Compose networking with network_mode.
 * @returns {{ errors: Array<{ code: string, message: string }> }}
 */
export function checkRuntimeComposeIsolation(composeDoc) {
  const errors = [];
  const services = isMapping(composeDoc?.services) ? composeDoc.services : {};
  const declared = isMapping(composeDoc?.networks) ? composeDoc.networks : {};
  const members = new Map();
  for (const [name, service] of Object.entries(services)) {
    if (service?.network_mode !== undefined) errors.push({ code: "RCT-NETWORK", message: `${name} must not set network_mode` });
    for (const network of serviceNetworks(service)) {
      if (!members.has(network)) members.set(network, new Set());
      members.get(network).add(name);
    }
  }
  const isInternal = (network) => declared[network]?.internal === true;
  for (const media of MEDIA_SERVICES) {
    const service = services[media];
    if (!service) {
      errors.push({ code: "RCT-NETWORK", message: `${media} service is missing` });
      continue;
    }
    if (service.ports !== undefined) errors.push({ code: "RCT-NETWORK", message: `${media} must not publish host ports` });
    for (const network of serviceNetworks(service)) {
      const outsiders = [...members.get(network)].filter((name) => !MEDIA_PEERS.has(name));
      if (outsiders.length) errors.push({ code: "RCT-NETWORK", message: `${media} shares network ${network} with ${outsiders.join(", ")}; only runtime-gateway may reach it` });
      if (!isInternal(network) && (media !== "livetalking" || members.get(network).size !== 1)) errors.push({ code: "RCT-NETWORK", message: `${media} network ${network} must be internal, or an egress network used by livetalking alone` });
    }
  }
  const mediaNetworks = Object.keys(declared).filter((network) => isInternal(network) && MEDIA_SERVICES.every((media) => serviceNetworks(services[media]).includes(network)));
  if (mediaNetworks.length !== 1 || !serviceNetworks(services["runtime-gateway"]).includes(mediaNetworks[0])) errors.push({ code: "RCT-NETWORK", message: "runtime-gateway, livetalking and cosyvoice must share exactly one internal media network" });
  if (!serviceNetworks(services["runtime-gateway"]).includes("default")) errors.push({ code: "RCT-NETWORK", message: "runtime-gateway must stay on the default network for its callers and published port" });
  return { errors };
}

export const TEMPLATE_NAMES = Object.freeze(["runtime", "runtime-gateway", "channel-adapter", "alert-notifier"]);
const OWN_TEMPLATE_VARIABLES = Object.freeze({ CHANNEL_ADAPTER_DATABASE_URL: "channel-adapter", ALERT_NOTIFIER_DATABASE_URL: "alert-notifier" });

/**
 * L11: every required (`:?`) Compose variable names, in its `set-in-<name>-env` hint, the repository
 * template that actually defines it, and that template gives it a non-empty value.
 * @param {{ composeDoc: object, templates: Record<string, Map<string, string>> }} input keyed by TEMPLATE_NAMES
 * @returns {{ errors: Array<{ code: string, message: string }> }}
 */
export function checkTemplateRequirements({ composeDoc, templates }) {
  const errors = [];
  const defines = (name, variable) => Boolean(normalizeEnvValue(templates[name]?.get(variable) ?? ""));
  for (const [variable, uses] of collectComposeReferences(composeDoc)) {
    const required = uses.filter((use) => use.operator === ":?" || use.operator === "?");
    if (required.length === 0) continue;
    for (const use of required) {
      const hint = /^set-in-(.+)-env$/.exec(use.argument ?? "")?.[1];
      if (!hint || !TEMPLATE_NAMES.includes(hint) || !defines(hint, variable)) errors.push({ code: "RCT-HINT", message: `${variable} at ${use.path} says ${use.argument || "(no hint)"}, but config/${hint ?? "<unknown>"}.example.env does not define it` });
    }
    const owners = OWN_TEMPLATE_VARIABLES[variable] ? [OWN_TEMPLATE_VARIABLES[variable]] : ["runtime", "runtime-gateway"];
    if (!owners.some((name) => defines(name, variable))) errors.push({ code: "RCT-REQUIRED", message: `${variable} is required by the runtime Compose but config/${owners.join(".example.env or config/")}.example.env does not define it` });
  }
  return { errors };
}

function portExpressions(service) {
  const expressions = new Set();
  for (const entry of service?.expose ?? []) expressions.add(String(entry).replace(/\/(tcp|udp)$/, ""));
  for (const entry of service?.ports ?? []) {
    const text = typeof entry === "object" && entry !== null ? String(entry.target ?? "") : String(entry);
    const containerSide = text.slice(text.lastIndexOf(":") + 1).replace(/\/(tcp|udp)$/, "");
    if (containerSide) expressions.add(containerSide);
  }
  return expressions;
}

/**
 * L10: a service that reads its listen port from an environment variable must expose and health-check
 * that same interpolation, and URLs pointing at another service must use the port it listens on.
 * @returns {{ errors: Array<{ code: string, message: string }> }}
 */
export function checkComposePorts(composeDoc) {
  const errors = [];
  const services = isMapping(composeDoc?.services) ? composeDoc.services : {};
  const listenPorts = new Map();
  for (const [name, service] of Object.entries(services)) {
    const environment = isMapping(service?.environment) ? service.environment : {};
    const configured = Object.entries(environment).filter(([key]) => /_PORT$/.test(key)).map(([, value]) => String(value));
    const exposed = portExpressions(service);
    if (configured.length > 0) {
      for (const expression of exposed) if (!configured.includes(expression)) errors.push({ code: "RCT-PORT", message: `${name} exposes ${expression} but listens on ${configured.join(", ")}` });
    }
    const ports = configured.length > 0 ? new Set(configured) : exposed;
    listenPorts.set(name, ports);
    const health = [].concat(service?.healthcheck?.test ?? []).join(" ");
    for (const match of health.matchAll(/localhost:(\$\{[^}]+\}|\d+)\//g)) {
      if (!ports.has(match[1])) errors.push({ code: "RCT-PORT", message: `${name} health check probes port ${match[1]} but listens on ${[...ports].join(", ") || "no declared port"}` });
    }
  }
  for (const [name, service] of Object.entries(services)) {
    const environment = isMapping(service?.environment) ? service.environment : {};
    for (const [key, value] of Object.entries(environment)) {
      const text = String(value ?? "");
      const candidates = [text, ...parseInterpolations(text).filter((reference) => reference.operator === ":-" || reference.operator === "-").map((reference) => reference.argument)];
      for (const candidate of candidates) {
        const match = /^https?:\/\/([a-z0-9-]+):(\$\{[^}]+\}|\d+)(\/|$)/.exec(candidate);
        if (!match || !listenPorts.has(match[1])) continue;
        if (!listenPorts.get(match[1]).has(match[2])) errors.push({ code: "RCT-PORT", message: `${name} environment.${key} reaches ${match[1]} on port ${match[2]} but it listens on ${[...listenPorts.get(match[1])].join(", ")}` });
      }
    }
  }
  return { errors };
}

// H2: Runtime Compose passes the key only as the stream_key secret file, never through argv or interpolation.
export function streamKeyComposeProblems(doc) {
  const problems = [];
  if (collectComposeReferences(doc).has("STREAM_KEY")) problems.push("运行时 Compose 不得插值 STREAM_KEY；推流密钥只能经 stream_key secret 文件传入");
  const liveTalking = doc?.services?.livetalking ?? {};
  const command = [].concat(liveTalking.command ?? []).join(" ");
  const tokens = command.split(/\s+/).filter(Boolean);
  if (command.split("--stream_key_file /run/secrets/stream-key").length !== 2) problems.push("运行时 Compose 的 livetalking.command 必须恰好包含一次 --stream_key_file /run/secrets/stream-key");
  const pushUrlIndex = tokens.indexOf("--push_url");
  if (pushUrlIndex < 0 || !tokens[pushUrlIndex + 1] || tokens[pushUrlIndex + 1].includes("STREAM_KEY") || tokens.slice(pushUrlIndex + 2).includes("--push_url")) problems.push("运行时 Compose 的 livetalking --push_url 只能是不含推流密钥的推流基址");
  const secretRefs = (service) => [].concat(service?.secrets ?? []).map((entry) => (typeof entry === "string" ? { source: entry } : entry ?? {}));
  if (!secretRefs(liveTalking).some((entry) => entry.source === "stream_key" && entry.target === "stream-key")) problems.push("运行时 Compose 的 livetalking 必须以 {source: stream_key, target: stream-key} 挂载推流密钥");
  for (const [name, service] of Object.entries(doc?.services ?? {})) {
    if (name !== "livetalking" && secretRefs(service).some((entry) => entry.source === "stream_key")) problems.push(`运行时 Compose 的 ${name} 不得挂载推流密钥`);
  }
  const file = String(doc?.secrets?.stream_key?.file ?? "");
  const references = file ? parseInterpolations(file) : [];
  if (references.length !== 1 || references[0].name !== "STREAM_KEY_FILE" || references[0].raw !== file) problems.push("运行时 Compose 的 secrets.stream_key.file 必须是 ${STREAM_KEY_FILE…} 插值");
  return problems;
}

// POSIX-style word splitting (single quotes, double quotes, backslashes), the way Compose splits a string command.
export function shellWords(text) {
  const words = [];
  let current = "";
  let started = false;
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote === "'") {
      if (character === "'") quote = null; else current += character;
      continue;
    }
    if (quote === "\"") {
      if (character === "\"") quote = null;
      else if (character === "\\" && index + 1 < text.length && "\"\\$`".includes(text[index + 1])) current += text[++index];
      else current += character;
      continue;
    }
    if (character === "'" || character === "\"") { quote = character; started = true; continue; }
    if (character === "\\" && index + 1 < text.length) { current += text[++index]; started = true; continue; }
    if (/\s/.test(character)) {
      if (started) words.push(current);
      current = "";
      started = false;
      continue;
    }
    current += character;
    started = true;
  }
  if (quote) return null;
  if (started) words.push(current);
  return words;
}

const LIVETALKING_TTS_OPTIONS = Object.freeze({ "--tts": "none", "--TTS_SERVER": "http://cosyvoice:50000" });

// H3/D2 (15.12): LiveTalking must load no TTS plugin. Speech reaches it only as CosyVoice audio
// through /humanaudio, so --tts is exactly "none" and --TTS_SERVER names the internal CosyVoice.
export function liveTalkingTtsComposeProblems(doc) {
  const command = doc?.services?.livetalking?.command;
  const words = Array.isArray(command) ? command.map(String) : typeof command === "string" ? shellWords(command) : null;
  if (!words) return ["LiveTalking_Runtime TTS 配置不合规：livetalking.command 缺失或引号不成对"];
  const problems = [];
  const seen = Object.fromEntries(Object.keys(LIVETALKING_TTS_OPTIONS).map((name) => [name, []]));
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (!word.startsWith("--")) continue;
    const separator = word.indexOf("=");
    const flag = separator < 0 ? word : word.slice(0, separator);
    for (const name of Object.keys(LIVETALKING_TTS_OPTIONS)) {
      if (flag === name) seen[name].push(separator < 0 ? words[index + 1] ?? "" : word.slice(separator + 1));
      // argparse accepts any unique prefix, so --tt or --TTS_SERV would silently set the option.
      else if (flag.length > 2 && name.startsWith(flag)) problems.push(`LiveTalking_Runtime TTS 配置不合规：${flag} 是 ${name} 的前缀缩写，argparse 会把它当作 ${name}`);
    }
  }
  for (const [name, expected] of Object.entries(LIVETALKING_TTS_OPTIONS)) {
    if (seen[name].length !== 1) problems.push(`LiveTalking_Runtime TTS 配置不合规：${name} 必须恰好出现一次，实际 ${seen[name].length} 次`);
    else if (seen[name][0] !== expected) problems.push(`LiveTalking_Runtime TTS 配置不合规：${name} 必须为 ${expected}，实际为 ${seen[name][0] || "(空)"}`);
  }
  return problems;
}

export function getPath(value, path) {
  if (path === undefined || path === null || path === "") return value;
  const parts = Array.isArray(path) ? path : String(path).split(".");
  let current = value;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if ((typeof current !== "object" && typeof current !== "function") || !(part in current)) return undefined;
    current = current[part];
  }
  return current;
}

export function readMappedValue(record, mapping, { fieldName = "field", required = false } = {}) {
  if (mapping === undefined || mapping === null) {
    if (required) throw new Error("Missing mapping for required field: " + fieldName);
    return undefined;
  }

  let value;
  let transform;
  if (typeof mapping === "function") {
    value = mapping(record);
  } else if (typeof mapping === "string" || Array.isArray(mapping)) {
    value = getPath(record, mapping);
  } else if (mapping && typeof mapping === "object" && !Array.isArray(mapping) && Object.hasOwn(mapping, "path")) {
    value = getPath(record, mapping.path);
    transform = mapping.transform;
  } else {
    throw new TypeError("Invalid field mapping for " + fieldName);
  }

  if (value === undefined || value === null) {
    if (required) throw new Error("Missing required mapped field: " + fieldName);
    return undefined;
  }
  return transform === undefined ? value : applyTransform(value, transform, fieldName);
}

export function applyTransform(value, transform, fieldName = "field") {
  if (typeof transform === "function") return transform(value);
  if (typeof transform !== "string") throw new TypeError("Invalid transform for " + fieldName);
  switch (transform) {
    case "identity":
      return value;
    case "string":
      return String(value);
    case "trimmed-string":
      return String(value).trim();
    case "integer": {
      const number = typeof value === "number" ? value : Number(value);
      if (!Number.isSafeInteger(number)) throw new Error("Mapped field is not a safe integer: " + fieldName);
      return number;
    }
    case "number": {
      const number = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(number)) throw new Error("Mapped field is not a finite number: " + fieldName);
      return number;
    }
    case "boolean":
      if (typeof value === "boolean") return value;
      if (value === "true" || value === "1" || value === 1) return true;
      if (value === "false" || value === "0" || value === 0) return false;
      throw new Error("Mapped field is not boolean-like: " + fieldName);
    case "iso-date": {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) throw new Error("Mapped field is not a valid date: " + fieldName);
      return date.toISOString();
    }
    default:
      throw new Error("Unsupported transform: " + transform);
  }
}

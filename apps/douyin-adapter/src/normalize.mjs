import { getPath, readMappedValue } from "./value-map.mjs";

export class ResponseNormalizationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ResponseNormalizationError";
    this.code = code;
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizePagination(payload, pagination) {
  if (pagination === undefined) return undefined;
  if (!isObject(pagination)) throw new TypeError("pagination mapping must be an object");
  const result = {};
  for (const [key, mapping] of Object.entries(pagination)) {
    const value = readMappedValue(payload, mapping, { fieldName: "pagination." + key });
    if (value !== undefined) result[key] = value;
  }
  return result;
}

export function normalizeCollectionResponse(payload, {
  itemsPath,
  fields,
  requiredFields = ["id"],
  pagination,
  type = "items"
} = {}) {
  if (!isObject(payload)) throw new ResponseNormalizationError("invalid_payload", "response payload must be an object");
  if (itemsPath === undefined) throw new TypeError("itemsPath must be configured explicitly");
  if (!isObject(fields) || !Object.keys(fields).length) throw new TypeError("fields mapping must be a non-empty object");
  for (const field of requiredFields) {
    if (!(field in fields)) throw new TypeError("fields mapping must include required field: " + field);
  }
  const sourceItems = getPath(payload, itemsPath);
  if (!Array.isArray(sourceItems)) throw new ResponseNormalizationError("invalid_items", "configured itemsPath did not resolve to an array");
  const items = sourceItems.map((item, index) => {
    if (!isObject(item)) throw new ResponseNormalizationError("invalid_item", type + " item at index " + index + " must be an object");
    const normalized = {};
    for (const [field, mapping] of Object.entries(fields)) {
      const value = readMappedValue(item, mapping, { fieldName: type + "." + field, required: requiredFields.includes(field) });
      if (value !== undefined) normalized[field] = value;
    }
    const id = normalized.id;
    if (id === undefined || id === null || String(id).trim() === "") {
      throw new ResponseNormalizationError("missing_id", type + " item at index " + index + " has no id");
    }
    return normalized;
  });
  const normalizedPagination = normalizePagination(payload, pagination);
  return { type, items, ...(normalizedPagination === undefined ? {} : { pagination: normalizedPagination }) };
}

export function normalizeProductResponse(payload, config) {
  const normalized = normalizeCollectionResponse(payload, { ...config, type: "products" });
  return { products: normalized.items, ...(normalized.pagination === undefined ? {} : { pagination: normalized.pagination }) };
}

export function normalizeBillingResponse(payload, config) {
  const normalized = normalizeCollectionResponse(payload, { ...config, type: "billing" });
  return { records: normalized.items, ...(normalized.pagination === undefined ? {} : { pagination: normalized.pagination }) };
}

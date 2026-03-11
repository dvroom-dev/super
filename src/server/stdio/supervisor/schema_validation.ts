export type JsonSchemaNode = {
  type?: string | string[];
  required?: string[];
  properties?: Record<string, JsonSchemaNode>;
  additionalProperties?: boolean;
  enum?: unknown[];
  const?: unknown;
  items?: JsonSchemaNode;
  oneOf?: JsonSchemaNode[];
  anyOf?: JsonSchemaNode[];
  allOf?: JsonSchemaNode[];
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function matchesSchemaType(value: unknown, typeName: string): boolean {
  if (typeName === "null") return value === null;
  if (typeName === "array") return Array.isArray(value);
  if (typeName === "object") return isPlainRecord(value);
  if (typeName === "string") return typeof value === "string";
  if (typeName === "number") return typeof value === "number" && Number.isFinite(value);
  if (typeName === "boolean") return typeof value === "boolean";
  return true;
}

export function validateSchemaValue(value: unknown, schema: JsonSchemaNode, at = "$"): string | undefined {
  if (schema.const !== undefined && schema.const !== value) {
    return `${at}: expected const ${JSON.stringify(schema.const)}`;
  }
  if (Array.isArray(schema.type)) {
    const valid = schema.type.some((t) => matchesSchemaType(value, t));
    if (!valid) return `${at}: expected type ${schema.type.join("|")}`;
  } else if (typeof schema.type === "string" && !matchesSchemaType(value, schema.type)) {
    return `${at}: expected type ${schema.type}`;
  }
  if (schema.enum && !schema.enum.some((candidate) => candidate === value)) {
    return `${at}: expected one of [${schema.enum.map((v) => JSON.stringify(v)).join(", ")}]`;
  }
  if (schema.required || schema.properties || schema.additionalProperties === false) {
    if (!isPlainRecord(value)) {
      const declaredTypes =
        Array.isArray(schema.type) ? schema.type : typeof schema.type === "string" ? [schema.type] : [];
      const matchesAllowedNonObjectType = declaredTypes.some(
        (typeName) => typeName !== "object" && matchesSchemaType(value, typeName),
      );
      if (!matchesAllowedNonObjectType) return `${at}: expected object`;
    } else {
      const obj = value as Record<string, unknown>;
      if (Array.isArray(schema.required)) {
        for (const key of schema.required) {
          if (!(key in obj)) return `${at}.${key}: required`;
        }
      }
      if (schema.additionalProperties === false && schema.properties) {
        for (const key of Object.keys(obj)) {
          if (!(key in schema.properties)) return `${at}.${key}: additional property not allowed`;
        }
      }
      if (schema.properties) {
        for (const [key, propSchema] of Object.entries(schema.properties)) {
          if (!(key in obj)) continue;
          const err = validateSchemaValue(obj[key], propSchema, `${at}.${key}`);
          if (err) return err;
        }
      }
    }
  }
  if (schema.items) {
    if (!Array.isArray(value)) {
      const allowsArray =
        schema.type === undefined ||
        schema.type === "array" ||
        (Array.isArray(schema.type) && schema.type.includes("array"));
      const allowsNonArray =
        schema.type === undefined ||
        (Array.isArray(schema.type) && schema.type.some((t) => t !== "array")) ||
        schema.type === "null" ||
        schema.type === "object" ||
        schema.type === "string" ||
        schema.type === "number" ||
        schema.type === "boolean";
      if (!allowsNonArray && allowsArray) return `${at}: expected array`;
      return undefined;
    }
    for (let i = 0; i < value.length; i += 1) {
      const err = validateSchemaValue(value[i], schema.items, `${at}[${i}]`);
      if (err) return err;
    }
  }
  if (schema.allOf && schema.allOf.length > 0) {
    for (const node of schema.allOf) {
      const err = validateSchemaValue(value, node, at);
      if (err) return err;
    }
  }
  if (schema.anyOf && schema.anyOf.length > 0) {
    const anyOk = schema.anyOf.some((node) => validateSchemaValue(value, node, at) == null);
    if (!anyOk) {
      return `${at}: expected value matching at least one anyOf schema`;
    }
  }
  if (schema.oneOf && schema.oneOf.length > 0) {
    const passCount = schema.oneOf.filter((node) => validateSchemaValue(value, node, at) == null).length;
    if (passCount !== 1) {
      return `${at}: expected value matching exactly one oneOf schema`;
    }
  }
  return undefined;
}

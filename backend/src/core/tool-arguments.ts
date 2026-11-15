// The tools in this repo use a bounded JSON-schema subset; semantic validation remains in each tool.
export function argumentError(schema: Record<string, any>, value: unknown, path = "args", depth = 0): string | null {
  if (depth > 12) return `${path}嵌套过深`;
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value === "number" && Number.isInteger(value) ? "integer" : typeof value;
  if (types.length && !types.includes(actual) && !(actual === "integer" && types.includes("number"))) return `${path}类型应为${types.join("/")}`;
  if (schema.enum && !schema.enum.includes(value)) return `${path}不在允许值中`;
  if (typeof value === "number" && !Number.isFinite(value)) return `${path}数值无效`;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!Object.hasOwn(obj, key)) return `${path}.${key}必填`;
    for (const [key, entry] of Object.entries(obj)) {
      if (schema.additionalProperties === false && !Object.hasOwn(schema.properties ?? {}, key)) return `${path}.${key}未声明`;
      if (schema.properties?.[key]) { const error = argumentError(schema.properties[key], entry, `${path}.${key}`, depth + 1); if (error) return error; }
    }
  }
  if (Array.isArray(value) && schema.items) for (let index = 0; index < value.length; index++) { const error = argumentError(schema.items, value[index], `${path}[${index}]`, depth + 1); if (error) return error; }
  return null;
}

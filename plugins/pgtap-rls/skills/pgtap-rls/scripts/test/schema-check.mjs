// Tiny dependency-free JSON Schema checker: exactly the keywords test-gate's evidence.schema.json uses
// ($ref to #/$defs, type incl. arrays of types, const, enum, pattern, minLength, maxLength, required, properties, items,
// additionalProperties). Returns a list of error strings (empty = valid). Test helper only.
const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const isType = (v, t) => (t === 'number' ? typeof v === 'number' : t === 'integer' ? Number.isInteger(v) : typeOf(v) === t);

export function checkSchema(value, schema, root = schema, path = '$') {
  const errors = [];
  if (schema.$ref) {
    const target = schema.$ref.replace(/^#\//, '').split('/').reduce((o, k) => o?.[k], root);
    if (!target) return [`${path}: unresolvable $ref ${schema.$ref}`];
    return checkSchema(value, target, root, path);
  }
  if ('const' in schema && value !== schema.const) errors.push(`${path}: must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: ${JSON.stringify(value)} not in ${JSON.stringify(schema.enum)}`);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => isType(value, t))) { errors.push(`${path}: expected ${types.join('|')}, got ${typeOf(value)}`); return errors; }
  }
  if (typeof value === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: does not match ${schema.pattern}`);
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`);
  }
  if (Array.isArray(value) && schema.items) value.forEach((x, i) => errors.push(...checkSchema(x, schema.items, root, `${path}[${i}]`)));
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const k of schema.required ?? []) if (!(k in value)) errors.push(`${path}: missing required "${k}"`);
    for (const [k, sub] of Object.entries(schema.properties ?? {})) if (k in value) errors.push(...checkSchema(value[k], sub, root, `${path}.${k}`));
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(value)) if (!(k in (schema.properties ?? {}))) errors.push(`${path}: unexpected "${k}"`);
    }
  }
  return errors;
}

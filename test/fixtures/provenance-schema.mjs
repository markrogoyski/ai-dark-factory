import assert from 'node:assert/strict'
export function validate(value, schema) {
  const allowed = new Set(['type', 'enum', 'pattern', 'properties', 'required', 'additionalProperties', 'items', 'definitions'])
  for (const key of Object.keys(schema)) assert.ok(allowed.has(key), `Unsupported schema keyword: ${key}`)
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value
  assert.ok([].concat(schema.type).includes(type), `Expected ${schema.type}, got ${type}`)
  if (schema.enum) assert.ok(schema.enum.includes(value), 'enum')
  if (schema.pattern) assert.match(value, new RegExp(schema.pattern))
  if (type === 'object') {
    for (const key of schema.required || []) assert.ok(Object.hasOwn(value, key), `required ${key}`)
    for (const [key, child] of Object.entries(value)) {
      if (schema.properties?.[key]) validate(child, schema.properties[key])
      else assert.notEqual(schema.additionalProperties, false, `unexpected ${key}`)
    }
  }
  if (type === 'array' && schema.items) value.forEach(x => validate(x, schema.items))
}

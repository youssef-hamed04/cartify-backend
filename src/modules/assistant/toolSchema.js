// Server-side validation of tool arguments produced by the model, against the same JSON Schema that
// is sent to the model as the tool's input_schema. Supports the subset the Cartify tools use.
// Model output is untrusted input: every tool runs only on validated, normalised arguments.

function check(schema, value, path, errors) {
  if (value === undefined) return schema.default;
  if (value === null && schema.nullable) return null;
  switch (schema.type) {
    case 'string': {
      if (typeof value !== 'string') { errors.push(`${path} must be a string`); return undefined; }
      const v = value.trim();
      if (schema.minLength && v.length < schema.minLength) errors.push(`${path} is too short`);
      if (schema.maxLength && v.length > schema.maxLength) errors.push(`${path} must be at most ${schema.maxLength} characters`);
      if (schema.enum && !schema.enum.includes(v)) errors.push(`${path} must be one of: ${schema.enum.join(', ')}`);
      if (schema.pattern && !new RegExp(schema.pattern).test(v)) errors.push(`${path} has an invalid format`);
      return v;
    }
    case 'integer':
    case 'number': {
      const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (typeof n !== 'number' || !Number.isFinite(n)) { errors.push(`${path} must be a number`); return undefined; }
      if (schema.type === 'integer' && !Number.isInteger(n)) errors.push(`${path} must be a whole number`);
      if (schema.minimum !== undefined && n < schema.minimum) errors.push(`${path} must be ≥ ${schema.minimum}`);
      if (schema.maximum !== undefined && n > schema.maximum) errors.push(`${path} must be ≤ ${schema.maximum}`);
      if (schema.enum && !schema.enum.includes(n)) errors.push(`${path} must be one of: ${schema.enum.join(', ')}`);
      return n;
    }
    case 'boolean':
      if (typeof value !== 'boolean') { errors.push(`${path} must be true or false`); return undefined; }
      return value;
    case 'array': {
      if (!Array.isArray(value)) { errors.push(`${path} must be a list`); return undefined; }
      if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path} needs at least ${schema.minItems} item(s)`);
      if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path} allows at most ${schema.maxItems} item(s)`);
      const out = value.map((v, i) => check(schema.items || {}, v, `${path}[${i}]`, errors));
      return schema.uniqueItems ? [...new Set(out)] : out;
    }
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) { errors.push(`${path || 'input'} must be an object`); return undefined; }
      const props = schema.properties || {};
      const out = {};
      for (const key of Object.keys(value)) {
        if (!props[key]) { if (schema.additionalProperties === false) errors.push(`unknown field "${key}"`); continue; }
      }
      for (const [key, sub] of Object.entries(props)) {
        const v = check(sub, value[key], path ? `${path}.${key}` : key, errors);
        if (v !== undefined) out[key] = v;
        else if ((schema.required || []).includes(key) && value[key] === undefined) errors.push(`${path ? `${path}.` : ''}${key} is required`);
      }
      return out;
    }
    default:
      return value;
  }
}

export function validateToolInput(schema, input) {
  const errors = [];
  const value = check(schema, input ?? {}, '', errors);
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

export const objectIdSchema = (description) => ({ type: 'string', pattern: '^[a-fA-F0-9]{24}$', description });

import type { SchemaField, BlockVariant, CollectionSchema } from './types.js';

/**
 * Introspect all collection schemas from a content config's collections object.
 * Returns a map of collection name → SchemaField[].
 */
export function introspectCollections(
  collections: Record<string, { schema?: unknown }>
): Record<string, CollectionSchema> {
  const result: Record<string, CollectionSchema> = {};
  for (const [name, col] of Object.entries(collections)) {
    if (col.schema) {
      result[name] = introspectObjectSchema(col.schema);
    }
  }
  return result;
}

/**
 * Create a chainable mock that mimics a ZodString for image() in function schemas.
 * Uses Proxy so any chained method (.optional(), .refine(), .describe(), etc.)
 * returns the same mock — prevents throws on `image().optional()`.
 */
function zodStringMock(): any {
  const self: any = new Proxy({ _def: { typeName: 'ZodString' } }, {
    get(target, prop) {
      if (prop === '_def') return target._def;
      if (typeof prop === 'symbol') return undefined;
      return () => self;
    }
  });
  return self;
}

/**
 * Introspect a ZodObject schema into an array of SchemaField descriptors.
 * Handles function schemas: schema({ image }) => z.object(...)
 */
function introspectObjectSchema(schema: any): SchemaField[] {
  // Handle function schemas (Astro supports both direct Zod and function form)
  let resolved = schema;
  if (typeof resolved === 'function') {
    try { resolved = resolved({ image: zodStringMock }); } catch { return []; }
  }

  const unwrapped = unwrapSchema(resolved);
  if (unwrapped?._def?.typeName !== 'ZodObject') return [];

  const shape = unwrapped._def.shape?.() ?? unwrapped._def.shape ?? {};
  const fields: SchemaField[] = [];

  for (const [name, fieldSchema] of Object.entries(shape)) {
    fields.push(introspectField(name, fieldSchema as any));
  }

  return fields;
}

/**
 * Introspect a single Zod field into a SchemaField descriptor.
 */
function introspectField(name: string, schema: any): SchemaField {
  let required = true;
  let defaultValue: unknown = undefined;
  let current = schema;

  // Unwrap layers of ZodOptional, ZodDefault, ZodNullable
  while (current?._def) {
    const typeName = current._def.typeName;

    if (typeName === 'ZodOptional' || typeName === 'ZodNullable') {
      required = false;
      current = current._def.innerType;
      continue;
    }

    if (typeName === 'ZodDefault') {
      required = false;
      try {
        defaultValue = current._def.defaultValue();
      } catch {}
      current = current._def.innerType;
      continue;
    }

    break;
  }

  const baseField = introspectBaseType(current);
  return {
    name,
    required,
    defaultValue,
    ...baseField,
  };
}

/**
 * Determine the type info from the innermost (unwrapped) Zod type.
 */
function introspectBaseType(schema: any): Omit<SchemaField, 'name' | 'required' | 'defaultValue'> {
  if (!schema?._def) return { type: 'unknown' };

  const typeName = schema._def.typeName;

  // Check for reference pattern first (ZodEffects wrapping ZodUnion)
  if (typeName === 'ZodEffects') {
    const refCollection = detectReference(schema);
    if (refCollection) {
      return { type: 'reference', referenceCollection: refCollection };
    }
    // Non-reference effects (e.g., z.coerce.date()) — unwrap and recurse
    if (schema._def.schema) {
      return introspectBaseType(schema._def.schema);
    }
  }

  // Handle z.coerce.date() which wraps as ZodPipeline in some Zod versions
  if (typeName === 'ZodPipeline') {
    if (schema._def.out) {
      return introspectBaseType(schema._def.out);
    }
  }

  switch (typeName) {
    case 'ZodString':
      return { type: 'string' };
    case 'ZodNumber':
      return { type: 'number' };
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodDate':
      return { type: 'date' };
    case 'ZodEnum':
      return { type: 'enum', enumValues: schema._def.values ?? [] };

    case 'ZodArray': {
      const elementSchema = schema._def.type;
      if (!elementSchema) return { type: 'array', arrayItemType: { type: 'unknown' } };

      // Unwrap wrappers on the element to find DU/union/object
      const inner = unwrapArrayElement(elementSchema);
      const innerTypeName = inner?._def?.typeName;

      // Check for discriminated union → blocks
      if (innerTypeName === 'ZodDiscriminatedUnion') {
        const blockConfig = introspectDiscriminatedUnion(inner);
        if (blockConfig) {
          return { type: 'array', arrayItemType: { type: 'object', blockConfig } };
        }
      }

      // Check for z.union where all members are objects with a common literal field → blocks
      if (innerTypeName === 'ZodUnion') {
        const blockConfig = introspectUnionAsBlocks(inner);
        if (blockConfig) {
          return { type: 'array', arrayItemType: { type: 'object', blockConfig } };
        }
      }

      // Default: introspect element type normally
      const elementType = introspectBaseType(elementSchema);
      return { type: 'array', arrayItemType: elementType };
    }

    case 'ZodObject': {
      const shape = schema._def.shape?.() ?? schema._def.shape ?? {};
      const objectFields: SchemaField[] = [];
      for (const [fieldName, fieldSchema] of Object.entries(shape)) {
        objectFields.push(introspectField(fieldName, fieldSchema as any));
      }
      return { type: 'object', objectFields };
    }

    default:
      return { type: 'unknown' };
  }
}

/**
 * Unwrap wrappers on an array element schema to find the core type.
 * Strips ZodEffects (non-reference), ZodPipeline, ZodOptional, ZodNullable, ZodDefault.
 */
function unwrapArrayElement(schema: any): any {
  let inner = schema;
  while (inner?._def) {
    const tn = inner._def.typeName;
    if (tn === 'ZodEffects' && !detectReference(inner) && inner._def.schema) {
      inner = inner._def.schema;
    } else if (tn === 'ZodPipeline' && inner._def.in) {
      inner = inner._def.in;
    } else if (tn === 'ZodOptional' || tn === 'ZodNullable') {
      inner = inner._def.innerType;
    } else if (tn === 'ZodDefault') {
      inner = inner._def.innerType;
    } else {
      break;
    }
  }
  return inner;
}

/**
 * Safely extract options array from a ZodDiscriminatedUnion.
 * Handles Array (Zod ≤3.21) and Map (Zod 3.22+).
 */
function getDUOptions(schema: any): any[] {
  const raw = schema._def.options;
  if (Array.isArray(raw)) return raw;
  if (raw instanceof Map) return [...raw.values()];
  const map = schema._def.optionsMap;
  if (map instanceof Map) return [...map.values()];
  return [];
}

/**
 * Introspect a ZodDiscriminatedUnion into block config.
 */
function introspectDiscriminatedUnion(schema: any): SchemaField['blockConfig'] | null {
  const discriminator = schema._def.discriminator;
  const options = getDUOptions(schema);
  if (!discriminator || options.length === 0) return null;

  const variants: BlockVariant[] = [];
  for (const option of options) {
    if (option._def?.typeName !== 'ZodObject') continue;
    const shape = option._def.shape?.() ?? option._def.shape ?? {};

    const discField = shape[discriminator];
    const litValue = extractLiteralValue(discField);
    if (litValue === null) continue;

    const fields: SchemaField[] = [];
    for (const [name, fieldSchema] of Object.entries(shape)) {
      if (name === discriminator) continue;
      fields.push(introspectField(name, fieldSchema as any));
    }

    const label = String(litValue).charAt(0).toUpperCase() + String(litValue).slice(1);
    const defaultItem = { [discriminator]: litValue, ...generateDefaults(fields) };
    variants.push({ type: String(litValue), label, fields, defaultItem });
  }

  return variants.length > 0 ? { discriminator, variants } : null;
}

/**
 * Detect z.union where all members are ZodObject with a common literal field.
 * Treats it as a block pattern with the common field as discriminator.
 */
function introspectUnionAsBlocks(schema: any): SchemaField['blockConfig'] | null {
  const options = schema._def.options;
  if (!Array.isArray(options) || options.length < 2) return null;
  if (!options.every((o: any) => o._def?.typeName === 'ZodObject')) return null;

  const firstShape = options[0]._def.shape?.() ?? options[0]._def.shape ?? {};
  const candidates = Object.keys(firstShape).filter(key => extractLiteralValue(firstShape[key]) !== null);

  for (const candidate of candidates) {
    const allHaveLiteral = options.every((opt: any) => {
      const s = opt._def.shape?.() ?? opt._def.shape ?? {};
      return extractLiteralValue(s[candidate]) !== null;
    });
    const allUnique = new Set(options.map((opt: any) => {
      const s = opt._def.shape?.() ?? opt._def.shape ?? {};
      return extractLiteralValue(s[candidate]);
    })).size === options.length;

    if (allHaveLiteral && allUnique) {
      const variants: BlockVariant[] = [];
      for (const option of options) {
        const shape = option._def.shape?.() ?? option._def.shape ?? {};
        const litValue = extractLiteralValue(shape[candidate]);
        const fields: SchemaField[] = [];
        for (const [name, fieldSchema] of Object.entries(shape)) {
          if (name === candidate) continue;
          fields.push(introspectField(name, fieldSchema as any));
        }
        const label = String(litValue).charAt(0).toUpperCase() + String(litValue).slice(1);
        const defaultItem = { [candidate]: litValue, ...generateDefaults(fields) };
        variants.push({ type: String(litValue), label, fields, defaultItem });
      }
      return { discriminator: candidate, variants };
    }
  }
  return null;
}

/**
 * Extract the literal value from a ZodLiteral (unwrapping wrappers).
 */
function extractLiteralValue(schema: any): string | number | boolean | null {
  if (!schema?._def) return null;
  let s = schema;
  while (s?._def) {
    const tn = s._def.typeName;
    if (tn === 'ZodLiteral') return s._def.value;
    if (tn === 'ZodOptional' || tn === 'ZodNullable' || tn === 'ZodDefault') {
      s = s._def.innerType;
      continue;
    }
    break;
  }
  return null;
}

/**
 * Generate sensible default values from a list of SchemaFields.
 * Used when creating a new block instance.
 */
function generateDefaults(fields: SchemaField[]): Record<string, unknown> {
  const item: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.defaultValue !== undefined) { item[f.name] = f.defaultValue; continue; }
    if (!f.required) continue;
    switch (f.type) {
      case 'string': item[f.name] = ''; break;
      case 'number': item[f.name] = 0; break;
      case 'boolean': item[f.name] = false; break;
      case 'date': item[f.name] = new Date().toISOString().split('T')[0]; break;
      case 'array': item[f.name] = []; break;
      case 'object': item[f.name] = f.objectFields ? generateDefaults(f.objectFields) : {}; break;
      default: item[f.name] = ''; break;
    }
  }
  return item;
}

/**
 * Detect if a ZodEffects schema is an Astro reference() and extract the collection name.
 * Astro's reference() returns ZodEffects<ZodUnion<[ZodString, ZodObject, ZodObject]>>
 */
function detectReference(schema: any): string | null {
  if (schema._def?.typeName !== 'ZodEffects') return null;
  if (schema._def?.effect?.type !== 'transform') return null;

  const innerSchema = schema._def.schema;
  if (!innerSchema || innerSchema._def?.typeName !== 'ZodUnion') return null;

  const options = innerSchema._def.options;
  if (!Array.isArray(options) || options.length < 2) return null;

  // Check pattern: first option is ZodString, second is ZodObject with collection field
  const firstIsString = options[0]?._def?.typeName === 'ZodString';
  const secondIsObject = options[1]?._def?.typeName === 'ZodObject';
  if (!firstIsString || !secondIsObject) return null;

  const secondShape = options[1]._def.shape?.() ?? options[1]._def.shape ?? {};
  if (!('collection' in secondShape)) return null;

  // Try to extract collection name from the transform function's source
  try {
    const fnStr = schema._def.effect.transform.toString();
    const match = fnStr.match(/!==\s*["']([^"']+)["']/) ??
                  fnStr.match(/collection\s*[=!]==?\s*["']([^"']+)["']/);
    if (match) return match[1];
  } catch {}

  // Fallback: try calling the transform with a mock context to extract the collection
  try {
    const mockCtx = {
      path: [],
      addIssue: () => {},
    };
    const result = schema._def.effect.transform('__mimsy_probe__', mockCtx);
    if (result && typeof result === 'object' && 'collection' in result) {
      return result.collection as string;
    }
  } catch {}

  return '__unknown__';
}

/**
 * Unwrap a schema through ZodEffects (preprocess/refine), ZodPipeline, etc.
 * Used to get to the base ZodObject for the top-level shape.
 */
function unwrapSchema(schema: any): any {
  if (!schema?._def) return schema;
  const typeName = schema._def.typeName;

  if (typeName === 'ZodEffects' && schema._def.schema) {
    return unwrapSchema(schema._def.schema);
  }
  if (typeName === 'ZodPipeline' && schema._def.in) {
    return unwrapSchema(schema._def.in);
  }
  return schema;
}

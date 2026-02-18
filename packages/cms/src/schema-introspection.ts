import type { SchemaField, CollectionSchema } from './types.js';

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
 * Introspect a ZodObject schema into an array of SchemaField descriptors.
 */
function introspectObjectSchema(schema: any): SchemaField[] {
  const unwrapped = unwrapSchema(schema);
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
      const elementType = schema._def.type
        ? introspectBaseType(schema._def.type)
        : { type: 'unknown' as const };
      return { type: 'array', arrayItemType: elementType };
    }
    case 'ZodObject':
      return { type: 'object' };
    default:
      return { type: 'unknown' };
  }
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
    // Look for string literal comparisons with the collection name
    // Pattern: !== "collectionName" or !== 'collectionName'
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

  // We know it's a reference but can't determine the collection
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

import { z, type ZodTypeAny } from 'astro/zod';

/**
 * Extract raw Zod schemas from the user's collections object.
 * Replaces reference() fields with z.string() so safeParse works
 * without Astro's content layer. Handles function schemas by calling
 * them with a mock image() context. Preserves top-level refinements
 * and recurses into nested ZodObject shapes.
 */
export function extractValidators(
  collections: Record<string, { schema?: unknown }>
): Record<string, ZodTypeAny> {
  const result: Record<string, ZodTypeAny> = {};

  for (const [name, col] of Object.entries(collections)) {
    if (!col.schema) continue;

    // Schema can be a ZodType or a function returning one (Astro supports both)
    let schema: any = col.schema;
    if (typeof schema === 'function') {
      try {
        schema = schema({ image: () => z.string() });
      } catch {
        continue;
      }
    }

    // Clean the entire schema tree — preserves effects, recurses into objects
    result[name] = cleanSchema(schema);
  }

  return result;
}

/**
 * Recursively clean a Zod schema tree, replacing reference() patterns with
 * z.string() and walking through all wrappers including nested ZodObjects.
 * Preserves refinements, transforms, and preprocess effects.
 */
function cleanSchema(schema: any): ZodTypeAny {
  if (!schema?._def) return schema;

  const typeName = schema._def.typeName;

  // ZodOptional — recurse into inner, re-wrap
  if (typeName === 'ZodOptional') {
    return cleanSchema(schema._def.innerType).optional() as ZodTypeAny;
  }

  // ZodDefault — recurse into inner, re-wrap with same default
  if (typeName === 'ZodDefault') {
    const defaultVal = schema._def.defaultValue;
    return cleanSchema(schema._def.innerType).default(defaultVal()) as ZodTypeAny;
  }

  // ZodNullable — recurse into inner, re-wrap
  if (typeName === 'ZodNullable') {
    return cleanSchema(schema._def.innerType).nullable() as ZodTypeAny;
  }

  // ZodArray — recurse into element type
  if (typeName === 'ZodArray') {
    if (schema._def.type) {
      return z.array(cleanSchema(schema._def.type)) as ZodTypeAny;
    }
    return schema;
  }

  // ZodObject — recurse into shape fields
  if (typeName === 'ZodObject') {
    const shape = schema._def.shape?.() ?? schema._def.shape ?? {};
    const cleanedShape: Record<string, ZodTypeAny> = {};
    for (const [field, fieldSchema] of Object.entries(shape)) {
      cleanedShape[field] = cleanSchema(fieldSchema as any);
    }
    return z.object(cleanedShape) as ZodTypeAny;
  }

  // ZodEffects — check if it's a reference(), otherwise preserve effect with cleaned inner
  if (typeName === 'ZodEffects') {
    if (isReference(schema)) {
      return z.string();
    }
    // Preserve the effect, clean the inner schema
    if (schema._def.schema) {
      const cleaned = cleanSchema(schema._def.schema);
      const effect = schema._def.effect;
      if (effect.type === 'refinement') {
        return cleaned.refine(effect.refinement) as ZodTypeAny;
      }
      if (effect.type === 'transform') {
        return cleaned.transform(effect.transform) as ZodTypeAny;
      }
      if (effect.type === 'preprocess') {
        return z.preprocess(effect.transform, cleaned) as ZodTypeAny;
      }
    }
    return schema;
  }

  // ZodPipeline — recurse into input
  if (typeName === 'ZodPipeline') {
    if (schema._def.in) {
      return cleanSchema(schema._def.in);
    }
    return schema;
  }

  // Primitives (string, number, boolean, date, enum, etc.) — keep as-is
  return schema;
}

/**
 * Detect if a ZodEffects schema is an Astro reference().
 * Same detection logic as schema-introspection.ts detectReference().
 */
function isReference(schema: any): boolean {
  if (schema._def?.typeName !== 'ZodEffects') return false;
  if (schema._def?.effect?.type !== 'transform') return false;

  const inner = schema._def.schema;
  if (!inner || inner._def?.typeName !== 'ZodUnion') return false;

  const options = inner._def.options;
  if (!Array.isArray(options) || options.length < 2) return false;

  return (
    options[0]?._def?.typeName === 'ZodString' &&
    options[1]?._def?.typeName === 'ZodObject'
  );
}

/**
 * Validate frontmatter against a collection's Zod schema.
 * Uses safeParseAsync to support async refinements.
 * Validates only — does NOT return parsed/coerced data.
 */
export async function validateFrontmatter(
  schema: ZodTypeAny,
  frontmatter: Record<string, unknown>
): Promise<{ success: true } | { success: false; error: string; fieldErrors: Record<string, string[]> }> {
  const result = await schema.safeParseAsync(frontmatter);

  if (result.success) {
    return { success: true };
  }

  const flat = result.error.flatten();
  return {
    success: false,
    error: 'Validation failed',
    fieldErrors: flat.fieldErrors as Record<string, string[]>,
  };
}

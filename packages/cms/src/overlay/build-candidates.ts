import type { SchemaField, PageTextField } from '../types.js';

export interface MatchCandidate {
  fieldPath: string;
  value: string;
  fieldType: string;
  fieldName: string;
  arrayField?: string;
  arrayIndex?: number;
  editable: boolean;
}

/**
 * Walk frontmatter recursively using schema for type info.
 * Only includes string-type values (skips booleans, numbers, dates, reference IDs).
 */
export function buildCandidates(
  data: Record<string, unknown>,
  schema: SchemaField[],
  prefix = '',
): MatchCandidate[] {
  const candidates: MatchCandidate[] = [];

  for (const field of schema) {
    const value = data[field.name];
    const path = prefix ? `${prefix}.${field.name}` : field.name;

    if (field.type === 'string' && typeof value === 'string' && value.trim()) {
      candidates.push({
        fieldPath: path,
        value: value.trim(),
        fieldType: 'string',
        fieldName: field.name,
        editable: true,
      });
    }

    if (
      field.type === 'object' &&
      field.objectFields &&
      typeof value === 'object' &&
      value
    ) {
      candidates.push(
        ...buildCandidates(
          value as Record<string, unknown>,
          field.objectFields,
          path,
        ),
      );
    }

    if (field.type === 'array' && Array.isArray(value)) {
      const blockConfig = field.arrayItemType?.blockConfig;
      if (blockConfig) {
        for (let i = 0; i < value.length; i++) {
          const item = value[i] as Record<string, unknown>;
          const discValue = item[blockConfig.discriminator];
          const variant = blockConfig.variants.find(
            (v) => v.type === discValue,
          );
          if (variant) {
            const itemCandidates = buildCandidates(
              item,
              variant.fields,
              `${path}[${i}]`,
            );
            for (const c of itemCandidates) {
              c.arrayField = path;
              c.arrayIndex = i;
            }
            candidates.push(...itemCandidates);
          }
        }
      } else if (field.arrayItemType?.objectFields) {
        for (let i = 0; i < value.length; i++) {
          const item = value[i] as Record<string, unknown>;
          const itemCandidates = buildCandidates(
            item,
            field.arrayItemType!.objectFields!,
            `${path}[${i}]`,
          );
          for (const c of itemCandidates) {
            c.arrayField = path;
            c.arrayIndex = i;
          }
          candidates.push(...itemCandidates);
        }
      }
    }
  }

  return candidates;
}

/**
 * Convert PageTextField[] directly to candidates.
 * These have exact text from AST extraction — high confidence matches.
 */
export function buildPageCandidates(fields: PageTextField[]): MatchCandidate[] {
  return fields
    .filter((f) => f.value.trim().length > 0)
    .map((f) => ({
      fieldPath: f.id,
      value: f.value.trim(),
      fieldType: f.kind,
      fieldName: f.label,
      editable: true,
    }));
}

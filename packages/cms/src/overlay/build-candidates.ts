import type { SchemaField, PageTextField } from '../types.js';
import { djb2Hash } from './bridge.js';

export interface MatchCandidate {
  fieldPath: string;
  value: string;
  fieldType: string;
  fieldName: string;
  arrayField?: string;
  arrayIndex?: number;
  editable: boolean;
  /** 'attribute' matches src/href/style attrs; default is text matching */
  matchMode?: 'text' | 'attribute';
}

/**
 * Walk frontmatter recursively using schema for type info.
 * Emits string and image fields (skips booleans, numbers, dates, reference IDs).
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
      const trimmed = value.trim();
      // Detect by VALUE, not field name: URLs/paths never contain spaces
      const isAttr = /^https?:\/\//.test(trimmed) ||
        (/^(\/|\.\/|\.\.\/|#)/.test(trimmed) && !/\s/.test(trimmed));
      candidates.push({
        fieldPath: path,
        value: trimmed,
        fieldType: 'string',
        fieldName: field.name,
        editable: !isAttr,
        matchMode: isAttr ? 'attribute' : undefined,
      });
    }

    if (field.type === 'image' && typeof value === 'string' && value.trim()) {
      candidates.push({
        fieldPath: path,
        value: value.trim(),
        fieldType: 'image',
        fieldName: field.name,
        editable: false,
        matchMode: 'attribute',
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

/**
 * Generate a probe sentinel value for a given field.
 * Image/URL fields get a path-like value so components that parse URLs don't break.
 * Text fields get a plain sentinel string.
 */
function makeProbeId(fieldPath: string, fieldType: string, value: string): string {
  const hash = djb2Hash(fieldPath);
  const safePath = fieldPath.replace(/[.\[\]]/g, '_');
  const isUrl = fieldType === 'image' ||
    /^https?:\/\//.test(value) ||
    (/^(\/|\.\/|\.\.\/|#)/.test(value) && !/\s/.test(value));
  if (isUrl) {
    // Path-like probe so <Image>, URL parsers, etc. don't throw
    return `/_mimsy_probe/${hash}_${safePath}`;
  }
  return `__mp_${hash}_${safePath}__`;
}

/**
 * Generate probed frontmatter for mutation probing.
 * Replaces all string/image values with unique sentinel IDs.
 * Returns the modified data and a map from probe ID → field path.
 */
export function generateProbes(
  data: Record<string, unknown>,
  schema: SchemaField[],
  prefix = '',
): { probedData: Record<string, unknown>; probeMap: Record<string, string> } {
  const probedData: Record<string, unknown> = { ...data };
  const probeMap: Record<string, string> = {};

  for (const field of schema) {
    const value = data[field.name];
    const path = prefix ? `${prefix}.${field.name}` : field.name;

    if ((field.type === 'string' || field.type === 'image') && typeof value === 'string' && value.trim()) {
      const probeId = makeProbeId(path, field.type, value);
      probedData[field.name] = probeId;
      probeMap[probeId] = path;
    }

    if (field.type === 'object' && field.objectFields && typeof value === 'object' && value) {
      const sub = generateProbes(value as Record<string, unknown>, field.objectFields, path);
      probedData[field.name] = sub.probedData;
      Object.assign(probeMap, sub.probeMap);
    }

    if (field.type === 'array' && Array.isArray(value)) {
      const probedArray: unknown[] = [];
      const blockConfig = field.arrayItemType?.blockConfig;

      for (let i = 0; i < value.length; i++) {
        const item = value[i];
        const itemPath = `${path}[${i}]`;

        if (blockConfig && typeof item === 'object' && item) {
          const rec = item as Record<string, unknown>;
          const discValue = rec[blockConfig.discriminator];
          const variant = blockConfig.variants.find((v) => v.type === discValue);
          if (variant) {
            const sub = generateProbes(rec, variant.fields, itemPath);
            sub.probedData[blockConfig.discriminator] = discValue; // preserve discriminator
            probedArray.push(sub.probedData);
            Object.assign(probeMap, sub.probeMap);
          } else {
            probedArray.push(item);
          }
        } else if (field.arrayItemType?.objectFields && typeof item === 'object' && item) {
          const sub = generateProbes(item as Record<string, unknown>, field.arrayItemType.objectFields, itemPath);
          probedArray.push(sub.probedData);
          Object.assign(probeMap, sub.probeMap);
        } else if (typeof item === 'string' && item.trim()) {
          // Primitive string array item (e.g., tags: z.array(z.string()))
          const probeId = makeProbeId(itemPath, field.arrayItemType?.type ?? 'string', item);
          probedArray.push(probeId);
          probeMap[probeId] = itemPath;
        } else {
          probedArray.push(item);
        }
      }
      probedData[field.name] = probedArray;
    }
  }

  return { probedData, probeMap };
}

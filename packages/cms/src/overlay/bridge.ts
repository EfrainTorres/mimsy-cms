/** UTF-8-safe hash — djb2 algorithm. Returns hex string. */
export function djb2Hash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16);
}

/** Parse dotted/bracketed path to segments: 'sections[0].heading' → ['sections', 0, 'heading'] */
export function parsePath(path: string): (string | number)[] {
  return path
    .split(/\.|\[|\]/)
    .filter(Boolean)
    .map((s) => (/^\d+$/.test(s) ? Number(s) : s));
}

export function setNestedValue(obj: any, path: string, value: unknown): void {
  const segments = parsePath(path);
  let current = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    current = current[segments[i]];
    if (!current) return;
  }
  current[segments[segments.length - 1]] = value;
}

export function getNestedValue(obj: any, path: string): unknown {
  const segments = parsePath(path);
  let current = obj;
  for (const seg of segments) {
    current = current?.[seg as keyof typeof current];
  }
  return current;
}

/**
 * Focus a field in the editor panel by its fieldPath.
 *
 * Field IDs use a deterministic path-based scheme:
 * - Top-level: `field-title`, `field-description`
 * - Nested in block: `field-sections-0-heading`, `field-sections-1-features-0-text`
 *
 * FieldRenderer MUST generate IDs matching this pattern:
 *   path segments joined with '-', brackets replaced: sections[0].heading → sections-0-heading
 */
export function focusFieldInEditor(fieldPath: string): void {
  const fieldId =
    'field-' +
    fieldPath.replace(/\./g, '-').replace(/\[/g, '-').replace(/\]/g, '');
  let el = document.getElementById(fieldId);

  // Fallback: try top-level key (for simple fields)
  if (!el) {
    const topKey = fieldPath.split(/[.\[]/)[0];
    el = document.getElementById(`field-${topKey}`);
  }

  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('mimsy-field-focus');
    setTimeout(() => el!.classList.remove('mimsy-field-focus'), 1500);
    const input = el.querySelector('input, textarea, select');
    if (input) (input as HTMLElement).focus();
  }
}

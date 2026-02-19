const ACRONYMS = new Set(['cta', 'url', 'seo', 'api', 'id', 'html', 'css', 'ui', 'ux']);

/** Convert camelCase/snake_case field names to human-readable labels.
 *  "buttonText" → "Button Text", "cta" → "CTA", "buttonUrl" → "Button URL" */
export function formatLabel(name) {
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .map(p => ACRONYMS.has(p.toLowerCase()) ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join(' ');
}

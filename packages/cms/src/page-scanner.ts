import { parse } from '@astrojs/compiler';
import { is } from '@astrojs/compiler/utils';
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { PageTextField, PageInfo } from './types.js';
import type { Node, ParentNode, ElementNode, ComponentNode, TextNode, AttributeNode } from '@astrojs/compiler/types';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Elements whose text children should be skipped */
const SKIP_ELEMENTS = new Set(['script', 'style', 'head', 'code', 'pre']);

/** Attributes that contain user-visible content */
const CONTENT_ATTRS = new Set(['alt', 'title', 'placeholder', 'aria-label', 'aria-description']);

/** Component props that contain user-visible content */
const CONTENT_PROPS = new Set([
  'title', 'subtitle', 'heading', 'description', 'label', 'text', 'cta', 'alt', 'placeholder',
]);

/** Elements that always contain meaningful text content (for phantom fields + whitespace check) */
const CONTENT_ELEMENTS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'a', 'button', 'label',
  'span', 'li', 'td', 'th', 'figcaption', 'blockquote', 'dt', 'dd',
]);

/** Section-level landmark elements for field grouping */
const SECTION_ELEMENTS = new Set([
  'header', 'section', 'footer', 'nav', 'main', 'article', 'aside',
]);

/**
 * Find the byte offset right AFTER the opening tag's `>`.
 * Skips `>` inside quoted strings and `{...}` expression regions.
 */
function findOpenTagEnd(sourceBytes: Uint8Array, startOffset: number): number | null {
  const region = decoder.decode(sourceBytes.slice(startOffset, Math.min(startOffset + 2000, sourceBytes.length)));
  let inQuote: string | null = null;
  let braceDepth = 0;
  for (let i = 0; i < region.length; i++) {
    const ch = region[i];
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inQuote = ch; continue; }
    if (ch === '{') { braceDepth++; continue; }
    if (ch === '}') { braceDepth = Math.max(0, braceDepth - 1); continue; }
    if (ch === '>' && braceDepth === 0) {
      const before = region.slice(0, i + 1);
      return startOffset + encoder.encode(before).length;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Build-time: scan pages directory for sidebar
// ---------------------------------------------------------------------------

export function scanPagesDirectory(pagesDir: string, basePath: string): PageInfo[] {
  const pages: PageInfo[] = [];

  function scan(dir: string) {
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (entry.name.includes('[')) continue;
        scan(fullPath);
        continue;
      }

      if (!entry.name.endsWith('.astro')) continue;
      if (entry.name.includes('[')) continue;

      const relPath = relative(pagesDir, fullPath);
      const normalized = relPath.replace(/\\/g, '/');

      // Derive route: "index.astro" → "", "about.astro" → "about", "about/index.astro" → "about"
      const stripped = normalized
        .replace(/(^|\/)index\.astro$/, '')
        .replace(/\.astro$/, '')
        .replace(/\/$/, '');
      const route = '/' + stripped;

      // Skip pages that match the admin basePath
      if (route === basePath || route.startsWith(basePath + '/')) continue;

      // Derive display name
      const segment = stripped === '' ? 'Home' : stripped.split('/').pop()!;
      const name = segment.charAt(0).toUpperCase() + segment.slice(1);

      pages.push({ name, path: normalized, route });
    }
  }

  scan(pagesDir);
  return pages.sort((a, b) => a.route.localeCompare(b.route));
}

// ---------------------------------------------------------------------------
// Runtime: extract editable text fields from .astro source
// ---------------------------------------------------------------------------

export async function extractTextFields(source: string): Promise<PageTextField[]> {
  const { ast } = await parse(source, { position: true });
  const sourceBytes = encoder.encode(source);
  const fields: PageTextField[] = [];
  const sectionCounters = new Map<string, number>();

  // Custom recursive walk with skip tracking and section grouping
  function visit(node: Node, parent: ParentNode | undefined, skip: boolean, group: string) {
    // Determine if this node (or its children) should be skipped
    const shouldSkip = skip ||
      is.expression(node) ||
      is.frontmatter(node) ||
      (is.element(node) && SKIP_ELEMENTS.has(node.name));

    // Update group when entering a section-level element
    let currentGroup = group;
    if (is.element(node) && SECTION_ELEMENTS.has(node.name)) {
      const count = (sectionCounters.get(node.name) ?? 0) + 1;
      sectionCounters.set(node.name, count);
      currentGroup = count === 1 ? node.name : `${node.name}:${count}`;
    }

    // Extract text nodes (only if not skipped)
    if (is.text(node) && !shouldSkip) {
      extractTextField(node, parent, sourceBytes, fields, currentGroup);
    }

    // Extract content attributes from elements and components (only if not skipped)
    if (!shouldSkip && (is.element(node) || is.component(node))) {
      extractAttrFields(node as ElementNode | ComponentNode, sourceBytes, fields, currentGroup);
    }

    // Recurse into children
    if (is.parent(node)) {
      const fieldsBefore = fields.length;
      for (const child of node.children) {
        visit(child, node, shouldSkip, currentGroup);
      }
      // Phantom field: content element with no text fields extracted from children
      if (!shouldSkip && is.element(node) && CONTENT_ELEMENTS.has(node.name)) {
        const hasTextFieldFromChildren = fields.length > fieldsBefore &&
          fields.slice(fieldsBefore).some(f => f.kind === 'text');
        if (!hasTextFieldFromChildren && node.children.length === 0 && node.position?.start) {
          const insertOffset = findOpenTagEnd(sourceBytes, node.position.start.offset);
          if (insertOffset !== null) {
            fields.push({
              id: `text:${insertOffset}`,
              label: `${node.name} text`,
              value: '',
              kind: 'text',
              offset: insertOffset,
              length: 0,
              multiline: false,
              group: currentGroup,
            });
          }
        }
      }
    }
  }

  visit(ast, undefined, false, '');
  return fields;
}

function extractTextField(
  node: TextNode,
  parent: ParentNode | undefined,
  sourceBytes: Uint8Array,
  fields: PageTextField[],
  group: string,
) {
  if (!node.position?.start) return;

  // Smart whitespace filter: skip whitespace-only text when parent has
  // non-text siblings (element, component, or expression = formatting indent)
  if (/^\s*$/.test(node.value)) {
    if (!parent || !is.parent(parent)) return;
    const hasNonTextSiblings = parent.children.some(
      (c: Node) => is.element(c) || is.component(c) || is.expression(c),
    );
    if (hasNonTextSiblings) return;
    // Whitespace-only inside a content element with no other children — keep it
    if (!is.element(parent) || !CONTENT_ELEMENTS.has(parent.name)) return;
  }

  const offset = node.position.start.offset;
  const valueBytes = encoder.encode(node.value);

  // Verify the bytes at the offset match
  const slice = sourceBytes.slice(offset, offset + valueBytes.length);
  if (decoder.decode(slice) !== node.value) return;

  // Derive label from parent element
  let label = 'text';
  if (parent && is.element(parent)) {
    label = `${parent.name} text`;
  } else if (parent && is.component(parent)) {
    label = `${parent.name} text`;
  }

  fields.push({
    id: `text:${offset}`,
    label,
    value: node.value,
    kind: 'text',
    offset,
    length: valueBytes.length,
    multiline: node.value.length > 80 || node.value.includes('\n'),
    group,
  });
}

function extractAttrFields(
  tagNode: ElementNode | ComponentNode,
  sourceBytes: Uint8Array,
  fields: PageTextField[],
  group: string,
) {
  const allowlist = is.component(tagNode) ? CONTENT_PROPS : CONTENT_ATTRS;

  for (const attr of tagNode.attributes) {
    if (attr.kind !== 'quoted') continue;
    if (!allowlist.has(attr.name)) continue;

    const trimmed = attr.value.trim();
    if (trimmed.length < 2) continue;

    const attrOffset = findAttributeValueOffset(sourceBytes, tagNode, attr);
    if (attrOffset === null) continue;

    const attrValueBytes = encoder.encode(attr.value);
    // Verify bytes at offset match
    const slice = sourceBytes.slice(attrOffset, attrOffset + attrValueBytes.length);
    if (decoder.decode(slice) !== attr.value) continue;

    fields.push({
      id: `attr:${attrOffset}:${attr.name}`,
      label: `${tagNode.name} ${attr.name}`,
      value: attr.value,
      kind: 'attribute',
      offset: attrOffset,
      length: attrValueBytes.length,
      multiline: false,
      group,
    });
  }
}

/**
 * Find the byte offset of an attribute's VALUE in the source.
 * AST positions for attributes point to the attribute name, not the value.
 * Search is bounded to the opening tag (up to the closing `>`).
 */
function findAttributeValueOffset(
  sourceBytes: Uint8Array,
  parent: ElementNode | ComponentNode,
  attr: AttributeNode,
): number | null {
  if (!parent.position?.start) return null;

  const startOffset = parent.position.start.offset;
  const tagEnd = findOpenTagEnd(sourceBytes, startOffset);
  const searchEnd = tagEnd ?? Math.min(startOffset + 2000, sourceBytes.length);
  const searchRegion = decoder.decode(sourceBytes.slice(startOffset, searchEnd));

  // Look for attrName=" or attrName='
  for (const quote of ['"', "'"]) {
    const pattern = `${attr.name}=${quote}`;
    const idx = searchRegion.indexOf(pattern);
    if (idx === -1) continue;

    const valueStartInRegion = idx + pattern.length;
    const beforeValue = searchRegion.slice(0, valueStartInRegion);
    const beforeValueBytes = encoder.encode(beforeValue);
    return startOffset + beforeValueBytes.length;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Runtime: extract collection references from frontmatter
// ---------------------------------------------------------------------------

export function extractCollectionRefs(source: string): string[] {
  // Only scan frontmatter (between first --- pair)
  const fmMatch = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return [];
  const frontmatter = fmMatch[1];

  const refs = new Set<string>();
  const getCollectionRe = /getCollection\s*\(\s*['"](\w+)['"]/g;
  const getEntryRe = /getEntry\s*\(\s*['"](\w+)['"]/g;

  let m: RegExpExecArray | null;
  while ((m = getCollectionRe.exec(frontmatter)) !== null) refs.add(m[1]);
  while ((m = getEntryRe.exec(frontmatter)) !== null) refs.add(m[1]);

  return [...refs];
}

// ---------------------------------------------------------------------------
// Runtime: apply text edits to source (byte-safe)
// ---------------------------------------------------------------------------

export async function applyTextEdits(
  source: string,
  edits: Array<{ id: string; oldValue: string; value: string }>,
): Promise<string> {
  const fields = await extractTextFields(source);
  const sourceBytes = encoder.encode(source);
  const replacements: Array<{ offset: number; length: number; newValue: string }> = [];

  for (const edit of edits) {
    const field = fields.find((f) => f.id === edit.id);
    if (!field) continue;

    // Empty oldValue: only allow insertion if the field is still empty (phantom)
    if (edit.oldValue === '') {
      if (field.length !== 0) continue; // file changed — field is no longer empty
      replacements.push({ offset: field.offset, length: 0, newValue: edit.value });
      continue;
    }

    // Verify the bytes at offset match oldValue
    const oldValueBytes = encoder.encode(edit.oldValue);
    const slice = sourceBytes.slice(field.offset, field.offset + oldValueBytes.length);

    if (decoder.decode(slice) === edit.oldValue) {
      replacements.push({ offset: field.offset, length: oldValueBytes.length, newValue: edit.value });
      continue;
    }

    // Fallback: search for oldValue within ±200 bytes of expected offset
    const searchStart = Math.max(0, field.offset - 200);
    const searchEnd = Math.min(sourceBytes.length, field.offset + oldValueBytes.length + 200);
    const searchRegion = decoder.decode(sourceBytes.slice(searchStart, searchEnd));
    const fallbackIdx = searchRegion.indexOf(edit.oldValue);

    if (fallbackIdx !== -1) {
      const fallbackOffset = searchStart + encoder.encode(searchRegion.slice(0, fallbackIdx)).length;
      replacements.push({ offset: fallbackOffset, length: oldValueBytes.length, newValue: edit.value });
    }
  }

  // Sort by offset descending (end-to-start) to preserve earlier offsets
  replacements.sort((a, b) => b.offset - a.offset);

  let result = source;
  for (const rep of replacements) {
    result = spliceBytes(result, rep.offset, rep.length, rep.newValue);
  }

  return result;
}

/** Replace bytes at [offset, offset+length) with replacement string. */
function spliceBytes(source: string, offset: number, length: number, replacement: string): string {
  const bytes = encoder.encode(source);
  const before = bytes.slice(0, offset);
  const after = bytes.slice(offset + length);
  const rep = encoder.encode(replacement);
  const result = new Uint8Array(before.length + rep.length + after.length);
  result.set(before, 0);
  result.set(rep, before.length);
  result.set(after, before.length + rep.length);
  return decoder.decode(result);
}

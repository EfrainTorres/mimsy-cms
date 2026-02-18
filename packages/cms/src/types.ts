/** User-facing configuration for mimsy() */
export interface MimsyConfig {
  /** Base path for admin UI. Default: '/admin' */
  basePath?: string;
  /** Absolute path to content data directory. Default: auto-detected from project root + 'src/data' */
  contentDir?: string;
}

/** Internal resolved config (after defaults applied) */
export interface ResolvedMimsyConfig {
  basePath: string;
  contentDir?: string;
}

/** A content entry as returned by the content adapter */
export interface ContentEntry {
  slug: string;
  collection: string;
  frontmatter: Record<string, unknown>;
  body: string;
  rawContent: string;
}

/** Describes a single field introspected from a Zod schema */
export interface SchemaField {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'date' | 'array' | 'enum' | 'reference' | 'object' | 'unknown';
  required: boolean;
  defaultValue?: unknown;
  /** For enum fields */
  enumValues?: string[];
  /** For reference fields — the target collection name */
  referenceCollection?: string;
  /** For array fields — the element type */
  arrayItemType?: Omit<SchemaField, 'name' | 'required'>;
}

/** Schema field map for a collection: field name → field info */
export type CollectionSchema = SchemaField[];

/** Authenticated user info (set by middleware in GitHub mode) */
export interface MimsyUser {
  login: string;
  name: string;
  email: string;
  avatar: string;
}

/** Error thrown when a concurrent edit causes a conflict (GitHub mode). */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

/** Editable text field extracted from an .astro page */
export interface PageTextField {
  id: string;
  label: string;
  value: string;
  kind: 'text' | 'attribute';
  offset: number;
  length: number;
  multiline: boolean;
}

/** Scanned .astro page for sidebar */
export interface PageInfo {
  name: string;
  path: string;
  route: string;
}

/** Content adapter interface — filesystem or GitHub */
export interface ContentAdapter {
  listCollections(): Promise<string[]>;
  listEntries(collection: string): Promise<ContentEntry[]>;
  getEntry(collection: string, slug: string): Promise<ContentEntry | null>;
  createEntry(collection: string, slug: string, frontmatter: Record<string, unknown>, body: string): Promise<void>;
  updateEntry(collection: string, slug: string, frontmatter: Record<string, unknown>, body: string): Promise<void>;
  deleteEntry(collection: string, slug: string): Promise<void>;

  /** Write an asset file (image upload). Returns the public URL. */
  writeAsset(filePath: string, content: Uint8Array, filename: string): Promise<string>;

  /** Read an arbitrary file by path (relative to content dir). Returns content string or null if not found. */
  getFileContent(path: string): Promise<string | null>;

  /** Read a file by project-root-relative path (e.g., 'src/pages/index.astro'). */
  getProjectFile(path: string): Promise<string | null>;

  /** Write a file by project-root-relative path. */
  writeProjectFile(path: string, content: string): Promise<void>;
}

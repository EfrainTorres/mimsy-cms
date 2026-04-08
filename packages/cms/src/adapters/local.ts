import { readdir, readFile, writeFile, unlink, mkdir, stat } from 'node:fs/promises';
import { join, dirname, parse as parsePath, extname, resolve, sep } from 'node:path';
import { existsSync } from 'node:fs';
import matter from 'gray-matter';
import type { ContentAdapter, ContentEntry } from '../types.js';

export class LocalContentAdapter implements ContentAdapter {
  constructor(private contentDir: string) {}

  /** Resolve path within base. Returns null if the result would escape base. */
  private safe(base: string, ...parts: string[]): string | null {
    const resolved = resolve(base, ...parts);
    return resolved.startsWith(resolve(base) + sep) ? resolved : null;
  }

  /** Like safe() but throws a tagged 400 error on traversal — for write operations. */
  private confined(base: string, ...parts: string[]): string {
    const resolved = this.safe(base, ...parts);
    if (!resolved) throw Object.assign(new Error('Invalid path'), { status: 400 });
    return resolved;
  }

  async listCollections(): Promise<string[]> {
    if (!existsSync(this.contentDir)) return [];
    const entries = await readdir(this.contentDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
      .map((e) => e.name)
      .sort();
  }

  async listEntries(collection: string): Promise<ContentEntry[]> {
    const dir = this.safe(this.contentDir, collection);
    if (!dir || !existsSync(dir)) return [];

    const files = await readdir(dir);
    const entries: ContentEntry[] = [];

    for (const file of files) {
      const ext = extname(file);
      if (ext !== '.md' && ext !== '.mdx' && ext !== '.json') continue;

      const slug = parsePath(file).name;
      const filePath = join(dir, file); // file comes from readdir, not user input
      const [rawContent, fileStat] = await Promise.all([
        readFile(filePath, 'utf-8'),
        stat(filePath),
      ]);
      const modifiedAt = fileStat.mtime.toISOString();

      if (ext === '.json') {
        let data: Record<string, unknown>;
        try { data = JSON.parse(rawContent); } catch (e) { console.warn(`[mimsy] Failed to parse ${filePath}:`, e); continue; }
        entries.push({ slug, collection, frontmatter: data, body: '', rawContent, modifiedAt });
      } else {
        const { data: frontmatter, content: body } = matter(rawContent);
        entries.push({ slug, collection, frontmatter, body: body.trim(), rawContent, modifiedAt });
      }
    }

    return entries;
  }

  async getEntry(collection: string, slug: string): Promise<ContentEntry | null> {
    const dir = this.safe(this.contentDir, collection);
    if (!dir) return null;

    for (const ext of ['.md', '.mdx', '.json']) {
      const filePath = this.safe(dir, `${slug}${ext}`);
      if (!filePath || !existsSync(filePath)) continue;

      const rawContent = await readFile(filePath, 'utf-8');

      if (ext === '.json') {
        const data = JSON.parse(rawContent);
        return { slug, collection, frontmatter: data, body: '', rawContent };
      }

      const { data: frontmatter, content: body } = matter(rawContent);
      return { slug, collection, frontmatter, body: body.trim(), rawContent };
    }

    return null;
  }

  async createEntry(
    collection: string,
    slug: string,
    frontmatter: Record<string, unknown>,
    body: string,
    format?: 'json' | 'markdown'
  ): Promise<void> {
    const dir = this.confined(this.contentDir, collection);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    const isJson = format === 'json' || (format !== 'markdown' && await this.isJsonCollection(collection));

    if (isJson) {
      const filePath = this.confined(dir, `${slug}.json`);
      await writeFile(filePath, JSON.stringify(frontmatter, null, 2) + '\n', 'utf-8');
    } else {
      const filePath = this.confined(dir, `${slug}.md`);
      const content = matter.stringify('\n' + body, frontmatter);
      await writeFile(filePath, content, 'utf-8');
    }
  }

  async updateEntry(
    collection: string,
    slug: string,
    frontmatter: Record<string, unknown>,
    body: string
  ): Promise<void> {
    const dir = this.confined(this.contentDir, collection);

    const jsonPath = this.confined(dir, `${slug}.json`);
    if (existsSync(jsonPath)) {
      await writeFile(jsonPath, JSON.stringify(frontmatter, null, 2) + '\n', 'utf-8');
      return;
    }

    for (const ext of ['.md', '.mdx']) {
      const filePath = this.confined(dir, `${slug}${ext}`);
      if (existsSync(filePath)) {
        const content = matter.stringify('\n' + body, frontmatter);
        await writeFile(filePath, content, 'utf-8');
        return;
      }
    }

    // Fallback: create as markdown
    await this.createEntry(collection, slug, frontmatter, body);
  }

  async deleteEntry(collection: string, slug: string): Promise<void> {
    const dir = this.confined(this.contentDir, collection);
    for (const ext of ['.md', '.mdx', '.json']) {
      const filePath = this.confined(dir, `${slug}${ext}`);
      if (existsSync(filePath)) {
        await unlink(filePath);
        return;
      }
    }
  }

  async writeAsset(filePath: string, content: Uint8Array, filename: string): Promise<string> {
    // Derive upload dir from content dir: src/data → project root → src/assets/uploads
    const projectRoot = dirname(dirname(this.contentDir));
    const uploadDir = join(projectRoot, 'src', 'assets', 'uploads');
    await mkdir(uploadDir, { recursive: true });
    const dest = this.confined(uploadDir, filename);
    await writeFile(dest, content);
    return `/src/assets/uploads/${filename}`;
  }

  async getFileContent(path: string): Promise<string | null> {
    const fullPath = this.safe(this.contentDir, path);
    if (!fullPath || !existsSync(fullPath)) return null;
    return readFile(fullPath, 'utf-8');
  }

  async getProjectFile(path: string): Promise<string | null> {
    const projectRoot = dirname(dirname(this.contentDir));
    const fullPath = this.safe(projectRoot, path);
    if (!fullPath || !existsSync(fullPath)) return null;
    return readFile(fullPath, 'utf-8');
  }

  async writeProjectFile(path: string, content: string): Promise<void> {
    const projectRoot = dirname(dirname(this.contentDir));
    const fullPath = this.confined(projectRoot, path);
    await writeFile(fullPath, content, 'utf-8');
  }

  private async isJsonCollection(collection: string): Promise<boolean> {
    const dir = this.safe(this.contentDir, collection);
    if (!dir || !existsSync(dir)) return false;
    const files = await readdir(dir);
    return files.some((f) => f.endsWith('.json'));
  }
}

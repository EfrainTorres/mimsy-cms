import { readdir, readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { join, dirname, parse as parsePath, extname } from 'node:path';
import { existsSync } from 'node:fs';
import matter from 'gray-matter';
import type { ContentAdapter, ContentEntry } from '../types.js';

export class LocalContentAdapter implements ContentAdapter {
  constructor(private contentDir: string) {}

  async listCollections(): Promise<string[]> {
    if (!existsSync(this.contentDir)) return [];
    const entries = await readdir(this.contentDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
      .map((e) => e.name)
      .sort();
  }

  async listEntries(collection: string): Promise<ContentEntry[]> {
    const dir = join(this.contentDir, collection);
    if (!existsSync(dir)) return [];

    const files = await readdir(dir);
    const entries: ContentEntry[] = [];

    for (const file of files) {
      const ext = extname(file);
      if (ext !== '.md' && ext !== '.mdx' && ext !== '.json') continue;

      const slug = parsePath(file).name;
      const filePath = join(dir, file);
      const rawContent = await readFile(filePath, 'utf-8');

      if (ext === '.json') {
        const data = JSON.parse(rawContent);
        entries.push({ slug, collection, frontmatter: data, body: '', rawContent });
      } else {
        const { data: frontmatter, content: body } = matter(rawContent);
        entries.push({ slug, collection, frontmatter, body: body.trim(), rawContent });
      }
    }

    return entries;
  }

  async getEntry(collection: string, slug: string): Promise<ContentEntry | null> {
    const dir = join(this.contentDir, collection);

    for (const ext of ['.md', '.mdx', '.json']) {
      const filePath = join(dir, `${slug}${ext}`);
      if (!existsSync(filePath)) continue;

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
    body: string
  ): Promise<void> {
    const dir = join(this.contentDir, collection);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    // Detect collection type from existing files
    const isJson = await this.isJsonCollection(collection);

    if (isJson) {
      const filePath = join(dir, `${slug}.json`);
      await writeFile(filePath, JSON.stringify(frontmatter, null, 2) + '\n', 'utf-8');
    } else {
      const filePath = join(dir, `${slug}.md`);
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
    const dir = join(this.contentDir, collection);

    // Check if existing file is JSON
    const jsonPath = join(dir, `${slug}.json`);
    if (existsSync(jsonPath)) {
      await writeFile(jsonPath, JSON.stringify(frontmatter, null, 2) + '\n', 'utf-8');
      return;
    }

    // Otherwise write as markdown
    for (const ext of ['.md', '.mdx']) {
      const filePath = join(dir, `${slug}${ext}`);
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
    const dir = join(this.contentDir, collection);
    for (const ext of ['.md', '.mdx', '.json']) {
      const filePath = join(dir, `${slug}${ext}`);
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

    const dest = join(uploadDir, filename);
    await writeFile(dest, content);
    return `/src/assets/uploads/${filename}`;
  }

  async getFileContent(path: string): Promise<string | null> {
    const fullPath = path.startsWith('/') ? path : join(this.contentDir, path);
    if (!existsSync(fullPath)) return null;
    return readFile(fullPath, 'utf-8');
  }

  private async isJsonCollection(collection: string): Promise<boolean> {
    const dir = join(this.contentDir, collection);
    if (!existsSync(dir)) return false;
    const files = await readdir(dir);
    return files.some((f) => f.endsWith('.json'));
  }
}

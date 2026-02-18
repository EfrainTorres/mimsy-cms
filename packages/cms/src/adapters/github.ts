import { Octokit } from 'octokit';
import matter from 'gray-matter';
import { ConflictError } from '../types.js';
import type { ContentAdapter, ContentEntry } from '../types.js';

export interface GitHubAdapterConfig {
  repo: string;
  branch: string;
  contentPath: string;
  token: string;
  author?: { name: string; email: string };
}

/** Module-level response cache — persists across per-request adapter instances. */
const apiCache = new Map<string, { data: unknown; expires: number }>();
const CACHE_TTL = 30_000; // 30 seconds

export class GitHubContentAdapter implements ContentAdapter {
  private octokit: Octokit;
  private owner: string;
  private repo: string;
  private branch: string;
  private contentPath: string;
  private author?: { name: string; email: string };

  constructor(config: GitHubAdapterConfig) {
    const parts = config.repo.split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error(
        `[mimsy] Invalid MIMSY_GITHUB_REPO format: "${config.repo}". Expected "owner/repo".`
      );
    }

    this.octokit = new Octokit({ auth: config.token });
    this.owner = parts[0];
    this.repo = parts[1];
    this.branch = config.branch;
    this.contentPath = config.contentPath;
    this.author = config.author;
  }

  async listCollections(): Promise<string[]> {
    try {
      const { data } = await this.octokit.rest.repos.getContent({
        owner: this.owner,
        repo: this.repo,
        ref: this.branch,
        path: this.contentPath,
      });

      if (!Array.isArray(data)) return [];

      return data
        .filter((entry) => entry.type === 'dir' && !entry.name.startsWith('_'))
        .map((entry) => entry.name)
        .sort();
    } catch (err: unknown) {
      if (isNotFound(err)) return [];
      throw err;
    }
  }

  async listEntries(collection: string): Promise<ContentEntry[]> {
    const dirPath = `${this.contentPath}/${collection}`;

    try {
      const { data } = await this.octokit.rest.repos.getContent({
        owner: this.owner,
        repo: this.repo,
        ref: this.branch,
        path: dirPath,
      });

      if (!Array.isArray(data)) return [];

      const contentFiles = data.filter((entry) => {
        if (entry.type !== 'file') return false;
        const name = entry.name;
        return name.endsWith('.md') || name.endsWith('.mdx') || name.endsWith('.json');
      });

      const entries = await Promise.all(
        contentFiles.map(async (file) => {
          const rawContent = await this.fetchFileContent(`${dirPath}/${file.name}`);
          if (rawContent === null) return null;

          const ext = extname(file.name);
          const slug = basename(file.name, ext);

          if (ext === '.json') {
            const frontmatter = JSON.parse(rawContent);
            return { slug, collection, frontmatter, body: '', rawContent } as ContentEntry;
          }

          const { data: frontmatter, content: body } = matter(rawContent);
          return { slug, collection, frontmatter, body: body.trim(), rawContent } as ContentEntry;
        })
      );

      return entries.filter((e): e is ContentEntry => e !== null);
    } catch (err: unknown) {
      if (isNotFound(err)) return [];
      throw err;
    }
  }

  async getEntry(collection: string, slug: string): Promise<ContentEntry | null> {
    const ext = await this.findFileExtension(collection, slug);
    if (!ext) return null;

    const filePath = `${this.contentPath}/${collection}/${slug}${ext}`;
    const rawContent = await this.fetchFileContent(filePath);
    if (rawContent === null) return null;

    if (ext === '.json') {
      const frontmatter = JSON.parse(rawContent);
      return { slug, collection, frontmatter, body: '', rawContent };
    }

    const { data: frontmatter, content: body } = matter(rawContent);
    return { slug, collection, frontmatter, body: body.trim(), rawContent };
  }

  async createEntry(
    collection: string,
    slug: string,
    frontmatter: Record<string, unknown>,
    body: string
  ): Promise<void> {
    const isJson = await this.isJsonCollection(collection);

    if (isJson) {
      const filePath = `${this.contentPath}/${collection}/${slug}.json`;
      const content = JSON.stringify(frontmatter, null, 2) + '\n';
      await this.commitFile(filePath, content, 'utf-8', `Create: ${collection}/${slug}`);
    } else {
      const filePath = `${this.contentPath}/${collection}/${slug}.md`;
      const content = matter.stringify('\n' + body, frontmatter);
      await this.commitFile(filePath, content, 'utf-8', `Create: ${collection}/${slug}`);
    }
  }

  async updateEntry(
    collection: string,
    slug: string,
    frontmatter: Record<string, unknown>,
    body: string
  ): Promise<void> {
    // Check if existing file is JSON
    const ext = await this.findFileExtension(collection, slug);

    if (ext === '.json') {
      const filePath = `${this.contentPath}/${collection}/${slug}.json`;
      const content = JSON.stringify(frontmatter, null, 2) + '\n';
      await this.commitFile(filePath, content, 'utf-8', `Update: ${collection}/${slug}`);
      return;
    }

    if (ext === '.md' || ext === '.mdx') {
      const filePath = `${this.contentPath}/${collection}/${slug}${ext}`;
      const content = matter.stringify('\n' + body, frontmatter);
      await this.commitFile(filePath, content, 'utf-8', `Update: ${collection}/${slug}`);
      return;
    }

    // Fallback: create as new entry (matches local adapter behavior)
    await this.createEntry(collection, slug, frontmatter, body);
  }

  async deleteEntry(collection: string, slug: string): Promise<void> {
    const ext = await this.findFileExtension(collection, slug);
    if (!ext) return;

    const filePath = `${this.contentPath}/${collection}/${slug}${ext}`;
    await this.deleteGitFile(filePath, `Delete: ${collection}/${slug}`);
  }

  async writeAsset(filePath: string, content: Uint8Array, filename: string): Promise<string> {
    const base64Content = uint8ArrayToBase64(content);
    await this.commitFile(filePath, base64Content, 'base64', `Upload: ${filename}`);
    return `/${filePath}`;
  }

  async getFileContent(path: string): Promise<string | null> {
    // Resolve relative paths against contentPath (matches local adapter behavior)
    const fullPath = path.startsWith(this.contentPath) ? path : `${this.contentPath}/${path}`;
    return this.fetchFileContent(fullPath);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Fetch a single file's text content from the repo. Returns null on 404.
   * Results are cached for CACHE_TTL to avoid redundant API calls.
   */
  private async fetchFileContent(path: string): Promise<string | null> {
    const cacheKey = `file:${path}`;
    const cached = apiCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) return cached.data as string | null;

    try {
      const { data } = await this.octokit.rest.repos.getContent({
        owner: this.owner,
        repo: this.repo,
        ref: this.branch,
        path,
      });

      if (Array.isArray(data) || data.type !== 'file' || !data.content) return null;

      const content = decodeBase64(data.content);
      apiCache.set(cacheKey, { data: content, expires: Date.now() + CACHE_TTL });
      return content;
    } catch (err: unknown) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  /**
   * Commit a single file to the repo using the Git Data API (atomic).
   *
   * Steps:
   *   1. Get current ref (latest commit SHA)
   *   2. Get commit (base tree SHA)
   *   3. Create blob
   *   4. Create tree with the new blob
   *   5. Create commit
   *   6. Update ref
   */
  private async commitFile(
    path: string,
    content: string,
    encoding: 'utf-8' | 'base64',
    message: string
  ): Promise<void> {
    const owner = this.owner;
    const repo = this.repo;

    // 1. Get current ref
    const { data: refData } = await this.octokit.rest.git.getRef({
      owner,
      repo,
      ref: `heads/${this.branch}`,
    });
    const latestCommitSha = refData.object.sha;

    // 2. Get commit to find base tree
    const { data: commitData } = await this.octokit.rest.git.getCommit({
      owner,
      repo,
      commit_sha: latestCommitSha,
    });
    const baseTreeSha = commitData.tree.sha;

    // 3. Create blob
    const { data: blobData } = await this.octokit.rest.git.createBlob({
      owner,
      repo,
      content,
      encoding,
    });

    // 4. Create tree
    const { data: treeData } = await this.octokit.rest.git.createTree({
      owner,
      repo,
      base_tree: baseTreeSha,
      tree: [
        {
          path,
          mode: '100644',
          type: 'blob',
          sha: blobData.sha,
        },
      ],
    });

    // 5. Create commit
    const commitParams: Parameters<typeof this.octokit.rest.git.createCommit>[0] = {
      owner,
      repo,
      message,
      tree: treeData.sha,
      parents: [latestCommitSha],
    };

    if (this.author) {
      commitParams.author = {
        name: this.author.name,
        email: this.author.email,
        date: new Date().toISOString(),
      };
    }

    const { data: newCommit } = await this.octokit.rest.git.createCommit(commitParams);

    // 6. Update ref
    try {
      await this.octokit.rest.git.updateRef({
        owner,
        repo,
        ref: `heads/${this.branch}`,
        sha: newCommit.sha,
      });
    } catch (err: unknown) {
      if (isConflict(err)) {
        throw new ConflictError(
          `Conflict updating ${path}: the branch was modified concurrently. Please retry.`
        );
      }
      throw err;
    }

    // Invalidate cache after write
    apiCache.clear();
  }

  /**
   * Delete a single file from the repo using the Git Data API.
   * Creates a tree entry with `sha: null` to remove the file.
   */
  private async deleteGitFile(path: string, message: string): Promise<void> {
    const owner = this.owner;
    const repo = this.repo;

    // 1. Get current ref
    const { data: refData } = await this.octokit.rest.git.getRef({
      owner,
      repo,
      ref: `heads/${this.branch}`,
    });
    const latestCommitSha = refData.object.sha;

    // 2. Get commit to find base tree
    const { data: commitData } = await this.octokit.rest.git.getCommit({
      owner,
      repo,
      commit_sha: latestCommitSha,
    });
    const baseTreeSha = commitData.tree.sha;

    // 3. Create tree with sha: null to delete the file
    const { data: treeData } = await this.octokit.rest.git.createTree({
      owner,
      repo,
      base_tree: baseTreeSha,
      tree: [
        {
          path,
          mode: '100644',
          type: 'blob',
          sha: null as unknown as string,
        },
      ],
    });

    // 4. Create commit
    const commitParams: Parameters<typeof this.octokit.rest.git.createCommit>[0] = {
      owner,
      repo,
      message,
      tree: treeData.sha,
      parents: [latestCommitSha],
    };

    if (this.author) {
      commitParams.author = {
        name: this.author.name,
        email: this.author.email,
        date: new Date().toISOString(),
      };
    }

    const { data: newCommit } = await this.octokit.rest.git.createCommit(commitParams);

    // 5. Update ref
    try {
      await this.octokit.rest.git.updateRef({
        owner,
        repo,
        ref: `heads/${this.branch}`,
        sha: newCommit.sha,
      });
    } catch (err: unknown) {
      if (isConflict(err)) {
        throw new ConflictError(
          `Conflict deleting ${path}: the branch was modified concurrently. Please retry.`
        );
      }
      throw err;
    }

    // Invalidate cache after delete
    apiCache.clear();
  }

  /**
   * Check if a collection uses JSON format by looking at existing files.
   */
  private async isJsonCollection(collection: string): Promise<boolean> {
    const dirPath = `${this.contentPath}/${collection}`;

    try {
      const { data } = await this.octokit.rest.repos.getContent({
        owner: this.owner,
        repo: this.repo,
        ref: this.branch,
        path: dirPath,
      });

      if (!Array.isArray(data)) return false;

      return data.some((entry) => entry.type === 'file' && entry.name.endsWith('.json'));
    } catch {
      return false;
    }
  }

  /**
   * Find which file extension exists for a given collection/slug.
   * Uses a single directory listing instead of trying each extension separately.
   */
  private async findFileExtension(collection: string, slug: string): Promise<string | null> {
    const dirFiles = await this.listDirFiles(collection);
    for (const ext of ['.md', '.mdx', '.json']) {
      if (dirFiles.some((f) => f.name === `${slug}${ext}`)) return ext;
    }
    return null;
  }

  /**
   * List files in a collection directory. Cached to avoid redundant API calls.
   */
  private async listDirFiles(collection: string): Promise<Array<{ name: string; type: string }>> {
    const dirPath = `${this.contentPath}/${collection}`;
    const cacheKey = `dir:${dirPath}`;
    const cached = apiCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) return cached.data as Array<{ name: string; type: string }>;

    try {
      const { data } = await this.octokit.rest.repos.getContent({
        owner: this.owner,
        repo: this.repo,
        ref: this.branch,
        path: dirPath,
      });

      if (!Array.isArray(data)) return [];

      const files = data.map((entry) => ({ name: entry.name, type: entry.type }));
      apiCache.set(cacheKey, { data: files, expires: Date.now() + CACHE_TTL });
      return files;
    } catch {
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

/**
 * Decode a base64 string to UTF-8 text.
 * GitHub returns base64 content with newline characters mixed in.
 * Uses atob() + TextDecoder to properly handle multi-byte UTF-8.
 */
function decodeBase64(encoded: string): string {
  const cleaned = encoded.replace(/\n/g, '');
  const bytes = Uint8Array.from(atob(cleaned), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * Convert a Uint8Array to a base64 string.
 */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Extract the file extension from a filename (e.g. ".md", ".json").
 */
function extname(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot);
}

/**
 * Extract the filename without extension (e.g. "hello-world" from "hello-world.md").
 */
function basename(filename: string, ext: string): string {
  if (filename.endsWith(ext)) {
    return filename.slice(0, -ext.length);
  }
  return filename;
}

/**
 * Check if an error is a GitHub 404 response.
 */
function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    (err as { status: number }).status === 404
  );
}

/**
 * Check if an error is a GitHub 409/422 conflict response.
 */
function isConflict(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('status' in err)) return false;
  const status = (err as { status: number }).status;
  return status === 409 || status === 422;
}

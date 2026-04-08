declare module 'virtual:mimsy/config' {
  import type { MediaConfig } from '@mimsy/cms/src/types.js';
  const config: {
    basePath: string;
    contentDir: string;
    isGitHubMode: boolean;
    media: MediaConfig | null;
  };
  export default config;
}

declare module 'virtual:mimsy/schemas' {
  import type { CollectionSchema } from '@mimsy/cms/src/types.js';
  const schemas: Record<string, CollectionSchema>;
  export default schemas;
}

declare module 'virtual:mimsy/validators' {
  import type { ZodTypeAny } from 'astro/zod';
  const validators: Record<string, ZodTypeAny>;
  export default validators;
}

declare module 'virtual:mimsy/pages' {
  import type { PageInfo } from '@mimsy/cms/src/types.js';
  const pages: PageInfo[];
  export default pages;
}

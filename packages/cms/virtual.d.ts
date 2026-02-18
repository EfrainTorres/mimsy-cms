declare module 'virtual:mimsy/config' {
  const config: {
    basePath: string;
    contentDir: string;
    isGitHubMode: boolean;
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

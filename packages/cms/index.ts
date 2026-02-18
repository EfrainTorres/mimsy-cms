import type { AstroIntegration } from 'astro';
import type { MimsyConfig } from './src/types.js';
import { createMimsyIntegration } from './src/integration.js';

export default function mimsy(config: MimsyConfig = {}): AstroIntegration {
  return createMimsyIntegration(config);
}

export type { MimsyConfig };

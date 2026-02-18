import { defineConfig } from 'astro/config';
import svelte from '@astrojs/svelte';
import tailwindcss from '@tailwindcss/vite';
import mimsy from '@mimsy/cms';

export default defineConfig({
  output: 'server',
  integrations: [
    svelte(),
    mimsy(),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
});

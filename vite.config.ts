import { defineConfig } from 'vite';

// Relative base lets the build work whether served from
// `<user>.github.io/<repo>/` or a custom domain root.
export default defineConfig({
  base: './',
});

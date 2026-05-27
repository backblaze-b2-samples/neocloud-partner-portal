import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['tests/setup.js'],
    include: ['tests/**/*.test.js'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['server/**/*.js', 'src/lib/**/*.js'],
      exclude: ['server/seed-*.mjs', 'server/index.js'],
    },
  },
});

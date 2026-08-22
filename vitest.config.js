import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['tests/setup.js'],
    include: ['tests/**/*.test.{js,jsx}'],
    // Server tests run in node; frontend component tests opt into jsdom with a
    // `// @vitest-environment jsdom` docblock at the top of the file.
    environment: 'node',
    // Server test files share a module-level SQLite connection via
    // server/db.js. Disabling file-level parallelism guarantees each file's
    // beforeAll() can DELETE + INSERT without racing another file's writes.
    // Tests within a file still run serially. Total runtime is still <1s.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      // Views and components are included so the frontend gap stays visible.
      // Most pre-existing views have no tests, so the headline number is low by
      // design — it is measuring what is actually covered, not flattering it.
      include: ['server/**/*.js', 'src/lib/**/*.js', 'src/components/**/*.jsx', 'src/views/**/*.jsx'],
      exclude: ['server/seed-*.mjs', 'server/index.js'],
    },
  },
});

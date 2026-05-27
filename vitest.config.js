import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['tests/setup.js'],
    include: ['tests/**/*.test.js'],
    environment: 'node',
    // Server test files share a module-level SQLite connection via
    // server/db.js. Disabling file-level parallelism guarantees each file's
    // beforeAll() can DELETE + INSERT without racing another file's writes.
    // Tests within a file still run serially. Total runtime is still <1s.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      include: ['server/**/*.js', 'src/lib/**/*.js'],
      exclude: ['server/seed-*.mjs', 'server/index.js'],
    },
  },
});

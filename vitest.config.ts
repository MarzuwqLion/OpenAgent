import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // SQLite files, git repos and child processes are per-test temp dirs;
    // forks keep native modules (better-sqlite3) isolated per worker.
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Tests must never read the developer's real .env or ./data.
    env: {
      DOTENV_DISABLE: '1',
    },
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['tests/globalSetup.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**'],
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 120000,
    fileParallelism: false,
    env: {
      NODE_ENV: 'test',
      DEV_AUTH: '1',
      SNAPSHOT_SECRET: 'test-snapshot-secret',
      DATABASE_URL:
        'postgresql://app_runtime:dev_runtime@127.0.0.1:55432/nightclub_test',
      TEST_DATABASE_URL:
        'postgresql://postgres@127.0.0.1:55432/nightclub_test',
      RUNTIME_DATABASE_URL:
        'postgresql://app_runtime:dev_runtime@127.0.0.1:55432/nightclub_test',
      READONLY_DATABASE_URL:
        'postgresql://app_readonly:dev_readonly@127.0.0.1:55432/nightclub_test',
    },
  },
});

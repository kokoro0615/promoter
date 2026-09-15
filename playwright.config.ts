import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  retries: 0,
  use: { baseURL: 'http://127.0.0.1:5173' },
  webServer: [
    {
      command: 'pnpm dev:api',
      port: 8787,
      env: { DEV_AUTH: '1', NODE_ENV: 'development' },
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: 'pnpm dev:web',
      port: 5173,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});

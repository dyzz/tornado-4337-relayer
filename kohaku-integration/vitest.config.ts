import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['e2e/**/*.test.ts'],
    testTimeout: 1_500_000,
    hookTimeout: 1_500_000,
    fileParallelism: false,
    server: { deps: { inline: [/@kohaku-eth/] } },
  },
});

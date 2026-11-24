import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["./test/helpers/global-setup.ts"],
    // Все файлы работают с одной настоящей базой и очищают её между тестами.
    fileParallelism: false,
    testTimeout: 15000,
    hookTimeout: 30000,
  },
});

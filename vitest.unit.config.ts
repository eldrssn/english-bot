import { defineConfig } from "vitest/config";

// Чистая логика обучения: без глобальной настройки базы, общая тестовая база не затрагивается.
export default defineConfig({
  test: {
    include: ["test/domain/learning/**/*.test.ts"],
  },
});

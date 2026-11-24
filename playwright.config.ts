import { defineConfig, devices } from "@playwright/test";
import { accounts, baseUrl, serverEnv, type AccountName } from "./e2e/env.js";

// Запуск: npm run test:e2e (сборка кабинета, пересоздание базы english_bot_e2e, затем тесты).
export default defineConfig({
  testDir: "e2e",
  testMatch: "*.spec.ts",
  outputDir: "node_modules/.cache/playwright-e2e",
  // Сценарии работают с одной базой и упираются в серверный лимит на ввод кода.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 30_000,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    locale: "ru-RU",
    trace: "retain-on-failure",
  },
  webServer: (Object.keys(accounts) as AccountName[]).map((name) => ({
    // Без --env-file: окружение целиком задано здесь.
    command: "node --import tsx scripts/dev-api.ts",
    url: `${baseUrl(name)}/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "ignore" as const,
    stderr: "pipe" as const,
    env: { ...serverEnv, PORT: String(accounts[name].port), DEV_LOGIN_TELEGRAM_ID: String(accounts[name].telegramId) },
  })),
});

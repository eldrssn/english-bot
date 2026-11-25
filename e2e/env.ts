// Окружение e2e: своя база и свои порты. Файлы .env здесь не читаются,
// общая тестовая база и настоящий Telegram не затрагиваются.
const CLUSTER = process.env.E2E_PG_URL ?? "postgres://english_bot@127.0.0.1:54329";

export const E2E_DB_NAME = "english_bot_e2e";
export const ADMIN_DATABASE_URL = `${CLUSTER}/postgres`;
export const E2E_DATABASE_URL = `${CLUSTER}/${E2E_DB_NAME}`;
export const E2E_APP_SECRET = "e2e-secret-only-for-local-playwright-runs-0123456789";

/**
 * Вход для разработки привязан к одному Telegram ID на сервер, поэтому у каждого аккаунта свой сервер.
 * main и other — два преподавателя основных сценариев, responsive — чистый аккаунт для пустого состояния,
 * phoneLight…desktopDark — свои аккаунты комбинаций экрана и темы.
 */
export const accounts = {
  main: { telegramId: 910000001, port: 3101, teacher: true },
  other: { telegramId: 910000002, port: 3102, teacher: true },
  responsive: { telegramId: 910000003, port: 3103, teacher: true },
  stranger: { telegramId: 910000004, port: 3104, teacher: false },
  // Вёрстка: у каждой комбинации экрана и темы свой преподаватель. Ввод кода ограничен 10 попытками
  // в минуту на преподавателя, и четыре комбинации на одном аккаунте упирались бы в лимит при повторных прогонах.
  phoneLight: { telegramId: 910000005, port: 3105, teacher: true },
  phoneDark: { telegramId: 910000006, port: 3106, teacher: true },
  desktopLight: { telegramId: 910000007, port: 3107, teacher: true },
  desktopDark: { telegramId: 910000008, port: 3108, teacher: true },
  // Результаты (этап 7): свой преподаватель по той же причине — лимит ввода кода не делится с другими сценариями.
  results: { telegramId: 910000009, port: 3109, teacher: true },
} as const;

export type AccountName = keyof typeof accounts;

export const baseUrl = (name: AccountName) => `http://127.0.0.1:${accounts[name].port}`;

/** Окружение серверов и скрипта dev-student. */
export const serverEnv = {
  DATABASE_URL: E2E_DATABASE_URL,
  APP_SECRET: E2E_APP_SECRET,
  DEV_BOT_USERNAME: "e2e_bot",
  WEB_DIST_DIR: "dist/web",
};

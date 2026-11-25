import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, loadDatabaseConfig, loadWebConfig } from "../src/config.js";

const APP_SECRET = "x".repeat(32);
const base = { BOT_TOKEN: "123:abc-DEF_1", DATABASE_URL: "postgres://u@localhost:5432/db", APP_SECRET };
const production = {
  ...base,
  NODE_ENV: "production",
  WEB_BASE_URL: "https://cabinet.example",
  TELEGRAM_LOGIN_CLIENT_ID: "id",
  TELEGRAM_LOGIN_CLIENT_SECRET: "secret",
  BOT_MODE: "webhook",
  WEBHOOK_SECRET: "w".repeat(32),
};

describe("настройки окружения", () => {
  it("по умолчанию: опрос, порт 3000, локальный адрес", () => {
    expect(loadConfig(base)).toMatchObject({ botMode: "polling", port: 3000, host: "127.0.0.1", webhook: null });
  });

  it("webhook требует адрес и секрет", () => {
    expect(() => loadConfig({ ...base, BOT_MODE: "webhook" })).toThrow(/WEBHOOK_BASE_URL[\s\S]*WEBHOOK_SECRET/);
    expect(() =>
      loadConfig({ ...base, BOT_MODE: "webhook", WEBHOOK_BASE_URL: "http://x.example", WEBHOOK_SECRET: "a".repeat(32) }),
    ).toThrow(/WEBHOOK_BASE_URL/);
    expect(() =>
      loadConfig({ ...base, BOT_MODE: "webhook", WEBHOOK_BASE_URL: "https://x.example", WEBHOOK_SECRET: "short" }),
    ).toThrow(/WEBHOOK_SECRET/);
    expect(
      loadConfig({ ...base, BOT_MODE: "webhook", WEBHOOK_BASE_URL: "https://x.example", WEBHOOK_SECRET: "a".repeat(32) }),
    ).toMatchObject({ host: "0.0.0.0", webhook: { baseUrl: "https://x.example" } });
  });

  it("пустые значения из шаблона .env считаются незаданными", () => {
    expect(loadConfig({ ...base, PORT: "", WEBHOOK_SECRET: "", WEBHOOK_BASE_URL: "" }).port).toBe(3000);
  });

  it("сообщение об ошибке называет переменную и не содержит значения", () => {
    const secret = "not-a-valid-token-value";
    try {
      loadConfig({ ...base, BOT_TOKEN: secret });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).toContain("BOT_TOKEN");
      expect((error as Error).message).not.toContain(secret);
    }
    expect(() => loadConfig({ DATABASE_URL: base.DATABASE_URL, APP_SECRET })).toThrow(/BOT_TOKEN: не задана/);
  });

  it("служебным командам базы токен не нужен", () => {
    expect(loadDatabaseConfig({ DATABASE_URL: base.DATABASE_URL }).databaseUrl).toBe(base.DATABASE_URL);
    expect(() => loadDatabaseConfig({})).toThrow(/DATABASE_URL/);
  });

  it("APP_SECRET обязателен и не короче 32 символов", () => {
    expect(() => loadConfig({ BOT_TOKEN: base.BOT_TOKEN, DATABASE_URL: base.DATABASE_URL })).toThrow(/APP_SECRET/);
    expect(() => loadConfig({ ...base, APP_SECRET: "short" })).toThrow(/APP_SECRET/);
  });

  it("вход для разработки разрешён вне production", () => {
    expect(loadConfig({ ...base, DEV_LOGIN_TELEGRAM_ID: "42" }).web.devLoginTelegramId).toBe(42);
    expect(loadConfig(base).web.devLoginTelegramId).toBeNull();
    expect(() => loadConfig({ ...base, DEV_LOGIN_TELEGRAM_ID: "abc" })).toThrow(/DEV_LOGIN_TELEGRAM_ID/);
  });

  it("при NODE_ENV=production и DEV_LOGIN_TELEGRAM_ID настройки отклоняются", () => {
    expect(loadConfig(production).web.isProduction).toBe(true);
    expect(() => loadConfig({ ...production, DEV_LOGIN_TELEGRAM_ID: "42" })).toThrow(/DEV_LOGIN_TELEGRAM_ID/);
    expect(() => loadWebConfig({ ...production, DEV_LOGIN_TELEGRAM_ID: "42" })).toThrow(/DEV_LOGIN_TELEGRAM_ID/);
  });

  it("production работает только через webhook с секретом; адрес webhook по умолчанию — адрес кабинета", () => {
    expect(loadConfig(production)).toMatchObject({
      botMode: "webhook",
      host: "0.0.0.0",
      webhook: { baseUrl: "https://cabinet.example", secret: "w".repeat(32) },
    });
    expect(() => loadConfig({ ...production, BOT_MODE: "polling" })).toThrow(/BOT_MODE: при NODE_ENV=production нужен webhook/);
    const { WEBHOOK_SECRET: _secret, ...withoutSecret } = production;
    expect(() => loadConfig(withoutSecret)).toThrow(/WEBHOOK_SECRET/);
    expect(loadConfig({ ...production, WEBHOOK_BASE_URL: "https://hook.example" }).webhook?.baseUrl).toBe("https://hook.example");
    // Кабинет без production и без https: адрес webhook нужно задать явно.
    expect(() => loadConfig({ ...base, BOT_MODE: "webhook", WEB_BASE_URL: "http://localhost:3000", WEBHOOK_SECRET: "a".repeat(32) })).toThrow(
      /WEBHOOK_BASE_URL/,
    );
  });

  it("LOG_LEVEL: по умолчанию info, неизвестный уровень отклоняется", () => {
    expect(loadConfig(base).logLevel).toBe("info");
    expect(loadConfig({ ...base, LOG_LEVEL: "debug" }).logLevel).toBe("debug");
    expect(() => loadConfig({ ...base, LOG_LEVEL: "verbose" })).toThrow(/LOG_LEVEL/);
  });

  it("production требует настоящий вход и https", () => {
    const { TELEGRAM_LOGIN_CLIENT_SECRET: _secret, ...withoutSecret } = production;
    expect(() => loadConfig(withoutSecret)).toThrow(/TELEGRAM_LOGIN_CLIENT_SECRET/);
    expect(() => loadConfig({ ...production, WEB_BASE_URL: "http://cabinet.example" })).toThrow(/WEB_BASE_URL/);
  });
});

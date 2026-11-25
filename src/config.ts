import { z } from "zod";
import { LOG_LEVELS, type LogLevel } from "./logger.js";

const postgresUrl = z
  .string()
  .regex(/^postgres(ql)?:\/\/.+/, "ожидается строка подключения postgres://...");

const emptyToUndefined = (value: unknown) => (value === "" ? undefined : value);

const databaseEnvSchema = z.object({
  DATABASE_URL: postgresUrl,
});

/** Настройки кабинета: нужны и основному сервису, и серверу разработки без бота. */
const webEnvFields = {
  NODE_ENV: z.preprocess(emptyToUndefined, z.string().optional()),
  // Секрет для HMAC токенов ссылок, кодов и подписанных cookie.
  APP_SECRET: z.string().min(32, "ожидается строка не короче 32 символов"),
  WEB_BASE_URL: z.preprocess(
    emptyToUndefined,
    z.string().regex(/^https?:\/\/[^/]+$/, "ожидается http(s)-адрес без пути").optional(),
  ),
  WEB_DIST_DIR: z.preprocess(emptyToUndefined, z.string().optional()),
  TELEGRAM_LOGIN_CLIENT_ID: z.preprocess(emptyToUndefined, z.string().optional()),
  TELEGRAM_LOGIN_CLIENT_SECRET: z.preprocess(emptyToUndefined, z.string().optional()),
  DEV_LOGIN_TELEGRAM_ID: z.preprocess(
    emptyToUndefined,
    z.string().regex(/^[1-9]\d{0,15}$/, "ожидается Telegram ID").optional(),
  ),
};

type WebEnv = z.output<z.ZodObject<typeof webEnvFields>>;

/** В production нет входа для разработки и обязателен настоящий вход. */
function refineWebEnv(env: WebEnv, ctx: z.RefinementCtx) {
  if (env.NODE_ENV !== "production") return;
  if (env.DEV_LOGIN_TELEGRAM_ID) {
    ctx.addIssue({ code: "custom", path: ["DEV_LOGIN_TELEGRAM_ID"], message: "запрещена при NODE_ENV=production" });
  }
  for (const name of ["TELEGRAM_LOGIN_CLIENT_ID", "TELEGRAM_LOGIN_CLIENT_SECRET"] as const) {
    if (!env[name]) ctx.addIssue({ code: "custom", path: [name], message: "обязателен при NODE_ENV=production" });
  }
  if (!env.WEB_BASE_URL?.startsWith("https://")) {
    ctx.addIssue({ code: "custom", path: ["WEB_BASE_URL"], message: "при NODE_ENV=production нужен https-адрес" });
  }
}

const webEnvSchema = databaseEnvSchema.extend(webEnvFields).superRefine(refineWebEnv);

/** Адрес webhook: свой или адрес кабинета, если он https (на Railway это один сервис). */
function webhookBaseUrl(env: { WEBHOOK_BASE_URL?: string | undefined; WEB_BASE_URL?: string | undefined }) {
  if (env.WEBHOOK_BASE_URL) return env.WEBHOOK_BASE_URL;
  return env.WEB_BASE_URL?.startsWith("https://") ? env.WEB_BASE_URL : undefined;
}

const appEnvSchema = databaseEnvSchema
  .extend({
    ...webEnvFields,
    BOT_TOKEN: z.string().regex(/^\d+:[\w-]+$/, "ожидается токен от BotFather"),
    BOT_MODE: z.preprocess(emptyToUndefined, z.enum(["polling", "webhook"]).default("polling")),
    PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(65535).default(3000)),
    HOST: z.preprocess(emptyToUndefined, z.string().optional()),
    WEBHOOK_BASE_URL: z.preprocess(
      emptyToUndefined,
      z.string().regex(/^https:\/\/[^/]+$/, "ожидается https-адрес без пути").optional(),
    ),
    // Ограничения Telegram на secret_token: 1–256 символов A-Z, a-z, 0-9, _ и -.
    WEBHOOK_SECRET: z.preprocess(
      emptyToUndefined,
      z
        .string()
        .regex(/^[A-Za-z0-9_-]{32,256}$/, "ожидается 32–256 символов A-Z, a-z, 0-9, _ и -")
        .optional(),
    ),
    TELEGRAM_API_ROOT: z.preprocess(
      emptyToUndefined,
      z.string().regex(/^https?:\/\/.+/, "ожидается http(s)-адрес").optional(),
    ),
    LOG_LEVEL: z.preprocess(emptyToUndefined, z.enum(LOG_LEVELS).default("info")),
  })
  .superRefine((env, ctx) => {
    refineWebEnv(env, ctx);
    // На сервере только webhook: постоянный опрос там не нужен, а два процесса с опросом мешали бы друг другу.
    if (env.NODE_ENV === "production" && env.BOT_MODE !== "webhook") {
      ctx.addIssue({ code: "custom", path: ["BOT_MODE"], message: "при NODE_ENV=production нужен webhook" });
    }
    if (env.BOT_MODE !== "webhook") return;
    if (!webhookBaseUrl(env)) {
      ctx.addIssue({
        code: "custom",
        path: ["WEBHOOK_BASE_URL"],
        message: "обязателен при BOT_MODE=webhook, если WEB_BASE_URL не https",
      });
    }
    if (!env.WEBHOOK_SECRET) {
      ctx.addIssue({ code: "custom", path: ["WEBHOOK_SECRET"], message: "обязателен при BOT_MODE=webhook" });
    }
  });

export type DatabaseConfig = { databaseUrl: string };

export type WebConfig = {
  appSecret: string;
  isProduction: boolean;
  /** Публичный адрес кабинета: из него строится адрес возврата входа. */
  baseUrl: string;
  login: { clientId: string; clientSecret: string } | null;
  devLoginTelegramId: number | null;
  /** Папка сборки кабинета. */
  webDistDir: string;
};

export type AppConfig = DatabaseConfig & {
  web: WebConfig;
  botToken: string;
  botMode: "polling" | "webhook";
  port: number;
  host: string;
  webhook: { baseUrl: string; secret: string } | null;
  telegramApiRoot: string | undefined;
  logLevel: LogLevel;
};

/** Ошибка настройки. Сообщение называет переменные, но не содержит их значений. */
export class ConfigError extends Error {
  override name = "ConfigError";
}

function parseEnv<Schema extends z.ZodType>(schema: Schema, env: NodeJS.ProcessEnv): z.output<Schema> {
  const result = schema.safeParse(env);
  if (result.success) return result.data;
  const lines = result.error.issues.map((issue) => {
    const name = issue.path.join(".");
    // Для отсутствующей переменной Zod пишет технический текст; значение в сообщение не попадает.
    const message = issue.code === "invalid_type" ? "не задана" : issue.message;
    return `  ${name}: ${message}`;
  });
  throw new ConfigError(`Неверные настройки окружения:\n${lines.join("\n")}`);
}

/** Настройки для служебных команд базы: им не нужен токен бота. */
export function loadDatabaseConfig(env: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  return { databaseUrl: parseEnv(databaseEnvSchema, env).DATABASE_URL };
}

const DEFAULT_WEB_DIST_DIR = "dist/web";

function toWebConfig(parsed: WebEnv & { PORT?: number }): WebConfig {
  return {
    appSecret: parsed.APP_SECRET,
    isProduction: parsed.NODE_ENV === "production",
    baseUrl: parsed.WEB_BASE_URL ?? `http://localhost:${parsed.PORT ?? 3000}`,
    login:
      parsed.TELEGRAM_LOGIN_CLIENT_ID && parsed.TELEGRAM_LOGIN_CLIENT_SECRET
        ? { clientId: parsed.TELEGRAM_LOGIN_CLIENT_ID, clientSecret: parsed.TELEGRAM_LOGIN_CLIENT_SECRET }
        : null,
    devLoginTelegramId: parsed.DEV_LOGIN_TELEGRAM_ID ? Number(parsed.DEV_LOGIN_TELEGRAM_ID) : null,
    webDistDir: parsed.WEB_DIST_DIR ?? DEFAULT_WEB_DIST_DIR,
  };
}

/** Настройки сервера кабинета без бота: для разработки интерфейса токен не нужен. */
export function loadWebConfig(env: NodeJS.ProcessEnv = process.env): DatabaseConfig & { web: WebConfig } {
  const parsed = parseEnv(webEnvSchema, env);
  return { databaseUrl: parsed.DATABASE_URL, web: toWebConfig(parsed) };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = parseEnv(appEnvSchema, env);
  const baseUrl = webhookBaseUrl(parsed);
  const webhook =
    parsed.BOT_MODE === "webhook" && baseUrl && parsed.WEBHOOK_SECRET ? { baseUrl, secret: parsed.WEBHOOK_SECRET } : null;
  return {
    web: toWebConfig(parsed),
    databaseUrl: parsed.DATABASE_URL,
    botToken: parsed.BOT_TOKEN,
    botMode: parsed.BOT_MODE,
    port: parsed.PORT,
    host: parsed.HOST ?? (parsed.BOT_MODE === "webhook" ? "0.0.0.0" : "127.0.0.1"),
    webhook,
    telegramApiRoot: parsed.TELEGRAM_API_ROOT,
    logLevel: parsed.LOG_LEVEL,
  };
}

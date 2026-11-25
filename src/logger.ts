// Журнал ошибок и событий: JSON-строки в stdout. Railway показывает их как структурированные логи
// (поля level и message), локально их можно читать как есть или через `| npx pino-pretty`.
// Пользователю детали ошибок не показываются: бот и кабинет отвечают общими сообщениями, а подробности
// (стек, код Telegram, номер события или запроса) остаются только здесь.
import { pino, stdSerializers, type DestinationStream, type Logger } from "pino";

export type { Logger };

export const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * Значения, которые не должны попасть в журнал ни при каких обстоятельствах: cookie сессии, CSRF,
 * секрет webhook, токены ссылок и проверочные коды. Даже если их по ошибке передадут в поле записи.
 */
const REDACT_PATHS = [
  "req.headers.cookie",
  "req.headers.authorization",
  'req.headers["x-csrf-token"]',
  'req.headers["x-telegram-bot-api-secret-token"]',
  "token",
  "code",
  "secret",
  "*.token",
  "*.code",
  "*.secret",
];

export type CreateLoggerOptions = {
  level?: LogLevel;
  /** Куда писать. По умолчанию stdout; в тестах — буфер. */
  destination?: DestinationStream;
};

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  return pino(
    {
      level: options.level ?? "info",
      messageKey: "message",
      base: { service: "english-bot" },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      redact: { paths: REDACT_PATHS, censor: "[скрыто]" },
      serializers: {
        err: stdSerializers.err,
        error: stdSerializers.err,
        // Адрес без строки запроса: в ней бывают code и state адреса возврата входа.
        req: (request: { method?: string; url?: string; id?: string }) => ({
          id: request.id,
          method: request.method,
          url: request.url?.split("?")[0],
        }),
        res: (reply: { statusCode?: number }) => ({ statusCode: reply.statusCode }),
      },
    },
    options.destination,
  );
}

/** Уровень из LOG_LEVEL: неизвестное значение не роняет сервис, а даёт info. */
export function logLevelFromEnv(value: string | undefined): LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value ?? "") ? (value as LogLevel) : "info";
}

/**
 * Общий журнал процесса. Фоновые циклы, бот и пул базы пишут в него, если им не передали свой.
 * В тестах Vitest он молчит, пока не задан LOG_LEVEL: ошибки, которые тесты вызывают нарочно, не засоряют вывод.
 */
export const appLogger: Logger = createLogger({
  level: process.env.VITEST && !process.env.LOG_LEVEL ? "silent" : logLevelFromEnv(process.env.LOG_LEVEL),
});

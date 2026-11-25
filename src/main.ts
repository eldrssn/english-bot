import { createBot } from "./bot/index.js";
import { startReminderScheduler } from "./notifications/reminders.js";
import { startNotificationWorker } from "./notifications/worker.js";
import { createTelegramLogin } from "./server/api/login.js";
import { ConfigError, loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { WEBHOOK_PATH, buildServer } from "./server/index.js";
import { apiRoutes } from "./shared/api-contract.js";
import { createLogger, type Logger } from "./logger.js";

const BOT_INIT_TIMEOUT_MS = 60_000;
const ALLOWED_UPDATES = ["message", "callback_query"] as const;

let logger: Logger | null = null;

async function main() {
  const config = loadConfig();
  logger = createLogger({ level: config.logLevel });
  const { db, close } = createDb(config.databaseUrl);
  const bot = createBot({
    token: config.botToken,
    db,
    logger,
    appSecret: config.web.appSecret,
    ...(config.telegramApiRoot ? { apiRoot: config.telegramApiRoot } : {}),
  });
  // Имя и ID бота нужны кабинету для ссылок и проверки входа.
  // grammY повторяет getMe бесконечно, пока Telegram недоступен. Ограничиваем запуск: процесс завершится с ошибкой
  // в журнале, а Railway перезапустит его (restartPolicy в railway.json) вместо вечного «зависшего» деплоя.
  // Тип сигнала у grammY — из полифила abort-controller; настоящий AbortSignal Node совместим с ним.
  await bot.init(AbortSignal.timeout(BOT_INIT_TIMEOUT_MS) as unknown as Parameters<typeof bot.init>[0]);
  const server = buildServer({
    db,
    // В журнал не попадают код и state из адреса возврата входа: сериализатор req отбрасывает строку запроса.
    logger,
    proxyHops: config.web.isProduction ? 1 : 0,
    webDistDir: config.web.webDistDir,
    api: {
      appSecret: config.web.appSecret,
      isProduction: config.web.isProduction,
      botUsername: bot.botInfo.username,
      devLoginTelegramId: config.web.devLoginTelegramId,
      login: config.web.login
        ? createTelegramLogin({
            ...config.web.login,
            botId: String(bot.botInfo.id),
            redirectUri: `${config.web.baseUrl}${apiRoutes.telegramLoginCallback.path}`,
          })
        : null,
    },
    ...(config.webhook ? { webhook: { bot, secretToken: config.webhook.secret } } : {}),
  });

  const notificationWorker = startNotificationWorker(db, bot.api, { logger });
  // Раз в минуту: квесты прошлых дней закрываются, наступившие напоминания ставятся в очередь.
  const reminderScheduler = startReminderScheduler(db, { logger });

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    logger?.info("Остановка сервиса");
    await reminderScheduler.stop();
    await notificationWorker.stop();
    if (config.botMode === "polling") await bot.stop();
    await server.close();
    await close();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  await server.listen({ port: config.port, host: config.host });

  if (config.webhook) {
    await bot.api.setWebhook(`${config.webhook.baseUrl}${WEBHOOK_PATH}`, {
      secret_token: config.webhook.secret,
      allowed_updates: [...ALLOWED_UPDATES],
    });
    logger.info({ url: `${config.webhook.baseUrl}${WEBHOOK_PATH}` }, "Webhook зарегистрирован");
    return;
  }

  // Опрос работает до остановки процесса, поэтому его завершения не ждём.
  bot
    .start({
      allowed_updates: [...ALLOWED_UPDATES],
      onStart: ({ username }) => logger?.info({ username }, "Бот запущен в режиме опроса"),
    })
    .catch(async (error: unknown) => {
      logger?.fatal({ err: error }, "Опрос Telegram остановился с ошибкой");
      process.exitCode = 1;
      await shutdown();
    });
}

main().catch((error: unknown) => {
  // Ошибка настроек — до журнала: сообщение называет переменные без значений.
  if (error instanceof ConfigError || !logger) console.error(error instanceof ConfigError ? error.message : error);
  else logger.fatal({ err: error }, "Сервис не запустился");
  process.exit(1);
});

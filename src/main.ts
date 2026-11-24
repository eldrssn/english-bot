import { createBot } from "./bot/index.js";
import { startNotificationWorker } from "./notifications/worker.js";
import { createTelegramLogin } from "./server/api/login.js";
import { ConfigError, loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { WEBHOOK_PATH, buildServer } from "./server/index.js";
import { apiRoutes } from "./shared/api-contract.js";

const ALLOWED_UPDATES = ["message", "callback_query"] as const;

async function main() {
  const config = loadConfig();
  const { db, close } = createDb(config.databaseUrl);
  const bot = createBot({
    token: config.botToken,
    db,
    appSecret: config.web.appSecret,
    ...(config.telegramApiRoot ? { apiRoot: config.telegramApiRoot } : {}),
  });
  // Имя и ID бота нужны кабинету для ссылок и проверки входа.
  await bot.init();
  const server = buildServer({
    db,
    // В журнал не попадают код и state из адреса возврата входа.
    logger: {
      level: "info",
      serializers: { req: (request) => ({ method: request.method, url: request.url.split("?")[0] }) },
    },
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

  const notificationWorker = startNotificationWorker(db, bot.api);

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
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
    console.log("Webhook зарегистрирован");
    return;
  }

  // Опрос работает до остановки процесса, поэтому его завершения не ждём.
  bot
    .start({
      allowed_updates: [...ALLOWED_UPDATES],
      onStart: ({ username }) => console.log(`Бот @${username} запущен в режиме опроса`),
    })
    .catch(async (error: unknown) => {
      console.error("Опрос Telegram остановился с ошибкой:", error);
      process.exitCode = 1;
      await shutdown();
    });
}

main().catch((error: unknown) => {
  console.error(error instanceof ConfigError ? error.message : error);
  process.exit(1);
});

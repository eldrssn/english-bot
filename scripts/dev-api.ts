// Сервер кабинета для разработки интерфейса: только HTTP API и статика. Бот не создаётся,
// к Telegram запросов нет, токен не нужен. В production не запускается.
import { ConfigError, loadWebConfig } from "../src/config.js";
import { createDb } from "../src/db/client.js";
import { createLogger, logLevelFromEnv } from "../src/logger.js";
import { buildServer } from "../src/server/index.js";

try {
  const { databaseUrl, web } = loadWebConfig();
  if (web.isProduction) throw new ConfigError("npm run dev:api не работает при NODE_ENV=production");
  const { db } = createDb(databaseUrl);
  const server = buildServer({
    db,
    logger: createLogger({ level: logLevelFromEnv(process.env.LOG_LEVEL) }),
    webDistDir: web.webDistDir,
    api: {
      appSecret: web.appSecret,
      isProduction: false,
      botUsername: process.env.DEV_BOT_USERNAME || "dev_bot",
      devLoginTelegramId: web.devLoginTelegramId,
      login: null,
    },
  });
  await server.listen({ port: Number(process.env.PORT) || 3000, host: "127.0.0.1" });
} catch (error) {
  console.error(error instanceof ConfigError ? error.message : error);
  process.exit(1);
}

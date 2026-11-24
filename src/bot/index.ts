import { Bot } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import type { Db } from "../db/client.js";
import type { BotContext } from "./context.js";
import { createLinkingService } from "../linking/service.js";
import { createLearningService } from "../learning/service.js";
import type { Rng } from "../domain/learning/index.js";
import { learningHandlers } from "./learning.js";
import { linkingHandlers } from "./linking.js";
import { attachAppUser } from "./middleware/app-user.js";
import { skipProcessedUpdates } from "./middleware/processed-updates.js";

export type CreateBotOptions = {
  token: string;
  db: Db;
  /** Секрет для хэшей ссылок и кодов. */
  appSecret: string;
  /** Если задан, бот не вызывает getMe. Используется в тестах. */
  botInfo?: UserFromGetMe;
  /** Свой сервер Bot API вместо api.telegram.org. */
  apiRoot?: string;
  /** Генератор случайных чисел для плана и вариантов. По умолчанию Math.random. */
  rng?: Rng;
};

/** Собирает бота, но не запускает его: при импорте нет ни опроса, ни запросов к Telegram. */
export function createBot(options: CreateBotOptions): Bot<BotContext> {
  const { token, db, appSecret, botInfo, apiRoot, rng } = options;
  const bot = new Bot<BotContext>(token, {
    ...(botInfo ? { botInfo } : {}),
    ...(apiRoot ? { client: { apiRoot } } : {}),
  });

  bot.use(skipProcessedUpdates(db));
  bot.use(attachAppUser(db));
  // Привязка пропускает дальше ученика с активной связью и ученика с копиями после отвязки.
  bot.use(linkingHandlers(createLinkingService(db, appSecret)));
  bot.use(learningHandlers(createLearningService(db, rng ? { rng } : {})));

  // Действует в режиме опроса. При webhook ошибка доходит до сервера, он отвечает 500, и Telegram повторяет событие.
  bot.catch((error) => {
    console.error(`Ошибка при обработке события ${error.ctx.update.update_id}:`, error.error);
  });

  return bot;
}

export type { BotContext } from "./context.js";

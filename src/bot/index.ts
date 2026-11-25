import { Bot, GrammyError, HttpError, type BotError } from "grammy";
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
import { appLogger, type Logger } from "../logger.js";

/** Общий ответ ученику при сбое: без подробностей, они остаются в журнале. */
export const BOT_ERROR_TEXT = "Что-то пошло не так. Попробуйте ещё раз чуть позже или откройте меню командой /start.";

/** Подробности ошибки для журнала: код и описание Telegram, сетевой сбой или исключение со стеком. */
export function describeBotError(error: unknown): Record<string, unknown> {
  if (error instanceof GrammyError) {
    return { kind: "telegram", method: error.method, errorCode: error.error_code, description: error.description };
  }
  if (error instanceof HttpError) return { kind: "network", err: error.error };
  return { kind: "exception", err: error };
}

/**
 * Обработчик ошибок бота в режиме опроса: запись в журнал и короткое сообщение ученику.
 * Текст исключения ученику не показывается. Если ответить не удалось (например, бот заблокирован), это тоже в журнале.
 */
export function botErrorHandler(logger: Logger) {
  return async (error: BotError) => {
    const update = error.ctx.update;
    logger.error(
      { updateId: update.update_id, chatId: error.ctx.chat?.id, ...describeBotError(error.error) },
      "Ошибка при обработке события Telegram",
    );
    if (!error.ctx.chat) return;
    try {
      await error.ctx.reply(BOT_ERROR_TEXT);
    } catch (replyError) {
      logger.warn({ updateId: update.update_id, ...describeBotError(replyError) }, "Не удалось сообщить ученику о сбое");
    }
  };
}

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
  /** Часы: локальная дата квеста ученика. В тестах подменяются. */
  now?: () => Date;
  /** Журнал ошибок. По умолчанию общий журнал процесса. */
  logger?: Logger;
};

/** Собирает бота, но не запускает его: при импорте нет ни опроса, ни запросов к Telegram. */
export function createBot(options: CreateBotOptions): Bot<BotContext> {
  const { token, db, appSecret, botInfo, apiRoot, rng, now } = options;
  const logger = (options.logger ?? appLogger).child({ component: "bot" });
  const bot = new Bot<BotContext>(token, {
    ...(botInfo ? { botInfo } : {}),
    ...(apiRoot ? { client: { apiRoot } } : {}),
  });

  bot.use(skipProcessedUpdates(db));
  bot.use(attachAppUser(db));
  // Привязка пропускает дальше ученика с активной связью и ученика с копиями после отвязки.
  bot.use(linkingHandlers(createLinkingService(db, appSecret)));
  bot.use(
    learningHandlers(createLearningService(db, { ...(rng ? { rng } : {}), ...(now ? { now } : {}) }), now ? { now } : {}),
  );

  // Действует в режиме опроса. При webhook ошибка доходит до сервера: он пишет её в журнал, отвечает 500
  // без подробностей, и Telegram повторяет событие (повтор безопасен, см. skipProcessedUpdates).
  bot.catch(botErrorHandler(logger));

  return bot;
}

export type { BotContext } from "./context.js";

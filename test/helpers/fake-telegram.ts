import type { Update, UserFromGetMe } from "grammy/types";
import { createBot } from "../../src/bot/index.js";
import type { Db } from "../../src/db/client.js";

export const FAKE_TOKEN = "123456:TEST-TOKEN";
export const TEST_APP_SECRET = "test-app-secret-".repeat(4);

const BOT_INFO: UserFromGetMe = {
  id: 123456,
  is_bot: true,
  first_name: "Тестовый бот",
  username: "test_bot",
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

export type ApiCall = { method: string; payload: Record<string, any> };

export type FakeBotOptions = {
  /** Позволяет подставить ответ Telegram, например ошибку. */
  respond?: (call: ApiCall) => unknown;
  /** Предсказуемый порядок вопросов и вариантов. */
  rng?: () => number;
};

/** Бот с настоящей обработкой и базой, но API заменён: ни один запрос не уходит в сеть. */
export function createFakeBot(db: Db, options: FakeBotOptions = {}) {
  const calls: ApiCall[] = [];
  const bot = createBot({ token: FAKE_TOKEN, db, appSecret: TEST_APP_SECRET, botInfo: BOT_INFO, ...(options.rng ? { rng: options.rng } : {}) });
  let nextMessageId = 1000;

  bot.api.config.use(async (_prev, method, payload) => {
    const call = { method, payload: payload as Record<string, any> };
    calls.push(call);
    const custom = options.respond?.(call);
    if (custom) return custom as any;
    const result =
      method === "answerCallbackQuery"
        ? true
        : {
            message_id: nextMessageId++,
            date: 0,
            chat: { id: call.payload.chat_id ?? 0, type: "private", first_name: "x" },
            text: call.payload.text,
          };
    return { ok: true, result } as any;
  });

  return { bot, calls };
}

let nextUpdateId = 1;
export const newUpdateId = () => nextUpdateId++;

const from = (telegramId: number) => ({ id: telegramId, is_bot: false, first_name: "Анна", username: "anna" });
const chat = (telegramId: number) => ({ id: telegramId, type: "private" as const, first_name: "Анна" });

export function textUpdate(telegramId: number, text: string, updateId = newUpdateId()): Update {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 0,
      from: from(telegramId),
      chat: chat(telegramId),
      text,
      ...(text.startsWith("/")
        ? { entities: [{ type: "bot_command" as const, offset: 0, length: text.split(" ")[0]!.length }] }
        : {}),
    },
  };
}

export function callbackUpdate(telegramId: number, data: string, updateId = newUpdateId()): Update {
  return {
    update_id: updateId,
    callback_query: {
      id: String(updateId),
      from: from(telegramId),
      chat_instance: "test",
      data,
      message: { message_id: 500, date: 0, chat: chat(telegramId), text: "старое сообщение" },
    },
  };
}

/** Кнопки из последнего сообщения бота с клавиатурой. */
export function lastButtons(calls: ApiCall[]): { text: string; callback_data: string }[] {
  const call = [...calls].reverse().find((item) => item.payload.reply_markup);
  return call?.payload.reply_markup.inline_keyboard.flat() ?? [];
}

export const sentTexts = (calls: ApiCall[]): string[] =>
  calls.filter((call) => call.method === "sendMessage" || call.method === "editMessageText").map((call) => call.payload.text);

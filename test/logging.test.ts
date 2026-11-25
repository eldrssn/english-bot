// Этап 7: журнал ошибок. Подробности — в структурированный журнал, пользователю — только общий ответ.
import { Writable } from "node:stream";
import { BotError, GrammyError } from "grammy";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { BOT_ERROR_TEXT, botErrorHandler } from "../src/bot/index.js";
import { createDb } from "../src/db/client.js";
import { createLogger } from "../src/logger.js";
import { WEBHOOK_PATH, buildServer } from "../src/server/index.js";
import { apiRoutes } from "../src/shared/api-contract.js";
import { buildTestApp } from "./helpers/api.js";
import { openTestDb, resetDb } from "./helpers/db.js";
import { createFakeBot, textUpdate } from "./helpers/fake-telegram.js";

const { db, close } = openTestDb();
beforeEach(() => resetDb(db));
afterAll(close);

/** Журнал в память: каждая запись — разобранная строка JSON. */
function memoryLogger(level: "info" | "debug" = "info") {
  const lines: Record<string, any>[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      for (const line of String(chunk).split("\n").filter(Boolean)) lines.push(JSON.parse(line));
      callback();
    },
  });
  return { logger: createLogger({ level, destination }), lines };
}

describe("формат журнала", () => {
  it("JSON-строки с level и message; секреты скрыты; строка запроса не пишется", () => {
    const { logger, lines } = memoryLogger();
    logger.info({ token: "invite-token", code: "123456", nested: { secret: "s3cr3t" } }, "Событие");
    logger.child({ component: "api" }).info({ req: { id: "req-1", method: "GET", url: "/api/auth/telegram/callback?code=abc&state=xyz" } }, "Запрос");
    expect(lines[0]).toMatchObject({ level: "info", message: "Событие", service: "english-bot", token: "[скрыто]", code: "[скрыто]" });
    expect(lines[0]!.nested.secret).toBe("[скрыто]");
    expect(typeof lines[0]!.time).toBe("string");
    expect(lines[1]).toMatchObject({ component: "api", req: { id: "req-1", method: "GET", url: "/api/auth/telegram/callback" } });
    expect(JSON.stringify(lines)).not.toMatch(/invite-token|123456|s3cr3t|state=xyz/);
  });

  it("ошибка пишется со стеком и типом", () => {
    const { logger, lines } = memoryLogger();
    logger.error({ err: new TypeError("сломалось") }, "Сбой");
    expect(lines[0]).toMatchObject({ level: "error", message: "Сбой", err: { type: "TypeError", message: "сломалось" } });
    expect(lines[0]!.err.stack).toContain("TypeError");
  });
});

describe("сервер: ошибка без утечки подробностей", () => {
  it("API: база недоступна — 500 с общим сообщением кабинета, подробности и номер запроса в журнале", async () => {
    const broken = createDb("postgres://nobody@127.0.0.1:1/english_bot_test");
    const { logger, lines } = memoryLogger();
    const app = buildTestApp(broken.db, null, {}, { logger });
    try {
      const response = await app.inject({ method: "GET", url: apiRoutes.dashboard.path, cookies: { eb_session: "any" } });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ error: { code: "internal", message: "Что-то пошло не так. Попробуйте ещё раз." } });
      expect(response.body).not.toMatch(/ECONNREFUSED|127\.0\.0\.1|stack|select/i);
      const entry = lines.find((line) => line.message === "Ошибка запроса кабинета");
      expect(entry).toMatchObject({ level: "error" });
      expect(entry!.reqId).toBeTruthy();
      // Запрос с тем же номером записан при поступлении: по номеру ошибка находится в журнале.
      expect(lines.find((line) => line.reqId === entry!.reqId && line.req)).toMatchObject({ req: { method: "GET", url: "/api/dashboard" } });
      expect(JSON.stringify(entry!.err)).toMatch(/ECONNREFUSED|connect/);
    } finally {
      await app.close();
      await broken.close();
    }
  });

  it("webhook: сбой обработки — 500 без текста ошибки (Telegram повторит событие), подробности в журнале", async () => {
    const { bot } = createFakeBot(db, {
      respond: (call) =>
        call.method === "sendMessage" ? { ok: false, error_code: 500, description: "секретная подробность" } : undefined,
    });
    const { logger, lines } = memoryLogger();
    const secret = "s".repeat(32);
    const app = buildServer({ db, logger, webhook: { bot, secretToken: secret } });
    const response = await app.inject({
      method: "POST",
      url: WEBHOOK_PATH,
      payload: textUpdate(5551, "/start"),
      headers: { "x-telegram-bot-api-secret-token": secret },
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "Internal Server Error" });
    expect(response.body).not.toContain("секретная подробность");
    const entry = lines.find((line) => line.message === "Необработанная ошибка запроса");
    expect(JSON.stringify(entry)).toContain("секретная подробность");
    // Секрет webhook из заголовка в журнал не попадает.
    expect(JSON.stringify(lines)).not.toContain(secret);
    await app.close();
  });
});

describe("бот: обработчик ошибок в режиме опроса", () => {
  const fakeContext = (reply: (text: string) => Promise<unknown>) =>
    ({ update: { update_id: 42 }, chat: { id: 7, type: "private" }, reply }) as never;

  it("пишет событие в журнал и отвечает ученику общим текстом без подробностей", async () => {
    const { logger, lines } = memoryLogger();
    const replies: string[] = [];
    await botErrorHandler(logger)(
      new BotError(new Error("внутренняя деталь"), fakeContext(async (text) => replies.push(text))),
    );
    expect(replies).toEqual([BOT_ERROR_TEXT]);
    expect(BOT_ERROR_TEXT).not.toContain("деталь");
    expect(lines[0]).toMatchObject({ level: "error", updateId: 42, chatId: 7, kind: "exception", err: { message: "внутренняя деталь" } });
  });

  it("ошибка Telegram записывается с кодом; если ответить не удалось, это тоже в журнале", async () => {
    const { logger, lines } = memoryLogger();
    const telegram = new GrammyError("Call to 'sendMessage' failed!", { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }, "sendMessage", {});
    await botErrorHandler(logger)(
      new BotError(telegram, fakeContext(async () => {
        throw telegram;
      })),
    );
    expect(lines[0]).toMatchObject({ kind: "telegram", errorCode: 403, method: "sendMessage" });
    expect(lines[1]).toMatchObject({ level: "warn", message: "Не удалось сообщить ученику о сбое", errorCode: 403 });
  });
});

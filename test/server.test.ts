import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../src/db/client.js";
import { users } from "../src/db/schema.js";
import { HEALTH_PATH, WEBHOOK_PATH, buildServer } from "../src/server/index.js";
import { openTestDb, resetDb } from "./helpers/db.js";
import { createFakeBot, textUpdate } from "./helpers/fake-telegram.js";

const { db, close } = openTestDb();
beforeEach(() => resetDb(db));
afterAll(close);

const SECRET = "s".repeat(32);

describe("сервер", () => {
  it("health-check отвечает 200, когда база доступна", async () => {
    const app = buildServer({ db });
    const response = await app.inject({ method: "GET", url: HEALTH_PATH });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    await app.close();
  });

  it("health-check отвечает 503, когда база недоступна", async () => {
    const broken = createDb("postgres://nobody@127.0.0.1:1/english_bot_test");
    const app = buildServer({ db: broken.db });
    const response = await app.inject({ method: "GET", url: HEALTH_PATH });
    expect(response.statusCode).toBe(503);
    await app.close();
    await broken.close();
  });

  it("без настройки webhook маршрута нет: локально работает опрос", async () => {
    const app = buildServer({ db });
    const response = await app.inject({ method: "POST", url: WEBHOOK_PATH, payload: {} });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("webhook отклоняет запрос без верного секрета и ничего не обрабатывает", async () => {
    const { bot, calls } = createFakeBot(db);
    const app = buildServer({ db, webhook: { bot, secretToken: SECRET } });
    const payload = textUpdate(555, "/start");

    const missing = await app.inject({ method: "POST", url: WEBHOOK_PATH, payload });
    expect(missing.statusCode).toBe(401);
    const wrong = await app.inject({
      method: "POST",
      url: WEBHOOK_PATH,
      payload,
      headers: { "x-telegram-bot-api-secret-token": "wrong" },
    });
    expect(wrong.statusCode).toBe(401);
    expect(calls).toHaveLength(0);
    expect(await db.select().from(users)).toHaveLength(0);
    await app.close();
  });

  it("webhook с верным секретом передаёт событие боту", async () => {
    const { bot, calls } = createFakeBot(db);
    const app = buildServer({ db, webhook: { bot, secretToken: SECRET } });
    const response = await app.inject({
      method: "POST",
      url: WEBHOOK_PATH,
      payload: textUpdate(555, "/start"),
      headers: { "x-telegram-bot-api-secret-token": SECRET },
    });
    expect(response.statusCode).toBe(200);
    expect(calls.some((call) => call.method === "sendMessage")).toBe(true);
    expect(await db.select().from(users)).toHaveLength(1);
    await app.close();
  });

  it("сбой обработки при webhook даёт 500, чтобы Telegram повторил событие", async () => {
    const { bot } = createFakeBot(db, {
      respond: (call) =>
        call.method === "sendMessage" ? { ok: false, error_code: 500, description: "Internal Server Error" } : undefined,
    });
    const app = buildServer({ db, webhook: { bot, secretToken: SECRET } });
    const response = await app.inject({
      method: "POST",
      url: WEBHOOK_PATH,
      payload: textUpdate(555, "/start"),
      headers: { "x-telegram-bot-api-secret-token": SECRET },
    });
    expect(response.statusCode).toBe(500);
    await app.close();
  });
});

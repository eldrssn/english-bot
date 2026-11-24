import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { notifications, users } from "../src/db/schema.js";
import { enqueueNotification } from "../src/notifications/queue.js";
import { notificationKeyboard, renderNotification } from "../src/notifications/render.js";
import { MAX_DELIVERY_ATTEMPTS, deliverDueNotifications, startNotificationWorker } from "../src/notifications/worker.js";
import { openTestDb, resetDb } from "./helpers/db.js";
import { createFakeBot, sentTexts, textUpdate } from "./helpers/fake-telegram.js";
import { makeUser } from "./helpers/linking.js";

const { db, close } = openTestDb();
afterAll(close);
beforeEach(() => resetDb(db));

const noSleep = async () => {};
const queued = () => db.select().from(notifications).orderBy(notifications.id);

async function enqueue(userId: number, key: string, reason: "link_ended" | "link_confirmed" = "link_ended") {
  await enqueueNotification(db, { recipientUserId: userId, reason, dedupeKey: key });
}

describe("очередь", () => {
  it("повторная постановка с тем же ключом не создаёт второе сообщение", async () => {
    const user = await makeUser(db, 1);
    await enqueue(user.id, "same");
    await enqueue(user.id, "same");
    expect(await queued()).toHaveLength(1);
    const { bot, calls } = createFakeBot(db);
    await deliverDueNotifications(db, bot.api, { sleep: noSleep });
    await enqueue(user.id, "same");
    await deliverDueNotifications(db, bot.api, { sleep: noSleep });
    expect(sentTexts(calls)).toHaveLength(1);
    expect((await queued())[0]).toMatchObject({ status: "sent", deliveryAttempts: 1 });
    expect((await queued())[0]?.sentAt).toBeInstanceOf(Date);
  });

  it("письмо уходит на Telegram ID получателя", async () => {
    const user = await makeUser(db, 555);
    await enqueue(user.id, "k");
    const { bot, calls } = createFakeBot(db);
    await deliverDueNotifications(db, bot.api, { sleep: noSleep });
    expect(calls.at(-1)?.payload.chat_id).toBe(555);
  });

  it("за такт не больше 25 сообщений, между ними пауза; следующий такт добирает остальное", async () => {
    const created = await Promise.all(Array.from({ length: 30 }, (_, i) => makeUser(db, 1000 + i)));
    for (const user of created) await enqueue(user.id, `k${user.id}`);
    const { bot, calls } = createFakeBot(db);
    const sleeps: number[] = [];
    const sleep = async (ms: number) => void sleeps.push(ms);
    const first = await deliverDueNotifications(db, bot.api, { sleep });
    expect(first.sent).toBe(25);
    expect(sentTexts(calls)).toHaveLength(25);
    expect(sleeps).toHaveLength(24);
    expect(sleeps.every((ms) => ms >= 40)).toBe(true);
    const second = await deliverDueNotifications(db, bot.api, { sleep });
    expect(second.sent).toBe(5);
  });

  it("одному получателю за такт только одно сообщение, по порядку", async () => {
    const user = await makeUser(db, 1);
    await enqueue(user.id, "a", "link_confirmed");
    await enqueue(user.id, "b");
    const { bot, calls } = createFakeBot(db);
    expect((await deliverDueNotifications(db, bot.api, { sleep: noSleep })).sent).toBe(1);
    expect(sentTexts(calls)[0]).toContain("подтвердил");
    expect((await deliverDueNotifications(db, bot.api, { sleep: noSleep })).sent).toBe(1);
    expect(sentTexts(calls)[1]).toContain("больше не ведёт");
  });

  it("429: повтор через retry_after, остальная партия возвращается в очередь, попытки не считаются", async () => {
    const [a, b, c] = [await makeUser(db, 1), await makeUser(db, 2), await makeUser(db, 3)];
    for (const user of [a, b, c]) await enqueue(user.id, `k${user.id}`);
    let limited = true;
    const { bot, calls } = createFakeBot(db, {
      respond: (call) =>
        limited && call.payload.chat_id === 2
          ? { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 7 } }
          : undefined,
    });
    const before = Date.now();
    const report = await deliverDueNotifications(db, bot.api, { sleep: noSleep });
    expect(report).toMatchObject({ sent: 1, retried: 2, pauseMs: 7000 });

    const rows = await queued();
    expect(rows[0]?.status).toBe("sent");
    for (const row of rows.slice(1)) {
      expect(row).toMatchObject({ status: "pending", deliveryAttempts: 0 });
      expect(row.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before + 7000);
    }
    expect((await deliverDueNotifications(db, bot.api, { sleep: noSleep })).sent).toBe(0);

    limited = false;
    await db.update(notifications).set({ nextAttemptAt: new Date(0) }).where(eq(notifications.status, "pending"));
    expect((await deliverDueNotifications(db, bot.api, { sleep: noSleep })).sent).toBe(2);
    expect(calls.filter((call) => call.payload.chat_id === 2).length).toBe(2);
  });

  it("403: статус blocked, users.bot_blocked_at заполнен, повторов нет; новое сообщение от ученика снимает отметку", async () => {
    const user = await makeUser(db, 1);
    await enqueue(user.id, "k");
    const { bot, calls } = createFakeBot(db, {
      respond: (call) =>
        call.method === "sendMessage" && call.payload.text.includes("больше не ведёт")
          ? { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }
          : undefined,
    });
    expect((await deliverDueNotifications(db, bot.api, { sleep: noSleep })).blocked).toBe(1);
    expect((await queued())[0]?.status).toBe("blocked");
    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row?.botBlockedAt).toBeInstanceOf(Date);
    const count = calls.length;
    await deliverDueNotifications(db, bot.api, { sleep: noSleep });
    expect(calls.length).toBe(count);

    await bot.handleUpdate(textUpdate(1, "/start"));
    const [after] = await db.select().from(users).where(eq(users.id, user.id));
    expect(after?.botBlockedAt).toBeNull();
  });

  it("сбой сервера Telegram: повтор с задержкой, после лимита попыток — failed", async () => {
    const user = await makeUser(db, 1);
    await enqueue(user.id, "k");
    const { bot } = createFakeBot(db, {
      respond: () => ({ ok: false, error_code: 500, description: "Internal Server Error" }),
    });
    const before = Date.now();
    expect((await deliverDueNotifications(db, bot.api, { sleep: noSleep })).retried).toBe(1);
    const [row] = await queued();
    expect(row).toMatchObject({ status: "pending", deliveryAttempts: 1 });
    expect(row?.nextAttemptAt.getTime()).toBeGreaterThan(before + 20_000);
    expect(row?.lastError).toContain("500");

    await db.update(notifications).set({ nextAttemptAt: new Date(0), deliveryAttempts: MAX_DELIVERY_ATTEMPTS - 1 });
    expect((await deliverDueNotifications(db, bot.api, { sleep: noSleep })).failed).toBe(1);
    expect((await queued())[0]?.status).toBe("failed");
  });

  it("ошибка 400 постоянная: без повторов", async () => {
    const user = await makeUser(db, 1);
    await enqueue(user.id, "k");
    const { bot } = createFakeBot(db, {
      respond: () => ({ ok: false, error_code: 400, description: "Bad Request: chat not found" }),
    });
    expect((await deliverDueNotifications(db, bot.api, { sleep: noSleep })).failed).toBe(1);
    expect((await queued())[0]?.status).toBe("failed");
  });

  it("взятая в работу запись не достаётся второму обработчику, после срока аренды возвращается", async () => {
    const user = await makeUser(db, 1);
    await enqueue(user.id, "k");
    const { bot, calls } = createFakeBot(db);
    const [one, two] = await Promise.all([
      deliverDueNotifications(db, bot.api, { sleep: noSleep }),
      deliverDueNotifications(db, bot.api, { sleep: noSleep }),
    ]);
    expect((one?.sent ?? 0) + (two?.sent ?? 0)).toBe(1);
    expect(sentTexts(calls)).toHaveLength(1);
  });

  it("фоновый цикл отправляет и корректно останавливается", async () => {
    const user = await makeUser(db, 1);
    await enqueue(user.id, "k");
    const { bot } = createFakeBot(db);
    const worker = startNotificationWorker(db, bot.api, { tickMs: 10 });
    await vi.waitFor(async () => expect((await queued())[0]?.status).toBe("sent"));
    await worker.stop();
  });
});

describe("тексты уведомлений", () => {
  it("заявка: имя преподавателя для записи и аккаунт для сверки", () => {
    const text = renderNotification("join_request", { displayName: "Пётр", telegramName: "Peter", telegramUsername: "peter" });
    expect(text).toContain("Пётр");
    expect(text).toContain("Peter");
    expect(text).toContain("@peter");
  });

  it("отклонение заявки не раскрывает подробностей", () => {
    expect(renderNotification("request_rejected", { displayName: "Секрет" })).toBe(
      "Преподаватель отклонил заявку. Если это ошибка, попросите у него новую ссылку.",
    );
  });

  it("у новой подборки кнопка «Посмотреть», у остальных уведомлений кнопок нет", () => {
    const keyboard = notificationKeyboard("new_collection", { studentCollectionId: 42, title: "Т", wordCount: 2 });
    expect(keyboard?.inline_keyboard.flat()).toEqual([{ text: "Посмотреть", callback_data: "c:n:42" }]);
    expect(notificationKeyboard("new_collection", {})).toBeUndefined();
    expect(notificationKeyboard("link_ended", { studentCollectionId: 42 })).toBeUndefined();
  });

  it("часовой пояс не спрашивается", () => {
    expect(renderNotification("link_confirmed", {})).not.toMatch(/пояс/i);
  });
});

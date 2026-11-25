// Напоминания о ежедневной практике: планировщик, очередь уведомлений и кнопка «Начать».
// Критерий этапа 6: перезапуск сервиса и повторная отправка уведомления не создают лишних занятий.
// Часы планировщика и бота подменены, ожидания в реальном времени нет.
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { DAILY_OPEN, DAILY_START, startTest } from "../../src/bot/callback-data.js";
import { createDb } from "../../src/db/client.js";
import { notifications, sessions, users } from "../../src/db/schema.js";
import { createSeededRng } from "../../src/domain/learning/index.js";
import { dailyReminderKey, runReminderTick, startReminderScheduler } from "../../src/notifications/reminders.js";
import { deliverDueNotifications } from "../../src/notifications/worker.js";
import { TEST_DATABASE_URL, openTestDb, resetDb } from "../helpers/db.js";
import { callbackUpdate, createFakeBot, lastButtons, sentTexts } from "../helpers/fake-telegram.js";
import { answerCurrent, connectStudent, currentStep, issue, waitForBlockedQuery, words } from "../helpers/learning.js";
import { lockUser } from "../../src/linking/locks.js";
import { makeTeacher, makeUser } from "../helpers/linking.js";

const { db, close } = openTestDb();
afterAll(close);
beforeEach(() => resetDb(db));

// 24 ноября 2026: 18:59 и 19:00 по Москве.
const BEFORE = new Date("2026-11-24T15:59:00Z");
const AT_SEVEN = new Date("2026-11-24T16:00:00Z");
const NEXT_DAY_SEVEN = new Date("2026-11-25T16:00:00Z");
const noSleep = async () => {};
const tick = (now: Date, seed = 1) => runReminderTick(db, { now, rng: createSeededRng(seed) });

let nextTelegramId = 77001;

async function student(options: { timezone?: string | null; wordCount?: number; patch?: Partial<typeof users.$inferInsert> } = {}) {
  const telegramId = nextTelegramId++;
  const { student, link } = await connectStudent(db, telegramId);
  const timezone = options.timezone === undefined ? "Europe/Moscow" : options.timezone;
  await db.update(users).set({ timezone, ...options.patch }).where(eq(users.id, student.id));
  const wordCount = options.wordCount ?? 12;
  const collectionId = wordCount > 0 ? await issue(db, link.id, `Подборка ${telegramId}`, words(wordCount)) : null;
  // Уведомление о выдаче подборки здесь не нужно: в очереди проверяются только напоминания.
  await db.delete(notifications).where(eq(notifications.recipientUserId, student.id));
  return { telegramId, userId: student.id, collectionId };
}

const reminders = () => db.select().from(notifications).where(eq(notifications.reason, "daily_reminder")).orderBy(notifications.id);
const quests = (userId?: number) =>
  db
    .select()
    .from(sessions)
    .where(userId === undefined ? eq(sessions.type, "daily_quest") : eq(sessions.studentUserId, userId))
    .orderBy(sessions.id);

describe("планировщик", () => {
  it("до времени напоминания ничего; в 19:00 — один квест на паузе и одно напоминание", async () => {
    const { userId } = await student();
    expect(await tick(BEFORE)).toEqual({ closedQuests: 0, reminded: 0, questsCreated: 0 });
    expect(await quests()).toHaveLength(0);

    expect(await tick(AT_SEVEN)).toEqual({ closedQuests: 0, reminded: 1, questsCreated: 1 });
    const [quest] = await quests();
    expect(quest).toMatchObject({ studentUserId: userId, status: "paused", questLocalDate: "2026-11-24" });
    const [reminder] = await reminders();
    expect(reminder).toMatchObject({
      recipientUserId: userId,
      dedupeKey: dailyReminderKey(userId, "2026-11-24"),
      status: "pending",
      payload: { questLocalDate: "2026-11-24", sessionId: quest!.id },
    });
  });

  it("повторные такты и перезапуск сервиса не создают второго квеста и второго напоминания", async () => {
    await student();
    await tick(AT_SEVEN, 1);
    await tick(new Date(AT_SEVEN.getTime() + 60_000), 2);
    const restarted = createDb(TEST_DATABASE_URL);
    try {
      expect(await runReminderTick(restarted.db, { now: new Date(AT_SEVEN.getTime() + 3 * 60 * 60_000), rng: createSeededRng(3) })).toEqual({
        closedQuests: 0,
        reminded: 0,
        questsCreated: 0,
      });
    } finally {
      await restarted.close();
    }
    expect(await quests()).toHaveLength(1);
    expect(await reminders()).toHaveLength(1);
  });

  it("сервис простаивал в 19:00: после перезапуска в 21:30 напоминание уходит в тот же день", async () => {
    await student();
    expect((await tick(new Date("2026-11-24T18:30:00Z"))).reminded).toBe(1);
  });

  it("одно и то же время: в Москве пора, в Нью-Йорке ещё нет", async () => {
    const moscow = await student();
    const newYork = await student({ timezone: "America/New_York" });
    await tick(AT_SEVEN);
    expect((await reminders()).map((row) => row.recipientUserId)).toEqual([moscow.userId]);
    // 19:00 в Нью-Йорке — 00:00 UTC следующего дня.
    await tick(new Date("2026-11-25T00:00:00Z"));
    expect((await reminders()).map((row) => [row.recipientUserId, row.payload.questLocalDate])).toEqual([
      [moscow.userId, "2026-11-24"],
      [newYork.userId, "2026-11-24"],
    ]);
  });

  it("своё время напоминания: в 08:00 по Владивостоку", async () => {
    const { userId } = await student({ timezone: "Asia/Vladivostok", patch: { reminderTime: "08:00" } });
    await tick(new Date("2026-11-23T21:59:00Z"));
    expect(await reminders()).toHaveLength(0);
    await tick(new Date("2026-11-23T22:00:00Z"));
    expect((await reminders())[0]).toMatchObject({ recipientUserId: userId, payload: { questLocalDate: "2026-11-24" } });
  });

  it("не уходит тем, кто отключил напоминания, заблокировал бота, не выбрал пояс или не имеет слов; и преподавателю", async () => {
    await student({ patch: { remindersEnabled: false } });
    await student({ patch: { botBlockedAt: new Date("2026-11-20T00:00:00Z") } });
    await student({ timezone: null });
    await student({ wordCount: 0 });
    const teacher = await makeTeacher(db, 77900);
    await db.update(users).set({ timezone: "Europe/Moscow" }).where(eq(users.id, teacher.id));
    await makeUser(db, 77901, "student");
    expect(await tick(AT_SEVEN)).toEqual({ closedQuests: 0, reminded: 0, questsCreated: 0 });
    expect(await reminders()).toHaveLength(0);
    expect(await quests()).toHaveLength(0);
  });

  it("сегодняшний квест уже пройден утром: напоминания нет; открытый, но не пройденный — напоминание ведёт к нему", async () => {
    const done = await student();
    const open = await student();
    for (const { telegramId, userId } of [done, open]) {
      const fake = createFakeBot(db, { now: () => new Date("2026-11-24T07:00:00Z"), rng: createSeededRng(1) });
      await fake.bot.handleUpdate(callbackUpdate(telegramId, DAILY_START));
      if (userId === done.userId) {
        for (let guard = 0; guard < 40 && (await currentStep(db, userId)); guard++) await answerCurrent(fake, db, telegramId, true);
      }
    }
    expect((await quests(done.userId))[0]!.status).toBe("completed");
    expect(await tick(AT_SEVEN)).toMatchObject({ reminded: 1, questsCreated: 0 });
    const [reminder] = await reminders();
    expect(reminder).toMatchObject({ recipientUserId: open.userId, payload: { sessionId: (await quests(open.userId))[0]!.id } });
  });

  it("на следующий день: вчерашний квест закрыт как незавершённый, создан новый и новое напоминание", async () => {
    const { userId } = await student();
    await tick(AT_SEVEN);
    const report = await tick(NEXT_DAY_SEVEN);
    expect(report).toEqual({ closedQuests: 1, reminded: 1, questsCreated: 1 });
    expect((await quests(userId)).map((quest) => [quest.questLocalDate, quest.status])).toEqual([
      ["2026-11-24", "incomplete"],
      ["2026-11-25", "paused"],
    ]);
    expect((await reminders()).map((row) => row.dedupeKey)).toEqual([
      dailyReminderKey(userId, "2026-11-24"),
      dailyReminderKey(userId, "2026-11-25"),
    ]);
  });

  it("квест планировщика не прерывает занятие, которое ученик проходит сейчас", async () => {
    const { telegramId, userId, collectionId } = await student();
    const fake = createFakeBot(db, { now: () => AT_SEVEN, rng: createSeededRng(1) });
    await fake.bot.handleUpdate(callbackUpdate(telegramId, startTest(collectionId!)));
    await tick(AT_SEVEN);
    const rows = await quests(userId);
    expect(rows.map((row) => [row.type, row.status])).toEqual([
      ["test", "current"],
      ["daily_quest", "paused"],
    ]);
  });

  it("гонка: такт планировщика и «Начать» ждут одну блокировку ученика — квест один", async () => {
    const { telegramId, userId } = await student();
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let locked = () => {};
    const holding = new Promise<void>((resolve) => (locked = resolve));
    const holder = db.transaction(async (tx) => {
      await lockUser(tx, userId);
      locked();
      await gate;
    });
    await holding;
    const fake = createFakeBot(db, { now: () => AT_SEVEN, rng: createSeededRng(2) });
    const pressed = fake.bot.handleUpdate(callbackUpdate(telegramId, DAILY_START));
    const ticked = tick(AT_SEVEN);
    await waitForBlockedQuery(db);
    release();
    await Promise.all([holder, pressed, ticked]);
    const rows = await quests(userId);
    expect(rows).toHaveLength(1);
    expect(await reminders()).toHaveLength(1);
  });

  it("цикл планировщика: такт сразу после запуска, остановка ждёт его завершения", async () => {
    await student();
    const scheduler = startReminderScheduler(db, { now: () => AT_SEVEN, rng: createSeededRng(1), intervalMs: 60_000 });
    await scheduler.stop();
    expect(await reminders()).toHaveLength(1);
  });
});

describe("доставка и кнопка «Начать»", () => {
  it("напоминание уходит с кнопкой «Начать»; повторная отправка и двойное нажатие — один квест", async () => {
    const { telegramId, userId } = await student();
    await tick(AT_SEVEN);
    const fake = createFakeBot(db, { now: () => AT_SEVEN, rng: createSeededRng(1) });
    expect((await deliverDueNotifications(db, fake.bot.api, { sleep: noSleep })).sent).toBe(1);
    expect(sentTexts(fake.calls).at(-1)).toBe("Сегодня короткая практика: повторить сложные слова и проверить новые.");
    expect(lastButtons(fake.calls)).toEqual([{ text: "Начать", callback_data: DAILY_START }]);

    // Повторная отправка того же уведомления (например, сбой после отправки до записи статуса).
    await db.update(notifications).set({ status: "pending", nextAttemptAt: new Date(0) }).where(eq(notifications.reason, "daily_reminder"));
    expect((await deliverDueNotifications(db, fake.bot.api, { sleep: noSleep })).sent).toBe(1);

    // Раздел показывает квест из напоминания как ещё не начатый.
    await fake.bot.handleUpdate(callbackUpdate(telegramId, DAILY_OPEN));
    expect(sentTexts(fake.calls).at(-1)).toContain("Вопросов: 10.");
    expect(lastButtons(fake.calls).map((button) => button.text)).toEqual(["Начать", "В меню"]);

    await fake.bot.handleUpdate(callbackUpdate(telegramId, DAILY_START));
    expect(sentTexts(fake.calls).at(-1)).toContain("Вопрос 1 из 10");
    await answerCurrent(fake, db, telegramId, true);
    await fake.bot.handleUpdate(callbackUpdate(telegramId, DAILY_START));
    expect(sentTexts(fake.calls).at(-1)).toContain("Вопрос 2 из 10");

    const rows = await quests(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: "daily_quest", status: "current" });
    expect(await reminders()).toHaveLength(1);
  });

  it("ученик заблокировал бота: доставка отмечает это, следующее напоминание не ставится", async () => {
    const { userId } = await student();
    await tick(AT_SEVEN);
    const fake = createFakeBot(db, {
      respond: (call) =>
        call.method === "sendMessage" ? { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" } : undefined,
    });
    expect((await deliverDueNotifications(db, fake.bot.api, { sleep: noSleep })).blocked).toBe(1);
    expect(await tick(NEXT_DAY_SEVEN)).toMatchObject({ reminded: 0, questsCreated: 0 });
    expect((await db.select().from(users).where(eq(users.id, userId)))[0]!.botBlockedAt).toBeInstanceOf(Date);
  });
});

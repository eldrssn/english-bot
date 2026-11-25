// Ежедневный квест через бота: один в день по локальной дате ученика, вчерашний закрывается как незавершённый.
// Часы подменены, случайность зафиксирована: результат не зависит от времени запуска.
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { DAILY_OPEN, DAILY_START, timezoneList } from "../../src/bot/callback-data.js";
import { attempts, questions, sessions, studentCards, studentWords, users } from "../../src/db/schema.js";
import { createSeededRng } from "../../src/domain/learning/index.js";
import { openTestDb, resetDb } from "../helpers/db.js";
import { callbackUpdate, createFakeBot, lastButtons, sentTexts, textUpdate } from "../helpers/fake-telegram.js";
import { answerCurrent, connectStudent, currentStep, issue, words, type FakeBot } from "../helpers/learning.js";
import { TEST_DATABASE_URL } from "../helpers/db.js";
import { createDb } from "../../src/db/client.js";

const { db, close } = openTestDb();
afterAll(close);

const STUDENT = 76001;
// 24 ноября 2026, 12:00 по Москве.
const NOON_MOSCOW = new Date("2026-11-24T09:00:00Z");
const HOUR = 60 * 60 * 1000;

let now = NOON_MOSCOW;
const clock = () => now;
const fakeBot = (seed = 1) => createFakeBot(db, { now: clock, rng: createSeededRng(seed) });

beforeEach(async () => {
  now = NOON_MOSCOW;
  await resetDb(db);
});

async function setup(options: { timezone?: string | null; wordCount?: number } = {}) {
  const { student, link } = await connectStudent(db, STUDENT);
  const timezone = options.timezone === undefined ? "Europe/Moscow" : options.timezone;
  await db.update(users).set({ timezone }).where(eq(users.id, student.id));
  const wordCount = options.wordCount ?? 14;
  const collectionId = wordCount > 0 ? await issue(db, link.id, "Подборка", words(wordCount)) : null;
  return { student, link, collectionId, fake: fakeBot() };
}

const quests = () => db.select().from(sessions).where(eq(sessions.type, "daily_quest")).orderBy(sessions.id);

async function press(fake: FakeBot, data: string) {
  await fake.bot.handleUpdate(callbackUpdate(STUDENT, data));
  return sentTexts(fake.calls).at(-1)!;
}

async function finishCurrent(fake: FakeBot, studentUserId: number, correct: (index: number) => boolean = () => true) {
  for (let index = 0; index < 40; index++) {
    if (!(await currentStep(db, studentUserId))) return;
    await answerCurrent(fake, db, STUDENT, correct(index));
  }
  throw new Error("Квест не закончился");
}

describe("экран «Ежедневная практика»", () => {
  it("до начала: текст сценария, 10 вопросов, «Начать»; квест ещё не создан", async () => {
    const { fake } = await setup();
    const text = await press(fake, DAILY_OPEN);
    expect(text).toContain("Сегодня короткая практика: повторить сложные слова и проверить новые.");
    expect(text).toContain("Вопросов: 10.");
    expect(text).toContain("Серия дней с завершённой практикой: 0.");
    expect(lastButtons(fake.calls).map((button) => button.text)).toEqual(["Начать", "В меню"]);
    expect(await quests()).toHaveLength(0);
  });

  it("пояс не выбран: просит выбрать пояс, квест не создаётся даже по кнопке «Начать»", async () => {
    const { fake } = await setup({ timezone: null });
    expect(await press(fake, DAILY_OPEN)).toContain("сначала выберите часовой пояс");
    expect(lastButtons(fake.calls).map((button) => button.callback_data)).toContain(timezoneList(0));
    await press(fake, DAILY_START);
    expect(await quests()).toHaveLength(0);
  });

  it("слов нет: практики нет, квест не создаётся", async () => {
    const { fake } = await setup({ wordCount: 0 });
    expect(await press(fake, DAILY_OPEN)).toContain("Слов пока нет");
    await press(fake, DAILY_START);
    expect(await quests()).toHaveLength(0);
  });
});

describe("один квест в день", () => {
  it("«Начать» дважды и после перезапуска: один квест, тот же вопрос, ответы сохранены", async () => {
    const { fake, student } = await setup();
    await press(fake, DAILY_START);
    const [quest] = await quests();
    expect(quest).toMatchObject({ status: "current", questLocalDate: "2026-11-24", studentCollectionId: null });
    expect(quest!.learningState!.plan).toHaveLength(10);
    const first = (await currentStep(db, student.id))!;
    await answerCurrent(fake, db, STUDENT, true);

    await press(fake, DAILY_START);
    const restarted = createDb(TEST_DATABASE_URL);
    try {
      const again = createFakeBot(restarted.db, { now: clock, rng: createSeededRng(99) });
      await again.bot.handleUpdate(callbackUpdate(STUDENT, DAILY_START));
      expect(sentTexts(again.calls).at(-1)).toContain("Вопрос 2 из 10");
    } finally {
      await restarted.close();
    }
    expect(await quests()).toHaveLength(1);
    const asked = await db.select().from(questions).where(eq(questions.sessionId, quest!.id));
    expect(asked).toHaveLength(2);
    expect(asked.map((row) => row.position).sort()).toEqual([0, 1]);
    expect(asked.find((row) => row.position === 0)!.id).toBe(first.question.id);
  });

  it("экран показывает «Продолжить» и прогресс; в меню квест появляется после начала", async () => {
    const { fake } = await setup();
    await fake.bot.handleUpdate(textUpdate(STUDENT, "/start"));
    expect(lastButtons(fake.calls).map((button) => button.text)).not.toContain("Продолжить: ежедневная практика");
    await press(fake, DAILY_START);
    await answerCurrent(fake, db, STUDENT, true);
    const text = await press(fake, DAILY_OPEN);
    expect(text).toContain("Отвечено: 1 из 10.");
    expect(lastButtons(fake.calls).map((button) => button.text)).toEqual(["Продолжить", "В меню"]);
    await fake.bot.handleUpdate(textUpdate(STUDENT, "/start"));
    expect(lastButtons(fake.calls).map((button) => button.text)).toContain("Продолжить: ежедневная практика");
  });

  it("локальная дата — по поясу ученика: в 23:30 UTC в Москве уже завтрашний квест", async () => {
    const { fake } = await setup();
    now = new Date("2026-11-24T23:30:00Z");
    await press(fake, DAILY_START);
    expect((await quests())[0]!.questLocalDate).toBe("2026-11-25");

    await db.update(users).set({ timezone: "America/New_York" }).where(eq(users.telegramId, STUDENT));
    await press(fake, DAILY_START);
    // В Нью-Йорке ещё 24-е: квест 25-го закрыт как квест другого дня, создан квест 24-го.
    expect((await quests()).map((quest) => [quest.questLocalDate, quest.status])).toEqual([
      ["2026-11-25", "incomplete"],
      ["2026-11-24", "current"],
    ]);
  });

  it("завершённый квест: итог со словами для повтора, второго квеста в тот же день нет, серия 1", async () => {
    const { fake, student } = await setup();
    await press(fake, DAILY_START);
    await finishCurrent(fake, student.id, (index) => index !== 0);
    const summary = sentTexts(fake.calls).at(-1)!;
    expect(summary).toContain("Практика завершена");
    expect(summary).toContain("С первой попытки: 9 из 10");
    expect(summary).toContain("Слова для повтора:");
    expect(lastButtons(fake.calls).map((button) => button.text)).toEqual(["Мой прогресс", "В меню"]);
    expect((await quests())[0]!.status).toBe("completed");

    expect(await press(fake, DAILY_OPEN)).toContain("Сегодняшняя практика пройдена");
    expect(sentTexts(fake.calls).at(-1)).toContain("Серия дней с завершённой практикой: 1.");
    await press(fake, DAILY_START);
    expect(sentTexts(fake.calls).at(-1)).toContain("Практика завершена");
    expect(await quests()).toHaveLength(1);
  });
});

describe("вчерашний квест", () => {
  it("на следующий день закрывается как незавершённый, ответы сохраняются, создаётся новый", async () => {
    const { fake, student } = await setup();
    await press(fake, DAILY_START);
    await answerCurrent(fake, db, STUDENT, true);
    await answerCurrent(fake, db, STUDENT, false);
    const [yesterday] = await quests();
    const pending = (await currentStep(db, student.id))!;

    now = new Date(NOON_MOSCOW.getTime() + 24 * HOUR);
    const text = await press(fake, DAILY_OPEN);
    expect(text).toContain("Вопросов: 10.");
    const closed = (await quests())[0]!;
    expect(closed).toMatchObject({ id: yesterday!.id, status: "incomplete" });
    expect(closed.finishedAt).toEqual(now);
    const saved = await db
      .select()
      .from(attempts)
      .innerJoin(questions, eq(questions.id, attempts.questionId))
      .where(eq(questions.sessionId, yesterday!.id));
    expect(saved).toHaveLength(2);

    await press(fake, DAILY_START);
    const all = await quests();
    expect(all.map((quest) => [quest.questLocalDate, quest.status])).toEqual([
      ["2026-11-24", "incomplete"],
      ["2026-11-25", "current"],
    ]);

    // Кнопка вчерашнего вопроса ответа не записывает, «Продолжить» вчерашнего показывает итог, а не вопрос.
    const before = (await db.select().from(attempts)).length;
    if (pending.question.format === "choice") {
      await press(fake, `q:${pending.question.id}:${pending.attemptNumber}:0`);
      expect((await db.select().from(attempts)).length).toBe(before);
    }
    expect(await press(fake, `t:r:${yesterday!.id}`)).toContain("Практика завершена");
    expect((await quests())[0]!.status).toBe("incomplete");
  });

  it("ответ на вчерашний вопрос после полуночи не засчитывается: квест закрывается, бот показывает итог", async () => {
    const { fake, student } = await setup();
    await press(fake, DAILY_START);
    const step = (await currentStep(db, student.id))!;
    now = new Date("2026-11-24T21:00:00Z"); // 00:00 по Москве
    if (step.question.format === "choice") {
      await press(fake, `q:${step.question.id}:1:${step.question.correctOptionIndex}`);
      expect(lastButtons(fake.calls).map((button) => button.text)).toContain("Показать итог");
    } else {
      await fake.bot.handleUpdate(textUpdate(STUDENT, "любой ответ"));
      expect(sentTexts(fake.calls).at(-1)).toContain("Выберите раздел");
    }
    expect(await db.select().from(attempts)).toHaveLength(0);
    expect((await quests())[0]!.status).toBe("incomplete");
  });

  it("неотвеченные вчера слова могут попасть в новый квест", async () => {
    const { fake } = await setup({ wordCount: 10 });
    await press(fake, DAILY_START);
    const yesterdayWords = (await quests())[0]!.learningState!.plan.map((item) => item.studentWordId);
    now = new Date(NOON_MOSCOW.getTime() + 24 * HOUR);
    await press(fake, DAILY_START);
    const todayWords = (await quests())[1]!.learningState!.plan.map((item) => item.studentWordId);
    // Слов ровно 10: в оба квеста входят все.
    expect([...todayWords].sort()).toEqual([...yesterdayWords].sort());
  });
});

describe("состав квеста из базы", () => {
  it("до 5 сложных, до 3 недавно добавленных, остальное — старые; кнопки и ввод", async () => {
    const { fake, student, collectionId } = await setup({ wordCount: 20 });
    const cards = await db.select().from(studentCards).where(eq(studentCards.studentCollectionId, collectionId!)).orderBy(studentCards.position);
    // Все слова старые, кроме четырёх последних; первые семь — сложные.
    await db.update(studentCards).set({ addedAt: new Date(NOON_MOSCOW.getTime() - 30 * 24 * HOUR) }).where(eq(studentCards.studentCollectionId, collectionId!));
    const recentIds = cards.slice(16).map((card) => card.id);
    await db.update(studentCards).set({ addedAt: new Date(NOON_MOSCOW.getTime() - HOUR) }).where(inArray(studentCards.id, recentIds));
    const hardWordIds = cards.slice(0, 7).map((card) => card.studentWordId!);
    await db.update(studentWords).set({ status: "hard", hardSince: NOON_MOSCOW }).where(inArray(studentWords.id, hardWordIds));
    const recentWordIds = cards.slice(16).map((card) => card.studentWordId!);

    await press(fake, DAILY_START);
    const plan = (await quests())[0]!.learningState!.plan;
    const planned = plan.map((item) => item.studentWordId);
    expect(planned).toHaveLength(10);
    expect(planned.filter((id) => hardWordIds.includes(id))).toHaveLength(5);
    expect(planned.filter((id) => recentWordIds.includes(id))).toHaveLength(3);
    expect(new Set(plan.map((item) => item.format))).toEqual(new Set(["choice", "typed"]));
    expect(await db.select().from(sessions).where(and(eq(sessions.studentUserId, student.id), eq(sessions.type, "daily_quest")))).toHaveLength(1);
  });
});

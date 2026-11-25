// Экзамен, «Мой прогресс» и «Настройки» через бота. Часы и случайность зафиксированы.
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  DAILY_START,
  EXAM_OPEN,
  EXAM_START,
  PROGRESS_OPEN,
  REMINDER_TIME_LIST,
  SETTINGS_OPEN,
  remindersToggle,
  reminderTimeButton,
  timezoneButton,
  timezoneList,
} from "../../src/bot/callback-data.js";
import { attempts, notifications, questions, sessions, studentWords, users } from "../../src/db/schema.js";
import { createSeededRng } from "../../src/domain/learning/index.js";
import { enqueueNotification } from "../../src/notifications/queue.js";
import { deliverDueNotifications } from "../../src/notifications/worker.js";
import { openTestDb, resetDb } from "../helpers/db.js";
import { callbackUpdate, createFakeBot, lastButtons, sentTexts, textUpdate } from "../helpers/fake-telegram.js";
import { answerCurrent, card, connectStudent, currentStep, issue, words, type FakeBot } from "../helpers/learning.js";

const { db, close } = openTestDb();
afterAll(close);
beforeEach(() => resetDb(db));

const STUDENT = 78001;
const NOW = new Date("2026-11-24T09:00:00Z");
const fakeBot = (seed = 1) => createFakeBot(db, { now: () => NOW, rng: createSeededRng(seed) });

async function setup(collections: number[] = [30, 10, 5], timezone: string | null = "Europe/Moscow") {
  const { student, link } = await connectStudent(db, STUDENT);
  await db.update(users).set({ timezone }).where(eq(users.id, student.id));
  const collectionIds: number[] = [];
  for (const [index, size] of collections.entries()) {
    collectionIds.push(await issue(db, link.id, `Подборка ${index + 1}`, words(size, `c${index + 1}w`)));
  }
  return { student, link, collectionIds, fake: fakeBot() };
}

async function press(fake: FakeBot, data: string) {
  await fake.bot.handleUpdate(callbackUpdate(STUDENT, data));
  return sentTexts(fake.calls).at(-1)!;
}

const buttonTexts = (fake: FakeBot) => lastButtons(fake.calls).map((button) => button.text);

describe("экзамен", () => {
  it("перед началом: число вопросов и правила", async () => {
    const { fake } = await setup();
    const text = await press(fake, EXAM_OPEN);
    expect(text).toContain("Вопросов: 20 — поровну из всех ваших подборок.");
    expect(text).toContain("повторит слово один раз в конце серии из 5 вопросов");
    expect(text).toContain("«Сложные слова»");
    expect(buttonTexts(fake)).toEqual(["Начать экзамен", "В меню"]);
  });

  it("20 вопросов равномерно из подборок, оба формата; двойное нажатие — один экзамен", async () => {
    const { fake, collectionIds, student } = await setup();
    await press(fake, EXAM_START);
    await press(fake, EXAM_START);
    const exams = await db.select().from(sessions).where(eq(sessions.type, "exam"));
    expect(exams).toHaveLength(1);
    const plan = exams[0]!.learningState!.plan;
    expect(plan).toHaveLength(20);
    expect(new Set(plan.map((item) => item.format))).toEqual(new Set(["choice", "typed"]));
    expect(new Set(plan.map((item) => item.direction))).toEqual(new Set(["ru_en", "en_ru"]));

    const words = await db
      .select({ id: studentWords.id, english: studentWords.normalizedEnglish })
      .from(studentWords)
      .where(inArray(studentWords.id, plan.map((item) => item.studentWordId)));
    const fromSmall = words.filter((word) => word.english.startsWith("c3w")).length;
    expect(fromSmall).toBe(5);
    expect(collectionIds).toHaveLength(3);
    expect(exams[0]).toMatchObject({ studentUserId: student.id, studentCollectionId: null, status: "current" });
  });

  it("слов меньше 20: в экзамен входят все", async () => {
    const { fake } = await setup([4, 3]);
    expect(await press(fake, EXAM_OPEN)).toContain("Вопросов: 7 — по всем вашим словам.");
    await press(fake, EXAM_START);
    expect((await db.select().from(sessions).where(eq(sessions.type, "exam")))[0]!.learningState!.plan).toHaveLength(7);
  });

  it("слов нет: экзамен объясняет это и не создаётся", async () => {
    const { fake } = await setup([]);
    expect(await press(fake, EXAM_OPEN)).toContain("Слов пока нет");
    await press(fake, EXAM_START);
    expect(await db.select().from(sessions)).toHaveLength(0);
  });

  it("итог: первая попытка, после повтора, ошибки и пополнение «Сложных слов»", async () => {
    const { fake, student } = await setup([3, 3]);
    await press(fake, EXAM_START);
    const first = (await currentStep(db, student.id))!;
    const target = first.question.studentWordId;
    for (let guard = 0; guard < 30; guard++) {
      const step = await currentStep(db, student.id);
      if (!step) break;
      await answerCurrent(fake, db, STUDENT, step.question.studentWordId !== target);
    }
    const summary = sentTexts(fake.calls).at(-1)!;
    const pair = `${first.version.english} — ${first.version.primaryTranslation}`;
    expect(summary).toContain("Экзамен завершён");
    expect(summary).toContain("С первой попытки: 5 из 6");
    expect(summary).toContain("После повтора: 5 из 6");
    expect(summary).toContain(`Ошибки:\n• ${pair}`);
    expect(summary).toContain(`Пополнили «Сложные слова»:\n• ${pair}`);
    expect((await db.select().from(studentWords).where(eq(studentWords.id, target)))[0]!.status).toBe("hard");
    const exam = (await db.select().from(sessions).where(eq(sessions.type, "exam")))[0]!;
    expect(exam.status).toBe("completed");
    expect(exam.finishedAt).toEqual(NOW);
  });

  it("прерванный экзамен продолжается из меню и из раздела «Экзамен», новый не создаётся", async () => {
    const { fake, collectionIds } = await setup();
    await press(fake, EXAM_START);
    await answerCurrent(fake, db, STUDENT, true);
    await press(fake, `t:s:${collectionIds[0]}`);
    await fake.bot.handleUpdate(textUpdate(STUDENT, "/start"));
    expect(buttonTexts(fake)).toContain("Продолжить экзамен");
    expect(await press(fake, EXAM_OPEN)).toContain("незавершённый экзамен");
    const resume = lastButtons(fake.calls).find((button) => button.text === "Продолжить экзамен")!;
    expect(await press(fake, resume.callback_data)).toContain("Вопрос 2 из 20");
    expect(await db.select().from(sessions).where(eq(sessions.type, "exam"))).toHaveLength(1);
  });
});

describe("«Мой прогресс»", () => {
  it("пустой прогресс", async () => {
    const { fake } = await setup([]);
    const text = await press(fake, PROGRESS_OPEN);
    expect(text).toContain("Доступно слов: 0");
    expect(text).toContain("Завершено подборок: 0 из 0");
    expect(text).toContain("Серия дней с завершённой практикой: 0.");
  });

  it("доступные, изученные, сложные, освоенные слова, завершённые подборки и серия дней", async () => {
    const { student, link, fake } = await setup([]);
    const small = await issue(db, link.id, "Маленькая", [card("one", "один"), card("two", "два")]);
    await issue(db, link.id, "Большая", words(8, "big"));
    await press(fake, `t:s:${small}`);
    for (let guard = 0; guard < 10 && (await currentStep(db, student.id)); guard++) await answerCurrent(fake, db, STUDENT, true);

    const all = await db.select().from(studentWords).where(eq(studentWords.studentUserId, student.id)).orderBy(studentWords.id);
    await db.update(studentWords).set({ status: "hard", hardSince: NOW }).where(inArray(studentWords.id, all.slice(2, 5).map((word) => word.id)));
    await db.update(studentWords).set({ status: "mastered", masteredAt: NOW }).where(eq(studentWords.id, all[5]!.id));
    // Завершённые квесты 22 и 23 ноября; сегодня, 24-го, ещё нет.
    for (const date of ["2026-11-22", "2026-11-23", "2026-11-20"]) {
      await db.insert(sessions).values({ studentUserId: student.id, type: "daily_quest", status: "completed", questLocalDate: date });
    }

    const text = await press(fake, PROGRESS_OPEN);
    expect(text).toContain("Доступно слов: 10");
    expect(text).toContain("Изучено (есть хотя бы один ответ): 2");
    expect(text).toContain("Сложные: 3");
    expect(text).toContain("Освоено: 1");
    expect(text).toContain("Завершено подборок: 1 из 2");
    expect(text).toContain("Серия дней с завершённой практикой: 2.");
    expect(text).toContain("Сегодняшняя практика ещё не пройдена.");
  });

  it("квест пройден сегодня: серия растёт", async () => {
    const { fake, student } = await setup([10]);
    await press(fake, DAILY_START);
    for (let guard = 0; guard < 40 && (await currentStep(db, student.id)); guard++) await answerCurrent(fake, db, STUDENT, true);
    const text = await press(fake, PROGRESS_OPEN);
    expect(text).toContain("Серия дней с завершённой практикой: 1.");
    expect(text).toContain("Сегодняшняя практика пройдена.");
    expect(text).toContain("Изучено (есть хотя бы один ответ): 10");
    expect(await db.select().from(attempts).innerJoin(questions, eq(questions.id, attempts.questionId))).toHaveLength(10);
  });
});

describe("«Настройки»", () => {
  const settingsOf = async () => (await db.select().from(users).where(eq(users.telegramId, STUDENT)))[0]!;

  it("по умолчанию: включены, 19:00, пояс не выбран", async () => {
    const { fake } = await setup([1], null);
    const text = await press(fake, SETTINGS_OPEN);
    expect(text).toContain("Напоминания о ежедневной практике: включены");
    expect(text).toContain("Время напоминания: 19:00");
    expect(text).toContain("Часовой пояс: не выбран — напоминания не приходят");
    expect(buttonTexts(fake)).toEqual(["Выключить напоминания", "Время: 19:00", "Часовой пояс", "В меню"]);
  });

  it("выключение и включение напоминаний", async () => {
    const { fake } = await setup([1]);
    await press(fake, SETTINGS_OPEN);
    expect(await press(fake, remindersToggle(false))).toContain("Напоминания о ежедневной практике: выключены");
    expect((await settingsOf()).remindersEnabled).toBe(false);
    expect(buttonTexts(fake)[0]).toBe("Включить напоминания");
    await press(fake, remindersToggle(true));
    expect((await settingsOf()).remindersEnabled).toBe(true);
  });

  it("время напоминания: список часов с отметкой текущего, выбор сохраняется", async () => {
    const { fake } = await setup([1]);
    await press(fake, REMINDER_TIME_LIST);
    expect(buttonTexts(fake)).toContain("✓ 19:00");
    expect(buttonTexts(fake)).toContain("07:00");
    expect(await press(fake, reminderTimeButton(8 * 60))).toContain("Время напоминания: 08:00");
    expect((await settingsOf()).reminderTime).toBe("08:00:00");
    await press(fake, reminderTimeButton(24 * 60));
    expect((await settingsOf()).reminderTime).toBe("08:00:00");
  });

  it("часовой пояс: вкладки, смещение UTC на кнопках, выбор сохраняется; неизвестный пояс отклоняется", async () => {
    const { fake } = await setup([1], null);
    const text = await press(fake, timezoneList(0));
    expect(text).toContain("Сейчас пояс не выбран.");
    expect(buttonTexts(fake)).toEqual(expect.arrayContaining(["• Россия", "Другие страны", "Смещение от UTC", "Москва (UTC+3)", "Владивосток (UTC+10)"]));
    await press(fake, timezoneList(2));
    expect(buttonTexts(fake)).toEqual(expect.arrayContaining(["UTC−12", "UTC", "UTC+14"]));

    expect(await press(fake, timezoneButton("Asia/Yekaterinburg"))).toContain("Часовой пояс: Екатеринбург (UTC+5)");
    expect((await settingsOf()).timezone).toBe("Asia/Yekaterinburg");
    await press(fake, timezoneButton("Etc/GMT-4"));
    expect((await settingsOf()).timezone).toBe("Etc/GMT-4");
    await press(fake, timezoneButton("Mars/Olympus"));
    expect((await settingsOf()).timezone).toBe("Etc/GMT-4");
    expect(fake.calls.filter((call) => call.method === "answerCallbackQuery").at(-1)?.payload.text).toBe(
      "Этот часовой пояс не распознан. Выберите другой.",
    );
  });

  it("пока пояс не выбран, меню при каждом входе предлагает его выбрать", async () => {
    const { fake } = await setup([1], null);
    await fake.bot.handleUpdate(textUpdate(STUDENT, "/start"));
    expect(sentTexts(fake.calls).at(-1)).toContain("Часовой пояс не выбран");
    expect(lastButtons(fake.calls).map((button) => button.callback_data)).toContain(timezoneList(0));
    await press(fake, timezoneButton("Europe/Moscow"));
    await fake.bot.handleUpdate(textUpdate(STUDENT, "/start"));
    expect(sentTexts(fake.calls).at(-1)).not.toContain("Часовой пояс не выбран");
  });

  it("после подтверждения связи уведомление предлагает выбрать пояс, его кнопка открывает список", async () => {
    const { fake, student } = await setup([1], null);
    await enqueueNotification(db, { recipientUserId: student.id, reason: "link_confirmed", dedupeKey: "link_confirmed:test" });
    await db.delete(notifications).where(eq(notifications.reason, "new_collection"));
    await deliverDueNotifications(db, fake.bot.api, { sleep: async () => {} });
    expect(sentTexts(fake.calls).at(-1)).toContain("Выберите часовой пояс");
    const button = lastButtons(fake.calls)[0]!;
    expect(button).toEqual({ text: "Выбрать часовой пояс", callback_data: timezoneList(0) });
    expect(await press(fake, button.callback_data)).toContain("Выберите часовой пояс. По нему бот определяет ваш день");
  });
});

// Условие готовности этапа 3 и правила серии: всё через настоящую обработку бота на настоящем PostgreSQL.
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resumeSession, startTest } from "../../src/bot/callback-data.js";
import { attempts, questions, sessions, studentWords } from "../../src/db/schema.js";
import { checkAnswer } from "../../src/domain/learning/index.js";
import { createLearningService } from "../../src/learning/service.js";
import { listVisibleCards } from "../../src/learning/vocabulary.js";
import { openTestDb, resetDb } from "../helpers/db.js";
import { callbackUpdate, createFakeBot, lastButtons, sentTexts, textUpdate } from "../helpers/fake-telegram.js";
import {
  answer,
  answerButtons,
  card,
  collectionStatus,
  connectStudent,
  issue,
  questionOf,
  sessionOf,
  startThroughMenu,
  withRestart,
  words,
  wordByPair,
} from "../helpers/learning.js";

const { db, close } = openTestDb();
afterAll(close);
beforeEach(() => resetDb(db));

const STUDENT = 71001;

const attemptRows = () =>
  db
    .select({ attempt: attempts, question: questions })
    .from(attempts)
    .innerJoin(questions, eq(questions.id, attempts.questionId))
    .orderBy(asc(attempts.id));

describe("условие готовности этапа 3", () => {
  it("ученик проходит подборку, прерывает, продолжает после перезапуска и получает точные результаты обеих попыток", async () => {
    const { student, link } = await connectStudent(db, STUDENT);
    const collectionId = await issue(db, link.id, "Подборка", words(7));
    const first = createFakeBot(db);

    await first.bot.handleUpdate(textUpdate(STUDENT, "/start"));
    expect(lastButtons(first.calls).map((button) => button.text)).toEqual(
      expect.arrayContaining(["Все слова", "Подборки", "Сложные слова", "Ежедневная практика", "Экзамен", "Мой прогресс", "Настройки"]),
    );
    await startThroughMenu(first, STUDENT, collectionId);
    expect(sentTexts(first.calls).at(-1)).toContain("Вопрос 1 из 7");

    // Первая серия: верно, ошибка, верно. Затем перерыв.
    await answer(first, db, STUDENT, true);
    const wrongFirst = await answer(first, db, STUDENT, false);
    await answer(first, db, STUDENT, true);
    const questionBefore = answerButtons(first.calls);

    await withRestart(async (fake, restartedDb) => {
      await fake.bot.handleUpdate(textUpdate(STUDENT, "/start"));
      const proceed = lastButtons(fake.calls).find((button) => button.text.startsWith("Продолжить"))!;
      expect(proceed.callback_data).toBe(resumeSession((await db.select().from(sessions))[0]!.id));
      await fake.bot.handleUpdate(callbackUpdate(STUDENT, proceed.callback_data));

      // Тот же вопрос с теми же вариантами, второй не создан.
      expect(answerButtons(fake.calls)).toEqual(questionBefore);
      expect(await restartedDb.select().from(questions)).toHaveLength(4);
      expect(await restartedDb.select().from(attempts)).toHaveLength(3);

      await answer(fake, restartedDb, STUDENT, false);
      await answer(fake, restartedDb, STUDENT, true);
    });

    // Серия из 5 окончена: повторы ошибок в порядке ошибок, в том же направлении и с теми же вариантами.
    const second = createFakeBot(db);
    const sessionId = (await db.select().from(sessions))[0]!.id;
    await second.bot.handleUpdate(callbackUpdate(STUDENT, resumeSession(sessionId)));
    expect(sentTexts(second.calls).at(-1)).toContain("Повтор ошибки");
    const firstRepeat = answerButtons(second.calls);
    const original = await questionOf(db, firstRepeat);
    const wrongButtonData = wrongFirst.callback_data.split(":");
    expect(original.question.id).toBe(Number(wrongButtonData[1]));
    expect(firstRepeat.every((button) => button.callback_data.split(":")[2] === "2")).toBe(true);
    expect(original.question.status).toBe("open");
    await answer(second, db, STUDENT, true);

    await withRestart(async (fake, restartedDb) => {
      await fake.bot.handleUpdate(callbackUpdate(STUDENT, resumeSession(sessionId)));
      expect(sentTexts(fake.calls).at(-1)).toContain("Повтор ошибки");
      await answer(fake, restartedDb, STUDENT, false);
      expect(sentTexts(fake.calls).at(-2)).toContain("Слово попало в «Сложные слова»");
      // Вторая серия: два оставшихся слова.
      expect(sentTexts(fake.calls).at(-1)).toContain("Вопрос 6 из 7");
      await answer(fake, restartedDb, STUDENT, true);
      await answer(fake, restartedDb, STUDENT, true);
      const summary = sentTexts(fake.calls).at(-1)!;
      expect(summary).toContain("Тест завершён: Подборка");
      expect(summary).toContain("С первой попытки: 5 из 7");
      expect(summary).toContain("После повтора: 6 из 7");
      expect(summary).toContain("Стали сложными:");
      expect(summary.match(/^• /gm)).toHaveLength(1);
    });

    // В базе точные результаты по каждой попытке.
    const rows = await attemptRows();
    expect(rows.map((row) => [row.attempt.attemptNumber, row.attempt.isCorrect])).toEqual([
      [1, true],
      [1, false],
      [1, true],
      [1, false],
      [1, true],
      [2, true],
      [2, false],
      [1, true],
      [1, true],
    ]);
    expect(rows.every((row) => row.attempt.studentLinkId === link.id)).toBe(true);
    const session = await sessionOf(db, sessionId);
    expect(session).toMatchObject({ status: "completed", studentLinkId: link.id, currentStep: 7 });
    expect(session.finishedAt).toBeInstanceOf(Date);
    expect(await collectionStatus(db, collectionId)).toBe("completed");
    expect((await db.select().from(studentWords).where(eq(studentWords.status, "hard")))).toHaveLength(1);

    // Итог можно прочитать и позже из сохранённых данных.
    const result = await createLearningService(db).getSessionResult({ userId: student.id, sessionId });
    expect(result).toMatchObject({ answeredCount: 7, firstAttemptCorrect: 5, afterRepeatCorrect: 6 });
  });
});

describe("обратная связь дословно по сценарию", () => {
  it("«Верно» и пара; «Вы выбрали …; верно …», пример показан после ответа", async () => {
    const { link } = await connectStudent(db, STUDENT);
    const collectionId = await issue(db, link.id, "Подборка", [
      card("breakfast", "завтрак", { example: "I have breakfast." }),
      card("lunch", "обед", { example: "I have lunch." }),
    ]);
    const fake = createFakeBot(db);
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, startTest(collectionId)));

    const q1 = await questionOf(db, answerButtons(fake.calls));
    await answer(fake, db, STUDENT, true);
    const correctFeedback = fake.calls.filter((call) => call.method === "editMessageText").at(-1)!.payload;
    expect(correctFeedback.text).toBe(`Верно: ${q1.version.english} — ${q1.version.primaryTranslation}\n\n${q1.version.example}`);
    // Кнопок под ответом больше нет.
    expect(correctFeedback.reply_markup).toBeUndefined();

    const q2 = await questionOf(db, answerButtons(fake.calls));
    const wrong = await answer(fake, db, STUDENT, false);
    expect(fake.calls.filter((call) => call.method === "editMessageText").at(-1)!.payload.text).toBe(
      `Вы выбрали ${wrong.text}; верно ${q2.version.english} — ${q2.version.primaryTranslation}\n\n${q2.version.example}`,
    );
  });
});

describe("серия и повторы", () => {
  it("вопрос создаётся до отправки: кнопка содержит только короткие данные и укладывается в 64 байта", async () => {
    const { link } = await connectStudent(db, STUDENT);
    const collectionId = await issue(db, link.id, "Подборка", words(4));
    const fake = createFakeBot(db);
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, startTest(collectionId)));
    const buttons = answerButtons(fake.calls);
    expect(buttons).toHaveLength(4);
    const { question } = await questionOf(db, buttons);
    expect(question.options).toHaveLength(4);
    expect(question.correctOptionIndex).not.toBeNull();
    for (const button of lastButtons(fake.calls)) {
      expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(64);
      expect(button.callback_data).not.toContain(button.text);
    }
  });

  it("повтор идёт только после пятого вопроса серии, той же строкой questions и теми же вариантами", async () => {
    const { link } = await connectStudent(db, STUDENT);
    const collectionId = await issue(db, link.id, "Подборка", words(6));
    const fake = createFakeBot(db);
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, startTest(collectionId)));

    const wrong = answerButtons(fake.calls);
    const asked = await questionOf(db, wrong);
    expect(asked.question.status).toBe("open");
    await answer(fake, db, STUDENT, false);
    const statusOf = async (id: number) => (await db.select().from(questions).where(eq(questions.id, id)))[0]?.status;
    expect(await statusOf(asked.question.id)).toBe("awaiting_repeat");
    const nextAsked = await questionOf(db, answerButtons(fake.calls));
    await answer(fake, db, STUDENT, true);
    expect(await statusOf(nextAsked.question.id)).toBe("closed");
    for (let i = 0; i < 2; i++) {
      expect(sentTexts(fake.calls).at(-1)).not.toContain("Повтор ошибки");
      await answer(fake, db, STUDENT, true);
    }
    expect(sentTexts(fake.calls).at(-1)).toContain("Вопрос 5 из 6");
    await answer(fake, db, STUDENT, true);

    expect(sentTexts(fake.calls).at(-1)).toContain("Повтор ошибки");
    const repeat = answerButtons(fake.calls);
    const repeated = await questionOf(db, repeat);
    expect(repeated.question.id).toBe(asked.question.id);
    expect(repeated.question.direction).toBe(asked.question.direction);
    expect(repeat.map((button) => button.text)).toEqual(wrong.map((button) => button.text));
    expect(await db.select().from(questions)).toHaveLength(5);
    await answer(fake, db, STUDENT, true);
    expect(await statusOf(asked.question.id)).toBe("closed");
  });

  it("верный повтор не считается верным с первой попытки и не увеличивает серию; вторая ошибка делает слово сложным", async () => {
    const { student, link } = await connectStudent(db, STUDENT);
    const collectionId = await issue(db, link.id, "Подборка", [card("alpha", "альфа"), card("beta", "бета")]);
    const fake = createFakeBot(db);

    // Занятие 1: alpha с ошибкой и верным повтором, beta верно.
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, startTest(collectionId)));
    const first = await questionOf(db, answerButtons(fake.calls));
    await answer(fake, db, STUDENT, false);
    await answer(fake, db, STUDENT, true);
    await answer(fake, db, STUDENT, true);
    const summary = sentTexts(fake.calls).at(-1)!;
    expect(summary).toContain("С первой попытки: 1 из 2");
    expect(summary).toContain("После повтора: 2 из 2");
    expect(summary).toContain("Новых сложных слов нет.");
    const word = (await db.select().from(studentWords).where(eq(studentWords.id, first.question.studentWordId)))[0]!;
    expect(word).toMatchObject({ status: "learning", correctStreak: 0 });

    // Занятие 2: то же слово дважды неверно.
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, startTest(collectionId)));
    const targetId = word.id;
    const order: boolean[] = [];
    for (let guard = 0; guard < 6 && answerButtons(fake.calls).length > 0 && (await sessionsOpen()); guard++) {
      const { question } = await questionOf(db, answerButtons(fake.calls));
      const isTarget = question.studentWordId === targetId;
      order.push(isTarget);
      await answer(fake, db, STUDENT, !isTarget);
    }
    const hard = (await db.select().from(studentWords).where(eq(studentWords.id, targetId)))[0]!;
    expect(hard).toMatchObject({ status: "hard", correctStreak: 0 });
    expect(hard.lastCountedSessionId).toBe((await db.select().from(sessions).orderBy(asc(sessions.id)))[1]!.id);
    expect(hard.hardSince).toBeInstanceOf(Date);
    const last = sentTexts(fake.calls).at(-1)!;
    expect(last).toContain("Стали сложными:");
    const [english, translation] = [hard.normalizedEnglish, hard.normalizedTranslation];
    expect(last).toContain(`${english} — ${translation}`);
    expect(await wordByPair(db, student.id, english, translation)).toMatchObject({ id: targetId });
  });

  it("сложное слово: верно с первой попытки в новом занятии +1 к серии, в том же занятии второго засчитанного нет", async () => {
    const { student, link } = await connectStudent(db, STUDENT);
    const collectionId = await issue(db, link.id, "Подборка", [card("alpha", "альфа"), card("beta", "бета")]);
    const alpha = await wordByPair(db, student.id, "alpha", "альфа");
    await db.update(studentWords).set({ status: "hard", hardSince: new Date() }).where(eq(studentWords.id, alpha.id));

    const fake = createFakeBot(db);
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, startTest(collectionId)));
    await answer(fake, db, STUDENT, true);
    await answer(fake, db, STUDENT, true);
    expect(await wordByPair(db, student.id, "alpha", "альфа")).toMatchObject({ status: "hard", correctStreak: 1 });

    // Ошибка обнуляет серию, верный повтор её не поднимает.
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, startTest(collectionId)));
    for (let guard = 0; guard < 5 && (await sessionsOpen()); guard++) {
      const { question } = await questionOf(db, answerButtons(fake.calls));
      const isAlpha = question.studentWordId === alpha.id;
      const isRepeat = sentTexts(fake.calls).at(-1)!.includes("Повтор ошибки");
      await answer(fake, db, STUDENT, !isAlpha || isRepeat);
    }
    expect(await wordByPair(db, student.id, "alpha", "альфа")).toMatchObject({ status: "hard", correctStreak: 0 });
  });

  it("варианты: ровно один верный для каждого вопроса, допустимые ответы слова среди неверных не встречаются", async () => {
    const { student, link } = await connectStudent(db, STUDENT);
    const collectionId = await issue(db, link.id, "Смесь", [
      card("bank", "банк"),
      card("bank", "берег"),
      card("fast", "быстрый", { acceptedRuEn: ["quick"], acceptedEnRu: ["скорый"] }),
      card("quick", "скорый"),
      card("lunch", "обед"),
      card("dinner", "ужин"),
    ]);
    const fake = createFakeBot(db);
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, startTest(collectionId)));
    for (let guard = 0; guard < 6 && (await sessionsOpen()); guard++) {
      const { question, version } = await questionOf(db, answerButtons(fake.calls));
      const cards = await listVisibleCards(db, student.id, { studentWordId: question.studentWordId });
      const correct = question.options!.filter(
        (option) => checkAnswer([version, ...cards.map((item) => item.version)], question.direction, option.text).isCorrect,
      );
      expect(correct).toHaveLength(1);
      if (version.english === "bank" && question.direction === "en_ru") {
        const other = version.primaryTranslation === "банк" ? "берег" : "банк";
        expect(question.options!.map((option) => option.text)).not.toContain(other);
      }
      await answer(fake, db, STUDENT, true);
    }
  });
});

async function sessionsOpen() {
  const rows = await db.select().from(sessions).where(eq(sessions.status, "current"));
  return rows.length > 0;
}

describe("новое занятие после завершённого", () => {
  it("завершённое занятие не продолжается: новый старт создаёт новое", async () => {
    const { link } = await connectStudent(db, STUDENT);
    const collectionId = await issue(db, link.id, "Подборка", words(2));
    const fake = createFakeBot(db);
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, startTest(collectionId)));
    await answer(fake, db, STUDENT, true);
    await answer(fake, db, STUDENT, true);
    await fake.bot.handleUpdate(textUpdate(STUDENT, "/start"));
    expect(lastButtons(fake.calls).some((button) => button.text.startsWith("Продолжить"))).toBe(false);
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, startTest(collectionId)));
    expect(await db.select().from(sessions)).toHaveLength(2);
  });

});

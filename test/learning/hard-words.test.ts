// «Сложные слова»: список, практика по всему списку и по выбранным словам, правило «5 из 5», возврат освоенного слова.
// Главное условие этапа 5: повторение не переписывает исходный результат занятия.
import { asc, eq, inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  HARD_WORDS_PAGE_PATTERN,
  START_HARD_ALL,
  START_HARD_SELECTED_PATTERN,
  hardWordsPage,
  startTest,
} from "../../src/bot/callback-data.js";
import { attempts, questions, sessions, studentWords } from "../../src/db/schema.js";
import { createLearningService } from "../../src/learning/service.js";
import { openTestDb, resetDb } from "../helpers/db.js";
import { callbackUpdate, createFakeBot, lastButtons, sentTexts, textUpdate } from "../helpers/fake-telegram.js";
import {
  answerCurrent,
  card,
  connectStudent,
  currentStep,
  deleteCard,
  issue,
  wordByPair,
  type FakeBot,
} from "../helpers/learning.js";

const { db, close } = openTestDb();
afterAll(close);
beforeEach(() => resetDb(db));

const STUDENT = 75001;
const CARDS = [card("alpha", "альфа"), card("beta", "бета"), card("gamma", "гамма"), card("delta", "дельта"), card("omega", "омега")];

async function setup() {
  const { student, link } = await connectStudent(db, STUDENT);
  const collectionId = await issue(db, link.id, "Подборка", CARDS);
  return { student, link, collectionId, fake: createFakeBot(db) };
}

async function makeHard(studentUserId: number, english: string, translation: string, correctStreak = 0) {
  const word = await wordByPair(db, studentUserId, english, translation);
  await db.update(studentWords).set({ status: "hard", hardSince: new Date(), correctStreak }).where(eq(studentWords.id, word.id));
  return word.id;
}

/** Проходит текущее занятие до конца: target отвечает по правилу, остальные верно. */
async function finishSession(fake: FakeBot, studentUserId: number, targetWordId: number | null, targetCorrect: (isRepeat: boolean) => boolean) {
  for (let guard = 0; guard < 30; guard++) {
    const step = await currentStep(db, studentUserId);
    if (!step) return;
    const isTarget = step.question.studentWordId === targetWordId;
    await answerCurrent(fake, db, STUDENT, isTarget ? targetCorrect(step.isRepeat) : true);
  }
  throw new Error("Занятие не закончилось");
}

const openHardList = async (fake: FakeBot) => {
  await fake.bot.handleUpdate(textUpdate(STUDENT, "/start"));
  const button = lastButtons(fake.calls).find((item) => item.text === "Сложные слова")!;
  expect(button.callback_data).toBe(hardWordsPage(0));
  await fake.bot.handleUpdate(callbackUpdate(STUDENT, button.callback_data));
  return sentTexts(fake.calls).at(-1)!;
};

describe("список «Сложные слова»", () => {
  it("пустой список объясняет, как слово туда попадает", async () => {
    const { fake } = await setup();
    expect(await openHardList(fake)).toContain("Сложных слов нет");
    expect(lastButtons(fake.calls).map((button) => button.text)).toEqual(["В меню"]);
  });

  it("слово, дважды неверное в серии теста, появляется с подборкой и серией; освоенное и удалённое — нет", async () => {
    const { fake, student, collectionId } = await setup();
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, startTest(collectionId)));
    const first = (await currentStep(db, student.id))!;
    await finishSession(fake, student.id, first.question.studentWordId, () => false);
    const pair = `${first.version.english} — ${first.version.primaryTranslation}`;

    const text = await openHardList(fake);
    expect(text).toContain("Сложные слова: 1.");
    expect(text).toContain(`1. ${pair} (Подборка) · серия 0 из 5`);
    expect(lastButtons(fake.calls).map((button) => button.text)).toEqual(
      expect.arrayContaining(["Повторить все (1)", `1. ${first.version.english}`, "В меню"]),
    );

    const other = CARDS.find((item) => item.english !== first.version.english)!;
    const otherId = await makeHard(student.id, other.english, other.translation);
    await db.update(studentWords).set({ status: "mastered", masteredAt: new Date() }).where(eq(studentWords.id, otherId));
    expect(await openHardList(fake)).toContain("Сложные слова: 1.");

    await deleteCard(db, collectionId, first.version.english);
    expect(await openHardList(fake)).toContain("Сложных слов нет");
  });
});

describe("практика сложных слов", () => {
  it("по всему списку: кнопки и ввод, серия растёт один раз за занятие, итог показывает серию", async () => {
    const { fake, student } = await setup();
    const ids = [await makeHard(student.id, "alpha", "альфа"), await makeHard(student.id, "beta", "бета")];
    await openHardList(fake);
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, START_HARD_ALL));
    const [session] = await db.select().from(sessions);
    expect(session).toMatchObject({ type: "hard_words", studentCollectionId: null, status: "current" });
    expect(session!.learningState!.plan.map((item) => item.studentWordId).sort()).toEqual([...ids].sort());

    await answerCurrent(fake, db, STUDENT, true);
    expect(sentTexts(fake.calls).at(-2)).toContain("Серия «5 из 5»: 1 из 5.");
    await answerCurrent(fake, db, STUDENT, true);
    const summary = sentTexts(fake.calls).at(-1)!;
    expect(summary).toContain("Повторение сложных слов завершено");
    expect(summary).toContain("С первой попытки: 2 из 2");
    expect(summary).toContain("• alpha — альфа: 1 из 5");
    expect(summary).toContain("• beta — бета: 1 из 5");
    expect(lastButtons(fake.calls).map((button) => button.text)).toEqual(["К сложным словам", "В меню"]);
    for (const id of ids) {
      expect((await db.select().from(studentWords).where(eq(studentWords.id, id)))[0]).toMatchObject({ status: "hard", correctStreak: 1 });
    }
  });

  it("смешанный план: в длинной практике есть и вопросы кнопками, и ввод", async () => {
    const { fake, student } = await setup();
    for (const item of CARDS) await makeHard(student.id, item.english, item.translation);
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, START_HARD_ALL));
    await finishSession(fake, student.id, null, () => true);
    const formats = new Set((await db.select().from(questions)).map((row) => row.format));
    expect(formats).toEqual(new Set(["choice", "typed"]));
  });

  it("по выбранным словам: отметки в кнопках, повторное нажатие продолжает то же занятие, другой набор закрывает прежнее", async () => {
    const { fake, student } = await setup();
    for (const item of CARDS) await makeHard(student.id, item.english, item.translation);
    await openHardList(fake);
    const toggle = (label: string) => lastButtons(fake.calls).find((button) => button.text.endsWith(label))!;
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, toggle(". beta").callback_data));
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, toggle(". delta").callback_data));
    const labels = lastButtons(fake.calls).map((button) => button.text);
    expect(labels).toContain("✓ 2. beta");
    expect(labels).toContain("✓ 3. delta");
    expect(labels).toContain("1. alpha");
    // Снять отметку тем же нажатием.
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, toggle(". alpha").callback_data));
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, toggle(". alpha").callback_data));
    const startSelected = lastButtons(fake.calls).find((button) => button.text === "Повторить выбранные (2)")!;
    expect(START_HARD_SELECTED_PATTERN.test(startSelected.callback_data)).toBe(true);
    for (const button of lastButtons(fake.calls)) expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(64);

    await fake.bot.handleUpdate(callbackUpdate(STUDENT, startSelected.callback_data));
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, startSelected.callback_data));
    const rows = await db.select().from(sessions);
    expect(rows).toHaveLength(1);
    const planned = rows[0]!.learningState!.plan.map((item) => item.studentWordId);
    const expected = [
      (await wordByPair(db, student.id, "beta", "бета")).id,
      (await wordByPair(db, student.id, "delta", "дельта")).id,
    ];
    expect(planned.sort()).toEqual(expected.sort());

    // Открытое повторение видно в списке; другой набор закрывает его как незавершённое.
    await openHardList(fake);
    const proceed = lastButtons(fake.calls).find((button) => button.text === "Продолжить повторение");
    expect(proceed).toBeDefined();
    // Последнее сообщение — список, а не вопрос: ученик возвращается к вопросу кнопкой «Продолжить повторение».
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, proceed!.callback_data));
    await answerCurrent(fake, db, STUDENT, true);
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, START_HARD_ALL));
    const after = await db.select().from(sessions).orderBy(asc(sessions.id));
    expect(after.map((row) => row.status)).toEqual(["incomplete", "current"]);
    expect(after[0]!.finishedAt).toBeInstanceOf(Date);
    expect(await db.select().from(attempts)).toHaveLength(1);
  });

  it("выбранное слово успели освоить: занятие не создаётся, список показан заново", async () => {
    const { fake, student } = await setup();
    const id = await makeHard(student.id, "alpha", "альфа");
    await openHardList(fake);
    const toggle = lastButtons(fake.calls).find((button) => HARD_WORDS_PAGE_PATTERN.test(button.callback_data) && button.text.endsWith("alpha"))!;
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, toggle.callback_data));
    const startSelected = lastButtons(fake.calls).find((button) => button.text === "Повторить выбранные (1)")!;
    await db.update(studentWords).set({ status: "mastered" }).where(eq(studentWords.id, id));
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, startSelected.callback_data));
    expect(await db.select().from(sessions)).toHaveLength(0);
    expect(fake.calls.filter((call) => call.method === "answerCallbackQuery").at(-1)?.payload.text).toContain("изменился");
    expect(sentTexts(fake.calls).at(-1)).toContain("Сложных слов нет");
  });

  it("чужие и несуществующие ID сервис отбрасывает", async () => {
    const { student } = await setup();
    await makeHard(student.id, "alpha", "альфа");
    const other = await connectStudent(db, STUDENT + 1);
    await issue(db, other.link.id, "Чужая", [card("zeta", "дзета")]);
    const foreign = await makeHard(other.student.id, "zeta", "дзета");
    const learning = createLearningService(db);
    expect((await learning.startHardPractice({ userId: student.id, wordIds: [foreign, 999999] })).kind).toBe("no_words");
    expect(await db.select().from(sessions)).toHaveLength(0);
  });
});

describe("правило «5 из 5» и возврат освоенного слова", () => {
  it("пять верных ответов с первой попытки в разных занятиях: освоено и ушло из списка; ошибка обнуляет серию, верный повтор не растит", async () => {
    const { fake, student } = await setup();
    const id = await makeHard(student.id, "alpha", "альфа");
    const practiceOnce = async (correct: (isRepeat: boolean) => boolean) => {
      await fake.bot.handleUpdate(callbackUpdate(STUDENT, START_HARD_ALL));
      await finishSession(fake, student.id, id, correct);
    };
    const word = async () => (await db.select().from(studentWords).where(eq(studentWords.id, id)))[0]!;

    await practiceOnce(() => true);
    await practiceOnce(() => true);
    expect(await word()).toMatchObject({ status: "hard", correctStreak: 2 });
    // Ошибка с первой попытки обнуляет серию, верный повтор её не поднимает.
    await practiceOnce((isRepeat) => isRepeat);
    expect(sentTexts(fake.calls).join("\n")).toContain("Серия «5 из 5» начинается заново.");
    expect(await word()).toMatchObject({ status: "hard", correctStreak: 0 });

    for (let i = 1; i <= 4; i++) {
      await practiceOnce(() => true);
      expect(await word()).toMatchObject({ status: "hard", correctStreak: i });
    }
    await practiceOnce(() => true);
    expect(await word()).toMatchObject({ status: "mastered", correctStreak: 5 });
    expect(sentTexts(fake.calls).at(-2)).toContain("Слово освоено");
    expect(sentTexts(fake.calls).at(-1)).toContain("Освоены и ушли из «Сложных слов»:\n• alpha — альфа");
    const mastered = await db.select().from(attempts).where(eq(attempts.becameMastered, true));
    expect(mastered).toHaveLength(1);
    expect(await openHardList(fake)).toContain("Сложных слов нет");
  });

  it("за одно занятие засчитывается не больше одного ответа: тест после практики в том же занятии невозможен, в новом — +1", async () => {
    const { fake, student, collectionId } = await setup();
    const id = await makeHard(student.id, "alpha", "альфа");
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, START_HARD_ALL));
    await finishSession(fake, student.id, id, () => true);
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, startTest(collectionId)));
    await finishSession(fake, student.id, id, () => true);
    expect((await db.select().from(studentWords).where(eq(studentWords.id, id)))[0]).toMatchObject({ correctStreak: 2 });
  });

  it("ошибка, верный повтор, ошибка в следующем занятии возвращают освоенное слово в «Сложные»", async () => {
    const { fake, student, collectionId } = await setup();
    const id = await makeHard(student.id, "alpha", "альфа");
    await db.update(studentWords).set({ status: "mastered", correctStreak: 5, masteredAt: new Date() }).where(eq(studentWords.id, id));

    await fake.bot.handleUpdate(callbackUpdate(STUDENT, startTest(collectionId)));
    await finishSession(fake, student.id, id, (isRepeat) => isRepeat);
    expect((await db.select().from(studentWords).where(eq(studentWords.id, id)))[0]).toMatchObject({
      status: "mastered",
      consecutiveErrors: 1,
    });

    await fake.bot.handleUpdate(callbackUpdate(STUDENT, startTest(collectionId)));
    await finishSession(fake, student.id, id, () => false);
    expect(sentTexts(fake.calls).join("\n")).toContain("Слово снова попало в «Сложные слова»");
    expect((await db.select().from(studentWords).where(eq(studentWords.id, id)))[0]).toMatchObject({ status: "hard", correctStreak: 0 });
    expect(await openHardList(fake)).toContain("alpha — альфа");
  });
});

describe("условие готовности этапа 5: повторение не переписывает исходный результат", () => {
  it("попытки, вопросы и итог исходного занятия неизменны после практики с ошибками и освоения", async () => {
    const { fake, student, collectionId } = await setup();
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, startTest(collectionId)));
    const target = (await currentStep(db, student.id))!.question.studentWordId;
    await finishSession(fake, student.id, target, () => false);
    const [original] = await db.select().from(sessions);
    const learning = createLearningService(db);

    const snapshot = async () => {
      const originalQuestions = await db.select().from(questions).where(eq(questions.sessionId, original!.id)).orderBy(asc(questions.id));
      return {
        session: (await db.select().from(sessions).where(eq(sessions.id, original!.id)))[0],
        questions: originalQuestions,
        attempts: await db
          .select()
          .from(attempts)
          .where(inArray(attempts.questionId, originalQuestions.map((row) => row.id)))
          .orderBy(asc(attempts.id)),
        // stillHard — текущая серия слов, а не история: её из сравнения исключаем.
        result: await learning
          .getSessionResult({ userId: student.id, sessionId: original!.id })
          .then((result) => result && { ...result, stillHard: undefined }),
      };
    };
    const before = await snapshot();
    expect(before.result).toMatchObject({ firstAttemptCorrect: 4, afterRepeatCorrect: 4, becameHard: [expect.any(Object)] });

    // Практика: ошибка с верным повтором, затем пять верных занятий до освоения.
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, START_HARD_ALL));
    await finishSession(fake, student.id, target, (isRepeat) => isRepeat);
    for (let i = 0; i < 5; i++) {
      await fake.bot.handleUpdate(callbackUpdate(STUDENT, START_HARD_ALL));
      await finishSession(fake, student.id, target, () => true);
    }
    expect((await db.select().from(studentWords).where(eq(studentWords.id, target)))[0]!.status).toBe("mastered");

    const after = await snapshot();
    expect(after).toEqual(before);
    // В исходном итоге слово по-прежнему значится ставшим сложным, хотя сейчас освоено.
    expect(after.result!.becameHard).toHaveLength(1);
    expect(after.result!.mastered).toHaveLength(0);
  });
});

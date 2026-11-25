// Старые кнопки, гонки, повтор событий, чужие кнопки, пауза и возврат.
import { and, count, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  ANSWER_PATTERN,
  answerButton,
  collectionCard,
  collectionPage,
  pauseSession,
  resumeSession,
  reminderTimeButton,
  startTest,
  TIMEZONE_PATTERN,
  timezoneButton,
  wordCard,
} from "../../src/bot/callback-data.js";
import { TIMEZONE_PAGES } from "../../src/bot/timezones.js";
import { attempts, cardViews, processedUpdates, questions, sessions, studentWords } from "../../src/db/schema.js";
import { lockUser } from "../../src/linking/locks.js";
import { createLearningService } from "../../src/learning/service.js";
import { openTestDb, resetDb } from "../helpers/db.js";
import { callbackUpdate, createFakeBot, lastButtons, sentTexts, textUpdate } from "../helpers/fake-telegram.js";
import {
  answer,
  answerButtons,
  cardByEnglish,
  connectStudent,
  correctButton,
  issue,
  parseAnswer,
  questionOf,
  waitForBlockedQuery,
  withRestart,
  wordByPair,
  words,
  wrongButton,
  type FakeBot,
} from "../helpers/learning.js";
import { makeTeacher } from "../helpers/linking.js";

const { db, close } = openTestDb();
afterAll(close);
beforeEach(() => resetDb(db));

const STUDENT = 72001;
const OTHER = 72002;
const learning = createLearningService(db);
const attemptCount = async () => (await db.select({ value: count() }).from(attempts))[0]?.value;
const currentSession = async () => (await db.select().from(sessions).where(eq(sessions.status, "current")))[0];
const lastCallbackAnswer = (fake: FakeBot) =>
  fake.calls.filter((call) => call.method === "answerCallbackQuery").at(-1)?.payload.text;

async function started(wordCount = 6, telegramId = STUDENT, fake = createFakeBot(db)) {
  const { student, link, teacher } = await connectStudent(db, telegramId);
  const collectionId = await issue(db, link.id, `Подборка ${telegramId}`, words(wordCount));
  await fake.bot.handleUpdate(callbackUpdate(telegramId, startTest(collectionId)));
  return { fake, student, link, teacher, collectionId };
}

describe("старая кнопка", () => {
  it("двойное нажатие: одна попытка, верный шаг, второе показывает записанный результат", async () => {
    const { fake } = await started();
    const buttons = answerButtons(fake.calls);
    const correct = await correctButton(db, buttons);
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, correct.callback_data));
    const nextQuestion = answerButtons(fake.calls);
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, correct.callback_data));

    expect(await attemptCount()).toBe(1);
    expect(lastCallbackAnswer(fake)).toBe("Ответ на этот вопрос уже записан.");
    expect(sentTexts(fake.calls).at(-1)).toContain("Верно:");
    expect(lastButtons(fake.calls).map((button) => button.text)).toContain("Продолжить");
    const session = (await currentSession())!;
    expect(session.learningState!.cursor).toBe(1);
    expect(session.currentStep).toBe(1);

    // «Продолжить» показывает тот же текущий вопрос.
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, resumeSession(session.id)));
    expect(answerButtons(fake.calls)).toEqual(nextQuestion);
    expect(await db.select().from(questions)).toHaveLength(2);
  });

  it("старая кнопка другого варианта не меняет записанный результат", async () => {
    const { fake } = await started();
    const buttons = answerButtons(fake.calls);
    const wrong = await wrongButton(db, buttons);
    const correct = await correctButton(db, buttons);
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, wrong.callback_data));
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, correct.callback_data));
    expect(await attemptCount()).toBe(1);
    const [attempt] = await db.select().from(attempts);
    expect(attempt).toMatchObject({ isCorrect: false, answerText: wrong.text });
    expect(sentTexts(fake.calls).at(-1)).toContain(`Вы выбрали ${wrong.text}`);
  });

  it("кнопка первой попытки после начала повтора не создаёт попытку и не закрывает вопрос", async () => {
    const { fake } = await started(5);
    const firstButtons = answerButtons(fake.calls);
    const correctOld = await correctButton(db, firstButtons);
    await answer(fake, db, STUDENT, false);
    for (let i = 0; i < 4; i++) await answer(fake, db, STUDENT, true);
    expect(sentTexts(fake.calls).at(-1)).toContain("Повтор ошибки");
    const repeatButtons = answerButtons(fake.calls);
    const before = (await currentSession())!;
    const attemptsBefore = await attemptCount();

    await fake.bot.handleUpdate(callbackUpdate(STUDENT, correctOld.callback_data));

    expect(await attemptCount()).toBe(attemptsBefore);
    expect(lastCallbackAnswer(fake)).toBe("Ответ на этот вопрос уже записан.");
    expect(sentTexts(fake.calls).at(-1)).toContain("Вы выбрали");
    const after = (await currentSession())!;
    expect(after.learningState).toEqual(before.learningState);
    const { question } = await questionOf(db, repeatButtons);
    expect((await db.select().from(questions).where(eq(questions.id, question.id)))[0]?.status).toBe("open");

    // Настоящая кнопка повтора по-прежнему работает.
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, (await correctButton(db, repeatButtons)).callback_data));
    const rows = await db.select().from(attempts).where(eq(attempts.questionId, question.id));
    expect(rows.map((row) => [row.attemptNumber, row.isCorrect]).sort()).toEqual([
      [1, false],
      [2, true],
    ]);
  });

  it("кнопка будущей попытки и несуществующий вариант не создают попытку", async () => {
    const { fake } = await started();
    const { questionId } = parseAnswer(answerButtons(fake.calls)[0]!.callback_data);
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, answerButton(questionId, 2, 0)));
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, answerButton(questionId, 3, 0)));
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, answerButton(questionId, 1, 99)));
    expect(await attemptCount()).toBe(0);
    expect((await currentSession())!.learningState!.cursor).toBe(0);
  });

  it("кнопка из вопроса завершённого занятия показывает состояние и предлагает итог", async () => {
    const { fake } = await started(2);
    const button = await answer(fake, db, STUDENT, true);
    await answer(fake, db, STUDENT, true);
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, button.callback_data));
    expect(lastCallbackAnswer(fake)).toBe("Это занятие уже завершено.");
    expect(await attemptCount()).toBe(2);
    const show = lastButtons(fake.calls).find((item) => item.text === "Показать итог")!;
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, show.callback_data));
    expect(sentTexts(fake.calls).at(-1)).toContain("С первой попытки: 2 из 2");
  });

  it("кнопка демо-вопроса этапа 1 из закрытого занятия без состояния: попытки нет, падения нет", async () => {
    const { student, link, collectionId } = await started();
    const asked = (await db.select().from(questions))[0]!;
    const [legacy] = await db
      .insert(sessions)
      .values({ studentUserId: student.id, studentLinkId: link.id, studentCollectionId: collectionId, type: "test", status: "incomplete" })
      .returning();
    const [question] = await db
      .insert(questions)
      .values({
        sessionId: legacy!.id,
        position: 0,
        studentWordId: asked.studentWordId,
        cardVersionId: asked.cardVersionId,
        direction: asked.direction,
        format: "choice",
        options: asked.options,
        correctOptionIndex: asked.correctOptionIndex,
        status: "closed",
      })
      .returning();
    const fake = createFakeBot(db);
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, answerButton(question!.id, 1, 0)));
    expect(await attemptCount()).toBe(0);
    expect(lastCallbackAnswer(fake)).toBe("Это занятие уже завершено.");
    expect(lastButtons(fake.calls).map((button) => button.text)).toEqual(["В меню"]);
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, resumeSession(legacy!.id)));
    expect(lastCallbackAnswer(fake)).toBe("Занятие не найдено.");
  });

  it("подделанные данные кнопки с огромным числом не роняют обработку", async () => {
    const { fake } = await started();
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, "q:999999999999999999999:1:0"));
    expect(lastCallbackAnswer(fake)).toBe("Эта кнопка устарела.");
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, "demo:start"));
    expect(lastCallbackAnswer(fake)).toBe("Эта кнопка устарела.");
    expect(await attemptCount()).toBe(0);
  });
});

describe("перезапуск", () => {
  it("кнопка вопроса, отправленного до перезапуска, принимается новым процессом", async () => {
    const { fake } = await started();
    const buttons = answerButtons(fake.calls);
    await withRestart(async (restarted, restartedDb) => {
      await restarted.bot.handleUpdate(callbackUpdate(STUDENT, (await correctButton(restartedDb, buttons)).callback_data));
      expect(await restartedDb.select().from(attempts)).toHaveLength(1);
      expect(sentTexts(restarted.calls).at(-1)).toContain("Вопрос 2 из 6");
    });
  });
});

describe("повтор события и сбои Telegram", () => {
  it("повторная доставка того же update_id ничего не меняет", async () => {
    const { fake } = await started();
    const update = callbackUpdate(STUDENT, (await correctButton(db, answerButtons(fake.calls))).callback_data);
    await fake.bot.handleUpdate(update);
    const callsAfterFirst = fake.calls.length;
    await fake.bot.handleUpdate(update);
    expect(fake.calls.length).toBe(callsAfterFirst);
    expect(await attemptCount()).toBe(1);
    expect(await db.select().from(processedUpdates).where(eq(processedUpdates.updateId, update.update_id))).toHaveLength(1);
  });

  it("ошибка обработки снимает отметку об update_id, повторная доставка показывает записанный результат", async () => {
    let fail = true;
    const fake = createFakeBot(db, {
      respond: (call) =>
        call.method === "editMessageText" && fail ? { ok: false, error_code: 500, description: "Internal Server Error" } : undefined,
    });
    await started(6, STUDENT, fake);
    const update = callbackUpdate(STUDENT, (await correctButton(db, answerButtons(fake.calls))).callback_data);
    await expect(fake.bot.handleUpdate(update)).rejects.toThrow();
    expect(await db.select().from(processedUpdates).where(eq(processedUpdates.updateId, update.update_id))).toHaveLength(0);
    expect(await attemptCount()).toBe(1);
    fail = false;
    await fake.bot.handleUpdate(update);
    expect(await attemptCount()).toBe(1);
    expect(sentTexts(fake.calls).at(-1)).toContain("Верно:");
  });

  it("ошибка «сообщение не изменено» при двойном нажатии не считается сбоем", async () => {
    let edits = 0;
    const fake = createFakeBot(db, {
      respond: (call) =>
        call.method === "editMessageText" && ++edits > 1
          ? { ok: false, error_code: 400, description: "Bad Request: message is not modified" }
          : undefined,
    });
    await started(6, STUDENT, fake);
    const correct = await correctButton(db, answerButtons(fake.calls));
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, correct.callback_data));
    await expect(fake.bot.handleUpdate(callbackUpdate(STUDENT, correct.callback_data))).resolves.toBeUndefined();
  });

  it("если старое сообщение нельзя изменить, результат уходит новым сообщением", async () => {
    const fake = createFakeBot(db, {
      respond: (call) =>
        call.method === "editMessageText" ? { ok: false, error_code: 400, description: "Bad Request: message can't be edited" } : undefined,
    });
    await started(6, STUDENT, fake);
    await answer(fake, db, STUDENT, true);
    const replies = fake.calls.filter((call) => call.method === "sendMessage").map((call) => call.payload.text);
    expect(replies.at(-2)).toContain("Верно:");
    expect(replies.at(-1)).toContain("Вопрос 2 из 6");
  });

  it("устаревший запрос нажатия не мешает записи ответа", async () => {
    const fake = createFakeBot(db, {
      respond: (call) =>
        call.method === "answerCallbackQuery" ? { ok: false, error_code: 400, description: "Bad Request: query is too old" } : undefined,
    });
    await started(6, STUDENT, fake);
    await answer(fake, db, STUDENT, true);
    expect(await attemptCount()).toBe(1);
    expect(sentTexts(fake.calls).at(-1)).toContain("Вопрос 2 из 6");
  });
});

describe("гонка нажатий", () => {
  it("одновременные нажатия дают одну попытку и один шаг вперёд", async () => {
    const { fake } = await started();
    const correct = await correctButton(db, answerButtons(fake.calls));
    await Promise.all(Array.from({ length: 5 }, () => fake.bot.handleUpdate(callbackUpdate(STUDENT, correct.callback_data))));
    expect(await attemptCount()).toBe(1);
    expect((await currentSession())!.learningState!.cursor).toBe(1);
    expect(await db.select().from(questions)).toHaveLength(2);
  });

  it("одновременный старт не создаёт второе занятие", async () => {
    const { link } = await connectStudent(db, STUDENT);
    const collectionId = await issue(db, link.id, "Подборка", words(4));
    const fake = createFakeBot(db);
    await Promise.all(Array.from({ length: 5 }, () => fake.bot.handleUpdate(callbackUpdate(STUDENT, startTest(collectionId)))));
    expect(await db.select().from(sessions)).toHaveLength(1);
    expect(await db.select().from(questions)).toHaveLength(1);
  });

  it("нажатие ждёт незавершённую транзакцию, держащую блокировку ученика, и получает её результат", async () => {
    const { fake, student } = await started();
    const { questionId, optionIndex } = parseAnswer((await correctButton(db, answerButtons(fake.calls))).callback_data);

    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let locked = () => {};
    const holding = new Promise<void>((resolve) => (locked = resolve));
    const first = db.transaction(async (tx) => {
      await lockUser(tx, student.id);
      await tx.insert(attempts).values({ questionId, attemptNumber: 1, answerText: "обед", isCorrect: false });
      locked();
      await gate;
    });
    await holding;

    const second = learning.answerChoice({ userId: student.id, questionId, attemptNumber: 1, optionIndex });
    await waitForBlockedQuery(db);
    release();
    await first;

    expect(await second).toMatchObject({ kind: "stale", saved: { isCorrect: false, chosen: "обед" } });
    expect(await attemptCount()).toBe(1);
  });

  it("ответ ждёт блокировку ученика: занятие, поставленное на паузу в этот момент, ответа не получает", async () => {
    const { fake, student } = await started();
    const { questionId, optionIndex } = parseAnswer((await correctButton(db, answerButtons(fake.calls))).callback_data);

    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let locked = () => {};
    const holding = new Promise<void>((resolve) => (locked = resolve));
    const first = db.transaction(async (tx) => {
      await lockUser(tx, student.id);
      await tx.update(sessions).set({ status: "paused" }).where(eq(sessions.studentUserId, student.id));
      locked();
      await gate;
    });
    await holding;

    const second = learning.answerChoice({ userId: student.id, questionId, attemptNumber: 1, optionIndex });
    await waitForBlockedQuery(db);
    release();
    await first;

    expect(await second).toMatchObject({ kind: "stale", sessionStatus: "paused" });
    expect(await attemptCount()).toBe(0);
  });

  it("попытка, записанная мимо блокировки ученика, останавливается уникальным ограничением", async () => {
    const { fake, student } = await started();
    const { questionId, optionIndex } = parseAnswer((await correctButton(db, answerButtons(fake.calls))).callback_data);
    const stateBefore = (await currentSession())!.learningState;

    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let written = () => {};
    const inserted = new Promise<void>((resolve) => (written = resolve));
    const first = db.transaction(async (tx) => {
      await tx.insert(attempts).values({ questionId, attemptNumber: 1, answerText: "обед", isCorrect: false });
      written();
      await gate;
    });
    await inserted;

    const second = learning.answerChoice({ userId: student.id, questionId, attemptNumber: 1, optionIndex });
    await waitForBlockedQuery(db);
    release();
    await first;

    expect(await second).toMatchObject({ kind: "stale", saved: { isCorrect: false, chosen: "обед" } });
    expect(await attemptCount()).toBe(1);
    expect((await currentSession())!.learningState).toEqual(stateBefore);
  });
});

describe("чужие кнопки: проверка владельца", () => {
  it("другой ученик не может ответить на чужой вопрос чужой кнопкой", async () => {
    const { fake } = await started();
    await connectStudent(db, OTHER);
    const buttons = answerButtons(fake.calls);
    const correct = await correctButton(db, buttons);
    const state = (await currentSession())!.learningState;
    await fake.bot.handleUpdate(callbackUpdate(OTHER, correct.callback_data));
    expect(await attemptCount()).toBe(0);
    expect(lastCallbackAnswer(fake)).toBe("Этот вопрос уже неактуален.");
    expect((await currentSession())!.learningState).toEqual(state);
    // Чужому ничего не показано, вопрос остаётся открытым для владельца.
    expect(sentTexts(fake.calls).join("\n")).not.toContain("Вы выбрали");
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, correct.callback_data));
    expect(await attemptCount()).toBe(1);
  });

  it("чужой ответ не задевает даже при своём текущем занятии", async () => {
    const { fake } = await started();
    const foreign = await correctButton(db, answerButtons(fake.calls));
    const other = await started(4, OTHER, fake);
    const ownSession = (await db.select().from(sessions).where(eq(sessions.studentUserId, other.student.id)))[0]!;
    await fake.bot.handleUpdate(callbackUpdate(OTHER, foreign.callback_data));
    expect(await attemptCount()).toBe(0);
    expect((await db.select().from(sessions).where(eq(sessions.id, ownSession.id)))[0]?.learningState?.cursor).toBe(0);
  });

  it("чужое занятие нельзя продолжить и поставить на паузу, чужая подборка и карточка не открываются", async () => {
    const { fake, collectionId, student } = await started();
    await connectStudent(db, OTHER);
    const session = (await currentSession())!;
    const card = await cardByEnglish(db, collectionId, "word1");
    const word = await wordByPair(db, student.id, "word1", "слово-word-1");

    await fake.bot.handleUpdate(callbackUpdate(OTHER, resumeSession(session.id)));
    expect(lastCallbackAnswer(fake)).toBe("Занятие не найдено.");
    await fake.bot.handleUpdate(callbackUpdate(OTHER, pauseSession(session.id)));
    expect(lastCallbackAnswer(fake)).toBe("Занятие не найдено.");
    expect((await currentSession())?.id).toBe(session.id);

    await fake.bot.handleUpdate(callbackUpdate(OTHER, startTest(collectionId)));
    expect(lastCallbackAnswer(fake)).toBe("Подборка не найдена.");
    await fake.bot.handleUpdate(callbackUpdate(OTHER, collectionPage(collectionId, 0)));
    expect(lastCallbackAnswer(fake)).toBe("Подборка не найдена.");
    await fake.bot.handleUpdate(callbackUpdate(OTHER, collectionCard(card.card.id, 0)));
    expect(lastCallbackAnswer(fake)).toBe("Этой карточки больше нет.");
    await fake.bot.handleUpdate(callbackUpdate(OTHER, wordCard(word.id, 0)));
    expect(lastCallbackAnswer(fake)).toBe("Этой карточки больше нет.");
    expect(await db.select().from(cardViews)).toHaveLength(0);
    expect(await db.select().from(sessions)).toHaveLength(1);
    expect((await db.select().from(studentWords).where(eq(studentWords.id, word.id)))[0]?.status).toBe("learning");
  });

  it("преподаватель и посторонний не проходят к учебным кнопкам", async () => {
    const { fake } = await started();
    const correct = await correctButton(db, answerButtons(fake.calls));
    await makeTeacher(db, 72100);
    await fake.bot.handleUpdate(callbackUpdate(72100, correct.callback_data));
    expect(sentTexts(fake.calls).at(-1)).toContain("преподавательский");
    await fake.bot.handleUpdate(callbackUpdate(72999, correct.callback_data));
    expect(sentTexts(fake.calls).at(-1)).toContain("попросите у преподавателя");
    expect(await attemptCount()).toBe(0);
  });
});

describe("пауза и возврат", () => {
  async function twoCollections() {
    const { student, link } = await connectStudent(db, STUDENT);
    const a = await issue(db, link.id, "Подборка А", words(5, "a"));
    const b = await issue(db, link.id, "Подборка Б", words(5, "b"));
    return { student, link, a, b, fake: createFakeBot(db) };
  }

  it("новое занятие ставит прежнее на паузу; ответ попадает только в текущее", async () => {
    const { a, b, fake, student } = await twoCollections();
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, startTest(a)));
    const buttonsA = answerButtons(fake.calls);
    const correctA = await correctButton(db, buttonsA);

    await fake.bot.handleUpdate(callbackUpdate(STUDENT, startTest(b)));
    expect(sentTexts(fake.calls).at(-2)).toContain("Предыдущее занятие на паузе");
    const buttonsB = answerButtons(fake.calls);
    const statuses = await db.select().from(sessions).orderBy(sessions.id);
    expect(statuses.map((session) => session.status)).toEqual(["paused", "current"]);

    // Кнопка занятия на паузе: попытки нет, ученик видит «Продолжить».
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, correctA.callback_data));
    expect(await attemptCount()).toBe(0);
    expect(lastCallbackAnswer(fake)).toBe("Это занятие на паузе.");
    expect(lastButtons(fake.calls)[0]).toEqual({ text: "Продолжить", callback_data: resumeSession(statuses[0]!.id) });

    // Текущее занятие принимает ответ, состояние занятия на паузе не меняется.
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, (await correctButton(db, buttonsB)).callback_data));
    const [pausedA, currentB] = await db.select().from(sessions).orderBy(sessions.id);
    expect(pausedA!.learningState!.cursor).toBe(0);
    expect(currentB!.learningState!.cursor).toBe(1);

    // Меню предлагает вернуться к обоим.
    await fake.bot.handleUpdate(textUpdate(STUDENT, "/start"));
    const proceed = lastButtons(fake.calls).filter((button) => button.text.startsWith("Продолжить"));
    expect(proceed.map((button) => button.text).sort()).toEqual(["Продолжить: Подборка А", "Продолжить: Подборка Б"]);

    // Возврат: прежнее становится текущим, вопрос тот же, другое на паузе.
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, resumeSession(pausedA!.id)));
    expect(answerButtons(fake.calls)).toEqual(buttonsA);
    const after = await db.select().from(sessions).orderBy(sessions.id);
    expect(after.map((session) => session.status)).toEqual(["current", "paused"]);
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, correctA.callback_data));
    expect(await attemptCount()).toBe(2);
    const attemptsA = await db
      .select({ sessionId: questions.sessionId })
      .from(attempts)
      .innerJoin(questions, eq(questions.id, attempts.questionId))
      .where(and(eq(questions.sessionId, pausedA!.id)));
    expect(attemptsA).toHaveLength(1);
    expect(student.id).toBeGreaterThan(0);
  });

  it("кнопка «На паузу» и возврат; повторный старт той же подборки продолжает занятие", async () => {
    const { a, fake } = await twoCollections();
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, startTest(a)));
    const buttons = answerButtons(fake.calls);
    const pause = lastButtons(fake.calls).find((button) => button.text === "На паузу")!;
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, pause.callback_data));
    expect(sentTexts(fake.calls).at(-1)).toContain("Занятие на паузе");
    expect((await db.select().from(sessions))[0]?.status).toBe("paused");

    // Кнопка вопроса на паузе не принимается.
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, (await correctButton(db, buttons)).callback_data));
    expect(await attemptCount()).toBe(0);

    await fake.bot.handleUpdate(callbackUpdate(STUDENT, startTest(a)));
    expect(answerButtons(fake.calls)).toEqual(buttons);
    expect(await db.select().from(sessions)).toHaveLength(1);
    expect((await db.select().from(sessions))[0]?.status).toBe("current");
  });

  it("экран подборки показывает «Продолжить тест» вместо «Начать тест»", async () => {
    const { a, fake } = await twoCollections();
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, collectionPage(a, 0)));
    expect(lastButtons(fake.calls).map((button) => button.text)).toContain("Начать тест");
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, startTest(a)));
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, collectionPage(a, 0)));
    const texts = lastButtons(fake.calls).map((button) => button.text);
    expect(texts).toContain("Продолжить тест");
    expect(texts).not.toContain("Начать тест");
  });
});

describe("текст без открытого вопроса", () => {
  it("без занятия: меню, попытки нет", async () => {
    await started();
    const fake = createFakeBot(db);
    await db.update(sessions).set({ status: "paused" });
    await fake.bot.handleUpdate(textUpdate(STUDENT, "слово-word-1"));
    expect(await attemptCount()).toBe(0);
    expect(sentTexts(fake.calls).at(-1)).toContain("Выберите раздел");
    expect(lastButtons(fake.calls).map((button) => button.text)).toContain("Все слова");
  });

  it("при вопросе с кнопками текст не считается ответом: вопрос остаётся открытым", async () => {
    const { fake } = await started();
    const { version } = await questionOf(db, answerButtons(fake.calls));
    await fake.bot.handleUpdate(textUpdate(STUDENT, version.primaryTranslation));
    expect(await attemptCount()).toBe(0);
    expect(sentTexts(fake.calls).at(-1)).toContain("Выберите раздел");
    expect(sentTexts(fake.calls).at(-1)).toContain("Продолжить");
    expect(await db.select().from(questions).where(eq(questions.status, "open"))).toHaveLength(1);
  });
});

describe("разделы этапа 6 в меню", () => {
  it.each([
    ["Ежедневная практика", "Ежедневная практика"],
    ["Экзамен", "Экзамен"],
    ["Мой прогресс", "Мой прогресс"],
    ["Настройки", "Настройки"],
  ])("%s: открывается рабочий раздел, а не «появится позже»", async (title, heading) => {
    await started();
    const fake = createFakeBot(db);
    await fake.bot.handleUpdate(textUpdate(STUDENT, "/start"));
    const button = lastButtons(fake.calls).find((item) => item.text === title)!;
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, button.callback_data));
    const text = sentTexts(fake.calls).at(-1)!;
    expect(text).not.toContain("появится позже");
    expect(text).toContain(heading);
  });

  it.each([
    ["m:soon:daily", "Ежедневная практика"],
    ["m:soon:exam", "Экзамен"],
    ["m:soon:progress", "Мой прогресс"],
    ["m:soon:settings", "Настройки"],
  ])("кнопка %s из старого сообщения ведёт в настоящий раздел", async (data, heading) => {
    await started();
    const fake = createFakeBot(db);
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, data));
    expect(sentTexts(fake.calls).at(-1)).toContain(heading);
  });

  it("все кнопки укладываются в 64 байта при самых длинных ID", () => {
    const id = 999_999_999_999_999;
    const longestZone = [...TIMEZONE_PAGES.flatMap((page) => page.options.map((option) => option.zone))].sort((a, b) => b.length - a.length)[0]!;
    for (const data of [
      answerButton(id, 2, 3),
      collectionCard(id, id),
      collectionPage(id, id),
      wordCard(id, id),
      timezoneButton(longestZone),
      reminderTimeButton(23 * 60),
    ]) {
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    }
    expect(ANSWER_PATTERN.test(answerButton(id, 2, 3))).toBe(true);
    expect(TIMEZONE_PATTERN.test(timezoneButton(longestZone))).toBe(true);
  });
});

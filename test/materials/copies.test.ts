// Этап 4: копия ученика из кабинета — дополнение, правка, удаление, «Забрать у ученика» и правила слова.
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { collectionFromNotification, collectionPage, collectionsPage, resumeSession, startTest, wordsPage } from "../../src/bot/callback-data.js";
import { attempts, cardVersions, notifications, questions, sessions, studentCards, studentWords } from "../../src/db/schema.js";
import { listVisibleCards } from "../../src/learning/vocabulary.js";
import { notificationKeyboard, renderNotification } from "../../src/notifications/render.js";
import { addCopyCardsResponse, apiRoutes, copyDetail, issueResponse, type CardInput } from "../../src/shared/api-contract.js";
import { createFakeOidc, type Browser, type FakeOidc } from "../helpers/api.js";
import { at, cardInput, connectedStudent, createCollection, createStudent, issueTo, requestingStudent, teacherSession } from "../helpers/cabinet.js";
import { openTestDb, resetDb } from "../helpers/db.js";
import { callbackUpdate, createFakeBot, sentTexts } from "../helpers/fake-telegram.js";
import { answer, answerButtons, questionOf, sessionOf, userId, wordByPair } from "../helpers/learning.js";

const { db, close } = openTestDb();
afterAll(close);
beforeEach(() => resetDb(db));

let oidc: FakeOidc;
beforeAll(async () => {
  oidc = await createFakeOidc();
});

const TEACHER = 93001;
const STUDENT = 93101;
const SECOND = 93102;
/** Генератор всегда возвращает 0: порядок вопросов предсказуем. */
const FIXED_ORDER = () => 0;

/** Подключённый ученик с выданной подборкой. Возвращает ID копии. */
async function studentWithCopy(cards: CardInput[], title = "Еда", telegramId = STUDENT, existing?: { browser: Browser }) {
  const session = existing ?? (await teacherSession(db, oidc, TEACHER));
  const browser = session.browser;
  const student = await connectedStudent(db, browser, telegramId);
  const collection = await createCollection(browser, title, cards);
  const { results } = issueResponse.parse((await issueTo(browser, collection.id, [student.id])).json());
  return { browser, student, collection, copyId: results[0]!.copyId, studentUserId: await userId(db, telegramId) };
}

const getCopy = async (browser: Browser, id: number) => copyDetail.parse((await browser.get(at(apiRoutes.getCopy, id))).json());
const cardOf = async (browser: Browser, copyId: number, english: string) =>
  (await getCopy(browser, copyId)).cards.find((card) => card.english === english)!;
const extendedNotices = async () => db.select().from(notifications).where(eq(notifications.reason, "collection_extended"));
const visibleWords = async (studentUserId: number) => new Set((await listVisibleCards(db, studentUserId)).map((card) => card.studentWordId));

async function setWord(studentUserId: number, english: string, translation: string, patch: Partial<typeof studentWords.$inferInsert>) {
  const word = await wordByPair(db, studentUserId, english, translation);
  await db.update(studentWords).set(patch).where(eq(studentWords.id, word.id));
  return word.id;
}

describe("дополнение копии", () => {
  it("одно уведомление «В подборку добавлены слова» с количеством; дубли пропущены; новые помечены в боте", async () => {
    const { browser, copyId } = await studentWithCopy([cardInput("bread", "хлеб")]);
    const response = await browser.send("POST", at(apiRoutes.addCopyCards, copyId), {
      cards: [cardInput("tea", "чай"), cardInput("Bread", "хлеб"), cardInput("milk", "молоко"), cardInput("tea", "ЧАЙ")],
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = addCopyCardsResponse.parse(response.json());
    expect(body).toMatchObject({ added: 2, duplicates: [1, 3], notification: "now" });
    expect(body.copy.cards.map((card) => [card.english, card.isNew])).toEqual([
      ["bread", false],
      ["tea", true],
      ["milk", true],
    ]);

    const notices = await extendedNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.payload).toEqual({ studentCollectionId: copyId, title: "Еда", addedCount: 2 });
    expect(renderNotification("collection_extended", notices[0]!.payload)).toBe(
      "В подборку добавлены слова: Еда. Новых карточек: 2. Посмотрите их и продолжите практику.",
    );
    expect(notificationKeyboard("collection_extended", notices[0]!.payload)?.inline_keyboard).toEqual([
      [{ text: "Посмотреть", callback_data: collectionFromNotification(copyId) }],
    ]);

    // Повтор того же действия ничего не добавляет и второго уведомления не даёт.
    const again = addCopyCardsResponse.parse(
      (await browser.send("POST", at(apiRoutes.addCopyCards, copyId), { cards: [cardInput("tea", "чай"), cardInput("milk", "молоко")] })).json(),
    );
    expect(again).toMatchObject({ added: 0, duplicates: [0, 1], notification: "none" });
    expect(await extendedNotices()).toHaveLength(1);
    // Следующее дополнение — отдельное уведомление.
    await browser.send("POST", at(apiRoutes.addCopyCards, copyId), { cards: [cardInput("water", "вода")] });
    expect((await extendedNotices()).map((row) => row.payload.addedCount)).toEqual([2, 1]);

    const fake = createFakeBot(db);
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, collectionPage(copyId, 0)));
    const screen = sentTexts(fake.calls).at(-1)!;
    expect(screen).toMatch(/bread — хлеб\n/);
    expect(screen).toMatch(/tea — чай \[новая, /);
  });

  it("ошибка в одной карточке: 422 с номером карточки, ничего не добавлено", async () => {
    const { browser, copyId } = await studentWithCopy([cardInput("bread", "хлеб")]);
    const response = await browser.send("POST", at(apiRoutes.addCopyCards, copyId), {
      cards: [cardInput("tea", "чай"), cardInput("", "пусто")],
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.details[0]).toMatch(/^Карточка 2: /);
    expect((await getCopy(browser, copyId)).cards).toHaveLength(1);
    expect(await extendedNotices()).toHaveLength(0);
  });

  it("завершённая подборка снова «Практикует» после дополнения", async () => {
    const { browser, copyId } = await studentWithCopy([cardInput("alpha", "альфа"), cardInput("beta", "бета"), cardInput("gamma", "гамма")]);
    const fake = createFakeBot(db);
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, startTest(copyId)));
    for (let i = 0; i < 3; i++) await answer(fake, db, STUDENT, true);
    expect((await getCopy(browser, copyId)).status).toBe("completed");

    await browser.send("POST", at(apiRoutes.addCopyCards, copyId), { cards: [cardInput("delta", "дельта")] });
    expect((await getCopy(browser, copyId)).status).toBe("practicing");
    // Удаление единственной неотвеченной карточки снова завершает подборку.
    await browser.send("DELETE", at(apiRoutes.deleteCopyCard, (await cardOf(browser, copyId, "delta")).id));
    expect((await getCopy(browser, copyId)).status).toBe("completed");
  });

  it("до подтверждения связи: без уведомления о дополнении и без пометки «новая»; после — одна «Новая подборка» со всеми словами", async () => {
    const { browser } = await teacherSession(db, oidc, TEACHER);
    const requesting = await requestingStudent(db, browser, STUDENT);
    const collection = await createCollection(browser, "Еда", [cardInput("bread", "хлеб")]);
    const copyId = issueResponse.parse((await issueTo(browser, collection.id, [requesting.id])).json()).results[0]!.copyId;

    const added = addCopyCardsResponse.parse((await browser.send("POST", at(apiRoutes.addCopyCards, copyId), { cards: [cardInput("tea", "чай")] })).json());
    expect(added).toMatchObject({ added: 1, notification: "none" });
    expect(added.copy.cards.every((card) => !card.isNew)).toBe(true);
    expect(await extendedNotices()).toHaveLength(0);

    await browser.send("POST", at(apiRoutes.approveRequest, requesting.id), { code: requesting.code });
    const notices = await db.select().from(notifications).where(eq(notifications.reason, "new_collection"));
    expect(notices.map((row) => row.payload.wordCount)).toEqual([2]);
    expect(await extendedNotices()).toHaveLength(0);
  });
});

describe("правка карточки копии", () => {
  it("новая версия в card_versions; без изменений версия не создаётся; дубль в копии — 409", async () => {
    const { browser, copyId } = await studentWithCopy([cardInput("bread", "хлеб"), cardInput("tea", "чай")]);
    const bread = await cardOf(browser, copyId, "bread");
    const same = await browser.send("PATCH", at(apiRoutes.editCopyCard, bread.id), cardInput(" bread ", "хлеб"));
    expect(same.statusCode).toBe(200);
    expect(await db.select().from(cardVersions).where(eq(cardVersions.studentCardId, bread.id))).toHaveLength(1);

    const edited = copyDetail.parse(
      (await browser.send("PATCH", at(apiRoutes.editCopyCard, bread.id), cardInput("bread", "хлеб", { acceptedEnRu: ["булка"] }))).json(),
    );
    expect(edited.cards[0]).toMatchObject({ versionNumber: 2, acceptedEnRu: ["булка"] });
    expect((await db.select().from(cardVersions).where(eq(cardVersions.studentCardId, bread.id))).map((v) => v.versionNumber)).toEqual([1, 2]);

    const duplicate = await browser.send("PATCH", at(apiRoutes.editCopyCard, bread.id), cardInput("tea", "чай"));
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe("duplicate_card");
    const invalid = await browser.send("PATCH", at(apiRoutes.editCopyCard, bread.id), cardInput("bread", ""));
    expect(invalid.statusCode).toBe(422);
  });

  it("исправление после ответа: попытка ссылается на прежнюю версию, серия «5 из 5» не сброшена", async () => {
    const { browser, copyId, studentUserId } = await studentWithCopy([cardInput("alpha", "альфа"), cardInput("beta", "бета"), cardInput("gamma", "гамма")]);
    const fake = createFakeBot(db, { rng: FIXED_ORDER });
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, startTest(copyId)));
    const asked = await questionOf(db, answerButtons(fake.calls));
    const wordId = await setWord(studentUserId, asked.version.english, asked.version.primaryTranslation, {
      status: "hard",
      correctStreak: 3,
      hardSince: new Date(),
    });
    await answer(fake, db, STUDENT, true);
    const streakAfterAnswer = (await db.select().from(studentWords).where(eq(studentWords.id, wordId)))[0]!.correctStreak;
    expect(streakAfterAnswer).toBe(4);

    const card = await cardOf(browser, copyId, asked.version.english);
    await browser.send("PATCH", at(apiRoutes.editCopyCard, card.id), cardInput(asked.version.english, asked.version.primaryTranslation, { example: "new" }));

    const [attempt] = await db
      .select({ versionId: questions.cardVersionId })
      .from(attempts)
      .innerJoin(questions, eq(questions.id, attempts.questionId))
      .where(eq(questions.studentWordId, wordId));
    expect(attempt!.versionId).toBe(asked.version.id);
    const [word] = await db.select().from(studentWords).where(eq(studentWords.id, wordId));
    expect(word).toMatchObject({ status: "hard", correctStreak: 4 });
    expect((await cardOf(browser, copyId, asked.version.english)).versionNumber).toBe(2);
  });

  it("смена перевода: карточка переходит к новому слову вместе с серией и статусом, прежнее слово исчезает из показа", async () => {
    const { browser, copyId, studentUserId } = await studentWithCopy([cardInput("bank", "банк"), cardInput("tree", "дерево")]);
    const oldWordId = await setWord(studentUserId, "bank", "банк", { status: "hard", correctStreak: 2, consecutiveErrors: 1, hardSince: new Date("2026-01-01") });

    const card = await cardOf(browser, copyId, "bank");
    await browser.send("PATCH", at(apiRoutes.editCopyCard, card.id), cardInput("bank", "банк (финансы)"));

    const moved = await wordByPair(db, studentUserId, "bank", "банк (финансы)");
    expect(moved.id).not.toBe(oldWordId);
    expect(moved).toMatchObject({ status: "hard", correctStreak: 2, consecutiveErrors: 1 });
    expect((await db.select().from(studentCards).where(eq(studentCards.id, card.id)))[0]!.studentWordId).toBe(moved.id);
    const visible = await visibleWords(studentUserId);
    expect(visible.has(moved.id)).toBe(true);
    expect(visible.has(oldWordId)).toBe(false);
    // Прежнее слово с историей остаётся в базе.
    expect(await wordByPair(db, studentUserId, "bank", "банк")).toMatchObject({ id: oldWordId, status: "hard" });

    const fake = createFakeBot(db);
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, wordsPage(0)));
    expect(sentTexts(fake.calls).at(-1)).toContain("bank — банк (финансы)");
    expect(sentTexts(fake.calls).at(-1)).not.toMatch(/bank — банк\b(?! \()/);
  });

  it("смена перевода на уже существующее слово: объединение — меньшая серия, «сложное» сохраняется", async () => {
    const { browser, copyId, studentUserId } = await studentWithCopy([cardInput("bank", "банк")], "А");
    const second = await createCollection(browser, "Б", [cardInput("bank", "берег")]);
    const linkId = (await getCopy(browser, copyId)).studentId;
    await issueTo(browser, second.id, [linkId]);

    const bankMoney = await setWord(studentUserId, "bank", "банк", { status: "learning", correctStreak: 0, consecutiveErrors: 1 });
    const bankShore = await setWord(studentUserId, "bank", "берег", { status: "hard", correctStreak: 3, hardSince: new Date("2026-02-01") });

    await browser.send("PATCH", at(apiRoutes.editCopyCard, (await cardOf(browser, copyId, "bank")).id), cardInput("bank", "Берег"));

    const [merged] = await db.select().from(studentWords).where(eq(studentWords.id, bankShore));
    expect(merged).toMatchObject({ status: "hard", correctStreak: 0, consecutiveErrors: 1 });
    expect(merged!.hardSince).toEqual(new Date("2026-02-01"));
    const visible = await visibleWords(studentUserId);
    expect(visible.has(bankShore)).toBe(true);
    expect(visible.has(bankMoney)).toBe(false);
    // Слово показывается один раз, с обеими подборками.
    const fake = createFakeBot(db);
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, wordsPage(0)));
    const listing = sentTexts(fake.calls).at(-1)!;
    expect(listing).toContain("bank — Берег (А, Б)");
    expect(listing.match(/bank —/g)).toHaveLength(1);
  });

  it("смена перевода в одной из совпавших карточек: прежнее слово остаётся у другой копии", async () => {
    const { browser, copyId, studentUserId } = await studentWithCopy([cardInput("fast", "быстрый")], "А");
    const second = await createCollection(browser, "Б", [cardInput("fast", "быстрый")]);
    await issueTo(browser, second.id, [(await getCopy(browser, copyId)).studentId]);
    const fastWord = await setWord(studentUserId, "fast", "быстрый", { status: "hard", correctStreak: 1, hardSince: new Date() });

    await browser.send("PATCH", at(apiRoutes.editCopyCard, (await cardOf(browser, copyId, "fast")).id), cardInput("fast", "скорый"));
    const moved = await wordByPair(db, studentUserId, "fast", "скорый");
    expect(moved).toMatchObject({ status: "hard", correctStreak: 1 });
    const visible = await visibleWords(studentUserId);
    expect(visible.has(fastWord)).toBe(true);
    expect(visible.has(moved.id)).toBe(true);
  });
});

describe("удаление карточки копии", () => {
  it("последняя карточка слова: слово уходит из словаря и «Сложных», история сохраняется; не последняя — слово остаётся", async () => {
    const { browser, copyId, studentUserId } = await studentWithCopy([cardInput("fast", "быстрый"), cardInput("slow", "медленный"), cardInput("red", "красный")], "А");
    const second = await createCollection(browser, "Б", [cardInput("fast", "быстрый")]);
    await issueTo(browser, second.id, [(await getCopy(browser, copyId)).studentId]);
    const slow = await setWord(studentUserId, "slow", "медленный", { status: "hard", hardSince: new Date() });
    const fast = await setWord(studentUserId, "fast", "быстрый", { status: "hard", hardSince: new Date() });

    const response = await browser.send("DELETE", at(apiRoutes.deleteCopyCard, (await cardOf(browser, copyId, "slow")).id));
    expect(copyDetail.parse(response.json()).cards.map((card) => card.english)).toEqual(["fast", "red"]);
    await browser.send("DELETE", at(apiRoutes.deleteCopyCard, (await cardOf(browser, copyId, "fast")).id));

    const visible = await visibleWords(studentUserId);
    expect(visible.has(slow)).toBe(false);
    expect(visible.has(fast)).toBe(true);
    // Слово и карточка в базе: история и статус не стёрты.
    expect((await db.select().from(studentWords).where(eq(studentWords.id, slow)))[0]!.status).toBe("hard");
    expect((await db.select().from(studentCards).where(and(eq(studentCards.studentWordId, slow)))).every((card) => card.deletedAt !== null)).toBe(true);
    const fake = createFakeBot(db);
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, wordsPage(0)));
    expect(sentTexts(fake.calls).at(-1)).not.toContain("slow");
    expect(sentTexts(fake.calls).at(-1)).toContain("fast — быстрый (Б)");
  });

  it("во время занятия: ещё не заданное слово снимается с плана сразу, открытый вопрос остаётся и принимается", async () => {
    const { browser, copyId } = await studentWithCopy([cardInput("alpha", "альфа"), cardInput("beta", "бета"), cardInput("gamma", "гамма"), cardInput("delta", "дельта")]);
    const fake = createFakeBot(db, { rng: FIXED_ORDER });
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, startTest(copyId)));
    const asked = await questionOf(db, answerButtons(fake.calls));
    const [session] = await db.select().from(sessions);
    const notAsked = ["alpha", "beta", "gamma", "delta"].find((english) => english !== asked.version.english)!;

    // Удаление открытого вопроса: он не снимается и завершается по старой версии.
    await browser.send("DELETE", at(apiRoutes.deleteCopyCard, (await cardOf(browser, copyId, asked.version.english)).id));
    expect((await sessionOf(db, session!.id)).learningState!.removedPositions).toEqual([]);
    await browser.send("DELETE", at(apiRoutes.deleteCopyCard, (await cardOf(browser, copyId, notAsked)).id));
    const state = (await sessionOf(db, session!.id)).learningState!;
    expect(state.removedPositions).toHaveLength(1);
    expect(state.plan[state.removedPositions[0]!]!.studentWordId).not.toBe(asked.question.studentWordId);

    await answer(fake, db, STUDENT, true);
    expect(await db.select().from(attempts).where(eq(attempts.questionId, asked.question.id))).toHaveLength(1);
    const shown: string[] = [];
    while ((await sessionOf(db, session!.id)).status === "current") {
      shown.push((await questionOf(db, answerButtons(fake.calls))).version.english);
      await answer(fake, db, STUDENT, true);
    }
    expect(shown).toHaveLength(2);
    expect(shown).not.toContain(notAsked);
  });

  it("приостановленное занятие тоже приводится в порядок; без оставшихся слов оно завершается", async () => {
    const { browser, copyId } = await studentWithCopy([cardInput("alpha", "альфа"), cardInput("beta", "бета"), cardInput("gamma", "гамма")]);
    const fake = createFakeBot(db, { rng: FIXED_ORDER });
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, startTest(copyId)));
    const asked = await questionOf(db, answerButtons(fake.calls));
    await answer(fake, db, STUDENT, true);
    const current = await questionOf(db, answerButtons(fake.calls));
    const [session] = await db.select().from(sessions);
    await db.update(sessions).set({ status: "paused" }).where(eq(sessions.id, session!.id));

    const rest = ["alpha", "beta", "gamma"].filter((english) => english !== asked.version.english && english !== current.version.english);
    await browser.send("DELETE", at(apiRoutes.deleteCopyCard, (await cardOf(browser, copyId, rest[0]!)).id));
    const paused = await sessionOf(db, session!.id);
    expect(paused.status).toBe("paused");
    expect(paused.learningState!.removedPositions).toHaveLength(1);

    await fake.bot.handleUpdate(callbackUpdate(STUDENT, resumeSession(session!.id)));
    expect((await questionOf(db, answerButtons(fake.calls))).question.id).toBe(current.question.id);
  });
});

describe("«Забрать у ученика»", () => {
  it("во время занятия: копия исчезает из бота, занятие завершается как незавершённое, история сохраняется", async () => {
    const { browser, copyId, student } = await studentWithCopy([cardInput("alpha", "альфа"), cardInput("beta", "бета"), cardInput("gamma", "гамма")]);
    const fake = createFakeBot(db, { rng: FIXED_ORDER });
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, startTest(copyId)));
    await answer(fake, db, STUDENT, false);
    const openButtons = answerButtons(fake.calls);
    const attemptsBefore = await db.select().from(attempts);
    expect(attemptsBefore).toHaveLength(1);

    expect((await browser.send("DELETE", at(apiRoutes.withdrawCopy, copyId))).json()).toEqual({ ok: true });

    const [session] = await db.select().from(sessions);
    expect(session).toMatchObject({ status: "incomplete" });
    expect(session!.finishedAt).not.toBeNull();
    // Старая кнопка не создаёт попытку.
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, openButtons[0]!.callback_data));
    expect(await db.select().from(attempts)).toEqual(attemptsBefore);

    await fake.bot.handleUpdate(callbackUpdate(STUDENT, collectionsPage(0)));
    expect(sentTexts(fake.calls).at(-1)).not.toContain("Еда");
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, collectionPage(copyId, 0)));
    expect(sentTexts(fake.calls).at(-1)).not.toContain("alpha");

    // Копия больше не видна преподавателю и не меняется; карточка ученика её не показывает.
    expect((await browser.get(at(apiRoutes.getCopy, copyId))).statusCode).toBe(404);
    expect((await browser.send("DELETE", at(apiRoutes.withdrawCopy, copyId))).statusCode).toBe(404);
    expect((await browser.get(at(apiRoutes.getStudent, student.id))).json().collections).toEqual([]);
  });

  it("неотправленное уведомление о копии отменяется; подборку можно выдать заново", async () => {
    const { browser, copyId, collection, student } = await studentWithCopy([cardInput("alpha", "альфа")]);
    await browser.send("DELETE", at(apiRoutes.withdrawCopy, copyId));
    const [notice] = await db.select().from(notifications).where(eq(notifications.reason, "new_collection"));
    expect(notice).toMatchObject({ status: "failed" });

    const again = issueResponse.parse((await issueTo(browser, collection.id, [student.id])).json());
    expect(again.results[0]).toMatchObject({ outcome: "now" });
    expect(again.results[0]!.copyId).not.toBe(copyId);
  });
});

describe("после отвязки", () => {
  it("копии и их карточки недоступны преподавателю: 404, ничего не меняется", async () => {
    const { browser, copyId, student } = await studentWithCopy([cardInput("alpha", "альфа")]);
    const card = await cardOf(browser, copyId, "alpha");
    await browser.send("POST", at(apiRoutes.unlinkStudent, student.id));
    const calls = [
      browser.get(at(apiRoutes.getCopy, copyId)),
      browser.send("POST", at(apiRoutes.addCopyCards, copyId), { cards: [cardInput("tea", "чай")] }),
      browser.send("PATCH", at(apiRoutes.editCopyCard, card.id), cardInput("alpha", "альфа2")),
      browser.send("DELETE", at(apiRoutes.deleteCopyCard, card.id)),
      browser.send("DELETE", at(apiRoutes.withdrawCopy, copyId)),
    ];
    for (const response of await Promise.all(calls)) expect(response.statusCode).toBe(404);
    expect(await db.select().from(cardVersions)).toHaveLength(1);
    expect(await db.select().from(studentCards)).toHaveLength(1);
    expect(await extendedNotices()).toHaveLength(0);
  });

  it("второй ученик той же подборки не затронут отвязкой первого", async () => {
    const first = await studentWithCopy([cardInput("alpha", "альфа")]);
    const second = await connectedStudent(db, first.browser, SECOND, "Вера");
    const copyId = issueResponse.parse((await issueTo(first.browser, first.collection.id, [second.id])).json()).results[0]!.copyId;
    await first.browser.send("POST", at(apiRoutes.unlinkStudent, first.student.id));
    expect((await first.browser.send("POST", at(apiRoutes.addCopyCards, copyId), { cards: [cardInput("tea", "чай")] })).statusCode).toBe(200);
  });
});

describe("запись без аккаунта", () => {
  it("копию «Ожидает подключения» можно править и забрать; слова заводятся при подтверждении", async () => {
    const { browser } = await teacherSession(db, oidc, TEACHER);
    const waiting = await createStudent(browser, "Борис");
    const collection = await createCollection(browser, "Еда", [cardInput("bread", "хлеб")]);
    const copyId = issueResponse.parse((await issueTo(browser, collection.id, [waiting.id])).json()).results[0]!.copyId;
    const bread = await cardOf(browser, copyId, "bread");
    expect((await browser.send("PATCH", at(apiRoutes.editCopyCard, bread.id), cardInput("bread", "булка"))).statusCode).toBe(200);
    expect((await getCopy(browser, copyId)).studentStatus).toBe("pending_connection");
    expect((await db.select().from(studentCards))[0]!.studentWordId).toBeNull();
    expect((await browser.send("DELETE", at(apiRoutes.withdrawCopy, copyId))).statusCode).toBe(200);
  });
});

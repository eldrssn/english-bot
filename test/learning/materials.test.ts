// Словарь, подборки, статусы, правка и удаление карточек, короткие подборки и длинные варианты.
import { and, count, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  BUTTON_LABEL_LIMIT,
  MESSAGE_LIMIT,
  paginate,
} from "../../src/bot/learning-render.js";
import {
  COLLECTION_CARD_PATTERN,
  WORD_CARD_PATTERN,
  collectionCard,
  collectionFromNotification,
  collectionPage,
  collectionsPage,
  resumeSession,
  startTest,
  wordCard,
  wordsPage,
} from "../../src/bot/callback-data.js";
import { issueCollectionCopy, upsertStudentWord } from "../../src/db/collections.js";
import { attempts, cardVersions, cardViews, questions, sessions, sourceCollections, studentCards, studentCollections, studentLinks, studentWords } from "../../src/db/schema.js";
import { normalizeWordText } from "../../src/domain/index.js";
import { openTestDb, resetDb } from "../helpers/db.js";
import { callbackUpdate, createFakeBot, lastButtons, sentTexts, textUpdate } from "../helpers/fake-telegram.js";
import {
  answer,
  answerButtons,
  card,
  cardByEnglish,
  collectionStatus,
  connectStudent,
  correctButton,
  deleteCard,
  editCard,
  issue,
  questionOf,
  sessionOf,
  wordByPair,
  words,
  type FakeBot,
} from "../helpers/learning.js";

const { db, close } = openTestDb();
afterAll(close);
beforeEach(() => resetDb(db));

const STUDENT = 73001;
/** Генератор всегда возвращает 0: порядок вопросов и направления предсказуемы. */
const FIXED_ORDER = () => 0;

async function newWord(english: string, translation: string, collectionId: number) {
  const [collection] = await db
    .select({ studentUserId: studentLinks.studentUserId })
    .from(studentCollections)
    .innerJoin(studentLinks, eq(studentLinks.id, studentCollections.studentLinkId))
    .where(eq(studentCollections.id, collectionId));
  const id = await upsertStudentWord(db, collection!.studentUserId!, english, translation);
  return { id };
}

/** Обходит все страницы «Всех слов» и собирает тексты. */
async function allWordPages(fake: FakeBot) {
  const texts: string[] = [];
  const buttons: { text: string; callback_data: string }[] = [];
  let page = 0;
  for (;;) {
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, wordsPage(page)));
    texts.push(sentTexts(fake.calls).at(-1)!);
    buttons.push(...lastButtons(fake.calls).filter((button) => WORD_CARD_PATTERN.test(button.callback_data)));
    if (!lastButtons(fake.calls).some((button) => button.text === "Вперёд →")) return { texts, buttons };
    page += 1;
  }
}

describe("лимит Telegram", () => {
  it("страницы делятся по числу символов, а не только по числу пунктов", () => {
    const lines = Array.from({ length: 6 }, () => "я".repeat(1500));
    const pages = paginate(lines, (line) => line);
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) expect(page.join("\n").length).toBeLessThanOrEqual(4096);
    expect(pages.flat()).toHaveLength(6);
    // Один длинный пункт не даёт пустой страницы.
    expect(paginate(["я".repeat(9000)], (line) => line)).toHaveLength(1);
  });

  it("карточка и вопрос с очень длинным текстом укладываются в 4096 символов", async () => {
    const { student, link } = await connectStudent(db, STUDENT);
    const huge = "длинный текст ".repeat(500);
    const id = await issue(db, link.id, "Огромная", [card("huge", huge, { example: huge, explanation: huge }), card(huge, "огромное")]);
    const word = await wordByPair(db, student.id, "huge", normalizeWordText(huge));
    const fake = createFakeBot(db);
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, wordCard(word.id, 0)));
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, startTest(id)));
    await answer(fake, db, STUDENT, false);
    for (const text of sentTexts(fake.calls)) expect(text.length).toBeLessThanOrEqual(MESSAGE_LIMIT);
  });
});

describe("Все слова", () => {
  it("bank — банк и bank — берег разные, совпадающие пары один раз с обеими подборками", async () => {
    const { student, link } = await connectStudent(db, STUDENT);
    await issue(db, link.id, "Первая", [card("bank", "банк"), card("fast", "быстрый")]);
    await issue(db, link.id, "Вторая", [card("bank", "берег"), card("  Fast", "Быстрый")]);
    const fake = createFakeBot(db);
    const { texts, buttons } = await allWordPages(fake);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("Все слова: 3.");
    expect(texts[0]).toContain("bank — банк (Первая)");
    expect(texts[0]).toContain("bank — берег (Вторая)");
    expect(texts[0]!.match(/fast — /gi)).toHaveLength(1);
    expect(texts[0]).toMatch(/fast — (быстрый|Быстрый) \(Первая, Вторая\)/i);
    expect(buttons).toHaveLength(3);

    // Разные слова — разные счётчики.
    const bank = await wordByPair(db, student.id, "bank", "банк");
    const shore = await wordByPair(db, student.id, "bank", "берег");
    expect(bank.id).not.toBe(shore.id);
    expect(await db.select().from(studentWords).where(eq(studentWords.studentUserId, student.id))).toHaveLength(3);
  });

  it("серия у совпавшей пары общая: ответ через одну подборку меняет единое слово", async () => {
    const { student, link } = await connectStudent(db, STUDENT);
    const first = await issue(db, link.id, "Первая", [card("fast", "быстрый"), card("slow", "медленный")]);
    await issue(db, link.id, "Вторая", [card("fast", "быстрый")]);
    const word = await wordByPair(db, student.id, "fast", "быстрый");
    await db.update(studentWords).set({ status: "hard", hardSince: new Date() }).where(eq(studentWords.id, word.id));
    const fake = createFakeBot(db);
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, startTest(first)));
    await answer(fake, db, STUDENT, true);
    await answer(fake, db, STUDENT, true);
    expect(await wordByPair(db, student.id, "fast", "быстрый")).toMatchObject({ correctStreak: 1 });
  });

  it("листание: каждое сообщение до 4096 символов, все слова доступны ровно один раз, даже при длинных текстах", async () => {
    const { link } = await connectStudent(db, STUDENT);
    const long = (index: number) => `${"очень длинный перевод ".repeat(60)}${index}`;
    await issue(db, link.id, "Длинная", [
      ...Array.from({ length: 12 }, (_, index) => card(`long${index}`, long(index))),
      ...words(30),
    ]);
    const fake = createFakeBot(db);
    const { texts, buttons } = await allWordPages(fake);
    expect(texts.length).toBeGreaterThan(1);
    for (const text of texts) expect(text.length).toBeLessThanOrEqual(MESSAGE_LIMIT);
    expect(buttons).toHaveLength(42);
    expect(new Set(buttons.map((button) => button.callback_data.split(":")[2])).size).toBe(42);

    // Номер несуществующей страницы не ломает экран.
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, wordsPage(9999)));
    expect(sentTexts(fake.calls).at(-1)).toContain("Все слова: 42.");
  });

  it("открытие карточки показывает содержимое и источники, записывает просмотр по всем её карточкам и текущей связи", async () => {
    const { student, link } = await connectStudent(db, STUDENT);
    const a = await issue(db, link.id, "Первая", [card("fast", "быстрый", { example: "He runs fast.", explanation: "Наречие тоже." })]);
    const b = await issue(db, link.id, "Вторая", [card("fast", "быстрый")]);
    const word = await wordByPair(db, student.id, "fast", "быстрый");
    const fake = createFakeBot(db);
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, wordsPage(0)));
    expect(await db.select().from(cardViews)).toHaveLength(0);
    expect(await collectionStatus(db, a)).toBe("assigned");

    await fake.bot.handleUpdate(callbackUpdate(STUDENT, wordCard(word.id, 0)));
    const text = sentTexts(fake.calls).at(-1)!;
    expect(text).toContain("fast — быстрый");
    expect(text).toContain("Подборки: Первая, Вторая");
    const views = await db.select().from(cardViews);
    expect(views).toHaveLength(2);
    expect(views.every((view) => view.studentLinkId === link.id)).toBe(true);
    expect(await collectionStatus(db, a)).toBe("started");
    expect(await collectionStatus(db, b)).toBe("started");
    expect(lastButtons(fake.calls).map((button) => button.text)).toEqual(["К списку слов", "В меню"]);
  });

  it("пустой словарь: понятное сообщение, никаких занятий", async () => {
    await connectStudent(db, STUDENT);
    const fake = createFakeBot(db);
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, wordsPage(0)));
    expect(sentTexts(fake.calls).at(-1)).toContain("Слов пока нет");
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, collectionsPage(0)));
    expect(sentTexts(fake.calls).at(-1)).toContain("Подборок пока нет");
    expect(await db.select().from(sessions)).toHaveLength(0);
  });
});

describe("Подборки", () => {
  it("список по дате публикации: сначала новые; все карточки видны, новые помечены датой", async () => {
    const { link } = await connectStudent(db, STUDENT);
    const older = await issue(db, link.id, "Старая", words(3, "o"));
    const newer = await issue(db, link.id, "Новая", words(10, "n"));
    await db.update(studentCollections).set({ publishedAt: new Date("2026-01-10T12:00:00Z") }).where(eq(studentCollections.id, older));
    await db.update(studentCards).set({ addedAt: new Date("2026-01-10T12:00:00Z") }).where(eq(studentCards.studentCollectionId, older));
    await db.update(studentCollections).set({ publishedAt: new Date("2026-02-10T12:00:00Z") }).where(eq(studentCollections.id, newer));
    await db.update(studentCards).set({ addedAt: new Date("2026-02-10T12:00:00Z") }).where(eq(studentCards.studentCollectionId, newer));

    const fake = createFakeBot(db);
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, collectionsPage(0)));
    const listing = sentTexts(fake.calls).at(-1)!;
    expect(listing.indexOf("Новая")).toBeLessThan(listing.indexOf("Старая"));
    expect(listing).toContain("10.02.2026");

    // Дополнение копии: карточка добавлена позже публикации.
    const { version } = await cardByEnglish(db, older, "o1");
    const [added] = await db
      .insert(studentCards)
      .values({
        studentCollectionId: older,
        position: 99,
        studentWordId: (await cardByEnglish(db, older, "o1")).card.studentWordId,
        addedAt: new Date("2026-03-01T12:00:00Z"),
      })
      .returning();
    await db.insert(cardVersions).values({
      studentCardId: added!.id,
      versionNumber: 1,
      english: "o1 extra",
      primaryTranslation: version.primaryTranslation,
    });

    await fake.bot.handleUpdate(callbackUpdate(STUDENT, collectionPage(older, 0)));
    const screen = sentTexts(fake.calls).at(-1)!;
    expect(screen).toContain("Опубликована: 10.01.2026");
    expect(screen).toContain("o1 — слово-o-1\n");
    expect(screen).toContain("o1 extra — слово-o-1 [новая, 01.03.2026]");
    expect(screen).not.toContain("o1 — слово-o-1 [новая");

    // Длинная подборка листается, все карточки доступны.
    const seen = new Set<string>();
    for (let page = 0; ; page++) {
      await fake.bot.handleUpdate(callbackUpdate(STUDENT, collectionPage(newer, page)));
      for (const button of lastButtons(fake.calls)) {
        if (COLLECTION_CARD_PATTERN.test(button.callback_data)) seen.add(button.callback_data.split(":")[2]!);
      }
      if (!lastButtons(fake.calls).some((button) => button.text === "Вперёд →")) break;
    }
    expect(seen.size).toBe(10);
  });

  it("карточка из подборки листается, просмотр записан, чужой статус не меняется", async () => {
    const { link } = await connectStudent(db, STUDENT);
    const id = await issue(db, link.id, "Подборка", [card("alpha", "альфа", { example: "Пример." }), card("beta", "бета")]);
    const other = await issue(db, link.id, "Другая", [card("gamma", "гамма")]);
    const alpha = await cardByEnglish(db, id, "alpha");
    const fake = createFakeBot(db);
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, collectionCard(alpha.card.id, 0)));
    expect(sentTexts(fake.calls).at(-1)).toBe("alpha — альфа\n\nПример.");
    const next = lastButtons(fake.calls).find((button) => button.text === "Следующая →")!;
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, next.callback_data));
    expect(sentTexts(fake.calls).at(-1)).toBe("beta — бета");
    expect(await db.select().from(cardViews)).toHaveLength(2);
    expect(await collectionStatus(db, id)).toBe("started");
    expect(await collectionStatus(db, other)).toBe("assigned");
  });

  it("статусы: назначено → начал → практикует → завершил; hasAnswer считается по слову", async () => {
    const { link } = await connectStudent(db, STUDENT);
    const a = await issue(db, link.id, "А", [card("fast", "быстрый"), card("slow", "медленный")]);
    const b = await issue(db, link.id, "Б", [card("fast", "быстрый"), card("red", "красный")]);
    const fake = createFakeBot(db);
    expect(await collectionStatus(db, a)).toBe("assigned");

    await fake.bot.handleUpdate(callbackUpdate(STUDENT, collectionPage(a, 0)));
    expect(await collectionStatus(db, a)).toBe("started");
    // Повторный показ списка не копит записи просмотра.
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, collectionPage(a, 0)));
    expect(await db.select().from(cardViews)).toHaveLength(2);

    await fake.bot.handleUpdate(callbackUpdate(STUDENT, startTest(a)));
    const firstWord = (await questionOf(db, answerButtons(fake.calls))).version.english;
    await answer(fake, db, STUDENT, true);
    expect(await collectionStatus(db, a)).toBe("practicing");
    expect(await collectionStatus(db, b)).toBe(firstWord === "fast" ? "practicing" : "assigned");

    await answer(fake, db, STUDENT, true);
    expect(await collectionStatus(db, a)).toBe("completed");
    // fast отвечен через А: в Б слово считается отвеченным, а red — нет.
    expect(await collectionStatus(db, b)).toBe("practicing");
  });

  it("удалённая карточка не мешает завершить подборку, добавленная возвращает её в «практикует»", async () => {
    const { link } = await connectStudent(db, STUDENT);
    const id = await issue(db, link.id, "А", [card("alpha", "альфа"), card("beta", "бета"), card("gamma", "гамма")]);
    const fake = createFakeBot(db, { rng: FIXED_ORDER });
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, startTest(id)));
    // Порядок при этом генераторе: beta, gamma, alpha.
    expect((await questionOf(db, answerButtons(fake.calls))).version.english).toBe("beta");
    await answer(fake, db, STUDENT, true);
    expect(await collectionStatus(db, id)).toBe("practicing");

    // Неотвеченное слово удалено: считаются только действующие карточки.
    await deleteCard(db, id, "alpha");
    await answer(fake, db, STUDENT, true);
    expect(await collectionStatus(db, id)).toBe("completed");
    expect((await db.select().from(sessions))[0]?.status).toBe("completed");

    // Дополнение копии: новая карточка без ответа.
    const [added] = await db
      .insert(studentCards)
      .values({
        studentCollectionId: id,
        position: 99,
      })
      .returning();
    await db.insert(cardVersions).values({ studentCardId: added!.id, versionNumber: 1, english: "delta", primaryTranslation: "дельта" });
    await db.update(studentCards).set({ studentWordId: (await newWord("delta", "дельта", id)).id }).where(eq(studentCards.id, added!.id));
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, collectionCard(added!.id, 0)));
    expect(await collectionStatus(db, id)).toBe("practicing");
  });

  it("уведомление «Посмотреть» открывает подборку новым сообщением", async () => {
    const { link } = await connectStudent(db, STUDENT);
    const id = await issue(db, link.id, "А", words(2));
    const fake = createFakeBot(db);
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, collectionFromNotification(id)));
    const call = fake.calls.filter((item) => item.method === "sendMessage" || item.method === "editMessageText").at(-1)!;
    expect(call.method).toBe("sendMessage");
    expect(call.payload.text).toContain("А\nОпубликована:");
    expect(lastButtons(fake.calls).map((button) => button.text)).toContain("Начать тест");
  });
});

describe("правка карточки во время занятия", () => {
  it("заданный вопрос и его повтор идут по старой версии, новые по новой; серия не сбрасывается", async () => {
    const { student, link } = await connectStudent(db, STUDENT);
    const id = await issue(db, link.id, "А", [card("alpha", "альфа"), card("beta", "бета"), card("gamma", "гамма"), card("delta", "дельта")]);
    const fake = createFakeBot(db);
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, startTest(id)));

    const asked = await questionOf(db, answerButtons(fake.calls));
    const askedEnglish = asked.version.english;
    const buttons = answerButtons(fake.calls);
    const others = ["alpha", "beta", "gamma", "delta"].filter((word) => word !== askedEnglish);
    const word = await wordByPair(db, student.id, asked.version.english, asked.version.primaryTranslation);
    await db.update(studentWords).set({ correctStreak: 3, status: "hard", hardSince: new Date() }).where(eq(studentWords.id, word.id));

    // Правка заданного слова и ещё не заданного: основной текст показа меняется, слово то же.
    await editCard(db, id, askedEnglish, {
      example: "Новая версия",
      acceptedEnRu: ["новый ответ"],
      acceptedRuEn: ["new answer"],
    });
    const edited = await editCard(db, id, others[0]!, {
      english: `${others[0]} NEW`,
      example: "Пример новой версии",
    });

    // Старая версия: неверный ответ и повтор по старому тексту.
    const wrong = buttons.find((button) => Number(button.callback_data.split(":")[3]) !== asked.question.correctOptionIndex)!;
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, wrong.callback_data));
    const feedback = fake.calls.filter((call) => call.method === "editMessageText").at(-1)!.payload.text;
    // Слово было сложным с серией 3: ошибка обнуляет серию, и бот говорит об этом.
    expect(feedback).toBe(
      `Вы выбрали ${wrong.text}; верно ${asked.version.english} — ${asked.version.primaryTranslation}\n\nСерия «5 из 5» начинается заново.`,
    );
    expect(feedback).not.toContain("Новая версия");
    const [attempt] = await db.select().from(attempts);
    expect((await db.select().from(questions).where(eq(questions.id, attempt!.questionId)))[0]?.cardVersionId).toBe(asked.version.id);
    // Прежняя серия обнулена только ошибкой, а не правкой: без ошибки значения не менялись бы.
    expect((await wordByPair(db, student.id, asked.version.english, asked.version.primaryTranslation)).correctStreak).toBe(0);

    // Дальше новые вопросы создаются по актуальной версии, хотя в плане снимок старой.
    const seen: string[] = [];
    for (let guard = 0; guard < 8; guard++) {
      if (answerButtons(fake.calls).length === 0) break;
      const session = (await db.select().from(sessions))[0]!;
      if (session.status !== "current") break;
      const current = await questionOf(db, answerButtons(fake.calls));
      seen.push(current.version.english);
      if (current.version.english === askedEnglish) {
        // Повтор: та же версия и те же варианты.
        expect(current.version.id).toBe(asked.version.id);
        expect(answerButtons(fake.calls).map((button) => button.text)).toEqual(buttons.map((button) => button.text));
      }
      if (current.version.english.endsWith("NEW")) expect(current.version.id).toBe(edited.version.id);
      await answer(fake, db, STUDENT, true);
    }
    expect(seen).toContain(`${others[0]} NEW`);
    expect(seen).toContain(askedEnglish);
  });

  it("верный ответ старой версии принимается, даже если новая версия его больше не допускает", async () => {
    const { student, link } = await connectStudent(db, STUDENT);
    const id = await issue(db, link.id, "А", [card("alpha", "альфа"), card("beta", "бета")]);
    const fake = createFakeBot(db);
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, startTest(id)));
    const buttons = answerButtons(fake.calls);
    const asked = await questionOf(db, buttons);
    // Текст показа сменился, но слово то же: на этапе 4 это исправление написания.
    await editCard(db, id, asked.version.english, { english: "ALPHA?", primaryTranslation: "ИСПРАВЛЕНО" });
    const correct = await correctButton(db, buttons);
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, correct.callback_data));
    const [attempt] = await db.select().from(attempts);
    expect(attempt).toMatchObject({ isCorrect: true, answerText: correct.text });
    expect(fake.calls.filter((call) => call.method === "editMessageText").at(-1)!.payload.text).toBe(
      `Верно: ${asked.version.english} — ${asked.version.primaryTranslation}`,
    );
    expect(student.id).toBeGreaterThan(0);
  });

  it("ответ из свежей версии карточки принимается и в заданном вопросе", async () => {
    const { link } = await connectStudent(db, STUDENT);
    const id = await issue(db, link.id, "А", [card("alpha", "альфа"), card("beta", "бета")]);
    const fake = createFakeBot(db);
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, startTest(id)));
    const buttons = answerButtons(fake.calls);
    const asked = await questionOf(db, buttons);
    const wrong = buttons.find((button) => Number(button.callback_data.split(":")[3]) !== asked.question.correctOptionIndex)!;
    // Новая версия слова объявила текст неверной кнопки допустимым.
    const accepted = asked.question.direction === "en_ru" ? { acceptedEnRu: [wrong.text] } : { acceptedRuEn: [wrong.text] };
    await editCard(db, id, asked.version.english, accepted);
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, wrong.callback_data));
    expect((await db.select().from(attempts))[0]?.isCorrect).toBe(true);
  });
});

describe("удаление карточки", () => {
  it("ещё не заданное слово снимается с плана и исчезает из словаря, история остаётся", async () => {
    const { student, link } = await connectStudent(db, STUDENT);
    const id = await issue(db, link.id, "А", words(4));
    const fake = createFakeBot(db);
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, startTest(id)));
    const asked = await questionOf(db, answerButtons(fake.calls));
    const toDelete = ["word1", "word2", "word3", "word4"].find((word) => word !== asked.version.english)!;
    await deleteCard(db, id, toDelete);

    await answer(fake, db, STUDENT, true);
    const session = (await db.select().from(sessions))[0]!;
    expect(session.learningState!.removedPositions).toHaveLength(1);
    const shown: string[] = [asked.version.english];
    while ((await sessionOf(db, session.id)).status === "current") {
      shown.push((await questionOf(db, answerButtons(fake.calls))).version.english);
      await answer(fake, db, STUDENT, true);
    }
    expect(shown).not.toContain(toDelete);
    expect(shown).toHaveLength(3);
    expect(sentTexts(fake.calls).at(-1)).toContain("С первой попытки: 3 из 3");

    await fake.bot.handleUpdate(callbackUpdate(STUDENT, wordsPage(0)));
    expect(sentTexts(fake.calls).at(-1)).not.toContain(toDelete);
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, collectionPage(id, 0)));
    expect(sentTexts(fake.calls).at(-1)).not.toContain(toDelete);
    expect(await wordByPair(db, student.id, toDelete, `слово-word-${toDelete.slice(4)}`)).toBeTruthy();
  });

  it("заданный вопрос и его повтор завершаются по старой версии, история сохраняется", async () => {
    const { student, link } = await connectStudent(db, STUDENT);
    const id = await issue(db, link.id, "А", words(3));
    const fake = createFakeBot(db);
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, startTest(id)));
    const firstButtons = answerButtons(fake.calls);
    const asked = await questionOf(db, firstButtons);

    await deleteCard(db, id, asked.version.english);
    // Вопрос уже отправлен: при возврате он не снимается.
    const sessionId = (await db.select().from(sessions))[0]!.id;
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, resumeSession(sessionId)));
    expect(answerButtons(fake.calls)).toEqual(firstButtons);
    expect((await sessionOf(db, sessionId)).learningState!.removedPositions).toEqual([]);

    await answer(fake, db, STUDENT, false);
    await answer(fake, db, STUDENT, true);
    await answer(fake, db, STUDENT, true);
    // Повтор удалённого слова всё равно задан.
    expect(sentTexts(fake.calls).at(-1)).toContain("Повтор ошибки");
    expect((await questionOf(db, answerButtons(fake.calls))).version.id).toBe(asked.version.id);
    await answer(fake, db, STUDENT, false);

    expect(sentTexts(fake.calls).at(-1)).toContain("С первой попытки: 2 из 3");
    expect(sentTexts(fake.calls).at(-1)).toContain(asked.version.english);
    expect(await db.select().from(attempts).where(eq(attempts.questionId, asked.question.id))).toHaveLength(2);
    const word = await wordByPair(db, student.id, asked.version.english, asked.version.primaryTranslation);
    expect(word.status).toBe("hard");
    // Из словаря слово ушло, а история нет.
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, wordsPage(0)));
    expect(sentTexts(fake.calls).at(-1)).not.toContain(`${asked.version.english} —`);
  });

  it("удаление одной из совпавших карточек не убирает слово и новый вопрос идёт по оставшейся", async () => {
    const { link } = await connectStudent(db, STUDENT);
    const a = await issue(db, link.id, "А", [card("fast", "быстрый", { example: "из А" }), card("slow", "медленный")]);
    await issue(db, link.id, "Б", [card("fast", "быстрый", { example: "из Б" }), card("red", "красный")]);
    const fake = createFakeBot(db, { rng: FIXED_ORDER });
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, startTest(a)));
    expect((await questionOf(db, answerButtons(fake.calls))).version.english).toBe("slow");

    await deleteCard(db, a, "fast");
    await answer(fake, db, STUDENT, true);
    const next = await questionOf(db, answerButtons(fake.calls));
    expect(next.version.english).toBe("fast");
    expect(next.version.example).toBe("из Б");

    await fake.bot.handleUpdate(callbackUpdate(STUDENT, wordsPage(0)));
    expect(sentTexts(fake.calls).at(-1)).toMatch(/fast — быстрый \(Б\)/);
  });

  it("у всего плана нет карточек: занятие закрывается без падения", async () => {
    const { link } = await connectStudent(db, STUDENT);
    const id = await issue(db, link.id, "А", words(2));
    const fake = createFakeBot(db);
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, startTest(id)));
    const asked = await questionOf(db, answerButtons(fake.calls));
    await deleteCard(db, id, asked.version.english === "word1" ? "word2" : "word1");
    await answer(fake, db, STUDENT, true);
    expect(sentTexts(fake.calls).at(-1)).toContain("С первой попытки: 1 из 1");
  });
});

describe("подборка с 1–3 словами и нехватка вариантов", () => {
  it("одно слово и нет других: вместо кнопок бот просит написать перевод, ответ засчитывается", async () => {
    const { link } = await connectStudent(db, STUDENT);
    const id = await issue(db, link.id, "Одно", [card("alone", "один")]);
    const fake = createFakeBot(db);
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, startTest(id)));
    const prompt = sentTexts(fake.calls).at(-1)!;
    expect(prompt).toContain("Вопрос 1 из 1");
    expect(prompt).toMatch(/Напишите перевод на (английский|русский)/);
    expect(prompt).toContain("Других вариантов для кнопок не нашлось");
    expect(answerButtons(fake.calls)).toHaveLength(0);
    const [question] = await db.select().from(questions);
    expect(question).toMatchObject({ format: "typed", options: null, correctOptionIndex: null });
    // План теста остаётся планом кнопок: ввод — замена только для этого слова.
    expect((await db.select().from(sessions))[0]!.learningState!.plan[0]!.format).toBe("choice");

    await fake.bot.handleUpdate(textUpdate(STUDENT, question!.direction === "ru_en" ? "Alone" : "один"));
    expect(sentTexts(fake.calls).at(-2)).toContain("Верно.");
    expect(sentTexts(fake.calls).at(-1)).toContain("С первой попытки: 1 из 1");
    expect((await db.select().from(sessions))[0]!.status).toBe("completed");
    expect(await db.select().from(attempts)).toHaveLength(1);
  });

  it.each([
    [2, 2],
    [3, 3],
    [4, 4],
    [7, 4],
  ])("в подборке %i слов: кнопок с ответами %i", async (size, optionCount) => {
    const { link } = await connectStudent(db, STUDENT);
    const id = await issue(db, link.id, "Подборка", words(size));
    const fake = createFakeBot(db);
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, startTest(id)));
    expect(answerButtons(fake.calls)).toHaveLength(optionCount);
  });

  it("одно слово, но есть другая подборка: варианты берутся из неё", async () => {
    const { link } = await connectStudent(db, STUDENT);
    const id = await issue(db, link.id, "Одно", [card("alone", "один")]);
    await issue(db, link.id, "Другая", words(5));
    const fake = createFakeBot(db);
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, startTest(id)));
    expect(answerButtons(fake.calls)).toHaveLength(4);
  });

  it("слово без вариантов спрашивается вводом, а остальное занятие идёт кнопками", async () => {
    const { link } = await connectStudent(db, STUDENT);
    // У синонимов нет ни одного неверного варианта: все тексты допустимы для обоих слов.
    const id = await issue(db, link.id, "Подборка", [
      card("fast", "быстрый", { acceptedRuEn: ["quick"], acceptedEnRu: ["скорый"] }),
      card("quick", "скорый", { acceptedRuEn: ["fast"], acceptedEnRu: ["быстрый"] }),
    ]);
    const fake = createFakeBot(db);
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, startTest(id)));
    for (let guard = 0; guard < 2; guard++) {
      const [question] = await db.select().from(questions).where(eq(questions.status, "open"));
      expect(question?.format).toBe("typed");
      await fake.bot.handleUpdate(textUpdate(STUDENT, question!.direction === "ru_en" ? "fast" : "скорый"));
    }
    expect(sentTexts(fake.calls).at(-1)).toContain("С первой попытки: 2 из 2");
    expect((await db.select().from(sessions))[0]?.status).toBe("completed");
  });

  it("пустая подборка: тест не создаётся", async () => {
    const { link, teacher } = await connectStudent(db, STUDENT);
    const [source] = await db.insert(sourceCollections).values({ teacherUserId: teacher.id, title: "Пустая" }).returning();
    const { studentCollectionId } = await issueCollectionCopy(db, { studentLinkId: link.id, sourceCollectionId: source!.id });
    const fake = createFakeBot(db);
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, startTest(studentCollectionId)));
    expect(await db.select().from(sessions)).toHaveLength(0);
    expect(fake.calls.at(-1)?.payload.text).toBe("В этой подборке пока нет слов.");
  });
});

describe("длинные варианты", () => {
  const prefix = "this is a very long english phrase with the same beginning ";

  it("кнопка обрезана, полный текст всех вариантов в сообщении, подписи различимы", async () => {
    const { link } = await connectStudent(db, STUDENT);
    const id = await issue(db, link.id, "Фразы", [
      card(`${prefix}one`, "один"),
      card(`${prefix}two`, "два"),
      card(`${prefix}three`, "три"),
      card(`${prefix}four`, "четыре"),
    ]);
    const fake = createFakeBot(db);
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, startTest(id)));
    // Нужен вопрос с английскими вариантами: направления чередуются, поэтому он первый или второй.
    if (!sentTexts(fake.calls).at(-1)!.includes("на английский")) await answer(fake, db, STUDENT, true);

    const text = sentTexts(fake.calls).at(-1)!;
    const buttons = answerButtons(fake.calls);
    const { question } = await questionOf(db, buttons);
    expect(question.direction).toBe("ru_en");
    for (const option of question.options!) expect(text).toContain(option.text);
    expect(new Set(buttons.map((button) => button.text)).size).toBe(buttons.length);
    buttons.forEach((button, index) => {
      expect([...button.text].length).toBeLessThanOrEqual(BUTTON_LABEL_LIMIT);
      expect(button.text.startsWith(`${index + 1}. `)).toBe(true);
      expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(64);
    });

    // Запись ответа хранит полный текст, а не обрезку.
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, (await correctButton(db, buttons)).callback_data));
    const saved = (await db.select().from(attempts).where(and(eq(attempts.questionId, question.id))))[0]!;
    expect(saved.answerText.startsWith(prefix)).toBe(true);
    expect(saved.isCorrect).toBe(true);
  });

  it("короткие варианты не нумеруются и не дублируются в сообщении", async () => {
    const { link } = await connectStudent(db, STUDENT);
    const id = await issue(db, link.id, "Слова", words(4));
    const fake = createFakeBot(db);
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, startTest(id)));
    const buttons = answerButtons(fake.calls);
    expect(buttons[0]!.text).not.toMatch(/^\d\. /);
    expect(sentTexts(fake.calls).at(-1)).not.toMatch(/^1\. /m);
    const [row] = await db.select({ value: count() }).from(questions);
    expect(row?.value).toBe(1);
  });
});

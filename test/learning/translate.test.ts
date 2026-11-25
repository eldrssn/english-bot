// «Переведи меня»: ввод перевода, нормализация на спорных примерах, вторая попытка и надёжность текстовых ответов.
// Всё через настоящую обработку бота на настоящем PostgreSQL.
import { readFileSync } from "node:fs";
import { asc, count, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { collectionPage, collectionsPage, startTest, startTranslate } from "../../src/bot/callback-data.js";
import { loadFixtureCollections } from "../../src/db/fixtures.js";
import { attempts, questions, sessions } from "../../src/db/schema.js";
import { makeWordKey, sameWord } from "../../src/domain/index.js";
import { primaryAnswerText, type Direction } from "../../src/domain/learning/index.js";
import { openTestDb, resetDb } from "../helpers/db.js";
import { callbackUpdate, createFakeBot, lastButtons, newUpdateId, sentTexts, textUpdate } from "../helpers/fake-telegram.js";
import {
  WRONG_TEXT,
  answerButtons,
  answerCurrent,
  card,
  connectStudent,
  currentStep,
  issue,
  words,
  wordByPair,
} from "../helpers/learning.js";

const { db, close } = openTestDb();
afterAll(close);
beforeEach(() => resetDb(db));

const STUDENT = 74001;
const attemptCount = async () => (await db.select({ value: count() }).from(attempts))[0]?.value;

async function startedTranslate(cards = words(6)) {
  const { student, link } = await connectStudent(db, STUDENT);
  const collectionId = await issue(db, link.id, "Подборка", cards);
  const fake = createFakeBot(db);
  await fake.bot.handleUpdate(callbackUpdate(STUDENT, startTranslate(collectionId)));
  return { fake, student, link, collectionId };
}

describe("«Переведи меня»: путь ученика", () => {
  it("кнопка в подборке, вопрос без вариантов, ответ сообщением; повтор ошибки тем же направлением; итог", async () => {
    const { student, link } = await connectStudent(db, STUDENT);
    const collectionId = await issue(db, link.id, "Подборка", words(6));
    const fake = createFakeBot(db);
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, collectionsPage(0)));
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, collectionPage(collectionId, 0)));
    const start = lastButtons(fake.calls).find((button) => button.text === "Переведи меня");
    expect(start?.callback_data).toBe(startTranslate(collectionId));
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, start!.callback_data));

    const prompt = sentTexts(fake.calls).at(-1)!;
    expect(prompt).toContain("Вопрос 1 из 6");
    expect(prompt).toMatch(/Напишите перевод на (английский|русский):/);
    expect(lastButtons(fake.calls).map((button) => button.text)).toEqual(["На паузу"]);
    const [session] = await db.select().from(sessions);
    expect(session).toMatchObject({ type: "translate", studentCollectionId: collectionId });
    expect(session!.learningState!.plan.every((item) => item.format === "typed")).toBe(true);

    // Верный ответ с другим регистром и пробелами: введённый текст, ожидаемый перевод и результат.
    const first = (await currentStep(db, student.id))!;
    const expected = primaryAnswerText(first.version, first.question.direction);
    await fake.bot.handleUpdate(textUpdate(STUDENT, `  ${expected.toUpperCase()}  `));
    expect(sentTexts(fake.calls).at(-2)).toBe(
      `Верно.\nВы написали: ${expected.toUpperCase()}\nОжидаемый перевод: ${expected}\n${first.version.english} — ${first.version.primaryTranslation}`,
    );

    // Ошибка: показывает верный перевод, повтор в конце серии тем же вопросом и направлением.
    const wrong = (await currentStep(db, student.id))!;
    await fake.bot.handleUpdate(textUpdate(STUDENT, "совсем не то"));
    const feedback = sentTexts(fake.calls).at(-2)!;
    expect(feedback).toContain("Неверно.");
    expect(feedback).toContain("Вы написали: совсем не то");
    expect(feedback).toContain(`Ожидаемый перевод: ${primaryAnswerText(wrong.version, wrong.question.direction)}`);
    for (let i = 0; i < 3; i++) await answerCurrent(fake, db, STUDENT, true);
    const repeat = (await currentStep(db, student.id))!;
    expect(repeat).toMatchObject({ isRepeat: true, attemptNumber: 2 });
    expect(repeat.question.id).toBe(wrong.question.id);
    expect(repeat.question.direction).toBe(wrong.question.direction);
    expect(sentTexts(fake.calls).at(-1)).toContain("Повтор ошибки");

    // Вторая ошибка: слово в «Сложных словах», третьей попытки нет.
    await fake.bot.handleUpdate(textUpdate(STUDENT, WRONG_TEXT));
    expect(sentTexts(fake.calls).at(-2)).toContain("Слово попало в «Сложные слова»");
    expect(sentTexts(fake.calls).at(-1)).toContain("Вопрос 6 из 6");
    await answerCurrent(fake, db, STUDENT, true);

    const summary = sentTexts(fake.calls).at(-1)!;
    expect(summary).toContain("«Переведи меня» завершено: Подборка");
    expect(summary).toContain("С первой попытки: 5 из 6");
    expect(summary).toContain("После повтора: 5 из 6");
    expect(summary).toContain("Стали сложными:");
    const rows = await db.select().from(attempts).orderBy(asc(attempts.id));
    expect(rows.map((row) => [row.attemptNumber, row.isCorrect])).toEqual([
      [1, true],
      [1, false],
      [1, true],
      [1, true],
      [1, true],
      [2, false],
      [1, true],
    ]);
    expect(rows.every((row) => row.selectedOptionIndex === null && row.studentLinkId === link.id)).toBe(true);
    expect(rows[0]!.answerText).toBe(expected.toUpperCase());
    const hard = await wordByPair(db, student.id, wrong.version.english, wrong.version.primaryTranslation);
    expect(hard.status).toBe("hard");
  });

  it("тест и «Переведи меня» по одной подборке — разные занятия, каждое продолжается своей кнопкой", async () => {
    const { link } = await connectStudent(db, STUDENT);
    const collectionId = await issue(db, link.id, "Подборка", words(4));
    const fake = createFakeBot(db);
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, startTest(collectionId)));
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, startTranslate(collectionId)));
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, startTranslate(collectionId)));
    const rows = await db.select().from(sessions).orderBy(asc(sessions.id));
    expect(rows.map((row) => [row.type, row.status])).toEqual([
      ["test", "paused"],
      ["translate", "current"],
    ]);
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, collectionPage(collectionId, 0)));
    const labels = lastButtons(fake.calls).map((button) => button.text);
    expect(labels).toContain("Продолжить тест");
    expect(labels).toContain("Продолжить «Переведи меня»");
    await fake.bot.handleUpdate(textUpdate(STUDENT, "/start"));
    expect(lastButtons(fake.calls).map((button) => button.text)).toContain("Продолжить «Переведи меня»: Подборка");
  });
});

describe("спорные примеры из fixtures оцениваются предсказуемо", () => {
  type Row = { english: string; translation: string; direction: Direction; input: string; expected: boolean; note: string };
  const { answers } = JSON.parse(readFileSync("fixtures/expected-results.json", "utf8")) as { answers: Row[] };

  it("каждый ответ таблицы через бота даёт ожидаемый результат; текст без букв попыткой не считается", async () => {
    const { student, link } = await connectStudent(db, STUDENT);
    const fixtureCards = (await loadFixtureCollections()).flatMap((collection) => collection.cards);

    // Каждая карточка слова — отдельной подборкой: слово одно, допустимые ответы всех его карточек объединяются.
    const collectionOf = new Map<string, number>();
    const keyOf = (english: string, translation: string) => JSON.stringify(makeWordKey(english, translation));
    for (const row of answers) {
      const key = keyOf(row.english, row.translation);
      if (collectionOf.has(key)) continue;
      const cards = fixtureCards.filter((item) => sameWord(makeWordKey(item.english, item.translation), makeWordKey(row.english, row.translation)));
      expect(cards.length, `${row.english} — ${row.translation}`).toBeGreaterThan(0);
      let first: number | undefined;
      for (const [index, item] of cards.entries()) {
        const id = await issue(db, link.id, `${row.english} — ${row.translation} #${index}`, [item]);
        first ??= id;
      }
      collectionOf.set(key, first!);
    }

    const mismatches: string[] = [];
    for (const row of answers) {
      // В подборке одно слово: направление задаёт единственный вызов генератора.
      const fake = createFakeBot(db, { rng: () => (row.direction === "ru_en" ? 0 : 0.75) });
      await fake.bot.handleUpdate(callbackUpdate(STUDENT, startTranslate(collectionOf.get(keyOf(row.english, row.translation))!)));
      const step = (await currentStep(db, student.id))!;
      expect(step.question.direction).toBe(row.direction);
      const before = await attemptCount();
      await fake.bot.handleUpdate(textUpdate(STUDENT, row.input));
      const added = await db.select().from(attempts).where(eq(attempts.questionId, step.question.id));

      if (row.input.trim() === "" || /^[\p{P}\p{S}\s]*$/u.test(row.input)) {
        // Пустой ответ и одна пунктуация не засчитываются верными и не тратят попытку.
        if (added.length !== 0 || (await attemptCount()) !== before) mismatches.push(`«${row.input}»: записана попытка`);
        if (!sentTexts(fake.calls).at(-1)!.includes("нет ни одной буквы")) mismatches.push(`«${row.input}»: нет подсказки`);
      } else if (added[0]?.isCorrect !== row.expected) {
        mismatches.push(`${row.english} — ${row.translation}, ${row.direction}, «${row.input}»: ${added[0]?.isCorrect} (${row.note})`);
      }
      // Довести занятие до конца, чтобы следующее по этой подборке началось заново.
      for (let guard = 0; guard < 3 && (await currentStep(db, student.id)); guard++) {
        await answerCurrent(fake, db, STUDENT, true);
      }
    }
    expect(mismatches).toEqual([]);
  });
});

describe("текстовый ответ относится только к открытому вопросу текущего занятия", () => {
  it("без текущего занятия: меню, попытки нет", async () => {
    const { fake } = await startedTranslate();
    await db.update(sessions).set({ status: "paused" });
    const step = await db.select().from(questions);
    await fake.bot.handleUpdate(textUpdate(STUDENT, "слово-word-1"));
    expect(await attemptCount()).toBe(0);
    expect(sentTexts(fake.calls).at(-1)).toContain("Выберите раздел");
    expect(lastButtons(fake.calls).some((button) => button.text.startsWith("Продолжить"))).toBe(true);
    expect((await db.select().from(questions))[0]!.status).toBe(step[0]!.status);
  });

  it("при нескольких занятиях ответ попадает только в текущее; у текущего вопрос с кнопками — подсказка", async () => {
    const { fake, student, link } = await startedTranslate();
    const typed = (await currentStep(db, student.id))!;
    const other = await issue(db, link.id, "Другая", words(5, "other"));
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, startTest(other)));
    await fake.bot.handleUpdate(textUpdate(STUDENT, primaryAnswerText(typed.version, typed.question.direction)));
    expect(await attemptCount()).toBe(0);
    expect(sentTexts(fake.calls).at(-1)).toContain("Сейчас ответ выбирается кнопкой");
    expect(answerButtons(fake.calls)).toHaveLength(0);
  });

  it("команда во время вопроса — не ответ", async () => {
    const { fake } = await startedTranslate();
    await fake.bot.handleUpdate(textUpdate(STUDENT, "/start"));
    await fake.bot.handleUpdate(textUpdate(STUDENT, "/unknown"));
    expect(await attemptCount()).toBe(0);
    expect(sentTexts(fake.calls).at(-1)).toContain("Выберите раздел");
  });

  it("текст без букв: подсказка, попытки нет, вопрос остаётся открытым", async () => {
    const { fake, student } = await startedTranslate();
    const before = (await currentStep(db, student.id))!;
    await fake.bot.handleUpdate(textUpdate(STUDENT, "?!"));
    expect(await attemptCount()).toBe(0);
    expect(sentTexts(fake.calls).at(-1)).toContain("нет ни одной буквы");
    expect((await currentStep(db, student.id))!.question.id).toBe(before.question.id);
  });

  it("сообщение, отправленное раньше показа вопроса (двойная отправка), не засчитывается следующему вопросу", async () => {
    const { fake, student } = await startedTranslate();
    const first = (await currentStep(db, student.id))!;
    const text = primaryAnswerText(first.version, first.question.direction);
    // Оба сообщения отправлены до того, как бот показал следующий вопрос.
    const original = textUpdate(STUDENT, text);
    const duplicate = textUpdate(STUDENT, text);
    await fake.bot.handleUpdate(original);
    const second = (await currentStep(db, student.id))!;
    await fake.bot.handleUpdate(duplicate);
    expect(await attemptCount()).toBe(1);
    expect(sentTexts(fake.calls).at(-2)).toContain("отправлено раньше вопроса");
    // Вопрос показан заново и принимает ответ, отправленный после показа.
    expect(sentTexts(fake.calls).at(-1)).toContain("Напишите перевод");
    expect((await currentStep(db, student.id))!.question.id).toBe(second.question.id);
    await answerCurrent(fake, db, STUDENT, true);
    expect(await attemptCount()).toBe(2);
  });

  it("показ вопроса не записан (сбой после отправки): ответ не засчитан, вопрос показан снова и дальше принимается", async () => {
    const { fake, student } = await startedTranslate();
    await db.update(questions).set({ promptMessageId: null });
    await answerCurrent(fake, db, STUDENT, true);
    expect(await attemptCount()).toBe(0);
    expect((await currentStep(db, student.id))!.question.promptMessageId).not.toBeNull();
    await answerCurrent(fake, db, STUDENT, true);
    expect(await attemptCount()).toBe(1);
  });

  it("повторная доставка того же update_id ничего не меняет", async () => {
    const { fake, student } = await startedTranslate();
    const step = (await currentStep(db, student.id))!;
    const update = textUpdate(STUDENT, primaryAnswerText(step.version, step.question.direction));
    await fake.bot.handleUpdate(update);
    const calls = fake.calls.length;
    await fake.bot.handleUpdate(update);
    expect(fake.calls.length).toBe(calls);
    expect(await attemptCount()).toBe(1);
  });

  it("одновременные сообщения дают одну попытку и один шаг вперёд", async () => {
    const { fake, student } = await startedTranslate();
    const step = (await currentStep(db, student.id))!;
    const text = primaryAnswerText(step.version, step.question.direction);
    const updates = Array.from({ length: 4 }, () => textUpdate(STUDENT, text, newUpdateId()));
    await Promise.all(updates.map((update) => fake.bot.handleUpdate(update)));
    expect(await attemptCount()).toBe(1);
    const [session] = await db.select().from(sessions);
    expect(session!.learningState!.cursor).toBe(1);
  });

  it("попытка неизменна: UPDATE отклоняется базой", async () => {
    const { fake } = await startedTranslate();
    await answerCurrent(fake, db, STUDENT, false);
    const error = await db
      .update(attempts)
      .set({ isCorrect: true })
      .then(
        () => null,
        (reason: unknown) => reason as { cause?: { message?: string } },
      );
    expect(error?.cause?.message).toMatch(/неизменна/);
    expect((await db.select().from(attempts))[0]!.isCorrect).toBe(false);
    // Без триггера запрос прошёл бы: проверяем, что он на месте.
    const triggers = await db.execute(sql`SELECT tgname FROM pg_trigger WHERE tgname = 'attempts_immutable'`);
    expect(triggers.rows).toHaveLength(1);
  });
});

describe("длинный ввод", () => {
  it("ответ целиком сохранён в попытке, в сообщении бота обрезан и укладывается в лимит", async () => {
    const { fake } = await startedTranslate([card("alpha", "альфа"), card("beta", "бета")]);
    const long = "очень длинный ответ ".repeat(200);
    await fake.bot.handleUpdate(textUpdate(STUDENT, long));
    const [attempt] = await db.select().from(attempts);
    expect(attempt!.answerText).toBe(long.trim());
    const feedback = sentTexts(fake.calls).at(-2)!;
    expect(feedback.length).toBeLessThan(1000);
    expect(feedback).toContain("…");
  });
});

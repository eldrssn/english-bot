import { readFileSync } from "node:fs";
import { and, count, eq, isNull } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { issueCollectionCopy, listCurrentCards } from "../src/db/collections.js";
import { loadFixtureCollections, seedFixtures, type FixtureCard } from "../src/db/fixtures.js";
import { sourceCards, sourceCollections, studentCards, studentLinks, studentWords, users } from "../src/db/schema.js";
import { makeWordKey, sameWord } from "../src/domain/index.js";
import { checkAnswer, type AnswerCard } from "../src/domain/learning/index.js";
import { openTestDb, resetDb } from "./helpers/db.js";

const expectedSchema = z.object({
  answers: z.array(
    z.object({
      english: z.string(),
      translation: z.string(),
      direction: z.enum(["ru_en", "en_ru"]),
      input: z.string(),
      expected: z.boolean(),
      note: z.string(),
    }),
  ),
  wordIdentity: z.array(
    z.object({
      a: z.tuple([z.string(), z.string()]),
      b: z.tuple([z.string(), z.string()]),
      same: z.boolean(),
      note: z.string(),
    }),
  ),
});

const expected = expectedSchema.parse(JSON.parse(readFileSync("fixtures/expected-results.json", "utf8")));
const collections = await loadFixtureCollections();
const allCards = collections.flatMap((collection) => collection.cards);

const answerCards = (cards: FixtureCard[]): AnswerCard[] =>
  cards.map((card) => ({ ...card, primaryTranslation: card.translation }));

describe("таблица ожидаемых результатов", () => {
  it.each(expected.answers)("$english — $translation, $direction: $input → $expected ($note)", (row) => {
    const key = makeWordKey(row.english, row.translation);
    const cards = allCards.filter((card) => sameWord(makeWordKey(card.english, card.translation), key));
    expect(cards.length, "слово должно быть в тестовых подборках").toBeGreaterThan(0);
    expect(checkAnswer(answerCards(cards), row.direction, row.input).isCorrect).toBe(row.expected);
  });

  it.each(expected.wordIdentity)("$a и $b: $same ($note)", (row) => {
    expect(sameWord(makeWordKey(...row.a), makeWordKey(...row.b))).toBe(row.same);
  });
});

describe("состав тестовых подборок", () => {
  const pairs = allCards.map((card) => makeWordKey(card.english, card.translation));
  const hasPair = (english: string, translation: string) =>
    pairs.filter((pair) => sameWord(pair, makeWordKey(english, translation))).length;

  it("содержит нужные спорные случаи", () => {
    expect(collections.length).toBeGreaterThanOrEqual(2);
    expect(hasPair("fast", "быстрый")).toBe(2);
    expect(hasPair("bank", "банк")).toBe(1);
    expect(hasPair("bank", "берег")).toBe(1);
    expect(allCards.some((card) => card.english.startsWith("to ") && card.allowOmitTo)).toBe(true);
    expect(allCards.some((card) => card.english.startsWith("to ") && !card.allowOmitTo)).toBe(true);
    expect(allCards.some((card) => card.translation.includes("ё"))).toBe(true);
    expect(allCards.some((card) => card.english.includes(" "))).toBe(true);
  });
});

describe("загрузка в базу", () => {
  const { db, close } = openTestDb();
  beforeEach(() => resetDb(db));
  afterAll(close);

  async function seededCollection(title: string) {
    const [row] = await db.select().from(sourceCollections).where(eq(sourceCollections.title, title));
    return row!;
  }

  it("повторная загрузка не создаёт дублей и обновляет содержимое", async () => {
    const first = await seedFixtures(db, collections);
    expect(first.cardCount).toBe(allCards.length);
    await seedFixtures(db, collections);
    const [cards] = await db.select({ value: count() }).from(sourceCards);
    const [cols] = await db.select({ value: count() }).from(sourceCollections);
    expect(cards?.value).toBe(allCards.length);
    expect(cols?.value).toBe(collections.length);

    const shortened = [{ ...collections[0]!, cards: collections[0]!.cards.slice(1) }];
    await seedFixtures(db, shortened);
    const hidden = await db.select().from(sourceCards).where(eq(sourceCards.english, "breakfast"));
    expect(hidden[0]?.deletedAt).not.toBeNull();
    const alive = await db
      .select({ value: count() })
      .from(sourceCards)
      .where(and(eq(sourceCards.english, "lunch"), isNull(sourceCards.deletedAt)));
    expect(alive[0]?.value).toBe(1);
  });

  it("совпавшая пара становится одним словом, bank — банк и bank — берег остаются разными", async () => {
    await seedFixtures(db, collections);
    const everyday = await seededCollection("Базовые слова");
    const travel = await seededCollection("Путешествие");
    const [student] = await db.insert(users).values({ telegramId: 5001, role: "student" }).returning();
    const [link] = await db
      .insert(studentLinks)
      .values({
        teacherUserId: everyday.teacherUserId,
        displayName: "Анна",
        studentUserId: student!.id,
        status: "active",
        startedAt: new Date(),
      })
      .returning();

    const a = await issueCollectionCopy(db, { studentLinkId: link!.id, sourceCollectionId: everyday.id });
    const b = await issueCollectionCopy(db, { studentLinkId: link!.id, sourceCollectionId: travel.id });
    const again = await issueCollectionCopy(db, { studentLinkId: link!.id, sourceCollectionId: travel.id });
    expect(again).toEqual({ studentCollectionId: b.studentCollectionId, created: false });

    const words = await db.select().from(studentWords).where(eq(studentWords.studentUserId, student!.id));
    expect(words.filter((word) => word.normalizedEnglish === "fast")).toHaveLength(1);
    expect(
      words
        .filter((word) => word.normalizedEnglish === "bank")
        .map((word) => word.normalizedTranslation)
        .sort(),
    ).toEqual(["банк", "берег"]);

    const fast = words.find((word) => word.normalizedEnglish === "fast")!;
    const linked = await db.select().from(studentCards).where(eq(studentCards.studentWordId, fast.id));
    expect(linked.map((card) => card.studentCollectionId).sort()).toEqual(
      [a.studentCollectionId, b.studentCollectionId].sort(),
    );

    const cards = await listCurrentCards(db, a.studentCollectionId);
    expect(cards[0]?.version.english).toBe("breakfast");
    expect(cards[0]?.version.versionNumber).toBe(1);
  });

  it("копия записи без Telegram-аккаунта хранится, карточки пока без слова", async () => {
    await seedFixtures(db, collections);
    const everyday = await seededCollection("Базовые слова");
    const [link] = await db
      .insert(studentLinks)
      .values({ teacherUserId: everyday.teacherUserId, displayName: "Пётр" })
      .returning();
    const { studentCollectionId } = await issueCollectionCopy(db, {
      studentLinkId: link!.id,
      sourceCollectionId: everyday.id,
    });
    const cards = await listCurrentCards(db, studentCollectionId);
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.every(({ card }) => card.studentWordId === null)).toBe(true);
  });
});

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { and, eq, isNull, notInArray } from "drizzle-orm";
import { z } from "zod";
import { makeWordKey, sameWord } from "../domain/index.js";
import type { Db } from "./client.js";
import { adminAuditLog, sourceCards, sourceCollections, users } from "./schema.js";

/** Служебный преподаватель тестовых подборок. Отрицательный ID не совпадёт с аккаунтом Telegram. */
export const SEED_TEACHER_TELEGRAM_ID = -1;
/** Подборка с карточкой breakfast: её чаще всего выдают ученику тесты. */
export const BASIC_COLLECTION_TITLE = "Базовые слова";

const fixtureCardSchema = z.object({
  english: z.string().min(1),
  translation: z.string().min(1),
  acceptedRuEn: z.array(z.string()),
  acceptedEnRu: z.array(z.string()),
  allowOmitTo: z.boolean(),
  example: z.string().nullable(),
  explanation: z.string().nullable(),
});

const fixtureCollectionSchema = z.object({
  title: z.string().min(1),
  cards: z.array(fixtureCardSchema).min(1),
});

export type FixtureCard = z.infer<typeof fixtureCardSchema>;
export type FixtureCollection = z.infer<typeof fixtureCollectionSchema>;

export const defaultFixturesDir = () => path.resolve(process.cwd(), "fixtures");

export async function loadFixtureCollections(dir = defaultFixturesDir()): Promise<FixtureCollection[]> {
  const collectionsDir = path.join(dir, "collections");
  const files = (await readdir(collectionsDir)).filter((name) => name.endsWith(".json")).sort();
  return Promise.all(
    files.map(async (name) => {
      const raw: unknown = JSON.parse(await readFile(path.join(collectionsDir, name), "utf8"));
      return fixtureCollectionSchema.parse(raw);
    }),
  );
}

/**
 * Загружает тестовые подборки как материалы служебного преподавателя.
 * Повторный запуск приводит их к содержимому файлов и не создаёт дублей.
 */
export async function seedFixtures(db: Db, collections: FixtureCollection[]) {
  return db.transaction(async (tx) => {
    const [existingTeacher] = await tx
      .select()
      .from(users)
      .where(eq(users.telegramId, SEED_TEACHER_TELEGRAM_ID));
    let teacherId = existingTeacher?.id;
    if (!teacherId) {
      const [created] = await tx
        .insert(users)
        .values({ telegramId: SEED_TEACHER_TELEGRAM_ID, role: "teacher", telegramFirstName: "Тестовый преподаватель" })
        .returning({ id: users.id });
      if (!created) throw new Error("Служебный преподаватель не создан");
      teacherId = created.id;
      await tx.insert(adminAuditLog).values({ actor: "db:seed", targetUserId: teacherId, newRole: "teacher" });
    }

    let cardCount = 0;
    for (const fixture of collections) {
      const [existing] = await tx
        .select({ id: sourceCollections.id })
        .from(sourceCollections)
        .where(and(eq(sourceCollections.teacherUserId, teacherId), eq(sourceCollections.title, fixture.title)));
      let collectionId = existing?.id;
      if (!collectionId) {
        const [created] = await tx
          .insert(sourceCollections)
          .values({ teacherUserId: teacherId, title: fixture.title })
          .returning({ id: sourceCollections.id });
        if (!created) throw new Error("Подборка не создана");
        collectionId = created.id;
      }

      const present = await tx.select().from(sourceCards).where(eq(sourceCards.collectionId, collectionId));
      const keptIds: number[] = [];
      for (const [position, card] of fixture.cards.entries()) {
        const key = makeWordKey(card.english, card.translation);
        const match = present.find((row) => sameWord(makeWordKey(row.english, row.primaryTranslation), key));
        const values = {
          position,
          english: card.english,
          primaryTranslation: card.translation,
          acceptedRuEn: card.acceptedRuEn,
          acceptedEnRu: card.acceptedEnRu,
          example: card.example,
          explanation: card.explanation,
          allowOmitTo: card.allowOmitTo,
          deletedAt: null,
        };
        if (match) {
          await tx.update(sourceCards).set(values).where(eq(sourceCards.id, match.id));
          keptIds.push(match.id);
        } else {
          const [created] = await tx
            .insert(sourceCards)
            .values({ ...values, collectionId })
            .returning({ id: sourceCards.id });
          if (!created) throw new Error("Карточка не создана");
          keptIds.push(created.id);
        }
        cardCount += 1;
      }
      // Карточки, которых больше нет в файле, только скрываются: на них могут ссылаться копии.
      await tx
        .update(sourceCards)
        .set({ deletedAt: new Date() })
        .where(
          and(
            eq(sourceCards.collectionId, collectionId),
            isNull(sourceCards.deletedAt),
            notInArray(sourceCards.id, keptIds),
          ),
        );
    }
    return { teacherUserId: teacherId, collectionCount: collections.length, cardCount };
  });
}

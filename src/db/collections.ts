import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { makeWordKey } from "../domain/index.js";
import type { DbOrTx } from "./client.js";
import {
  cardVersions,
  sourceCards,
  sourceCollections,
  studentCards,
  studentCollections,
  studentLinks,
  studentWords,
} from "./schema.js";

/** Возвращает слово ученика для пары текст и перевод, создавая его при первой встрече. */
export async function upsertStudentWord(
  db: DbOrTx,
  studentUserId: number,
  english: string,
  translation: string,
): Promise<number> {
  const key = makeWordKey(english, translation);
  await db
    .insert(studentWords)
    .values({ studentUserId, ...key })
    .onConflictDoNothing({
      target: [studentWords.studentUserId, studentWords.normalizedEnglish, studentWords.normalizedTranslation],
    });
  const [word] = await db
    .select({ id: studentWords.id })
    .from(studentWords)
    .where(
      and(
        eq(studentWords.studentUserId, studentUserId),
        eq(studentWords.normalizedEnglish, key.normalizedEnglish),
        eq(studentWords.normalizedTranslation, key.normalizedTranslation),
      ),
    );
  if (!word) throw new Error("Слово ученика не найдено сразу после вставки");
  return word.id;
}

/**
 * Выдаёт независимую копию подборки записи ученика: карточки и первые версии.
 * Карточки связываются со словами ученика только при активной связи: заявитель
 * не получает материалов, пока преподаватель не подтвердил заявку.
 * Повторный вызов возвращает прежнюю копию. Вызывать внутри транзакции.
 */
export async function issueCollectionCopy(
  tx: DbOrTx,
  input: { studentLinkId: number; sourceCollectionId: number },
): Promise<{ studentCollectionId: number; created: boolean }> {
  const [source] = await tx
    .select({ title: sourceCollections.title })
    .from(sourceCollections)
    .where(and(eq(sourceCollections.id, input.sourceCollectionId), isNull(sourceCollections.deletedAt)));
  if (!source) throw new Error(`Исходная подборка ${input.sourceCollectionId} не найдена`);

  const [link] = await tx
    .select({ studentUserId: studentLinks.studentUserId, status: studentLinks.status })
    .from(studentLinks)
    .where(eq(studentLinks.id, input.studentLinkId));
  if (!link) throw new Error(`Запись ученика ${input.studentLinkId} не найдена`);
  // После отвязки новых материалов нет: ученик занимается только по уже полученным копиям.
  if (link.status === "ended") throw new Error(`Связь ${input.studentLinkId} завершена: новые материалы не выдаются`);

  const [inserted] = await tx
    .insert(studentCollections)
    .values({ ...input, title: source.title })
    .onConflictDoNothing()
    .returning({ id: studentCollections.id, publishedAt: studentCollections.publishedAt });
  if (!inserted) {
    const [existing] = await tx
      .select({ id: studentCollections.id })
      .from(studentCollections)
      .where(
        and(
          eq(studentCollections.studentLinkId, input.studentLinkId),
          eq(studentCollections.sourceCollectionId, input.sourceCollectionId),
          isNull(studentCollections.deletedAt),
        ),
      );
    if (!existing) throw new Error("Копия подборки не найдена после конфликта вставки");
    return { studentCollectionId: existing.id, created: false };
  }

  const cards = await tx
    .select()
    .from(sourceCards)
    .where(and(eq(sourceCards.collectionId, input.sourceCollectionId), isNull(sourceCards.deletedAt)))
    .orderBy(asc(sourceCards.position));

  for (const card of cards) {
    const studentWordId =
      link.status === "active" && link.studentUserId
      ? await upsertStudentWord(tx, link.studentUserId, card.english, card.primaryTranslation)
      : null;
    const [copy] = await tx
      .insert(studentCards)
      .values({
        studentCollectionId: inserted.id,
        sourceCardId: card.id,
        studentWordId,
        position: card.position,
        // Карточка из самой выдачи не считается добавленной позже: новой будет только дополнение.
        addedAt: inserted.publishedAt,
      })
      .returning({ id: studentCards.id });
    if (!copy) throw new Error("Карточка копии не создана");
    await tx.insert(cardVersions).values({
      studentCardId: copy.id,
      versionNumber: 1,
      english: card.english.trim(),
      primaryTranslation: card.primaryTranslation.trim(),
      acceptedRuEn: card.acceptedRuEn,
      acceptedEnRu: card.acceptedEnRu,
      example: card.example,
      explanation: card.explanation,
      allowOmitTo: card.allowOmitTo,
    });
  }
  return { studentCollectionId: inserted.id, created: true };
}

/**
 * После подтверждения связи заполняет student_word_id у ранее выданных копий.
 * Удалённые карточки тоже получают слово: им нужна целостная история. Вызывать внутри транзакции.
 */
export async function attachCardsToStudent(tx: DbOrTx, studentLinkId: number, studentUserId: number) {
  const rows = await tx
    .select({ cardId: studentCards.id, english: cardVersions.english, translation: cardVersions.primaryTranslation })
    .from(studentCards)
    .innerJoin(studentCollections, eq(studentCollections.id, studentCards.studentCollectionId))
    .innerJoin(cardVersions, eq(cardVersions.studentCardId, studentCards.id))
    .where(
      and(
        eq(studentCollections.studentLinkId, studentLinkId),
        isNull(studentCards.studentWordId),
        eq(
          cardVersions.versionNumber,
          sql`(SELECT max(v.version_number) FROM card_versions v WHERE v.student_card_id = ${studentCards.id})`,
        ),
      ),
    )
    .orderBy(asc(studentCards.id));
  for (const row of rows) {
    const studentWordId = await upsertStudentWord(tx, studentUserId, row.english, row.translation);
    await tx.update(studentCards).set({ studentWordId }).where(eq(studentCards.id, row.cardId));
  }
  return rows.length;
}

/** Действующие карточки копии с текущими (последними) версиями в порядке подборки. */
export async function listCurrentCards(db: DbOrTx, studentCollectionId: number) {
  return db
    .select({ card: studentCards, version: cardVersions })
    .from(studentCards)
    .innerJoin(cardVersions, eq(cardVersions.studentCardId, studentCards.id))
    .where(
      and(
        eq(studentCards.studentCollectionId, studentCollectionId),
        isNull(studentCards.deletedAt),
        eq(
          cardVersions.versionNumber,
          sql`(SELECT max(v.version_number) FROM card_versions v WHERE v.student_card_id = ${studentCards.id})`,
        ),
      ),
    )
    .orderBy(asc(studentCards.position), asc(studentCards.id));
}

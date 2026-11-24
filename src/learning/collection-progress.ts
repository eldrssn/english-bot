// Статус подборки хранится в копии и обновляется при каждом просмотре и ответе.
import { and, eq, inArray, sql } from "drizzle-orm";
import type { DbOrTx } from "../db/client.js";
import { studentCards, studentCollections, studentLinks } from "../db/schema.js";
import { computeCollectionStatus, type CollectionCardProgress, type CollectionStatus } from "../domain/learning/index.js";

/**
 * Пересчитывает статусы подборок ученика, где есть эти слова или которые названы явно.
 * Ответ считается по слову: ответ на `fast` из одной подборки засчитан и в другой.
 * При активной связи считаются только ответы этой связи: статус новой копии не раскрывает новому
 * преподавателю результаты прежнего периода. У копии завершённой связи считаются все ответы.
 */
export async function refreshCollectionStatuses(
  tx: DbOrTx,
  studentUserId: number,
  scope: { wordIds?: number[]; collectionIds?: number[] },
) {
  const wordIds = scope.wordIds ?? [];
  const byWord =
    wordIds.length === 0
      ? []
      : await tx
          .selectDistinct({ id: studentCards.studentCollectionId })
          .from(studentCards)
          .where(inArray(studentCards.studentWordId, wordIds));
  const collectionIds = [...new Set([...(scope.collectionIds ?? []), ...byWord.map((row) => row.id)])];
  if (collectionIds.length === 0) return;

  const rows = await tx
    .select({
      collectionId: studentCollections.id,
      currentStatus: studentCollections.status,
      cardId: studentCards.id,
      isDeleted: sql<boolean>`${studentCards.deletedAt} IS NOT NULL`,
      wasViewed: sql<boolean>`EXISTS (SELECT 1 FROM card_views cv WHERE cv.student_card_id = ${studentCards.id})`,
      hasAnswer: sql<boolean>`EXISTS (
        SELECT 1 FROM attempts a JOIN questions q ON q.id = a.question_id
        WHERE q.student_word_id = ${studentCards.studentWordId}
          AND (${studentLinks.status} <> 'active' OR a.student_link_id = ${studentLinks.id})
      )`,
    })
    .from(studentCollections)
    .innerJoin(studentLinks, eq(studentLinks.id, studentCollections.studentLinkId))
    .leftJoin(studentCards, eq(studentCards.studentCollectionId, studentCollections.id))
    .where(and(inArray(studentCollections.id, collectionIds), eq(studentLinks.studentUserId, studentUserId)));

  const grouped = new Map<number, { current: CollectionStatus; cards: CollectionCardProgress[] }>();
  for (const row of rows) {
    const group = grouped.get(row.collectionId) ?? { current: row.currentStatus, cards: [] };
    grouped.set(row.collectionId, group);
    if (row.cardId !== null) {
      group.cards.push({ isDeleted: row.isDeleted, wasViewed: row.wasViewed, hasAnswer: row.hasAnswer });
    }
  }
  for (const [id, { current, cards }] of grouped) {
    const status = computeCollectionStatus(cards);
    if (status !== current) await tx.update(studentCollections).set({ status }).where(eq(studentCollections.id, id));
  }
}

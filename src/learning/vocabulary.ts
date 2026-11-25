// Что ученик видит в словаре. Единственное место, решающее, какие материалы ему открыты.
import { and, asc, desc, eq, exists, inArray, isNotNull, isNull, or, sql, type Column, type SQL } from "drizzle-orm";
import type { DbOrTx } from "../db/client.js";
import { cardVersions, studentCards, studentCollections, studentLinks } from "../db/schema.js";

export type CardVersionRow = typeof cardVersions.$inferSelect;

/**
 * Копии ученика открыты при активной связи и после отвязки. Запись заявителя сюда не попадает:
 * у неё статус pending_confirmation, а при отклонении student_user_id очищается.
 */
function ownedVisibleLink(studentUserId: number | Column): SQL {
  return and(
    eq(studentLinks.studentUserId, studentUserId),
    or(eq(studentLinks.status, "active"), eq(studentLinks.status, "ended")),
    isNotNull(studentLinks.startedAt),
    isNull(studentCollections.deletedAt),
  ) as SQL;
}

/**
 * Условие «у ученика есть хотя бы одна действующая карточка» для запроса по нескольким ученикам
 * (планировщик напоминаний). Правило видимости то же, что у listVisibleCards.
 */
export function visibleCardExists(db: DbOrTx, studentUserId: Column): SQL<boolean> {
  return exists(
    db
      .select({ one: sql`1` })
      .from(studentCards)
      .innerJoin(studentCollections, eq(studentCollections.id, studentCards.studentCollectionId))
      .innerJoin(studentLinks, eq(studentLinks.id, studentCollections.studentLinkId))
      .where(and(ownedVisibleLink(studentUserId), isNull(studentCards.deletedAt), isNotNull(studentCards.studentWordId))),
  ) as SQL<boolean>;
}

export type VisibleCard = {
  cardId: number;
  studentWordId: number;
  collectionId: number;
  collectionTitle: string;
  collectionLinkId: number;
  publishedAt: Date;
  addedAt: Date;
  position: number;
  version: CardVersionRow;
};

/** Действующие карточки ученика с текущими версиями: основа словаря, вариантов ответа и проверки. */
export async function listVisibleCards(
  db: DbOrTx,
  studentUserId: number,
  filter: { collectionId?: number; studentWordId?: number; cardIds?: number[] } = {},
): Promise<VisibleCard[]> {
  const rows = await db
    .select({
      cardId: studentCards.id,
      studentWordId: studentCards.studentWordId,
      collectionId: studentCollections.id,
      collectionTitle: studentCollections.title,
      collectionLinkId: studentCollections.studentLinkId,
      publishedAt: studentCollections.publishedAt,
      addedAt: studentCards.addedAt,
      position: studentCards.position,
      version: cardVersions,
    })
    .from(studentCards)
    .innerJoin(studentCollections, eq(studentCollections.id, studentCards.studentCollectionId))
    .innerJoin(studentLinks, eq(studentLinks.id, studentCollections.studentLinkId))
    .innerJoin(cardVersions, eq(cardVersions.studentCardId, studentCards.id))
    .where(
      and(
        ownedVisibleLink(studentUserId),
        isNull(studentCards.deletedAt),
        isNotNull(studentCards.studentWordId),
        eq(
          cardVersions.versionNumber,
          sql`(SELECT max(v.version_number) FROM card_versions v WHERE v.student_card_id = ${studentCards.id})`,
        ),
        ...(filter.collectionId === undefined ? [] : [eq(studentCollections.id, filter.collectionId)]),
        ...(filter.studentWordId === undefined ? [] : [eq(studentCards.studentWordId, filter.studentWordId)]),
        ...(filter.cardIds === undefined ? [] : [inArray(studentCards.id, filter.cardIds)]),
      ),
    )
    .orderBy(asc(studentCollections.id), asc(studentCards.position), asc(studentCards.id));
  return rows.map((row) => ({ ...row, studentWordId: row.studentWordId as number }));
}

export type VocabularyWord = {
  studentWordId: number;
  english: string;
  translation: string;
  example: string | null;
  explanation: string | null;
  /** Подборки, где встречается слово, без повторов. */
  sources: string[];
  cards: VisibleCard[];
};

/** Объединяет совпавшие карточки: слово показывается один раз по самой свежей версии, с указанием всех подборок. */
export function groupWords(cards: readonly VisibleCard[]): VocabularyWord[] {
  const byWord = new Map<number, VisibleCard[]>();
  for (const card of cards) {
    const group = byWord.get(card.studentWordId);
    if (group) group.push(card);
    else byWord.set(card.studentWordId, [card]);
  }
  const words = [...byWord.entries()].map(([studentWordId, group]): VocabularyWord => {
    const latest = group.reduce((a, b) => (b.version.id > a.version.id ? b : a));
    return {
      studentWordId,
      english: latest.version.english,
      translation: latest.version.primaryTranslation,
      example: latest.version.example,
      explanation: latest.version.explanation,
      sources: [...new Set(group.map((card) => card.collectionTitle))],
      cards: group,
    };
  });
  return words.sort(
    (a, b) =>
      a.english.localeCompare(b.english, "en", { sensitivity: "base" }) ||
      a.translation.localeCompare(b.translation, "ru", { sensitivity: "base" }) ||
      a.studentWordId - b.studentWordId,
  );
}

export type VisibleCollection = {
  id: number;
  title: string;
  publishedAt: Date;
  status: (typeof studentCollections.$inferSelect)["status"];
  wordCount: number;
};

/** Подборки ученика по дате публикации: сначала новые. */
export async function listVisibleCollections(
  db: DbOrTx,
  studentUserId: number,
  collectionId?: number,
): Promise<VisibleCollection[]> {
  return db
    .select({
      id: studentCollections.id,
      title: studentCollections.title,
      publishedAt: studentCollections.publishedAt,
      status: studentCollections.status,
      wordCount: sql<number>`count(${studentCards.id})::int`,
    })
    .from(studentCollections)
    .innerJoin(studentLinks, eq(studentLinks.id, studentCollections.studentLinkId))
    .leftJoin(
      studentCards,
      and(
        eq(studentCards.studentCollectionId, studentCollections.id),
        isNull(studentCards.deletedAt),
        isNotNull(studentCards.studentWordId),
      ),
    )
    .where(
      and(
        ownedVisibleLink(studentUserId),
        ...(collectionId === undefined ? [] : [eq(studentCollections.id, collectionId)]),
      ),
    )
    .groupBy(studentCollections.id)
    .orderBy(desc(studentCollections.publishedAt), desc(studentCollections.id));
}

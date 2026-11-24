// Исходные подборки преподавателя: создание, карточки, порядок, импорт.
// Правка оригинала не меняет выданные копии: у копий свои карточки и версии.
// Подзапросы счётчиков пишут имена таблиц явно: drizzle выводит поля выборки без имени таблицы.
// Каждое изменение карточек блокирует строку подборки: проверка дублей и позиции не разойдутся при гонке.
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Db, DbOrTx, DbTx } from "../db/client.js";
import { sourceCards, sourceCollections } from "../db/schema.js";
import type { CardInput, ImportPreviewResponse } from "../shared/api-contract.js";
import { DEFAULT_MAX_ROWS, parseCardTable, validateCard } from "../shared/card-import/index.js";
import { acceptCard, contentOf, hasSameWord, storedFields } from "./cards.js";
import { MaterialsError } from "./errors.js";

/** Сколько строк принимает одна вставка: тот же лимит, что у предпросмотра в браузере. */
export const IMPORT_MAX_ROWS = DEFAULT_MAX_ROWS;

type SourceCardRow = typeof sourceCards.$inferSelect;

const liveCollection = (teacherUserId: number, collectionId: number) =>
  and(
    eq(sourceCollections.id, collectionId),
    eq(sourceCollections.teacherUserId, teacherUserId),
    isNull(sourceCollections.deletedAt),
  );

const cardView = (row: SourceCardRow) => ({
  id: row.id,
  position: row.position,
  ...contentOf(row),
  updatedAt: row.updatedAt.toISOString(),
});

/** Сколько копий подборки сейчас у учеников списка: не забранные и не у завершённых записей. */
const issuedCountSql = sql<number>`(
  SELECT count(*)::int FROM student_collections sc JOIN student_links sl ON sl.id = sc.student_link_id
  WHERE sc.source_collection_id = source_collections.id AND sc.deleted_at IS NULL AND sl.status <> 'ended'
)`;
const cardCountSql = sql<number>`(
  SELECT count(*)::int FROM source_cards c WHERE c.collection_id = source_collections.id AND c.deleted_at IS NULL
)`;

async function listItems(db: DbOrTx, teacherUserId: number, collectionId?: number) {
  const rows = await db
    .select({
      id: sourceCollections.id,
      title: sourceCollections.title,
      cardCount: cardCountSql,
      issuedCount: issuedCountSql,
      createdAt: sourceCollections.createdAt,
      updatedAt: sourceCollections.updatedAt,
    })
    .from(sourceCollections)
    .where(
      collectionId === undefined
        ? and(eq(sourceCollections.teacherUserId, teacherUserId), isNull(sourceCollections.deletedAt))
        : liveCollection(teacherUserId, collectionId),
    )
    .orderBy(sql`${sourceCollections.createdAt} DESC`, sql`${sourceCollections.id} DESC`);
  return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }));
}

async function liveCards(db: DbOrTx, collectionId: number) {
  return db
    .select()
    .from(sourceCards)
    .where(and(eq(sourceCards.collectionId, collectionId), isNull(sourceCards.deletedAt)))
    .orderBy(asc(sourceCards.position), asc(sourceCards.id));
}

async function lockCollection(tx: DbTx, teacherUserId: number, collectionId: number) {
  const [row] = await tx.select().from(sourceCollections).where(liveCollection(teacherUserId, collectionId)).for("update");
  if (!row) throw new MaterialsError("not_found");
  return row;
}

/** Отмечает изменение подборки: дата правки видна в списке. */
async function touch(tx: DbTx, collectionId: number) {
  await tx.update(sourceCollections).set({ updatedAt: new Date() }).where(eq(sourceCollections.id, collectionId));
}

const nextPosition = (cards: readonly SourceCardRow[]) => cards.reduce((max, card) => Math.max(max, card.position + 1), 0);

export function createSourceService(db: Db) {
  async function detail(teacherUserId: number, collectionId: number, from: DbOrTx = db) {
    const [item] = await listItems(from, teacherUserId, collectionId);
    if (!item) throw new MaterialsError("not_found");
    return { ...item, cards: (await liveCards(from, collectionId)).map(cardView) };
  }

  /** Разбор вставки с учётом действующих карточек подборки. */
  async function parse(from: DbOrTx, collectionId: number, text: string) {
    const existing = (await liveCards(from, collectionId)).map((card) => ({
      english: card.english,
      translation: card.primaryTranslation,
    }));
    return parseCardTable(text, { existing, maxRows: IMPORT_MAX_ROWS });
  }

  /** Строку можно сохранить: прочитана, без ошибок, не дубль. Проверка карточки повторяется на сервере. */
  const savable = (row: ReturnType<typeof parseCardTable>["rows"][number]) =>
    row.card !== null && row.errors.length === 0 && row.duplicate === null && validateCard(row.card).length === 0;

  /** Только своя действующая подборка. Ответ одинаковый для чужой, удалённой и несуществующей. */
  async function exists(teacherUserId: number, collectionId: number) {
    const [row] = await db.select({ id: sourceCollections.id }).from(sourceCollections).where(liveCollection(teacherUserId, collectionId));
    return row !== undefined;
  }

  return {
    detail,

    async list(teacherUserId: number) {
      return { collections: await listItems(db, teacherUserId) };
    },

    exists,

    /** Подборка действующей карточки, если она своя. */
    async collectionOfCard(teacherUserId: number, cardId: number): Promise<number | null> {
      const [row] = await db
        .select({ collectionId: sourceCards.collectionId })
        .from(sourceCards)
        .innerJoin(sourceCollections, eq(sourceCollections.id, sourceCards.collectionId))
        .where(
          and(
            eq(sourceCards.id, cardId),
            isNull(sourceCards.deletedAt),
            eq(sourceCollections.teacherUserId, teacherUserId),
            isNull(sourceCollections.deletedAt),
          ),
        );
      return row?.collectionId ?? null;
    },

    async create(teacherUserId: number, title: string) {
      const [created] = await db.insert(sourceCollections).values({ teacherUserId, title }).returning({ id: sourceCollections.id });
      if (!created) throw new Error("Подборка не создана");
      return detail(teacherUserId, created.id);
    },

    async rename(teacherUserId: number, collectionId: number, title: string) {
      return db.transaction(async (tx) => {
        await lockCollection(tx, teacherUserId, collectionId);
        await tx.update(sourceCollections).set({ title }).where(eq(sourceCollections.id, collectionId));
        return detail(teacherUserId, collectionId, tx);
      });
    },

    /** Мягкое удаление: подборка пропадает из списка, копии учеников не трогаются. */
    async remove(teacherUserId: number, collectionId: number) {
      await db.transaction(async (tx) => {
        await lockCollection(tx, teacherUserId, collectionId);
        await tx.update(sourceCollections).set({ deletedAt: new Date() }).where(eq(sourceCollections.id, collectionId));
      });
    },

    async addCard(teacherUserId: number, collectionId: number, input: CardInput) {
      const card = acceptCard(input);
      return db.transaction(async (tx) => {
        await lockCollection(tx, teacherUserId, collectionId);
        const cards = await liveCards(tx, collectionId);
        if (hasSameWord(cards.map((row) => contentOf(row)), card)) throw new MaterialsError("duplicate_card");
        const [created] = await tx
          .insert(sourceCards)
          .values({ collectionId, position: nextPosition(cards), ...storedFields(card) })
          .returning();
        if (!created) throw new Error("Карточка не создана");
        await touch(tx, collectionId);
        return { card: cardView(created) };
      });
    },

    /** Правка на месте. Выданные копии не меняются: у них свои версии. */
    async editCard(teacherUserId: number, cardId: number, input: CardInput) {
      const card = acceptCard(input);
      return db.transaction(async (tx) => {
        const [peek] = await tx.select({ collectionId: sourceCards.collectionId }).from(sourceCards).where(eq(sourceCards.id, cardId));
        if (!peek) throw new MaterialsError("not_found");
        await lockCollection(tx, teacherUserId, peek.collectionId);
        const cards = await liveCards(tx, peek.collectionId);
        if (!cards.some((row) => row.id === cardId)) throw new MaterialsError("not_found");
        const others = cards.filter((row) => row.id !== cardId).map((row) => contentOf(row));
        if (hasSameWord(others, card)) throw new MaterialsError("duplicate_card");
        const [updated] = await tx.update(sourceCards).set(storedFields(card)).where(eq(sourceCards.id, cardId)).returning();
        if (!updated) throw new MaterialsError("not_found");
        await touch(tx, peek.collectionId);
        return { card: cardView(updated) };
      });
    },

    /** Мягкое удаление: на карточку могут ссылаться копии. */
    async removeCard(teacherUserId: number, cardId: number) {
      await db.transaction(async (tx) => {
        const [peek] = await tx.select({ collectionId: sourceCards.collectionId }).from(sourceCards).where(eq(sourceCards.id, cardId));
        if (!peek) throw new MaterialsError("not_found");
        await lockCollection(tx, teacherUserId, peek.collectionId);
        const removed = await tx
          .update(sourceCards)
          .set({ deletedAt: new Date() })
          .where(and(eq(sourceCards.id, cardId), isNull(sourceCards.deletedAt)))
          .returning({ id: sourceCards.id });
        if (removed.length === 0) throw new MaterialsError("not_found");
        await touch(tx, peek.collectionId);
      });
    },

    /** Новый порядок: присланы ровно все действующие карточки. Иначе экран устарел. */
    async reorder(teacherUserId: number, collectionId: number, cardIds: number[]) {
      return db.transaction(async (tx) => {
        await lockCollection(tx, teacherUserId, collectionId);
        const cards = await liveCards(tx, collectionId);
        const current = new Set(cards.map((card) => card.id));
        if (cardIds.length !== current.size || new Set(cardIds).size !== cardIds.length || !cardIds.every((id) => current.has(id))) {
          throw new MaterialsError("state_changed");
        }
        for (const [position, id] of cardIds.entries()) {
          const card = cards.find((row) => row.id === id);
          if (card?.position !== position) await tx.update(sourceCards).set({ position }).where(eq(sourceCards.id, id));
        }
        await touch(tx, collectionId);
        return detail(teacherUserId, collectionId, tx);
      });
    },

    /** Предпросмотр импорта: ничего не сохраняет. */
    async importPreview(teacherUserId: number, collectionId: number, text: string): Promise<ImportPreviewResponse> {
      if (!(await exists(teacherUserId, collectionId))) throw new MaterialsError("not_found");
      const parsed = await parse(db, collectionId, text);
      const rows = parsed.rows.map((row) => ({
        line: row.line,
        card: row.card ? contentOf(storedFields(row.card)) : null,
        errors: row.errors,
        duplicate: row.duplicate,
      }));
      const toAdd = parsed.rows.filter(savable).length;
      const invalid = parsed.rows.filter((row) => row.card === null || row.errors.length > 0 || (row.duplicate === null && !savable(row))).length;
      return {
        rows,
        delimiter: parsed.delimiter,
        hasHeader: parsed.hasHeader,
        tooManyRows: parsed.tooManyRows,
        maxRows: IMPORT_MAX_ROWS,
        toAdd,
        invalid,
        duplicates: parsed.rows.length - toAdd - invalid,
      };
    },

    /**
     * Сохранение импорта. Текст разбирается заново под блокировкой подборки: клиенту не доверяем,
     * дубли считаются по карточкам на момент сохранения. Всё в одной транзакции.
     */
    async importCards(teacherUserId: number, collectionId: number, text: string) {
      return db.transaction(async (tx) => {
        await lockCollection(tx, teacherUserId, collectionId);
        const parsed = await parse(tx, collectionId, text);
        if (parsed.tooManyRows) throw new MaterialsError("import_too_large");
        const toSave = parsed.rows.filter(savable);
        const cards = await liveCards(tx, collectionId);
        // Страховка от расхождения правил дублей: пары ещё раз сверяются с сохранёнными и между собой.
        const seen = cards.map((row) => contentOf(row));
        let position = nextPosition(cards);
        let added = 0;
        for (const row of toSave) {
          const card = row.card!;
          if (hasSameWord(seen, card)) continue;
          await tx.insert(sourceCards).values({ collectionId, position, ...storedFields(card) });
          seen.push(card);
          position += 1;
          added += 1;
        }
        if (added > 0) await touch(tx, collectionId);
        const invalid = parsed.rows.filter((row) => row.card === null || row.errors.length > 0 || (row.duplicate === null && !savable(row))).length;
        return {
          added,
          skippedInvalid: invalid,
          skippedDuplicates: parsed.rows.length - invalid - added,
          collection: await detail(teacherUserId, collectionId, tx),
        };
      });
    },
  };
}

export type SourceService = ReturnType<typeof createSourceService>;

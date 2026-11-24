// Личная копия ученика в кабинете: просмотр, дополнение, правка и удаление карточек, «Забрать у ученика».
// Правка одной копии не меняет ни оригинал, ни другие копии: у каждой копии свои карточки и версии.
// Порядок блокировок общий для проекта (linking/locks.ts): ученик, запись ученика, копия, слова.
import { and, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import type { Db, DbOrTx, DbTx } from "../db/client.js";
import { listCurrentCards, upsertStudentWord } from "../db/collections.js";
import {
  cardVersions,
  notifications,
  questions,
  sessions,
  studentCards,
  studentCollections,
  studentLinks,
  studentWords,
} from "../db/schema.js";
import { makeWordKey, sameWord } from "../domain/index.js";
import { mergeWordStates, nextStep, removeWordsFromPlan } from "../domain/learning/index.js";
import { refreshCollectionStatuses } from "../learning/collection-progress.js";
import { listVisibleCards } from "../learning/vocabulary.js";
import { lockLinks, lockUser } from "../linking/locks.js";
import { enqueueCollectionExtended } from "../notifications/queue.js";
import type { AddCopyCardsResponse, CardInput, CopyDetail } from "../shared/api-contract.js";
import { acceptCard, contentOf, hasSameWord, keyOf, sameContent, storedFields, type ImportedCard } from "./cards.js";
import { MaterialsError } from "./errors.js";

type LinkRow = typeof studentLinks.$inferSelect;
type CopyRow = typeof studentCollections.$inferSelect;
type WordRow = typeof studentWords.$inferSelect;

/** Копия своей не завершённой записи ученика, не забранная. */
const ownCopy = (teacherUserId: number) =>
  and(
    isNull(studentCollections.deletedAt),
    eq(studentLinks.teacherUserId, teacherUserId),
    ne(studentLinks.status, "ended"),
  );

const learningState = (word: WordRow) => ({
  status: word.status,
  correctStreak: word.correctStreak,
  consecutiveErrors: word.consecutiveErrors,
  lastCountedSessionId: word.lastCountedSessionId,
  hardSince: word.hardSince,
  masteredAt: word.masteredAt,
});

/** Слово ученика у карточки есть только при активной связи: до подтверждения материалы не открыты. */
const studentOf = (link: LinkRow) => (link.status === "active" ? link.studentUserId : null);

/**
 * Снимает с текущих и приостановленных занятий ученика слова без действующих карточек.
 * Уже заданный вопрос не трогается: он и его повтор завершаются по старой версии (раздел 8 сценария).
 * То же правило бот применяет при следующем шаге; здесь план приводится в порядок сразу после правки.
 */
export async function pruneOpenSessions(tx: DbTx, studentUserId: number) {
  const open = await tx
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.studentUserId, studentUserId),
        inArray(sessions.status, ["current", "paused"]),
        isNotNull(sessions.learningState),
      ),
    );
  if (open.length === 0) return;
  const withCards = new Set((await listVisibleCards(tx, studentUserId)).map((card) => card.studentWordId));
  for (const session of open) {
    const state = session.learningState!;
    const asked = new Set(
      (await tx.select({ position: questions.position }).from(questions).where(eq(questions.sessionId, session.id))).map(
        (row) => row.position,
      ),
    );
    const without = state.plan.flatMap((item, position) =>
      position >= state.cursor &&
      !asked.has(position) &&
      !state.removedPositions.includes(position) &&
      !withCards.has(item.studentWordId)
        ? [item.studentWordId]
        : [],
    );
    if (without.length === 0) continue;
    const next = removeWordsFromPlan(state, without);
    const step = nextStep(next);
    const finished = step.kind === "finished";
    await tx
      .update(sessions)
      .set({
        learningState: next,
        currentStep: finished ? next.plan.length : step.position,
        ...(finished ? { status: "completed" as const, finishedAt: new Date() } : {}),
      })
      .where(eq(sessions.id, session.id));
  }
}

/**
 * Карточка переходит к слову новой пары вместе с серией и статусом. Если слово уже есть, состояния
 * объединяются (mergeWordStates). Прежнее слово остаётся: на него ссылаются ответы и, возможно, другие карточки.
 */
async function moveCardToWord(tx: DbTx, studentUserId: number, cardId: number, oldWordId: number, pair: ImportedCard) {
  const key = makeWordKey(pair.english, pair.translation);
  const [old] = await tx.select().from(studentWords).where(eq(studentWords.id, oldWordId)).for("update");
  if (!old) throw new Error(`Слово ${oldWordId} не найдено`);
  const [target] = await tx
    .select()
    .from(studentWords)
    .where(
      and(
        eq(studentWords.studentUserId, studentUserId),
        eq(studentWords.normalizedEnglish, key.normalizedEnglish),
        eq(studentWords.normalizedTranslation, key.normalizedTranslation),
      ),
    )
    .for("update");
  let targetId: number;
  if (target) {
    targetId = target.id;
    if (target.id !== old.id) {
      await tx.update(studentWords).set(mergeWordStates(learningState(target), learningState(old))).where(eq(studentWords.id, target.id));
    }
  } else {
    const [created] = await tx
      .insert(studentWords)
      .values({ studentUserId, ...key, ...learningState(old) })
      .returning({ id: studentWords.id });
    if (!created) throw new Error("Слово не создано");
    targetId = created.id;
  }
  await tx.update(studentCards).set({ studentWordId: targetId }).where(eq(studentCards.id, cardId));
  return targetId;
}

export function createCopyService(db: Db) {
  /** Копия своей записи ученика: ID записи или null. */
  async function findCopy(teacherUserId: number, copyId: number): Promise<number | null> {
    const [row] = await db
      .select({ id: studentCollections.id })
      .from(studentCollections)
      .innerJoin(studentLinks, eq(studentLinks.id, studentCollections.studentLinkId))
      .where(and(eq(studentCollections.id, copyId), ownCopy(teacherUserId)));
    return row?.id ?? null;
  }

  /** Копия действующей карточки, если карточка своя. */
  async function copyOfCard(teacherUserId: number, cardId: number): Promise<number | null> {
    const [row] = await db
      .select({ copyId: studentCards.studentCollectionId })
      .from(studentCards)
      .innerJoin(studentCollections, eq(studentCollections.id, studentCards.studentCollectionId))
      .innerJoin(studentLinks, eq(studentLinks.id, studentCollections.studentLinkId))
      .where(and(eq(studentCards.id, cardId), isNull(studentCards.deletedAt), ownCopy(teacherUserId)));
    return row?.copyId ?? null;
  }

  /**
   * Блокирует ученика, запись и копию и заново проверяет права: после отвязки, пока шёл запрос,
   * правка копии запрещена так же, как выдача.
   */
  async function lockCopy(tx: DbTx, teacherUserId: number, copyId: number): Promise<{ copy: CopyRow; link: LinkRow }> {
    const [peek] = await tx
      .select({ linkId: studentLinks.id, studentUserId: studentLinks.studentUserId })
      .from(studentCollections)
      .innerJoin(studentLinks, eq(studentLinks.id, studentCollections.studentLinkId))
      .where(and(eq(studentCollections.id, copyId), ownCopy(teacherUserId)));
    if (!peek) throw new MaterialsError("not_found");
    if (peek.studentUserId !== null) await lockUser(tx, peek.studentUserId);
    const [link] = await lockLinks(tx, [peek.linkId]);
    if (!link || link.teacherUserId !== teacherUserId || link.status === "ended") throw new MaterialsError("not_found");
    if (link.studentUserId !== peek.studentUserId) throw new MaterialsError("state_changed");
    const [copy] = await tx
      .select()
      .from(studentCollections)
      .where(and(eq(studentCollections.id, copyId), isNull(studentCollections.deletedAt)))
      .for("update");
    if (!copy) throw new MaterialsError("not_found");
    return { copy, link };
  }

  async function detail(teacherUserId: number, copyId: number, from: DbOrTx = db): Promise<CopyDetail> {
    const [row] = await from
      .select({ copy: studentCollections, link: studentLinks })
      .from(studentCollections)
      .innerJoin(studentLinks, eq(studentLinks.id, studentCollections.studentLinkId))
      .where(and(eq(studentCollections.id, copyId), ownCopy(teacherUserId)));
    if (!row) throw new MaterialsError("not_found");
    const { copy, link } = row;
    const cards = await listCurrentCards(from, copyId);
    return {
      id: copy.id,
      studentId: link.id,
      studentDisplayName: link.displayName,
      studentStatus: link.status as CopyDetail["studentStatus"],
      title: copy.title,
      sourceCollectionId: copy.sourceCollectionId,
      status: copy.status,
      publishedAt: copy.publishedAt.toISOString(),
      cards: cards.map(({ card, version }) => ({
        id: card.id,
        position: card.position,
        ...contentOf(version),
        versionNumber: version.versionNumber,
        sourceCardId: card.sourceCardId,
        addedAt: card.addedAt.toISOString(),
        isNew: card.addedAt > copy.publishedAt,
      })),
    };
  }

  /** После изменения карточек: занятия без снятых слов и пересчёт статусов подборок. */
  async function afterChange(tx: DbTx, studentUserId: number, copyId: number, wordIds: number[]) {
    await pruneOpenSessions(tx, studentUserId);
    await refreshCollectionStatuses(tx, studentUserId, { wordIds, collectionIds: [copyId] });
  }

  return {
    findCopy,
    copyOfCard,
    detail,

    /**
     * Дополнение копии одним действием. Дубли (в копии или в самом запросе) пропускаются и перечисляются.
     * При активной связи — одно уведомление «В подборку добавлены слова» с числом новых карточек.
     * До подтверждения связи уведомления нет: после подтверждения придёт «Новая подборка» со всеми карточками.
     */
    async addCards(teacherUserId: number, copyId: number, inputs: CardInput[]): Promise<AddCopyCardsResponse> {
      const prepared = inputs.map((input, index) => {
        try {
          return acceptCard(input);
        } catch (error) {
          if (error instanceof MaterialsError && error.details) {
            throw new MaterialsError(
              "invalid_card",
              error.details.map((detail) => (inputs.length > 1 ? `Карточка ${index + 1}: ${detail}` : detail)),
            );
          }
          throw error;
        }
      });
      return db.transaction(async (tx) => {
        const { copy, link } = await lockCopy(tx, teacherUserId, copyId);
        const studentUserId = studentOf(link);
        const current = await listCurrentCards(tx, copyId);
        const seen = current.map(({ version }) => contentOf(version));
        let position = current.reduce((max, { card }) => Math.max(max, card.position + 1), 0);
        const now = new Date();
        const duplicates: number[] = [];
        const addedIds: number[] = [];
        const wordIds: number[] = [];
        for (const [index, card] of prepared.entries()) {
          if (hasSameWord(seen, card)) {
            duplicates.push(index);
            continue;
          }
          seen.push(card);
          const studentWordId = studentUserId === null ? null : await upsertStudentWord(tx, studentUserId, card.english, card.translation);
          if (studentWordId !== null) wordIds.push(studentWordId);
          const [created] = await tx
            .insert(studentCards)
            .values({
              studentCollectionId: copyId,
              studentWordId,
              position,
              // До подключения ученик увидит копию целиком впервые: такие карточки не помечаются новыми.
              addedAt: studentUserId === null ? copy.publishedAt : now,
            })
            .returning({ id: studentCards.id });
          if (!created) throw new Error("Карточка копии не создана");
          await tx.insert(cardVersions).values({ studentCardId: created.id, versionNumber: 1, ...storedFields(card) });
          addedIds.push(created.id);
          position += 1;
        }

        let notification: AddCopyCardsResponse["notification"] = "none";
        if (studentUserId !== null && addedIds.length > 0) {
          await enqueueCollectionExtended(tx, studentUserId, {
            collectionId: copyId,
            title: copy.title,
            addedCount: addedIds.length,
            firstCardId: addedIds[0]!,
          });
          notification = "now";
          await afterChange(tx, studentUserId, copyId, wordIds);
        }
        return { added: addedIds.length, duplicates, notification, copy: await detail(teacherUserId, copyId, tx) };
      });
    },

    /**
     * Правка карточки копии: новая версия, прежние ответы ссылаются на старую. Смена слова или основного перевода
     * переводит карточку к слову новой пары вместе с серией и статусом (раздел 6 плана).
     */
    async editCard(teacherUserId: number, cardId: number, input: CardInput): Promise<CopyDetail> {
      const card = acceptCard(input);
      return db.transaction(async (tx) => {
        const copyId = await copyOfCardIn(tx, cardId);
        const { link } = await lockCopy(tx, teacherUserId, copyId);
        const current = await listCurrentCards(tx, copyId);
        const target = current.find((row) => row.card.id === cardId);
        if (!target) throw new MaterialsError("not_found");
        const others = current.filter((row) => row.card.id !== cardId).map(({ version }) => contentOf(version));
        if (hasSameWord(others, card)) throw new MaterialsError("duplicate_card");
        if (sameContent(target.version, storedFields(card))) return detail(teacherUserId, copyId, tx);

        await tx.insert(cardVersions).values({
          studentCardId: cardId,
          versionNumber: target.version.versionNumber + 1,
          ...storedFields(card),
        });
        await tx.update(studentCards).set({ updatedAt: new Date() }).where(eq(studentCards.id, cardId));

        const studentUserId = studentOf(link);
        const oldWordId = target.card.studentWordId;
        if (studentUserId !== null && oldWordId !== null) {
          const pairChanged = !sameWord(keyOf(contentOf(target.version)), keyOf(card));
          const wordIds = [oldWordId];
          if (pairChanged) wordIds.push(await moveCardToWord(tx, studentUserId, cardId, oldWordId, card));
          await afterChange(tx, studentUserId, copyId, wordIds);
        }
        return detail(teacherUserId, copyId, tx);
      });
    },

    /** Удаление карточки копии: скрывается из словаря и будущих вопросов, история остаётся. */
    async removeCard(teacherUserId: number, cardId: number): Promise<CopyDetail> {
      return db.transaction(async (tx) => {
        const copyId = await copyOfCardIn(tx, cardId);
        const { link } = await lockCopy(tx, teacherUserId, copyId);
        const [removed] = await tx
          .update(studentCards)
          .set({ deletedAt: new Date() })
          .where(and(eq(studentCards.id, cardId), isNull(studentCards.deletedAt)))
          .returning({ wordId: studentCards.studentWordId });
        if (!removed) throw new MaterialsError("not_found");
        const studentUserId = studentOf(link);
        if (studentUserId !== null) {
          await afterChange(tx, studentUserId, copyId, removed.wordId === null ? [] : [removed.wordId]);
        }
        return detail(teacherUserId, copyId, tx);
      });
    },

    /**
     * «Забрать у ученика»: копия скрывается из бота, ответы и просмотры остаются в базе.
     * Занятие по этой копии завершается как незавершённое; из других занятий снимаются слова без карточек.
     * Ещё не отправленные уведомления о копии отменяются.
     */
    async withdraw(teacherUserId: number, copyId: number) {
      await db.transaction(async (tx) => {
        const { link } = await lockCopy(tx, teacherUserId, copyId);
        const now = new Date();
        await tx.update(studentCollections).set({ deletedAt: now }).where(eq(studentCollections.id, copyId));
        await tx
          .update(notifications)
          .set({ status: "failed", lastError: "Подборка забрана у ученика" })
          .where(
            and(
              eq(notifications.status, "pending"),
              inArray(notifications.reason, ["new_collection", "collection_extended"]),
              sql`${notifications.payload}->>'studentCollectionId' = ${String(copyId)}`,
            ),
          );
        if (link.studentUserId === null) return;
        await tx
          .update(sessions)
          .set({ status: "incomplete", finishedAt: now })
          .where(
            and(
              eq(sessions.studentUserId, link.studentUserId),
              eq(sessions.studentCollectionId, copyId),
              inArray(sessions.status, ["current", "paused"]),
            ),
          );
        await pruneOpenSessions(tx, link.studentUserId);
      });
    },
  };
}

async function copyOfCardIn(tx: DbTx, cardId: number): Promise<number> {
  const [row] = await tx
    .select({ copyId: studentCards.studentCollectionId })
    .from(studentCards)
    .where(eq(studentCards.id, cardId));
  if (!row) throw new MaterialsError("not_found");
  return row.copyId;
}

export type CopyService = ReturnType<typeof createCopyService>;

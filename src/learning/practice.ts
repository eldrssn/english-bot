// Ежедневный квест, экзамен и прогресс: данные из базы для чистых функций домена.
// Квест создают и бот, и планировщик напоминаний; оба вызывают ensureTodayQuest под блокировкой ученика.
import { and, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import type { DbOrTx, DbTx } from "../db/client.js";
import { sessions, studentLinks, studentWords } from "../db/schema.js";
import {
  buildQuestPlan,
  createSessionState,
  localDate,
  questStreak,
  type ExamCandidate,
  type QuestCandidate,
  type Rng,
} from "../domain/learning/index.js";
import { groupWords, listVisibleCards, listVisibleCollections } from "./vocabulary.js";

type SessionRow = typeof sessions.$inferSelect;

export async function activeLinkId(tx: DbOrTx, studentUserId: number): Promise<number | null> {
  const [active] = await tx
    .select({ id: studentLinks.id })
    .from(studentLinks)
    .where(and(eq(studentLinks.studentUserId, studentUserId), eq(studentLinks.status, "active")));
  return active?.id ?? null;
}

/**
 * Закрывает как незавершённые открытые квесты не за сегодняшнюю локальную дату: вчерашний квест не возобновляется,
 * его ответы остаются. Возвращает число закрытых.
 */
export async function closeStaleQuests(tx: DbOrTx, studentUserId: number, today: string, now: Date): Promise<number> {
  const closed = await tx
    .update(sessions)
    .set({ status: "incomplete", finishedAt: now })
    .where(
      and(
        eq(sessions.studentUserId, studentUserId),
        eq(sessions.type, "daily_quest"),
        inArray(sessions.status, ["current", "paused"]),
        ne(sessions.questLocalDate, today),
      ),
    )
    .returning({ id: sessions.id });
  return closed.length;
}

export async function findQuest(tx: DbOrTx, studentUserId: number, questLocalDate: string): Promise<SessionRow | undefined> {
  const [quest] = await tx
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.studentUserId, studentUserId),
        eq(sessions.type, "daily_quest"),
        eq(sessions.questLocalDate, questLocalDate),
      ),
    );
  return quest;
}

/** Слова словаря для квеста: статус слова и дата появления первой действующей карточки. */
export async function questCandidates(tx: DbOrTx, studentUserId: number): Promise<QuestCandidate[]> {
  const words = groupWords(await listVisibleCards(tx, studentUserId));
  if (words.length === 0) return [];
  const statuses = new Map(
    (
      await tx
        .select({ id: studentWords.id, status: studentWords.status })
        .from(studentWords)
        .where(eq(studentWords.studentUserId, studentUserId))
    ).map((row) => [row.id, row.status]),
  );
  return words.map((word) => ({
    studentWordId: word.studentWordId,
    cardVersionId: latestVersionId(word.cards),
    status: statuses.get(word.studentWordId) ?? "learning",
    addedAt: new Date(Math.min(...word.cards.map((card) => card.addedAt.getTime()))),
  }));
}

/** Слова словаря для экзамена: подборки, где у слова есть действующие карточки. */
export async function examCandidates(tx: DbOrTx, studentUserId: number): Promise<ExamCandidate[]> {
  return groupWords(await listVisibleCards(tx, studentUserId)).map((word) => ({
    studentWordId: word.studentWordId,
    cardVersionId: latestVersionId(word.cards),
    collectionIds: [...new Set(word.cards.map((card) => card.collectionId))],
  }));
}

const latestVersionId = (cards: readonly { version: { id: number } }[]) =>
  cards.reduce((a, b) => (b.version.id > a.version.id ? b : a)).version.id;

export type EnsuredQuest = { session: SessionRow; created: boolean };

/**
 * Квест на сегодняшнюю локальную дату: существующий или новый. Перед этим закрывает квесты других дней.
 * Новый квест создаётся на паузе: планировщик не должен прерывать занятие, которое ученик проходит сейчас.
 * Пустой словарь — квеста нет. Вызывается под блокировкой ученика; unique(ученик, локальная дата) — последняя защита.
 */
export async function ensureTodayQuest(
  tx: DbTx,
  input: { studentUserId: number; timezone: string; now: Date; rng: Rng },
): Promise<EnsuredQuest | null> {
  const today = localDate(input.now, input.timezone);
  await closeStaleQuests(tx, input.studentUserId, today, input.now);
  const existing = await findQuest(tx, input.studentUserId, today);
  if (existing) return { session: existing, created: false };

  const plan = buildQuestPlan(await questCandidates(tx, input.studentUserId), { rng: input.rng, now: input.now });
  if (plan.length === 0) return null;
  const [session] = await tx
    .insert(sessions)
    .values({
      studentUserId: input.studentUserId,
      studentLinkId: await activeLinkId(tx, input.studentUserId),
      type: "daily_quest",
      status: "paused",
      questLocalDate: today,
      questionPlan: plan,
      learningState: createSessionState(plan),
      startedAt: input.now,
    })
    .onConflictDoNothing()
    .returning();
  if (session) return { session, created: true };
  const raced = await findQuest(tx, input.studentUserId, today);
  if (!raced) throw new Error("Квест не создан и не найден");
  return { session: raced, created: false };
}

/** Локальные даты завершённых квестов ученика. */
export async function completedQuestDates(tx: DbOrTx, studentUserId: number): Promise<string[]> {
  const rows = await tx
    .select({ date: sessions.questLocalDate })
    .from(sessions)
    .where(
      and(
        eq(sessions.studentUserId, studentUserId),
        eq(sessions.type, "daily_quest"),
        eq(sessions.status, "completed"),
        isNotNull(sessions.questLocalDate),
      ),
    );
  return rows.map((row) => row.date!);
}

export type ProgressSummary = {
  /** Слова с действующими карточками. */
  available: number;
  /** Из доступных: есть хотя бы один ответ. */
  studied: number;
  hard: number;
  mastered: number;
  completedCollections: number;
  totalCollections: number;
  /** Дней подряд с завершённым квестом. */
  questStreak: number;
  /** Сегодняшний квест завершён. null: часовой пояс не выбран. */
  questCompletedToday: boolean | null;
};

/** «Мой прогресс». Удалённые карточки и снятые копии не считаются, как и в словаре. */
export async function progressSummary(
  tx: DbOrTx,
  input: { studentUserId: number; timezone: string | null; now: Date },
): Promise<ProgressSummary> {
  const words = groupWords(await listVisibleCards(tx, input.studentUserId));
  const wordIds = words.map((word) => word.studentWordId);
  const rows =
    wordIds.length === 0
      ? []
      : await tx
          .select({
            id: studentWords.id,
            status: studentWords.status,
            answered: sql<boolean>`EXISTS (
              SELECT 1 FROM attempts a JOIN questions q ON q.id = a.question_id WHERE q.student_word_id = "student_words"."id"
            )`,
          })
          .from(studentWords)
          .where(inArray(studentWords.id, wordIds));
  const collections = await listVisibleCollections(tx, input.studentUserId);
  const dates = await completedQuestDates(tx, input.studentUserId);
  // Без пояса квестов нет; дата по UTC нужна только чтобы не упасть на старых данных.
  const today = localDate(input.now, input.timezone ?? "UTC");
  return {
    available: words.length,
    studied: rows.filter((row) => row.answered).length,
    hard: rows.filter((row) => row.status === "hard").length,
    mastered: rows.filter((row) => row.status === "mastered").length,
    completedCollections: collections.filter((collection) => collection.status === "completed").length,
    totalCollections: collections.length,
    questStreak: questStreak(dates, today),
    questCompletedToday: input.timezone === null ? null : dates.includes(today),
  };
}

// Результаты для кабинета. Всё строится из сохранённых попыток, просмотров и занятий
// и только в рамках одной связи: попытки, просмотры и занятия хранят student_link_id.
// Прежние связи того же ученика (в том числе с тем же преподавателем) сюда не попадают.
import { and, desc, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "../db/client.js";
import {
  attempts,
  cardVersions,
  cardViews,
  questions,
  sessions,
  sourceCollections,
  studentCards,
  studentCollections,
  studentLinks,
  studentWords,
  users,
} from "../db/schema.js";
import { localDate, questStreak } from "../domain/learning/index.js";
import type {
  CollectionResults,
  ResultAnswer,
  ResultSession,
  ResultWord,
  Score,
  SessionKind,
  StudentResults,
} from "../shared/api-contract.js";

const iso = (date: Date) => date.toISOString();

/** Одна попытка в рамках связи вместе с вопросом и версией карточки, по которой он задан. */
type AttemptRow = {
  attemptNumber: number;
  answerText: string;
  isCorrect: boolean;
  becameHard: boolean;
  becameMastered: boolean;
  answeredAt: Date;
  questionId: number;
  sessionId: number;
  position: number;
  direction: "ru_en" | "en_ru";
  format: "choice" | "typed";
  studentWordId: number;
  english: string;
  translation: string;
  studentCardId: number;
  studentCollectionId: number;
  sourceCardId: number | null;
  linkId: number;
};

async function attemptsOfLinks(db: DbOrTx, linkIds: number[], extra?: ReturnType<typeof and>): Promise<AttemptRow[]> {
  if (linkIds.length === 0) return [];
  const rows = await db
    .select({
      attemptNumber: attempts.attemptNumber,
      answerText: attempts.answerText,
      isCorrect: attempts.isCorrect,
      becameHard: attempts.becameHard,
      becameMastered: attempts.becameMastered,
      answeredAt: attempts.answeredAt,
      questionId: questions.id,
      sessionId: questions.sessionId,
      position: questions.position,
      direction: questions.direction,
      format: questions.format,
      studentWordId: questions.studentWordId,
      english: cardVersions.english,
      translation: cardVersions.primaryTranslation,
      studentCardId: studentCards.id,
      studentCollectionId: studentCards.studentCollectionId,
      sourceCardId: studentCards.sourceCardId,
      linkId: attempts.studentLinkId,
    })
    .from(attempts)
    .innerJoin(questions, eq(questions.id, attempts.questionId))
    .innerJoin(cardVersions, eq(cardVersions.id, questions.cardVersionId))
    .innerJoin(studentCards, eq(studentCards.id, cardVersions.studentCardId))
    .where(and(inArray(attempts.studentLinkId, linkIds), ...(extra ? [extra] : [])))
    .orderBy(attempts.answeredAt, attempts.id);
  return rows.map((row) => ({ ...row, linkId: row.linkId as number }));
}

/** Вопрос с обеими попытками. */
type QuestionAnswers = { first: AttemptRow; second: AttemptRow | null };

function groupByQuestion(rows: readonly AttemptRow[]): QuestionAnswers[] {
  const byQuestion = new Map<number, QuestionAnswers>();
  for (const row of rows) {
    const entry = byQuestion.get(row.questionId);
    if (row.attemptNumber === 1) {
      if (entry) entry.first = row;
      else byQuestion.set(row.questionId, { first: row, second: null });
    } else if (entry) {
      entry.second = row;
    }
  }
  return [...byQuestion.values()];
}

const emptyScore = (): Score => ({ correct: 0, total: 0 });

/** Первая попытка и итог после повтора по набору вопросов. */
function scores(items: readonly QuestionAnswers[]) {
  const firstAttempt = emptyScore();
  const afterRepeat = emptyScore();
  for (const { first, second } of items) {
    firstAttempt.total += 1;
    afterRepeat.total += 1;
    if (first.isCorrect) {
      firstAttempt.correct += 1;
      afterRepeat.correct += 1;
    } else if (second?.isCorrect) {
      afterRepeat.correct += 1;
    }
  }
  return { firstAttempt, afterRepeat };
}

const wasMarked = (item: QuestionAnswers, flag: "becameHard" | "becameMastered") =>
  item.first[flag] || (item.second?.[flag] ?? false);

const STATUS_ORDER = { hard: 0, learning: 1, mastered: 2 } as const;

export type StudentResultsOptions = { now?: Date };

/**
 * Результаты своей незавершённой записи ученика. undefined — записи нет, она чужая или завершена:
 * маршрут уже проверил право, здесь условие повторяется, чтобы функция была безопасна сама по себе.
 */
export async function getStudentResults(
  db: Db,
  teacherUserId: number,
  linkId: number,
  options: StudentResultsOptions = {},
): Promise<StudentResults | undefined> {
  const now = options.now ?? new Date();
  const [row] = await db
    .select({ link: studentLinks, student: users })
    .from(studentLinks)
    .leftJoin(users, eq(users.id, studentLinks.studentUserId))
    .where(and(eq(studentLinks.id, linkId), eq(studentLinks.teacherUserId, teacherUserId), ne(studentLinks.status, "ended")));
  if (!row || row.link.status === "ended") return undefined;
  const { link, student } = row;

  // Подборки связи и их действующие карточки.
  const copies = await db
    .select()
    .from(studentCollections)
    .where(and(eq(studentCollections.studentLinkId, linkId), isNull(studentCollections.deletedAt)))
    .orderBy(desc(studentCollections.publishedAt), desc(studentCollections.id));
  const copyIds = copies.map((copy) => copy.id);
  const liveCards =
    copyIds.length === 0
      ? []
      : await db
          .select({
            cardId: studentCards.id,
            collectionId: studentCards.studentCollectionId,
            studentWordId: studentCards.studentWordId,
            versionId: cardVersions.id,
            english: cardVersions.english,
            translation: cardVersions.primaryTranslation,
          })
          .from(studentCards)
          .innerJoin(cardVersions, eq(cardVersions.studentCardId, studentCards.id))
          .where(
            and(
              inArray(studentCards.studentCollectionId, copyIds),
              isNull(studentCards.deletedAt),
              eq(
                cardVersions.versionNumber,
                sql`(SELECT max(v.version_number) FROM card_versions v WHERE v.student_card_id = ${studentCards.id})`,
              ),
            ),
          );

  const attemptRows = await attemptsOfLinks(db, [linkId]);
  const answered = groupByQuestion(attemptRows);

  // Занятия: начатые в рамках связи и те, где есть попытки этой связи (квест мог быть создан до подключения).
  const sessionIds = [...new Set(attemptRows.map((attempt) => attempt.sessionId))];
  const sessionRows = await db
    .select({ session: sessions, title: studentCollections.title })
    .from(sessions)
    .leftJoin(studentCollections, eq(studentCollections.id, sessions.studentCollectionId))
    .where(
      or(eq(sessions.studentLinkId, linkId), sessionIds.length > 0 ? inArray(sessions.id, sessionIds) : sql`false`),
    )
    .orderBy(desc(sessions.startedAt), desc(sessions.id));
  const sessionType = new Map(sessionRows.map(({ session }) => [session.id, session.type as SessionKind]));

  const bySession = new Map<number, QuestionAnswers[]>();
  for (const item of answered) {
    const list = bySession.get(item.first.sessionId) ?? [];
    list.push(item);
    bySession.set(item.first.sessionId, list);
  }
  const resultSessions: ResultSession[] = sessionRows.map(({ session, title }) => {
    const items = bySession.get(session.id) ?? [];
    const state = session.learningState;
    return {
      id: session.id,
      type: session.type,
      title: session.studentCollectionId === null ? null : title,
      status: session.status,
      startedAt: iso(session.startedAt),
      finishedAt: session.finishedAt ? iso(session.finishedAt) : null,
      questLocalDate: session.questLocalDate,
      plannedCount: state ? state.plan.length - state.removedPositions.length : session.questionPlan.length,
      answeredCount: items.length,
      ...scores(items),
      becameHard: items.filter((item) => wasMarked(item, "becameHard")).length,
      mastered: items.filter((item) => wasMarked(item, "becameMastered")).length,
    };
  });

  const answers: ResultAnswer[] = answered
    .map((item) => ({
      questionId: item.first.questionId,
      sessionId: item.first.sessionId,
      sessionType: sessionType.get(item.first.sessionId) ?? "test",
      english: item.first.english,
      translation: item.first.translation,
      direction: item.first.direction,
      format: item.first.format,
      first: { answer: item.first.answerText, correct: item.first.isCorrect, answeredAt: iso(item.first.answeredAt) },
      second: item.second
        ? { answer: item.second.answerText, correct: item.second.isCorrect, answeredAt: iso(item.second.answeredAt) }
        : null,
      becameHard: wasMarked(item, "becameHard"),
      becameMastered: wasMarked(item, "becameMastered"),
    }))
    .reverse();

  // Слова: из действующих карточек связи и из ответов в её рамках.
  const liveWordIds = new Set(liveCards.flatMap((card) => (card.studentWordId === null ? [] : [card.studentWordId])));
  const answeredWordIds = new Set(answered.map((item) => item.first.studentWordId));
  const wordIds = [...new Set([...liveWordIds, ...answeredWordIds])];
  const wordRows =
    wordIds.length === 0 ? [] : await db.select().from(studentWords).where(inArray(studentWords.id, wordIds));
  const titleOf = new Map(copies.map((copy) => [copy.id, copy.title]));
  const words: ResultWord[] = wordRows
    .map((word) => {
      const cards = liveCards.filter((card) => card.studentWordId === word.id);
      const items = answered.filter((item) => item.first.studentWordId === word.id);
      const latestCard = cards.reduce<(typeof cards)[number] | null>((a, b) => (a && a.versionId > b.versionId ? a : b), null);
      const lastAnswer = items.at(-1)?.second ?? items.at(-1)?.first ?? null;
      const label = latestCard ?? items.at(-1)?.first;
      return {
        studentWordId: word.id,
        english: label?.english ?? word.normalizedEnglish,
        translation: label?.translation ?? word.normalizedTranslation,
        status: word.status,
        correctStreak: word.correctStreak,
        sources: [...new Set(cards.map((card) => titleOf.get(card.collectionId)!))],
        firstAttempt: scores(items).firstAttempt,
        lastAnsweredAt: lastAnswer ? iso(lastAnswer.answeredAt) : null,
      };
    })
    .sort(
      (a, b) =>
        STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
        a.english.localeCompare(b.english, "en", { sensitivity: "base" }) ||
        a.translation.localeCompare(b.translation, "ru", { sensitivity: "base" }) ||
        a.studentWordId - b.studentWordId,
    );

  // Просмотры карточек в рамках связи.
  const viewRows = await db
    .select({
      cardId: cardViews.studentCardId,
      collectionTitle: studentCollections.title,
      views: sql<number>`count(*)::int`,
      lastViewedAt: sql<Date>`max(${cardViews.viewedAt})`,
      english: sql<string>`(SELECT v.english FROM card_versions v WHERE v.student_card_id = ${cardViews.studentCardId} ORDER BY v.version_number DESC LIMIT 1)`,
      translation: sql<string>`(SELECT v.primary_translation FROM card_versions v WHERE v.student_card_id = ${cardViews.studentCardId} ORDER BY v.version_number DESC LIMIT 1)`,
    })
    .from(cardViews)
    .innerJoin(studentCards, eq(studentCards.id, cardViews.studentCardId))
    .innerJoin(studentCollections, eq(studentCollections.id, studentCards.studentCollectionId))
    .where(eq(cardViews.studentLinkId, linkId))
    .groupBy(cardViews.studentCardId, studentCollections.title)
    .orderBy(desc(sql`max(${cardViews.viewedAt})`), desc(cardViews.studentCardId));
  const viewedCardIds = new Set(viewRows.map((view) => view.cardId));

  const collections = copies.map((copy) => {
    const cards = liveCards.filter((card) => card.collectionId === copy.id);
    const items = answered.filter((item) => item.first.studentCollectionId === copy.id);
    return {
      id: copy.id,
      title: copy.title,
      status: copy.status,
      publishedAt: iso(copy.publishedAt),
      wordCount: cards.length,
      viewedCards: cards.filter((card) => viewedCardIds.has(card.cardId)).length,
      answeredWords: new Set(items.map((item) => item.first.studentWordId)).size,
      firstAttempt: scores(items).firstAttempt,
    };
  });

  const available = wordRows.filter((word) => liveWordIds.has(word.id));
  const questDates = sessionRows.flatMap(({ session }) =>
    session.type === "daily_quest" && session.status === "completed" && session.questLocalDate ? [session.questLocalDate] : [],
  );
  const timezone = student?.timezone ?? null;
  const totals = scores(answered);

  return {
    student: {
      id: link.id,
      displayName: link.displayName,
      status: link.status as Exclude<typeof link.status, "ended">,
      startedAt: link.startedAt ? iso(link.startedAt) : null,
      timezone,
    },
    generatedAt: iso(now),
    progress: {
      available: available.length,
      studied: available.filter((word) => answeredWordIds.has(word.id)).length,
      hard: available.filter((word) => word.status === "hard").length,
      mastered: available.filter((word) => word.status === "mastered").length,
      completedCollections: copies.filter((copy) => copy.status === "completed").length,
      totalCollections: copies.length,
      questStreak: questStreak(questDates, localDate(now, timezone ?? "UTC")),
      questsCompleted: questDates.length,
      examsCompleted: sessionRows.filter(({ session }) => session.type === "exam" && session.status === "completed").length,
    },
    totals: { answered: answered.length, ...totals },
    collections,
    sessions: resultSessions,
    answers,
    words,
    views: viewRows.map((view) => ({
      english: view.english,
      translation: view.translation,
      collectionTitle: view.collectionTitle,
      views: view.views,
      lastViewedAt: iso(new Date(view.lastViewedAt)),
    })),
  };
}

/**
 * Результаты по своей исходной подборке: копии у текущих (не завершённых) записей учеников,
 * объединённые по исходной карточке. Попытки считаются только те, что сделаны в рамках связи, выдавшей копию.
 */
export async function getCollectionResults(
  db: Db,
  teacherUserId: number,
  sourceCollectionId: number,
): Promise<CollectionResults | undefined> {
  const [source] = await db
    .select({ title: sourceCollections.title })
    .from(sourceCollections)
    .where(
      and(
        eq(sourceCollections.id, sourceCollectionId),
        eq(sourceCollections.teacherUserId, teacherUserId),
        isNull(sourceCollections.deletedAt),
      ),
    );
  if (!source) return undefined;
  const copies = await db
    .select({ copy: studentCollections, link: studentLinks })
    .from(studentCollections)
    .innerJoin(studentLinks, eq(studentLinks.id, studentCollections.studentLinkId))
    .where(
      and(
        eq(studentCollections.sourceCollectionId, sourceCollectionId),
        isNull(studentCollections.deletedAt),
        eq(studentLinks.teacherUserId, teacherUserId),
        ne(studentLinks.status, "ended"),
      ),
    )
    .orderBy(studentLinks.displayName, studentLinks.id);
  const copyIds = copies.map(({ copy }) => copy.id);
  const linkOfCopy = new Map(copies.map(({ copy, link }) => [copy.id, link.id]));

  const rows = (
    await attemptsOfLinks(
      db,
      copies.map(({ link }) => link.id),
      copyIds.length > 0 ? and(inArray(studentCards.studentCollectionId, copyIds)) : undefined,
    )
  ).filter((row) => linkOfCopy.get(row.studentCollectionId) === row.linkId);
  const answered = groupByQuestion(rows);

  const recipients = copies.map(({ copy, link }) => ({
    studentId: link.id,
    displayName: link.displayName,
    studentStatus: link.status as "pending_connection" | "pending_confirmation" | "active",
    copyId: copy.id,
    status: copy.status,
    publishedAt: iso(copy.publishedAt),
    ...scores(answered.filter((item) => item.first.studentCollectionId === copy.id)),
  }));

  // Текущее состояние слов карточек копий: «сложное сейчас».
  const cardWords =
    copyIds.length === 0
      ? []
      : await db
          .select({
            cardId: studentCards.id,
            sourceCardId: studentCards.sourceCardId,
            status: studentWords.status,
          })
          .from(studentCards)
          .innerJoin(studentWords, eq(studentWords.id, studentCards.studentWordId))
          .where(and(inArray(studentCards.studentCollectionId, copyIds), isNull(studentCards.deletedAt), isNotNull(studentCards.studentWordId)));

  type Group = { sourceCardId: number | null; english: string; translation: string; items: QuestionAnswers[]; cardIds: Set<number> };
  const groups = new Map<string, Group>();
  for (const item of answered) {
    const { sourceCardId, english, translation, studentCardId } = item.first;
    const key = sourceCardId === null ? `pair:${english.toLowerCase()}\u0000${translation.toLowerCase()}` : `source:${sourceCardId}`;
    const group = groups.get(key) ?? { sourceCardId, english, translation, items: [], cardIds: new Set<number>() };
    // Подпись — по последнему ответу: так слово выглядит после правок.
    group.english = english;
    group.translation = translation;
    group.items.push(item);
    group.cardIds.add(studentCardId);
    groups.set(key, group);
  }

  const words = [...groups.values()]
    .map((group) => {
      const firstAttempt = scores(group.items).firstAttempt;
      return {
        sourceCardId: group.sourceCardId,
        english: group.english,
        translation: group.translation,
        students: new Set(group.items.map((item) => item.first.linkId)).size,
        firstAttempt,
        becameHard: group.items.filter((item) => wasMarked(item, "becameHard")).length,
        hardNow: cardWords.filter((card) => group.cardIds.has(card.cardId) && card.status === "hard").length,
      };
    })
    .sort(
      (a, b) =>
        b.firstAttempt.total - b.firstAttempt.correct - (a.firstAttempt.total - a.firstAttempt.correct) ||
        b.becameHard - a.becameHard ||
        b.hardNow - a.hardNow ||
        a.english.localeCompare(b.english, "en", { sensitivity: "base" }),
    );

  return { id: sourceCollectionId, title: source.title, recipients, words };
}

const RECENT_LIMIT = 5;

/** Для главной: недавно выданные подборки и последние завершённые занятия текущих учеников преподавателя. */
export async function recentActivity(db: Db, links: readonly { id: number; displayName: string }[]) {
  const linkIds = links.map((link) => link.id);
  if (linkIds.length === 0) return { recentCollections: [], recentResults: [] };
  const nameOf = new Map(links.map((link) => [link.id, link.displayName]));

  const copies = await db
    .select()
    .from(studentCollections)
    .where(and(inArray(studentCollections.studentLinkId, linkIds), isNull(studentCollections.deletedAt)))
    .orderBy(desc(studentCollections.publishedAt), desc(studentCollections.id))
    .limit(RECENT_LIMIT);

  const finished = await db
    .select({ session: sessions, title: studentCollections.title })
    .from(sessions)
    .leftJoin(studentCollections, eq(studentCollections.id, sessions.studentCollectionId))
    .where(and(inArray(sessions.studentLinkId, linkIds), eq(sessions.status, "completed"), isNotNull(sessions.finishedAt)))
    .orderBy(desc(sessions.finishedAt), desc(sessions.id))
    .limit(RECENT_LIMIT);
  const firstAttempts =
    finished.length === 0
      ? []
      : await db
          .select({ sessionId: questions.sessionId, isCorrect: attempts.isCorrect })
          .from(attempts)
          .innerJoin(questions, eq(questions.id, attempts.questionId))
          .where(
            and(
              inArray(questions.sessionId, finished.map(({ session }) => session.id)),
              inArray(attempts.studentLinkId, linkIds),
              eq(attempts.attemptNumber, 1),
            ),
          );

  return {
    recentCollections: copies.map((copy) => ({
      copyId: copy.id,
      studentId: copy.studentLinkId,
      displayName: nameOf.get(copy.studentLinkId)!,
      title: copy.title,
      publishedAt: iso(copy.publishedAt),
      status: copy.status,
    })),
    recentResults: finished.map(({ session, title }) => {
      const own = firstAttempts.filter((row) => row.sessionId === session.id);
      return {
        studentId: session.studentLinkId!,
        displayName: nameOf.get(session.studentLinkId!)!,
        sessionId: session.id,
        type: session.type,
        title: session.studentCollectionId === null ? null : title,
        finishedAt: iso(session.finishedAt!),
        firstAttempt: { correct: own.filter((row) => row.isCorrect).length, total: own.length },
      };
    }),
  };
}

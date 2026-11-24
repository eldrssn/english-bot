// Занятия и словарь ученика. Сервис не знает о Telegram: его вызывает бот, состояние хранится только в базе.
// Каждое изменение идёт под блокировкой строки ученика: порядок блокировок тот же, что в привязке (linking/locks.ts).
import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db, DbOrTx, DbTx } from "../db/client.js";
import {
  attempts,
  cardVersions,
  cardViews,
  questions,
  sessions,
  studentCollections,
  studentLinks,
  studentWords,
} from "../db/schema.js";
import {
  applyAnswer,
  buildChoiceOptions,
  buildSessionPlan,
  checkAnswer,
  createSessionState,
  nextStep,
  promptText,
  recordAnswer,
  removeWordsFromPlan,
  summarizeSession,
  type AttemptNumber,
  type Direction,
  type PlanItem,
  type Rng,
  type SessionState,
} from "../domain/learning/index.js";
import { lockUser } from "../linking/locks.js";
import { refreshCollectionStatuses } from "./collection-progress.js";
import {
  groupWords,
  listVisibleCards,
  listVisibleCollections,
  type CardVersionRow,
  type VisibleCard,
  type VisibleCollection,
  type VocabularyWord,
} from "./vocabulary.js";

type SessionRow = typeof sessions.$inferSelect;
type QuestionRow = typeof questions.$inferSelect;

export type WordPair = { english: string; translation: string };
export type CardContent = WordPair & { example: string | null; explanation: string | null };

export type AskedQuestion = {
  sessionId: number;
  questionId: number;
  attemptNumber: AttemptNumber;
  isRepeat: boolean;
  direction: Direction;
  prompt: string;
  /** Полный текст сохранённых вариантов. */
  options: string[];
  /** Номер вопроса в занятии и всего вопросов. Для повтора не показываются. */
  number: number;
  total: number;
};

export type SessionResult = {
  sessionId: number;
  title: string | null;
  plannedCount: number;
  answeredCount: number;
  /** Верно с первой попытки: верный повтор сюда не входит. */
  firstAttemptCorrect: number;
  /** Верно с первой попытки или на повторе. */
  afterRepeatCorrect: number;
  /** Слова, ставшие сложными в этом занятии. */
  becameHard: WordPair[];
};

export type SessionProgress = { skipped: WordPair[] } & (
  | { kind: "question"; question: AskedQuestion }
  | { kind: "finished"; result: SessionResult }
);

export type StartResult =
  | { kind: "not_found" }
  | { kind: "no_words" }
  | { kind: "started"; progress: SessionProgress; pausedPrevious: boolean };

export type ResumeResult =
  | { kind: "not_found" }
  | { kind: "resumed"; progress: SessionProgress; pausedPrevious: boolean }
  | { kind: "finished"; result: SessionResult };

export type PauseResult = { kind: "not_found" } | { kind: "paused" } | { kind: "not_current" };

export type AnswerFeedback = {
  isCorrect: boolean;
  chosen: string;
  card: CardContent;
};

export type AnswerResult =
  /** Вопрос чужой или его нет: никаких подробностей. */
  | { kind: "not_found" }
  /** На текущий шаг, но такого варианта нет. */
  | { kind: "invalid_option" }
  | { kind: "answered"; feedback: AnswerFeedback; becameHard: boolean; next: SessionProgress }
  /** Старая кнопка: попытка не создана. */
  | {
      kind: "stale";
      sessionId: number;
      sessionStatus: SessionRow["status"];
      hasState: boolean;
      /** Последняя сохранённая попытка этого вопроса. */
      saved: AnswerFeedback | null;
    };

export type OpenSession = { sessionId: number; title: string | null; status: "current" | "paused" };

export type CollectionScreen = {
  collection: VisibleCollection;
  cards: (VisibleCard & { isNew: boolean })[];
  openSessionId: number | null;
};

export type CollectionCardScreen = {
  card: CardContent;
  collectionId: number;
  nextCardId: number | null;
  previousCardId: number | null;
};

export type LearningService = ReturnType<typeof createLearningService>;

const contentOf = (version: CardVersionRow): CardContent => ({
  english: version.english,
  translation: version.primaryTranslation,
  example: version.example,
  explanation: version.explanation,
});

/**
 * Связь для записи занятия, попытки и просмотра: активная, если материал выдан в её рамках, иначе пусто.
 * После отвязки значение пустое. Занятие по копии прежней связи при новой тоже пишет пусто:
 * новый преподаватель видит только материалы и результаты своей связи.
 */
async function linkForCollection(tx: DbOrTx, studentUserId: number, collectionId: number | null): Promise<number | null> {
  const [active] = await tx
    .select({ id: studentLinks.id })
    .from(studentLinks)
    .where(and(eq(studentLinks.studentUserId, studentUserId), eq(studentLinks.status, "active")));
  if (!active) return null;
  if (collectionId === null) return active.id;
  const [collection] = await tx
    .select({ linkId: studentCollections.studentLinkId })
    .from(studentCollections)
    .where(eq(studentCollections.id, collectionId));
  return collection?.linkId === active.id ? active.id : null;
}

async function pauseCurrent(tx: DbTx, studentUserId: number, exceptSessionId?: number): Promise<boolean> {
  const paused = await tx
    .update(sessions)
    .set({ status: "paused" })
    .where(
      and(
        eq(sessions.studentUserId, studentUserId),
        eq(sessions.status, "current"),
        ...(exceptSessionId === undefined ? [] : [sql`${sessions.id} <> ${exceptSessionId}`]),
      ),
    )
    .returning({ id: sessions.id });
  return paused.length > 0;
}

async function collectionTitle(tx: DbOrTx, collectionId: number | null): Promise<string | null> {
  if (collectionId === null) return null;
  const [row] = await tx
    .select({ title: studentCollections.title })
    .from(studentCollections)
    .where(eq(studentCollections.id, collectionId));
  return row?.title ?? null;
}

async function buildResult(tx: DbOrTx, session: SessionRow, state: SessionState): Promise<SessionResult> {
  const summary = summarizeSession(state);
  const hard = await tx
    .select({ english: cardVersions.english, translation: cardVersions.primaryTranslation })
    .from(attempts)
    .innerJoin(questions, eq(questions.id, attempts.questionId))
    .innerJoin(cardVersions, eq(cardVersions.id, questions.cardVersionId))
    .where(and(eq(questions.sessionId, session.id), eq(attempts.becameHard, true)))
    .orderBy(asc(attempts.id));
  return {
    sessionId: session.id,
    title: await collectionTitle(tx, session.studentCollectionId),
    plannedCount: summary.plannedCount,
    answeredCount: summary.answeredCount,
    firstAttemptCorrect: summary.firstAttempt.correct,
    afterRepeatCorrect: summary.afterRepeat.correct,
    becameHard: hard,
  };
}

/**
 * Что делать со словом, для которого нет неверных вариантов. Единственное такое место.
 * Этап 5 заменит пропуск на вопрос с вводом ответа («Переведи меня»).
 */
function skipWordWithoutChoices(state: SessionState, item: PlanItem): SessionState {
  return removeWordsFromPlan(state, [item.studentWordId]);
}

export function createLearningService(db: Db, options: { rng?: Rng } = {}) {
  const rng = options.rng ?? Math.random;

  /**
   * Находит или создаёт вопрос текущего шага и сохраняет состояние занятия. Вопрос записывается до отправки:
   * после перезапуска он находится по (занятие, позиция), варианты не перемешиваются заново.
   */
  async function advance(tx: DbTx, session: SessionRow, start: SessionState): Promise<SessionProgress> {
    const studentUserId = session.studentUserId;
    const visible = await listVisibleCards(tx, studentUserId);
    const asked = new Map(
      (await tx.select().from(questions).where(eq(questions.sessionId, session.id))).map((row) => [row.position, row]),
    );

    // Слова без действующих карточек снимаются. Заданный вопрос завершается по старой версии, его слово не трогаем.
    const withCards = new Set(visible.map((card) => card.studentWordId));
    const withoutCards = start.plan.flatMap((item, position) =>
      position >= start.cursor && !asked.has(position) && !withCards.has(item.studentWordId) ? [item.studentWordId] : [],
    );
    let state = withoutCards.length > 0 ? removeWordsFromPlan(start, withoutCards) : start;

    const skipped: WordPair[] = [];
    let question: QuestionRow | undefined;
    for (;;) {
      const step = nextStep(state);
      if (step.kind === "finished") break;

      const existing = asked.get(step.position);
      if (existing) {
        question = existing;
        if (step.kind === "repeat" && existing.status !== "open") {
          [question] = await tx
            .update(questions)
            .set({ status: "open" })
            .where(eq(questions.id, existing.id))
            .returning();
        }
        break;
      }

      const created = await createQuestion(tx, session, step.position, step.item, visible);
      if (created.kind === "skip") {
        skipped.push(created.pair);
        state = skipWordWithoutChoices(state, step.item);
        continue;
      }
      question = created.question;
      break;
    }

    const step = nextStep(state);
    const finished = step.kind === "finished";
    const [saved] = await tx
      .update(sessions)
      .set({
        learningState: state,
        currentStep: finished ? state.plan.length : step.position,
        ...(finished ? { status: "completed" as const, finishedAt: new Date() } : {}),
      })
      .where(eq(sessions.id, session.id))
      .returning();
    if (!saved) throw new Error(`Занятие ${session.id} не найдено`);

    if (step.kind === "finished") return { kind: "finished", result: await buildResult(tx, saved, state), skipped };
    if (!question) throw new Error(`У занятия ${session.id} нет вопроса на шаге ${step.position}`);

    const [version] = await tx.select().from(cardVersions).where(eq(cardVersions.id, question.cardVersionId));
    if (!version) throw new Error(`Версия карточки ${question.cardVersionId} не найдена`);
    const summary = summarizeSession(state);
    return {
      kind: "question",
      skipped,
      question: {
        sessionId: session.id,
        questionId: question.id,
        attemptNumber: step.attemptNumber,
        isRepeat: step.kind === "repeat",
        direction: question.direction,
        prompt: promptText(version, question.direction),
        options: (question.options ?? []).map((option) => option.text),
        number: summary.answeredCount + 1,
        total: summary.plannedCount,
      },
    };
  }

  /** Новый вопрос идёт по актуальной версии: cardVersionId в плане только указывает, с какой карточки начать. */
  async function createQuestion(
    tx: DbTx,
    session: SessionRow,
    position: number,
    item: PlanItem,
    visible: VisibleCard[],
  ): Promise<{ kind: "created"; question: QuestionRow } | { kind: "skip"; pair: WordPair }> {
    const wordCards = visible.filter((card) => card.studentWordId === item.studentWordId);
    const [snapshot] = await tx
      .select({ cardId: cardVersions.studentCardId })
      .from(cardVersions)
      .where(eq(cardVersions.id, item.cardVersionId));
    const chosen =
      wordCards.find((card) => card.cardId === snapshot?.cardId) ??
      wordCards.find((card) => card.collectionId === session.studentCollectionId) ??
      wordCards[0];
    if (!chosen) throw new Error(`У слова ${item.studentWordId} нет действующих карточек`);

    const built = buildChoiceOptions({
      card: chosen.version,
      sameWordCards: wordCards.filter((card) => card !== chosen).map((card) => card.version),
      direction: item.direction,
      pool: visible.filter((card) => card.studentWordId !== item.studentWordId).map((card) => card.version),
      rng,
    });
    if (!built.available) {
      return { kind: "skip", pair: { english: chosen.version.english, translation: chosen.version.primaryTranslation } };
    }

    const [question] = await tx
      .insert(questions)
      .values({
        sessionId: session.id,
        position,
        studentWordId: item.studentWordId,
        cardVersionId: chosen.version.id,
        direction: item.direction,
        format: "choice",
        options: built.options,
        correctOptionIndex: built.correctOptionIndex,
      })
      .returning();
    if (!question) throw new Error("Вопрос не создан");
    return { kind: "created", question };
  }

  async function staleAnswer(tx: DbTx, session: SessionRow, question: QuestionRow, version: CardVersionRow): Promise<AnswerResult> {
    const [last] = await tx
      .select()
      .from(attempts)
      .where(eq(attempts.questionId, question.id))
      .orderBy(desc(attempts.attemptNumber))
      .limit(1);
    return {
      kind: "stale",
      sessionId: session.id,
      sessionStatus: session.status,
      hasState: session.learningState !== null,
      saved: last ? { isCorrect: last.isCorrect, chosen: last.answerText, card: contentOf(version) } : null,
    };
  }

  /** Записывает просмотр карточек и обновляет статусы их подборок. */
  async function recordViews(tx: DbTx, studentUserId: number, cards: VisibleCard[]) {
    if (cards.length === 0) return;
    const [active] = await tx
      .select({ id: studentLinks.id })
      .from(studentLinks)
      .where(and(eq(studentLinks.studentUserId, studentUserId), eq(studentLinks.status, "active")));
    await tx.insert(cardViews).values(
      cards.map((card) => ({
        studentCardId: card.cardId,
        cardVersionId: card.version.id,
        // Как у попытки: связь пишется, только если карточка выдана в рамках активной связи.
        studentLinkId: card.collectionLinkId === active?.id ? active.id : null,
      })),
    );
    await refreshCollectionStatuses(tx, studentUserId, { collectionIds: cards.map((card) => card.collectionId) });
  }

  async function findOpenSession(tx: DbOrTx, studentUserId: number, collectionId: number) {
    const [session] = await tx
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.studentUserId, studentUserId),
          eq(sessions.studentCollectionId, collectionId),
          eq(sessions.type, "test"),
          inArray(sessions.status, ["current", "paused"]),
          isNotNull(sessions.learningState),
        ),
      )
      .orderBy(desc(sessions.id))
      .limit(1);
    return session;
  }

  async function makeCurrent(tx: DbTx, session: SessionRow) {
    const pausedPrevious = await pauseCurrent(tx, session.studentUserId, session.id);
    if (session.status !== "current") {
      await tx.update(sessions).set({ status: "current" }).where(eq(sessions.id, session.id));
    }
    return pausedPrevious;
  }

  return {
    // ---------- Занятие ----------

    /**
     * Запускает тест по подборке. Открытое занятие по этой подборке продолжается, а не создаётся заново:
     * двойное нажатие не даёт второго занятия. Любое другое текущее занятие ставится на паузу.
     */
    async startCollectionTest(input: { userId: number; collectionId: number }): Promise<StartResult> {
      return db.transaction(async (tx): Promise<StartResult> => {
        await lockUser(tx, input.userId);
        const [collection] = await listVisibleCollections(tx, input.userId, input.collectionId);
        if (!collection) return { kind: "not_found" };

        const open = await findOpenSession(tx, input.userId, input.collectionId);
        if (open?.learningState) {
          const pausedPrevious = await makeCurrent(tx, open);
          return { kind: "started", pausedPrevious, progress: await advance(tx, open, open.learningState) };
        }

        const cards = await listVisibleCards(tx, input.userId, { collectionId: input.collectionId });
        if (cards.length === 0) return { kind: "no_words" };
        const plan = buildSessionPlan(
          cards.map((card) => ({ studentWordId: card.studentWordId, cardVersionId: card.version.id })),
          { rng },
        );
        const state = createSessionState(plan);
        const pausedPrevious = await pauseCurrent(tx, input.userId);
        const [session] = await tx
          .insert(sessions)
          .values({
            studentUserId: input.userId,
            studentLinkId: await linkForCollection(tx, input.userId, input.collectionId),
            studentCollectionId: input.collectionId,
            type: "test",
            questionPlan: plan,
            learningState: state,
          })
          .returning();
        if (!session) throw new Error("Занятие не создано");
        return { kind: "started", pausedPrevious, progress: await advance(tx, session, state) };
      });
    },

    /** Возвращается к занятию с сохранённого шага. Вопрос тот же, что был отправлен. */
    async resumeSession(input: { userId: number; sessionId: number }): Promise<ResumeResult> {
      return db.transaction(async (tx): Promise<ResumeResult> => {
        await lockUser(tx, input.userId);
        const [session] = await tx
          .select()
          .from(sessions)
          .where(and(eq(sessions.id, input.sessionId), eq(sessions.studentUserId, input.userId)));
        if (!session?.learningState) return { kind: "not_found" };
        if (session.status !== "current" && session.status !== "paused") {
          return { kind: "finished", result: await buildResult(tx, session, session.learningState) };
        }
        const pausedPrevious = await makeCurrent(tx, session);
        return { kind: "resumed", pausedPrevious, progress: await advance(tx, session, session.learningState) };
      });
    },

    async pauseSession(input: { userId: number; sessionId: number }): Promise<PauseResult> {
      return db.transaction(async (tx): Promise<PauseResult> => {
        await lockUser(tx, input.userId);
        const [session] = await tx
          .select({ status: sessions.status })
          .from(sessions)
          .where(and(eq(sessions.id, input.sessionId), eq(sessions.studentUserId, input.userId)));
        if (!session) return { kind: "not_found" };
        if (session.status !== "current") return { kind: "not_current" };
        await tx.update(sessions).set({ status: "paused" }).where(eq(sessions.id, input.sessionId));
        return { kind: "paused" };
      });
    },

    /**
     * Ответ кнопкой. Владелец проверяется запросом: чужой вопрос неотличим от несуществующего.
     * Попытка, состояние занятия, слово и статус подборки меняются в одной транзакции.
     * recordAnswer вызывается до записи попытки: при отказе записывать нечего, транзакция ничего не меняет.
     */
    async answerChoice(input: {
      userId: number;
      questionId: number;
      attemptNumber: number;
      optionIndex: number;
    }): Promise<AnswerResult> {
      return db.transaction(async (tx): Promise<AnswerResult> => {
        await lockUser(tx, input.userId);
        const [row] = await tx
          .select({ question: questions, session: sessions, version: cardVersions })
          .from(questions)
          .innerJoin(sessions, eq(sessions.id, questions.sessionId))
          .innerJoin(cardVersions, eq(cardVersions.id, questions.cardVersionId))
          .where(and(eq(questions.id, input.questionId), eq(sessions.studentUserId, input.userId)));
        if (!row) return { kind: "not_found" };
        const { question, session, version } = row;

        // Ответ принимается только в текущее занятие.
        const state = session.learningState;
        if (session.status !== "current" || !state) return staleAnswer(tx, session, question, version);

        // Кнопка должна относиться к текущему шагу. Кнопка первой попытки не засчитается как повтор.
        const step = nextStep(state);
        if (
          step.kind === "finished" ||
          step.position !== question.position ||
          step.attemptNumber !== input.attemptNumber
        ) {
          return staleAnswer(tx, session, question, version);
        }
        const chosen = question.options?.[input.optionIndex]?.text;
        if (chosen === undefined) return { kind: "invalid_option" };

        // Заданный вопрос принимается по своей версии и по всем действующим карточкам слова.
        const wordCards = await listVisibleCards(tx, input.userId, { studentWordId: question.studentWordId });
        const { isCorrect } = checkAnswer(
          [version, ...wordCards.map((card) => card.version)],
          question.direction,
          chosen,
        );

        const recorded = recordAnswer(state, {
          position: question.position,
          attemptNumber: step.attemptNumber,
          isCorrect,
        });
        if (!recorded.accepted) return staleAnswer(tx, session, question, version);

        const [word] = await tx
          .select()
          .from(studentWords)
          .where(eq(studentWords.id, question.studentWordId))
          .for("update");
        if (!word) throw new Error(`Слово ${question.studentWordId} не найдено`);
        const now = new Date();
        const applied = applyAnswer(word, { sessionId: session.id, attemptNumber: step.attemptNumber, isCorrect, now });
        const becameHard = applied.transition === "became_hard" || applied.transition === "returned_to_hard";

        // Уникальное ограничение решает спор, если попытка уже записана мимо блокировки ученика.
        const inserted = await tx
          .insert(attempts)
          .values({
            questionId: question.id,
            attemptNumber: step.attemptNumber,
            studentLinkId: await linkForCollection(tx, input.userId, session.studentCollectionId),
            selectedOptionIndex: input.optionIndex,
            answerText: chosen,
            isCorrect,
            becameHard,
            answeredAt: now,
          })
          .onConflictDoNothing({ target: [attempts.questionId, attempts.attemptNumber] })
          .returning({ id: attempts.id });
        if (inserted.length === 0) return staleAnswer(tx, session, question, version);

        await tx
          .update(studentWords)
          .set({
            status: applied.word.status,
            correctStreak: applied.word.correctStreak,
            consecutiveErrors: applied.word.consecutiveErrors,
            lastCountedSessionId: applied.word.lastCountedSessionId,
            hardSince: applied.word.hardSince,
            masteredAt: applied.word.masteredAt,
          })
          .where(eq(studentWords.id, word.id));
        await tx.update(questions).set({ status: recorded.questionStatus }).where(eq(questions.id, question.id));
        await refreshCollectionStatuses(tx, input.userId, { wordIds: [question.studentWordId] });

        return {
          kind: "answered",
          feedback: { isCorrect, chosen, card: contentOf(version) },
          becameHard,
          next: await advance(tx, session, recorded.state),
        };
      });
    },

    /** Итог занятия, в том числе незавершённого: считается из сохранённого состояния и попыток. */
    async getSessionResult(input: { userId: number; sessionId: number }): Promise<SessionResult | null> {
      const [session] = await db
        .select()
        .from(sessions)
        .where(and(eq(sessions.id, input.sessionId), eq(sessions.studentUserId, input.userId)));
      return session?.learningState ? buildResult(db, session, session.learningState) : null;
    },

    /** Текущее и приостановленные занятия: сначала недавние. Занятие на паузе продолжается кнопкой из меню. */
    async listOpenSessions(userId: number): Promise<OpenSession[]> {
      const rows = await db
        .select({ sessionId: sessions.id, title: studentCollections.title, status: sessions.status })
        .from(sessions)
        .leftJoin(studentCollections, eq(studentCollections.id, sessions.studentCollectionId))
        .where(
          and(
            eq(sessions.studentUserId, userId),
            inArray(sessions.status, ["current", "paused"]),
            isNotNull(sessions.learningState),
          ),
        )
        .orderBy(sql`${sessions.status} = 'current' DESC`, desc(sessions.updatedAt), desc(sessions.id));
      return rows as OpenSession[];
    },

    // ---------- Словарь ----------

    /** «Все слова»: совпавшие карточки объединены, у слова указаны подборки. */
    async listWords(userId: number): Promise<VocabularyWord[]> {
      return groupWords(await listVisibleCards(db, userId));
    },

    /** Открытие слова. Просмотр записывается по всем его действующим карточкам: ученик видел содержимое каждой. */
    async openWord(input: { userId: number; studentWordId: number }): Promise<VocabularyWord | null> {
      return db.transaction(async (tx) => {
        await lockUser(tx, input.userId);
        const cards = await listVisibleCards(tx, input.userId, { studentWordId: input.studentWordId });
        const [word] = groupWords(cards);
        if (!word) return null;
        await recordViews(tx, input.userId, cards);
        return word;
      });
    },

    listCollections: (userId: number) => listVisibleCollections(db, userId),

    /** Подборка со всеми действующими карточками. Новая — та, что добавлена после публикации. */
    async openCollection(input: { userId: number; collectionId: number }): Promise<CollectionScreen | null> {
      const [collection] = await listVisibleCollections(db, input.userId, input.collectionId);
      if (!collection) return null;
      const cards = await listVisibleCards(db, input.userId, { collectionId: input.collectionId });
      const open = await findOpenSession(db, input.userId, input.collectionId);
      return {
        collection,
        cards: cards.map((card) => ({ ...card, isNew: card.addedAt > card.publishedAt })),
        openSessionId: open?.id ?? null,
      };
    },

    /** Карточки показаны в списке подборки: считаем их открытыми, если этого ещё не было. */
    async markCardsShown(input: { userId: number; cardIds: number[] }) {
      if (input.cardIds.length === 0) return;
      await db.transaction(async (tx) => {
        await lockUser(tx, input.userId);
        const cards = await listVisibleCards(tx, input.userId, { cardIds: input.cardIds });
        const seen = await tx
          .selectDistinct({ id: cardViews.studentCardId })
          .from(cardViews)
          .where(inArray(cardViews.studentCardId, input.cardIds));
        const seenIds = new Set(seen.map((row) => row.id));
        await recordViews(tx, input.userId, cards.filter((card) => !seenIds.has(card.cardId)));
      });
    },

    async openCollectionCard(input: { userId: number; cardId: number }): Promise<CollectionCardScreen | null> {
      return db.transaction(async (tx) => {
        await lockUser(tx, input.userId);
        const [card] = await listVisibleCards(tx, input.userId, { cardIds: [input.cardId] });
        if (!card) return null;
        await recordViews(tx, input.userId, [card]);
        const siblings = await listVisibleCards(tx, input.userId, { collectionId: card.collectionId });
        const index = siblings.findIndex((sibling) => sibling.cardId === card.cardId);
        return {
          card: contentOf(card.version),
          collectionId: card.collectionId,
          nextCardId: siblings[index + 1]?.cardId ?? null,
          previousCardId: siblings[index - 1]?.cardId ?? null,
        };
      });
    },
  };
}



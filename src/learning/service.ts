// Занятия, словарь и сложные слова ученика. Сервис не знает о Telegram: его вызывает бот, состояние хранится только в базе.
// Каждое изменение идёт под блокировкой строки ученика: порядок блокировок тот же, что в привязке (linking/locks.ts).
import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
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
  users,
} from "../db/schema.js";
import {
  applyAnswer,
  buildChoiceOptions,
  buildExamPlan,
  buildSessionPlan,
  checkAnswer,
  createSessionState,
  isBlankAnswer,
  isQuestStale,
  isValidTimeZone,
  LEARNING_SETTINGS,
  localDate,
  nextStep,
  parseClock,
  formatClock,
  questStreak,
  primaryAnswerText,
  promptText,
  recordAnswer,
  removeWordsFromPlan,
  summarizeSession,
  type AttemptNumber,
  type Direction,
  type PlanFormat,
  type PlanItem,
  type QuestionFormat,
  type Rng,
  type SessionState,
  type SessionStep,
  type WordTransition,
} from "../domain/learning/index.js";
import { lockUser } from "../linking/locks.js";
import { refreshCollectionStatuses } from "./collection-progress.js";
import {
  closeStaleQuests,
  completedQuestDates,
  ensureTodayQuest,
  examCandidates,
  findQuest,
  progressSummary,
  type ProgressSummary,
} from "./practice.js";
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

export type SessionType = SessionRow["type"];
/** Занятия по одной подборке: тест кнопками и «Переведи меня» с вводом ответа. */
export type CollectionSessionType = Extract<SessionType, "test" | "translate">;

const PLAN_FORMAT: Record<CollectionSessionType | "hard_words", PlanFormat> = {
  test: "choice",
  translate: "typed",
  // Практика сложных слов проверяет и кнопками, и вводом в обоих направлениях.
  hard_words: "mixed",
};

export type WordPair = { english: string; translation: string };
export type CardContent = WordPair & { example: string | null; explanation: string | null };

export type AskedQuestion = {
  sessionId: number;
  questionId: number;
  attemptNumber: AttemptNumber;
  isRepeat: boolean;
  direction: Direction;
  format: QuestionFormat;
  /** Вопрос с вводом вместо кнопок: для слова не нашлось неверных вариантов (раздел 5 сценария). */
  typedFallback: boolean;
  prompt: string;
  /** Полный текст сохранённых вариантов. Пусто у вопроса с вводом. */
  options: string[];
  /** Номер вопроса в занятии и всего вопросов. Для повтора не показываются. */
  number: number;
  total: number;
};

export type SessionResult = {
  sessionId: number;
  type: SessionType;
  title: string | null;
  plannedCount: number;
  answeredCount: number;
  /** Верно с первой попытки: верный повтор сюда не входит. */
  firstAttemptCorrect: number;
  /** Верно с первой попытки или на повторе. */
  afterRepeatCorrect: number;
  /** Слова, ставшие сложными в этом занятии. */
  becameHard: WordPair[];
  /** Слова, освоенные в этом занятии: пять верных ответов подряд с первой попытки. */
  mastered: WordPair[];
  /** Слова занятия, которые остаются сложными, и их серия «5 из 5» сейчас. */
  stillHard: (WordPair & { correctStreak: number })[];
  /** Слова с ошибкой с первой попытки: «ошибки» экзамена и «слова для повтора» квеста. */
  mistakes: WordPair[];
};

export type SessionProgress =
  | { kind: "question"; question: AskedQuestion }
  | { kind: "finished"; result: SessionResult };

export type StartResult =
  | { kind: "not_found" }
  | { kind: "no_words" }
  | { kind: "started"; progress: SessionProgress; pausedPrevious: boolean };

export type ResumeResult =
  | { kind: "not_found" }
  | { kind: "resumed"; progress: SessionProgress; pausedPrevious: boolean }
  | { kind: "finished"; result: SessionResult };

export type PauseResult = { kind: "not_found" } | { kind: "paused" } | { kind: "not_current" };

/** Экран «Ежедневная практика». streak — дней подряд с завершённым квестом. */
export type DailyScreen =
  /** Часовой пояс не выбран: квест привязан к локальной дате ученика. */
  | { kind: "no_timezone" }
  | { kind: "no_words"; streak: number }
  /** Сегодняшний квест ещё не создан. */
  | { kind: "ready"; streak: number; questionCount: number }
  | { kind: "open"; sessionId: number; answered: number; total: number; streak: number }
  | { kind: "completed"; sessionId: number; streak: number };

export type DailyStartResult =
  | { kind: "no_timezone" }
  | { kind: "no_words" }
  /** Сегодняшний квест уже пройден: второй в тот же день не создаётся. */
  | { kind: "finished"; result: SessionResult }
  | { kind: "started"; progress: SessionProgress; pausedPrevious: boolean };

export type ExamScreen = {
  wordCount: number;
  /** Вопросов в новом экзамене: не больше examSize. */
  questionCount: number;
  openSessionId: number | null;
};

export type StudentSettings = {
  timezone: string | null;
  /** «ЧЧ:ММ». */
  reminderTime: string;
  remindersEnabled: boolean;
};

export type ProgressScreen = ProgressSummary;

export type AnswerFeedback = {
  isCorrect: boolean;
  /** Выбранный вариант или введённый текст. */
  chosen: string;
  card: CardContent;
  /** Есть у вопроса с вводом: основной ожидаемый ответ в направлении вопроса. */
  typed?: { expected: string };
};

/** Что ответ сделал со словом: серия «5 из 5» и переходы между «Сложными» и «Освоенными». */
export type WordProgress = {
  transition: WordTransition;
  /** Ответ увеличил серию «5 из 5». */
  countedInStreak: boolean;
  /** Серия после ответа. */
  correctStreak: number;
  /** Ошибка обнулила начатую серию сложного слова. */
  streakReset: boolean;
};

type Answered = { kind: "answered"; feedback: AnswerFeedback; becameHard: boolean; word: WordProgress; next: SessionProgress };

export type AnswerResult =
  /** Вопрос чужой или его нет: никаких подробностей. */
  | { kind: "not_found" }
  /** На текущий шаг, но такого варианта нет. */
  | { kind: "invalid_option" }
  | Answered
  /** Старая кнопка: попытка не создана. */
  | {
      kind: "stale";
      sessionId: number;
      sessionStatus: SessionRow["status"];
      hasState: boolean;
      /** Последняя сохранённая попытка этого вопроса. */
      saved: AnswerFeedback | null;
    };

export type TypedAnswerResult =
  /** Текущего занятия или открытого вопроса нет: текст не ответ. */
  | { kind: "no_question" }
  /** Текущий вопрос с кнопками: текст не ответ. */
  | { kind: "choice_question"; sessionId: number }
  /**
   * Сообщение отправлено раньше, чем показан текущий вопрос (например, ответ отправлен дважды),
   * или показ не записан. Попытки нет, вопрос показывается заново.
   */
  | { kind: "early"; question: AskedQuestion }
  /** В тексте нет ни буквы, ни цифры. Попытки нет. */
  | { kind: "blank" }
  | Answered;

export type OpenSession = { sessionId: number; type: SessionType; title: string | null; status: "current" | "paused" };

export type CollectionScreen = {
  collection: VisibleCollection;
  cards: (VisibleCard & { isNew: boolean })[];
  /** Открытые занятия по подборке: их продолжают, а не начинают заново. */
  openSessions: Record<CollectionSessionType, number | null>;
};

export type HardWord = VocabularyWord & { correctStreak: number };

export type HardWordsScreen = {
  words: HardWord[];
  /** Открытое повторение сложных слов. */
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

function settingsOf(user: typeof users.$inferSelect): StudentSettings {
  const minutes = parseClock(user.reminderTime);
  return {
    timezone: user.timezone,
    reminderTime: minutes === null ? LEARNING_SETTINGS.defaultReminderTime : formatClock(minutes),
    remindersEnabled: user.remindersEnabled,
  };
}

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
  const marked = await tx
    .select({
      english: cardVersions.english,
      translation: cardVersions.primaryTranslation,
      becameHard: attempts.becameHard,
    })
    .from(attempts)
    .innerJoin(questions, eq(questions.id, attempts.questionId))
    .innerJoin(cardVersions, eq(cardVersions.id, questions.cardVersionId))
    .where(and(eq(questions.sessionId, session.id), or(eq(attempts.becameHard, true), eq(attempts.becameMastered, true))))
    .orderBy(asc(attempts.id));
  const pair = ({ english, translation }: WordPair): WordPair => ({ english, translation });
  // Пара берётся из версии, по которой был задан вопрос: так ученик и видел слово в этом занятии.
  const stillHard = await tx
    .selectDistinctOn([questions.studentWordId], {
      english: cardVersions.english,
      translation: cardVersions.primaryTranslation,
      correctStreak: studentWords.correctStreak,
    })
    .from(questions)
    .innerJoin(cardVersions, eq(cardVersions.id, questions.cardVersionId))
    .innerJoin(studentWords, eq(studentWords.id, questions.studentWordId))
    .where(and(eq(questions.sessionId, session.id), eq(studentWords.status, "hard")))
    .orderBy(questions.studentWordId, asc(questions.position));
  const mistakes = await tx
    .select({ english: cardVersions.english, translation: cardVersions.primaryTranslation })
    .from(attempts)
    .innerJoin(questions, eq(questions.id, attempts.questionId))
    .innerJoin(cardVersions, eq(cardVersions.id, questions.cardVersionId))
    .where(and(eq(questions.sessionId, session.id), eq(attempts.attemptNumber, 1), eq(attempts.isCorrect, false)))
    .orderBy(asc(questions.position));
  return {
    sessionId: session.id,
    type: session.type,
    title: await collectionTitle(tx, session.studentCollectionId),
    plannedCount: summary.plannedCount,
    answeredCount: summary.answeredCount,
    firstAttemptCorrect: summary.firstAttempt.correct,
    afterRepeatCorrect: summary.afterRepeat.correct,
    becameHard: marked.filter((row) => row.becameHard).map(pair),
    mastered: marked.filter((row) => !row.becameHard).map(pair),
    stillHard,
    mistakes,
  };
}

function askedQuestion(
  session: SessionRow,
  state: SessionState,
  step: Exclude<SessionStep, { kind: "finished" }>,
  question: QuestionRow,
  version: CardVersionRow,
): AskedQuestion {
  const summary = summarizeSession(state);
  return {
    sessionId: session.id,
    questionId: question.id,
    attemptNumber: step.attemptNumber,
    isRepeat: step.kind === "repeat",
    direction: question.direction,
    format: question.format,
    typedFallback: question.format === "typed" && step.item.format === "choice",
    prompt: promptText(version, question.direction),
    options: (question.options ?? []).map((option) => option.text),
    number: summary.answeredCount + 1,
    total: summary.plannedCount,
  };
}

export type LearningServiceOptions = {
  rng?: Rng;
  /** Часы: локальная дата квеста и время ответа. В тестах подменяются. */
  now?: () => Date;
};

export function createLearningService(db: Db, options: LearningServiceOptions = {}) {
  const rng = options.rng ?? Math.random;
  const clock = options.now ?? (() => new Date());

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

    const step = nextStep(state);
    let question: QuestionRow | undefined;
    if (step.kind !== "finished") {
      const existing = asked.get(step.position);
      question = existing ?? (await createQuestion(tx, session, step.position, step.item, visible));
      if (existing && step.kind === "repeat" && existing.status !== "open") {
        [question] = await tx.update(questions).set({ status: "open" }).where(eq(questions.id, existing.id)).returning();
      }
    }

    const finished = step.kind === "finished";
    const [saved] = await tx
      .update(sessions)
      .set({
        learningState: state,
        currentStep: finished ? state.plan.length : step.position,
        ...(finished ? { status: "completed" as const, finishedAt: clock() } : {}),
      })
      .where(eq(sessions.id, session.id))
      .returning();
    if (!saved) throw new Error(`Занятие ${session.id} не найдено`);

    if (step.kind === "finished") return { kind: "finished", result: await buildResult(tx, saved, state) };
    if (!question) throw new Error(`У занятия ${session.id} нет вопроса на шаге ${step.position}`);

    const [version] = await tx.select().from(cardVersions).where(eq(cardVersions.id, question.cardVersionId));
    if (!version) throw new Error(`Версия карточки ${question.cardVersionId} не найдена`);
    return { kind: "question", question: askedQuestion(saved, state, step, question, version) };
  }

  /**
   * Новый вопрос идёт по актуальной версии: cardVersionId в плане только указывает, с какой карточки начать.
   * Если для кнопок нет ни одного неверного варианта, слово спрашивается вводом (раздел 5 сценария).
   */
  async function createQuestion(
    tx: DbTx,
    session: SessionRow,
    position: number,
    item: PlanItem,
    visible: VisibleCard[],
  ): Promise<QuestionRow> {
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

    const built =
      item.format === "choice"
        ? buildChoiceOptions({
            card: chosen.version,
            sameWordCards: wordCards.filter((card) => card !== chosen).map((card) => card.version),
            direction: item.direction,
            pool: visible.filter((card) => card.studentWordId !== item.studentWordId).map((card) => card.version),
            rng,
          })
        : null;

    const [question] = await tx
      .insert(questions)
      .values({
        sessionId: session.id,
        position,
        studentWordId: item.studentWordId,
        cardVersionId: chosen.version.id,
        direction: item.direction,
        ...(built?.available
          ? { format: "choice" as const, options: built.options, correctOptionIndex: built.correctOptionIndex }
          : { format: "typed" as const }),
      })
      .returning();
    if (!question) throw new Error("Вопрос не создан");
    return question;
  }

  /**
   * Записывает попытку на текущий шаг: попытка, состояние занятия, слово и статус подборки меняются в одной транзакции
   * под блокировкой ученика. Пусто: шаг уже не тот или попытка уже записана. Тогда ничего не меняется.
   */
  async function recordAttempt(
    tx: DbTx,
    input: {
      userId: number;
      session: SessionRow;
      state: SessionState;
      question: QuestionRow;
      version: CardVersionRow;
      attemptNumber: AttemptNumber;
      answerText: string;
      selectedOptionIndex: number | null;
    },
  ): Promise<Omit<Answered, "feedback"> & { isCorrect: boolean } | null> {
    const { session, question, version, attemptNumber } = input;
    // Заданный вопрос принимается по своей версии и по всем действующим карточкам слова.
    const wordCards = await listVisibleCards(tx, input.userId, { studentWordId: question.studentWordId });
    const { isCorrect } = checkAnswer([version, ...wordCards.map((card) => card.version)], question.direction, input.answerText);

    // recordAnswer вызывается до записи попытки: при отказе записывать нечего.
    const recorded = recordAnswer(input.state, { position: question.position, attemptNumber, isCorrect });
    if (!recorded.accepted) return null;

    const [word] = await tx
      .select()
      .from(studentWords)
      .where(eq(studentWords.id, question.studentWordId))
      .for("update");
    if (!word) throw new Error(`Слово ${question.studentWordId} не найдено`);
    const now = clock();
    const applied = applyAnswer(word, { sessionId: session.id, attemptNumber, isCorrect, now });
    const becameHard = applied.transition === "became_hard" || applied.transition === "returned_to_hard";

    // Уникальное ограничение решает спор, если попытка уже записана мимо блокировки ученика.
    const inserted = await tx
      .insert(attempts)
      .values({
        questionId: question.id,
        attemptNumber,
        studentLinkId: await linkForCollection(tx, input.userId, session.studentCollectionId),
        selectedOptionIndex: input.selectedOptionIndex,
        answerText: input.answerText,
        isCorrect,
        becameHard,
        becameMastered: applied.transition === "mastered",
        answeredAt: now,
      })
      .onConflictDoNothing({ target: [attempts.questionId, attempts.attemptNumber] })
      .returning({ id: attempts.id });
    if (inserted.length === 0) return null;

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
      isCorrect,
      becameHard,
      word: {
        transition: applied.transition,
        countedInStreak: applied.countedInStreak,
        correctStreak: applied.word.correctStreak,
        streakReset: word.status === "hard" && !isCorrect && word.correctStreak > 0,
      },
      next: await advance(tx, session, recorded.state),
    };
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

  /** Открытое занятие ученика этого типа: по подборке или, без неё, повторение сложных слов. */
  async function findOpenSession(tx: DbOrTx, studentUserId: number, type: SessionType, collectionId: number | null) {
    const [session] = await tx
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.studentUserId, studentUserId),
          collectionId === null ? isNull(sessions.studentCollectionId) : eq(sessions.studentCollectionId, collectionId),
          eq(sessions.type, type),
          inArray(sessions.status, ["current", "paused"]),
          isNotNull(sessions.learningState),
        ),
      )
      .orderBy(desc(sessions.id))
      .limit(1);
    return session;
  }

  function planFromCards(type: CollectionSessionType | "hard_words", cards: VisibleCard[]): PlanItem[] {
    return buildSessionPlan(
      cards.map((card) => ({ studentWordId: card.studentWordId, cardVersionId: card.version.id })),
      { rng, format: PLAN_FORMAT[type] },
    );
  }

  async function createSession(
    tx: DbTx,
    input: { userId: number; type: CollectionSessionType | "hard_words" | "exam"; collectionId: number | null; plan: PlanItem[] },
  ): Promise<StartResult> {
    const { plan } = input;
    const state = createSessionState(plan);
    const pausedPrevious = await pauseCurrent(tx, input.userId);
    const [session] = await tx
      .insert(sessions)
      .values({
        studentUserId: input.userId,
        studentLinkId: await linkForCollection(tx, input.userId, input.collectionId),
        studentCollectionId: input.collectionId,
        type: input.type,
        questionPlan: plan,
        learningState: state,
      })
      .returning();
    if (!session) throw new Error("Занятие не создано");
    return { kind: "started", pausedPrevious, progress: await advance(tx, session, state) };
  }

  /** Сложные слова ученика, у которых есть действующие карточки. */
  async function hardWords(tx: DbOrTx, userId: number): Promise<HardWord[]> {
    const hard = await tx
      .select({ id: studentWords.id, correctStreak: studentWords.correctStreak })
      .from(studentWords)
      .where(and(eq(studentWords.studentUserId, userId), eq(studentWords.status, "hard")));
    if (hard.length === 0) return [];
    const streaks = new Map(hard.map((word) => [word.id, word.correctStreak]));
    const cards = await listVisibleCards(tx, userId);
    return groupWords(cards.filter((card) => streaks.has(card.studentWordId))).map((word) => ({
      ...word,
      correctStreak: streaks.get(word.studentWordId)!,
    }));
  }

  /**
   * Квест не за сегодняшнюю локальную дату закрывается как незавершённый: вчерашний квест не возобновляется,
   * ответы в нём сохраняются. Остальные занятия возвращаются без изменений.
   */
  async function expireStaleQuest(tx: DbTx, session: SessionRow, timezone: string | null): Promise<SessionRow> {
    if (session.type !== "daily_quest" || session.questLocalDate === null || timezone === null) return session;
    if (session.status !== "current" && session.status !== "paused") return session;
    if (!isQuestStale(session.questLocalDate, localDate(clock(), timezone))) return session;
    const [closed] = await tx
      .update(sessions)
      .set({ status: "incomplete", finishedAt: clock() })
      .where(eq(sessions.id, session.id))
      .returning();
    return closed ?? session;
  }

  async function streakFor(tx: DbOrTx, userId: number, timezone: string): Promise<number> {
    return questStreak(await completedQuestDates(tx, userId), localDate(clock(), timezone));
  }

  async function updateSettings(
    userId: number,
    patch: Partial<Pick<typeof users.$inferInsert, "timezone" | "reminderTime" | "remindersEnabled">>,
  ): Promise<StudentSettings | null> {
    return db.transaction(async (tx) => {
      await lockUser(tx, userId);
      const [user] = await tx.update(users).set(patch).where(eq(users.id, userId)).returning();
      return user ? settingsOf(user) : null;
    });
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
     * Запускает тест кнопками или «Переведи меня» по подборке. Открытое занятие того же вида по этой подборке
     * продолжается, а не создаётся заново: двойное нажатие не даёт второго занятия. Любое другое текущее занятие
     * ставится на паузу.
     */
    async startCollectionSession(input: {
      userId: number;
      collectionId: number;
      type: CollectionSessionType;
    }): Promise<StartResult> {
      return db.transaction(async (tx): Promise<StartResult> => {
        await lockUser(tx, input.userId);
        const [collection] = await listVisibleCollections(tx, input.userId, input.collectionId);
        if (!collection) return { kind: "not_found" };

        const open = await findOpenSession(tx, input.userId, input.type, input.collectionId);
        if (open?.learningState) {
          const pausedPrevious = await makeCurrent(tx, open);
          return { kind: "started", pausedPrevious, progress: await advance(tx, open, open.learningState) };
        }

        const cards = await listVisibleCards(tx, input.userId, { collectionId: input.collectionId });
        if (cards.length === 0) return { kind: "no_words" };
        return createSession(tx, {
          userId: input.userId,
          type: input.type,
          collectionId: input.collectionId,
          plan: planFromCards(input.type, cards),
        });
      });
    },

    // ---------- Сложные слова ----------

    /** «Сложные слова»: слово, перевод, подборки и серия «5 из 5». Освоенные и удалённые сюда не входят. */
    async openHardWords(userId: number): Promise<HardWordsScreen> {
      const open = await findOpenSession(db, userId, "hard_words", null);
      return { words: await hardWords(db, userId), openSessionId: open?.id ?? null };
    },

    /**
     * Повторение по всему списку или по выбранным словам. Слова вне списка (уже освоены, чужие, удалены) отбрасываются.
     * Открытое повторение того же набора продолжается: двойное нажатие не даёт второго занятия. Повторение другого
     * набора закрывает прежнее как незавершённое, его ответы сохраняются.
     */
    async startHardPractice(input: { userId: number; wordIds: readonly number[] | "all" }): Promise<StartResult> {
      return db.transaction(async (tx): Promise<StartResult> => {
        await lockUser(tx, input.userId);
        const requested = input.wordIds === "all" ? null : new Set(input.wordIds);
        const words = (await hardWords(tx, input.userId)).filter(
          (word) => requested === null || requested.has(word.studentWordId),
        );
        if (words.length === 0) return { kind: "no_words" };

        const open = await findOpenSession(tx, input.userId, "hard_words", null);
        if (open?.learningState) {
          const planned = new Set(open.learningState.plan.map((item) => item.studentWordId));
          const same = planned.size === words.length && words.every((word) => planned.has(word.studentWordId));
          if (same) {
            const pausedPrevious = await makeCurrent(tx, open);
            return { kind: "started", pausedPrevious, progress: await advance(tx, open, open.learningState) };
          }
          await tx
            .update(sessions)
            .set({ status: "incomplete", finishedAt: clock() })
            .where(eq(sessions.id, open.id));
        }

        // Одна карточка на слово: вопрос всё равно принимает ответы всех его карточек.
        const cards = words.map((word) => word.cards.reduce((a, b) => (b.version.id > a.version.id ? b : a)));
        return createSession(tx, {
          userId: input.userId,
          type: "hard_words",
          collectionId: null,
          plan: planFromCards("hard_words", cards),
        });
      });
    },

    /** Возвращается к занятию с сохранённого шага. Вопрос тот же, что был отправлен. */
    async resumeSession(input: { userId: number; sessionId: number }): Promise<ResumeResult> {
      return db.transaction(async (tx): Promise<ResumeResult> => {
        const user = await lockUser(tx, input.userId);
        const [found] = await tx
          .select()
          .from(sessions)
          .where(and(eq(sessions.id, input.sessionId), eq(sessions.studentUserId, input.userId)));
        if (!found?.learningState) return { kind: "not_found" };
        const session = await expireStaleQuest(tx, found, user.timezone);
        if (!session.learningState) return { kind: "not_found" };
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
        const user = await lockUser(tx, input.userId);
        const [row] = await tx
          .select({ question: questions, session: sessions, version: cardVersions })
          .from(questions)
          .innerJoin(sessions, eq(sessions.id, questions.sessionId))
          .innerJoin(cardVersions, eq(cardVersions.id, questions.cardVersionId))
          .where(and(eq(questions.id, input.questionId), eq(sessions.studentUserId, input.userId)));
        if (!row) return { kind: "not_found" };
        const { question, version } = row;
        const session = await expireStaleQuest(tx, row.session, user.timezone);

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

        const recorded = await recordAttempt(tx, {
          userId: input.userId,
          session,
          state,
          question,
          version,
          attemptNumber: step.attemptNumber,
          answerText: chosen,
          selectedOptionIndex: input.optionIndex,
        });
        if (!recorded) return staleAnswer(tx, session, question, version);
        const { isCorrect, ...rest } = recorded;
        return { ...rest, feedback: { isCorrect, chosen, card: contentOf(version) } };
      });
    },

    /**
     * Текстовое сообщение. Ответом оно считается, только если у текущего занятия открыт вопрос с вводом,
     * а сообщение отправлено после его показа. Иначе попытки нет.
     */
    async answerTyped(input: { userId: number; text: string; messageId: number }): Promise<TypedAnswerResult> {
      return db.transaction(async (tx): Promise<TypedAnswerResult> => {
        const user = await lockUser(tx, input.userId);
        const [found] = await tx
          .select()
          .from(sessions)
          .where(
            and(
              eq(sessions.studentUserId, input.userId),
              eq(sessions.status, "current"),
              isNotNull(sessions.learningState),
            ),
          );
        const session = found ? await expireStaleQuest(tx, found, user.timezone) : undefined;
        const state = session?.learningState;
        if (!session || !state || session.status !== "current") return { kind: "no_question" };
        const step = nextStep(state);
        if (step.kind === "finished") return { kind: "no_question" };

        const [row] = await tx
          .select({ question: questions, version: cardVersions })
          .from(questions)
          .innerJoin(cardVersions, eq(cardVersions.id, questions.cardVersionId))
          .where(and(eq(questions.sessionId, session.id), eq(questions.position, step.position)));
        if (!row || row.question.status !== "open") return { kind: "no_question" };
        const { question, version } = row;
        if (question.format !== "typed") return { kind: "choice_question", sessionId: session.id };
        if (question.promptMessageId === null || input.messageId <= question.promptMessageId) {
          return { kind: "early", question: askedQuestion(session, state, step, question, version) };
        }

        const answerText = input.text.trim();
        if (isBlankAnswer(answerText)) return { kind: "blank" };

        const recorded = await recordAttempt(tx, {
          userId: input.userId,
          session,
          state,
          question,
          version,
          attemptNumber: step.attemptNumber,
          answerText,
          selectedOptionIndex: null,
        });
        if (!recorded) return { kind: "no_question" };
        const { isCorrect, ...rest } = recorded;
        return {
          ...rest,
          feedback: {
            isCorrect,
            chosen: answerText,
            card: contentOf(version),
            typed: { expected: primaryAnswerText(version, question.direction) },
          },
        };
      });
    },

    /**
     * Бот показал вопрос с вводом в сообщении messageId. Номер только растёт: повторный показ того же вопроса
     * (повтор ошибки, «Продолжить») сдвигает границу, старый показ её не откатывает.
     */
    async markQuestionShown(input: { userId: number; questionId: number; messageId: number }) {
      await db
        .update(questions)
        .set({ promptMessageId: sql`GREATEST(COALESCE(${questions.promptMessageId}, 0), ${input.messageId})` })
        .where(
          and(
            eq(questions.id, input.questionId),
            inArray(
              questions.sessionId,
              db.select({ id: sessions.id }).from(sessions).where(eq(sessions.studentUserId, input.userId)),
            ),
          ),
        );
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
      await db.transaction(async (tx) => {
        const user = await lockUser(tx, userId);
        if (user.timezone !== null) await closeStaleQuests(tx, userId, localDate(clock(), user.timezone), clock());
      });
      const rows = await db
        .select({ sessionId: sessions.id, type: sessions.type, title: studentCollections.title, status: sessions.status })
        .from(sessions)
        .leftJoin(studentCollections, eq(studentCollections.id, sessions.studentCollectionId))
        .where(
          and(
            eq(sessions.studentUserId, userId),
            inArray(sessions.status, ["current", "paused"]),
            isNotNull(sessions.learningState),
            // Квест, созданный планировщиком и ещё не начатый, продолжать нечего: он начинается из «Ежедневной практики».
            sql`(${sessions.type} <> 'daily_quest' OR EXISTS (SELECT 1 FROM questions q WHERE q.session_id = ${sessions.id}))`,
          ),
        )
        .orderBy(sql`${sessions.status} = 'current' DESC`, desc(sessions.updatedAt), desc(sessions.id));
      return rows as OpenSession[];
    },

    // ---------- Ежедневная практика ----------

    /** Экран «Ежедневная практика». Квест здесь не создаётся: только показ и закрытие квестов прошлых дней. */
    async openDaily(userId: number): Promise<DailyScreen> {
      return db.transaction(async (tx): Promise<DailyScreen> => {
        const user = await lockUser(tx, userId);
        if (user.timezone === null) return { kind: "no_timezone" };
        const today = localDate(clock(), user.timezone);
        await closeStaleQuests(tx, userId, today, clock());
        const streak = await streakFor(tx, userId, user.timezone);
        const quest = await findQuest(tx, userId, today);
        if (quest?.status === "completed") return { kind: "completed", sessionId: quest.id, streak };
        if (quest?.learningState && (quest.status === "current" || quest.status === "paused")) {
          const summary = summarizeSession(quest.learningState);
          // Квест, созданный вместе с напоминанием, ещё не начат: для ученика это «Начать», а не «Продолжить».
          if (summary.answeredCount === 0) return { kind: "ready", streak, questionCount: summary.plannedCount };
          return { kind: "open", sessionId: quest.id, answered: summary.answeredCount, total: summary.plannedCount, streak };
        }
        const words = groupWords(await listVisibleCards(tx, userId)).length;
        if (words === 0) return { kind: "no_words", streak };
        return { kind: "ready", streak, questionCount: Math.min(words, LEARNING_SETTINGS.questSize) };
      });
    },

    /**
     * «Начать» или «Продолжить» сегодняшний квест: из меню и из напоминания. Второй квест за день не создаётся:
     * повторное нажатие, повторная доставка напоминания и перезапуск сервиса продолжают тот же.
     */
    async startDaily(userId: number): Promise<DailyStartResult> {
      return db.transaction(async (tx): Promise<DailyStartResult> => {
        const user = await lockUser(tx, userId);
        if (user.timezone === null) return { kind: "no_timezone" };
        const ensured = await ensureTodayQuest(tx, { studentUserId: userId, timezone: user.timezone, now: clock(), rng });
        if (!ensured) return { kind: "no_words" };
        const { session } = ensured;
        if (!session.learningState) throw new Error(`У квеста ${session.id} нет состояния`);
        if (session.status !== "current" && session.status !== "paused") {
          return { kind: "finished", result: await buildResult(tx, session, session.learningState) };
        }
        const pausedPrevious = await makeCurrent(tx, session);
        return { kind: "started", pausedPrevious, progress: await advance(tx, session, session.learningState) };
      });
    },

    // ---------- Экзамен ----------

    async openExam(userId: number): Promise<ExamScreen> {
      const wordCount = groupWords(await listVisibleCards(db, userId)).length;
      const open = await findOpenSession(db, userId, "exam", null);
      return {
        wordCount,
        questionCount: Math.min(wordCount, LEARNING_SETTINGS.examSize),
        openSessionId: open?.id ?? null,
      };
    },

    /** Начинает экзамен или продолжает открытый: двойное нажатие не даёт второго экзамена. */
    async startExam(userId: number): Promise<StartResult> {
      return db.transaction(async (tx): Promise<StartResult> => {
        await lockUser(tx, userId);
        const open = await findOpenSession(tx, userId, "exam", null);
        if (open?.learningState) {
          const pausedPrevious = await makeCurrent(tx, open);
          return { kind: "started", pausedPrevious, progress: await advance(tx, open, open.learningState) };
        }
        const plan = buildExamPlan(await examCandidates(tx, userId), { rng });
        if (plan.length === 0) return { kind: "no_words" };
        return createSession(tx, { userId, type: "exam", collectionId: null, plan });
      });
    },

    // ---------- Прогресс ----------

    async getProgress(userId: number): Promise<ProgressScreen> {
      const [user] = await db.select({ timezone: users.timezone }).from(users).where(eq(users.id, userId));
      return progressSummary(db, { studentUserId: userId, timezone: user?.timezone ?? null, now: clock() });
    },

    // ---------- Настройки ----------

    async getSettings(userId: number): Promise<StudentSettings> {
      const [user] = await db.select().from(users).where(eq(users.id, userId));
      if (!user) throw new Error(`Пользователь ${userId} не найден`);
      return settingsOf(user);
    },

    /** Часовой пояс IANA. null: пояс не распознан, ничего не изменено. */
    async setTimezone(userId: number, timezone: string): Promise<StudentSettings | null> {
      if (!isValidTimeZone(timezone)) return null;
      return updateSettings(userId, { timezone });
    },

    /** Время напоминания в минутах от полуночи. null: неверное значение. */
    async setReminderTime(userId: number, minutes: number): Promise<StudentSettings | null> {
      if (!Number.isInteger(minutes) || minutes < 0 || minutes >= 24 * 60) return null;
      return updateSettings(userId, { reminderTime: formatClock(minutes) });
    },

    async setRemindersEnabled(userId: number, enabled: boolean): Promise<StudentSettings> {
      return (await updateSettings(userId, { remindersEnabled: enabled }))!;
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
      const test = await findOpenSession(db, input.userId, "test", input.collectionId);
      const translate = await findOpenSession(db, input.userId, "translate", input.collectionId);
      return {
        collection,
        cards: cards.map((card) => ({ ...card, isNew: card.addedAt > card.publishedAt })),
        openSessions: { test: test?.id ?? null, translate: translate?.id ?? null },
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



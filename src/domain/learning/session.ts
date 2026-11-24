import { randomIndex, shuffled, type Rng } from "./rng.js";
import { LEARNING_SETTINGS } from "./settings.js";
import { oppositeDirection, type AttemptNumber, type Direction, type QuestionFormat } from "./types.js";

export type PlanWord = {
  studentWordId: number;
  cardVersionId: number;
};

/**
 * Пункт плана, совпадает с SessionPlanItem из schema.ts.
 * cardVersionId — снимок на момент составления плана: новый вопрос создаётся по актуальной версии карточки.
 */
export type PlanItem = PlanWord & {
  direction: Direction;
  format: QuestionFormat;
};

export type DirectionMode = "alternate" | "random";

export type BuildPlanOptions = {
  rng: Rng;
  /** alternate: направления чередуются, первое выбирает генератор. random: каждое выбирает генератор. */
  directionMode?: DirectionMode;
  format?: QuestionFormat;
};

/** План занятия: слова в случайном порядке, каждое слово один раз. */
export function buildSessionPlan(words: readonly PlanWord[], options: BuildPlanOptions): PlanItem[] {
  const { rng, directionMode = "alternate", format = "choice" } = options;
  const unique = new Map<number, PlanWord>();
  for (const word of words) {
    if (!unique.has(word.studentWordId)) unique.set(word.studentWordId, word);
  }
  const order = shuffled([...unique.values()], rng);
  let direction = randomDirection(rng);
  return order.map((word, index) => {
    if (index > 0) direction = directionMode === "alternate" ? oppositeDirection(direction) : randomDirection(rng);
    return { studentWordId: word.studentWordId, cardVersionId: word.cardVersionId, direction, format };
  });
}

function randomDirection(rng: Rng): Direction {
  return randomIndex(2, rng) === 0 ? "ru_en" : "en_ru";
}

/** Результаты попыток одного пункта плана. Пусто: попытки ещё не было. */
export type ItemAnswers = {
  first: boolean | null;
  second: boolean | null;
};

/** Состояние занятия: только JSON-значения. Генератор и часы в нём не нужны. */
export type SessionState = {
  seriesSize: number;
  /** План не меняется. Индекс в нём — номер вопроса, он же questions.position. */
  plan: PlanItem[];
  /** Выровнен с plan по индексу. */
  answers: ItemAnswers[];
  /** Позиция, начиная с которой ищется следующий новый вопрос. */
  cursor: number;
  /** Номер текущей серии, с единицы. */
  seriesNumber: number;
  /** Сколько новых вопросов текущей серии уже получили ответ. */
  seriesAnswered: number;
  /** Позиции с ошибкой в текущей серии, ждущие повтора, в порядке ошибок. */
  repeatQueue: number[];
  /** Позиции, снятые с плана: карточка удалена до того, как вопрос был задан. */
  removedPositions: number[];
};

export function createSessionState(
  plan: readonly PlanItem[],
  options: { seriesSize?: number } = {},
): SessionState {
  const seriesSize = options.seriesSize ?? LEARNING_SETTINGS.seriesSize;
  if (!Number.isInteger(seriesSize) || seriesSize < 1) {
    throw new RangeError(`Размер серии должен быть целым положительным числом, получено ${seriesSize}`);
  }
  return {
    seriesSize,
    plan: plan.map((item) => ({ ...item })),
    answers: plan.map(() => ({ first: null, second: null })),
    cursor: 0,
    seriesNumber: 1,
    seriesAnswered: 0,
    repeatQueue: [],
    removedPositions: [],
  };
}

export type SessionStep =
  | { kind: "new"; position: number; attemptNumber: 1; item: PlanItem; seriesNumber: number }
  | { kind: "repeat"; position: number; attemptNumber: 2; item: PlanItem; seriesNumber: number }
  | { kind: "finished" };

/**
 * Что спросить дальше. Состояние меняет только recordAnswer, поэтому до ответа функция возвращает
 * тот же шаг: после перезапуска бот находит вопрос по позиции и не создаёт второй.
 */
export function nextStep(state: SessionState): SessionStep {
  const newPosition = nextNewPosition(state);
  const repeatPosition = state.repeatQueue[0];
  const seriesDone = state.seriesAnswered >= state.seriesSize || newPosition === null;
  if (repeatPosition !== undefined && seriesDone) {
    return {
      kind: "repeat",
      position: repeatPosition,
      attemptNumber: 2,
      item: state.plan[repeatPosition]!,
      seriesNumber: state.seriesNumber,
    };
  }
  if (newPosition !== null) {
    return {
      kind: "new",
      position: newPosition,
      attemptNumber: 1,
      item: state.plan[newPosition]!,
      seriesNumber: state.seriesNumber,
    };
  }
  return { kind: "finished" };
}

function nextNewPosition(state: SessionState): number | null {
  for (let position = state.cursor; position < state.plan.length; position++) {
    if (!state.removedPositions.includes(position)) return position;
  }
  return null;
}

export type RecordAnswerInput = {
  position: number;
  attemptNumber: AttemptNumber;
  isCorrect: boolean;
};

export type RecordAnswerResult =
  /** questionStatus — новое значение questions.status. */
  | { accepted: true; state: SessionState; questionStatus: "awaiting_repeat" | "closed" }
  /** Ответ не на текущий шаг: старая кнопка или повторная доставка. Состояние не меняется. */
  | { accepted: false; state: SessionState };

/** Записывает ответ на текущий шаг. Третьей попытки нет: после второй вопрос закрыт. */
export function recordAnswer(state: SessionState, answer: RecordAnswerInput): RecordAnswerResult {
  const step = nextStep(state);
  if (step.kind === "finished" || step.position !== answer.position || step.attemptNumber !== answer.attemptNumber) {
    return { accepted: false, state };
  }

  const answers = state.answers.map((item) => ({ ...item }));
  const itemAnswers = answers[step.position]!;
  let { cursor, seriesNumber, seriesAnswered } = state;
  let repeatQueue = [...state.repeatQueue];
  let questionStatus: "awaiting_repeat" | "closed" = "closed";

  if (step.kind === "new") {
    itemAnswers.first = answer.isCorrect;
    cursor = step.position + 1;
    seriesAnswered += 1;
    if (!answer.isCorrect) {
      repeatQueue.push(step.position);
      questionStatus = "awaiting_repeat";
    }
  } else {
    itemAnswers.second = answer.isCorrect;
    repeatQueue = repeatQueue.slice(1);
  }

  if (repeatQueue.length === 0 && seriesAnswered >= state.seriesSize) {
    seriesNumber += 1;
    seriesAnswered = 0;
  }

  return {
    accepted: true,
    state: { ...state, answers, cursor, seriesNumber, seriesAnswered, repeatQueue },
    questionStatus,
  };
}

/**
 * Снимает с плана ещё не заданные вопросы по словам без действующих карточек (раздел 8 сценария).
 * Уже заданный вопрос и его повтор завершаются по старой версии, поэтому бот не передаёт сюда слово
 * вопроса, который уже отправлен и ждёт ответа.
 */
export function removeWordsFromPlan(state: SessionState, studentWordIds: readonly number[]): SessionState {
  const removed = new Set(state.removedPositions);
  const words = new Set(studentWordIds);
  state.plan.forEach((item, position) => {
    if (position >= state.cursor && words.has(item.studentWordId)) removed.add(position);
  });
  return { ...state, removedPositions: [...removed].sort((a, b) => a - b) };
}

export type SessionSummary = {
  finished: boolean;
  /** Вопросов в плане без снятых. */
  plannedCount: number;
  /** Вопросов, получивших хотя бы один ответ. */
  answeredCount: number;
  /** Результат с первой попытки: верный повтор сюда не входит. */
  firstAttempt: { correct: number; wrong: number };
  /**
   * Итог после повтора: верно с первой попытки или верно на повторе.
   * pending — ошибка уже есть, а повтор ещё не задан.
   */
  afterRepeat: { correct: number; wrong: number; pending: number };
  firstAttemptCorrectWordIds: number[];
  /** Ошибка с первой попытки и верный повтор. */
  correctedOnRepeatWordIds: number[];
  /** Обе попытки неверны. */
  failedBothWordIds: number[];
  awaitingRepeatWordIds: number[];
};

/** Итоги занятия. Первая попытка и итог после повтора считаются отдельно. */
export function summarizeSession(state: SessionState): SessionSummary {
  const summary: SessionSummary = {
    finished: nextStep(state).kind === "finished",
    plannedCount: state.plan.length - state.removedPositions.length,
    answeredCount: 0,
    firstAttempt: { correct: 0, wrong: 0 },
    afterRepeat: { correct: 0, wrong: 0, pending: 0 },
    firstAttemptCorrectWordIds: [],
    correctedOnRepeatWordIds: [],
    failedBothWordIds: [],
    awaitingRepeatWordIds: [],
  };

  state.plan.forEach((item, position) => {
    const { first, second } = state.answers[position]!;
    if (first === null) return;
    summary.answeredCount += 1;
    if (first) {
      summary.firstAttempt.correct += 1;
      summary.afterRepeat.correct += 1;
      summary.firstAttemptCorrectWordIds.push(item.studentWordId);
      return;
    }
    summary.firstAttempt.wrong += 1;
    if (second === null) {
      summary.afterRepeat.pending += 1;
      summary.awaitingRepeatWordIds.push(item.studentWordId);
    } else if (second) {
      summary.afterRepeat.correct += 1;
      summary.correctedOnRepeatWordIds.push(item.studentWordId);
    } else {
      summary.afterRepeat.wrong += 1;
      summary.failedBothWordIds.push(item.studentWordId);
    }
  });
  return summary;
}

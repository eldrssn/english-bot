import { LEARNING_SETTINGS, type LearningSettings } from "./settings.js";
import { type AttemptNumber } from "./types.js";

export type WordStatus = "learning" | "hard" | "mastered";

/** Изменяемые поля student_words. Строка таблицы подходит без преобразований. */
export type WordLearningState = {
  status: WordStatus;
  correctStreak: number;
  consecutiveErrors: number;
  /**
   * Занятие, которое больше не может увеличить серию: в нём ответ уже засчитан или слово стало сложным.
   * Поэтому отдельное поле «занятие, где слово стало сложным» не требуется.
   */
  lastCountedSessionId: number | null;
  hardSince: Date | null;
  masteredAt: Date | null;
};

export type AppliedAnswer = {
  sessionId: number;
  attemptNumber: AttemptNumber;
  isCorrect: boolean;
  now: Date;
};

export type WordTransition = "none" | "became_hard" | "returned_to_hard" | "mastered";

export type ApplyAnswerResult = {
  word: WordLearningState;
  transition: WordTransition;
  /** Ответ увеличил серию «5 из 5». */
  countedInStreak: boolean;
};

export const INITIAL_WORD_STATE: Readonly<WordLearningState> = Object.freeze({
  status: "learning",
  correctStreak: 0,
  consecutiveErrors: 0,
  lastCountedSessionId: null,
  hardSince: null,
  masteredAt: null,
});

/**
 * Применяет одну попытку к состоянию слова (раздел 7 сценария).
 *
 * consecutiveErrors: ошибка на любой попытке +1, верно с первой попытки — 0. Верно со второй попытки
 * счётчик не меняет: ответ уже был показан, такой повтор не служит независимой оценкой (раздел 4 сценария).
 */
export function applyAnswer(
  word: WordLearningState,
  answer: AppliedAnswer,
  settings: Pick<LearningSettings, "masteryStreak" | "masteredErrorsToHard"> = LEARNING_SETTINGS,
): ApplyAnswerResult {
  const { sessionId, attemptNumber, isCorrect, now } = answer;
  const consecutiveErrors = isCorrect ? word.consecutiveErrors : word.consecutiveErrors + 1;

  if (isCorrect) {
    if (attemptNumber === 2) return unchanged(word, consecutiveErrors);
    return applyFirstAttemptCorrect(word, sessionId, now, settings.masteryStreak);
  }

  const secondErrorInSeries = attemptNumber === 2;
  const returnsFromMastered =
    word.status === "mastered" && consecutiveErrors >= settings.masteredErrorsToHard;

  if (word.status === "hard") {
    return unchanged({ ...word, correctStreak: 0 }, consecutiveErrors);
  }
  if (secondErrorInSeries || returnsFromMastered) {
    return {
      word: {
        ...word,
        status: "hard",
        correctStreak: 0,
        consecutiveErrors,
        lastCountedSessionId: sessionId,
        hardSince: now,
        masteredAt: null,
      },
      transition: word.status === "mastered" ? "returned_to_hard" : "became_hard",
      countedInStreak: false,
    };
  }
  return unchanged(word, consecutiveErrors);
}

function applyFirstAttemptCorrect(
  word: WordLearningState,
  sessionId: number,
  now: Date,
  masteryStreak: number,
): ApplyAnswerResult {
  const reset = { ...word, consecutiveErrors: 0 };
  if (word.status !== "hard" || word.lastCountedSessionId === sessionId) {
    return { word: reset, transition: "none", countedInStreak: false };
  }
  const correctStreak = word.correctStreak + 1;
  const counted = { ...reset, correctStreak, lastCountedSessionId: sessionId };
  if (correctStreak < masteryStreak) {
    return { word: counted, transition: "none", countedInStreak: true };
  }
  return {
    word: { ...counted, status: "mastered", hardSince: null, masteredAt: now },
    transition: "mastered",
    countedInStreak: true,
  };
}

function unchanged(word: WordLearningState, consecutiveErrors: number): ApplyAnswerResult {
  return { word: { ...word, consecutiveErrors }, transition: "none", countedInStreak: false };
}

/**
 * Объединение двух слов, когда правка основного перевода приводит карточку к уже существующему слову
 * (раздел 6 плана): остаётся меньшая серия, «сложное» сохраняется, если было хотя бы у одного.
 * «Освоено» остаётся, только если освоены оба; иначе слово снова изучается. Ошибки подряд — большее значение,
 * последнее засчитанное занятие — более позднее: в нём серия не вырастет второй раз.
 */
export function mergeWordStates(a: WordLearningState, b: WordLearningState): WordLearningState {
  const status: WordStatus =
    a.status === "hard" || b.status === "hard"
      ? "hard"
      : a.status === "mastered" && b.status === "mastered"
        ? "mastered"
        : "learning";
  const lastCounted = [a.lastCountedSessionId, b.lastCountedSessionId].filter((id): id is number => id !== null);
  const dates = (values: (Date | null)[]) => values.filter((value): value is Date => value !== null).map((d) => d.getTime());
  const hardDates = dates([a.status === "hard" ? a.hardSince : null, b.status === "hard" ? b.hardSince : null]);
  const masteredDates = dates([a.masteredAt, b.masteredAt]);
  return {
    status,
    correctStreak: Math.min(a.correctStreak, b.correctStreak),
    consecutiveErrors: Math.max(a.consecutiveErrors, b.consecutiveErrors),
    lastCountedSessionId: lastCounted.length > 0 ? Math.max(...lastCounted) : null,
    hardSince: status === "hard" && hardDates.length > 0 ? new Date(Math.min(...hardDates)) : null,
    masteredAt: status === "mastered" && masteredDates.length > 0 ? new Date(Math.max(...masteredDates)) : null,
  };
}

import { describe, expect, it } from "vitest";
import {
  applyAnswer,
  INITIAL_WORD_STATE,
  mergeWordStates,
  type AttemptNumber,
  type WordLearningState,
  type WordTransition,
} from "../../../src/domain/learning/index.js";

const NOW = new Date("2026-11-05T12:00:00Z");
const EARLIER = new Date("2026-11-01T12:00:00Z");
const S1 = 1;
const S2 = 2;

const learning = (over: Partial<WordLearningState> = {}): WordLearningState => ({ ...INITIAL_WORD_STATE, ...over });
const hard = (over: Partial<WordLearningState> = {}): WordLearningState =>
  learning({ status: "hard", hardSince: EARLIER, lastCountedSessionId: S1, ...over });
const mastered = (over: Partial<WordLearningState> = {}): WordLearningState =>
  learning({ status: "mastered", correctStreak: 5, masteredAt: EARLIER, lastCountedSessionId: S1, ...over });

type Row = {
  name: string;
  from: WordLearningState;
  attempt: AttemptNumber;
  correct: boolean;
  session?: number;
  to: Partial<WordLearningState>;
  transition?: WordTransition;
  counted?: boolean;
};

const table: Row[] = [
  // Новое слово
  { name: "учится: верно с первой — ошибки 0, серия не растёт", from: learning({ consecutiveErrors: 1 }), attempt: 1, correct: true, to: { status: "learning", correctStreak: 0, consecutiveErrors: 0, lastCountedSessionId: null } },
  { name: "учится: первая ошибка — ещё не сложное", from: learning(), attempt: 1, correct: false, to: { status: "learning", correctStreak: 0, consecutiveErrors: 1, hardSince: null } },
  { name: "учится: вторая ошибка в серии — сложное, занятие запомнено", from: learning({ consecutiveErrors: 1 }), attempt: 2, correct: false, session: S1, to: { status: "hard", correctStreak: 0, consecutiveErrors: 2, lastCountedSessionId: S1, hardSince: NOW }, transition: "became_hard" },
  { name: "учится: верно со второй — ошибки не меняются", from: learning({ consecutiveErrors: 1 }), attempt: 2, correct: true, to: { status: "learning", correctStreak: 0, consecutiveErrors: 1 } },
  { name: "учится: ошибки в разных занятиях сложным не делают", from: learning({ consecutiveErrors: 1 }), attempt: 1, correct: false, to: { status: "learning", consecutiveErrors: 2, hardSince: null } },

  // Сложное слово
  { name: "сложное: верно с первой в другом занятии — серия +1", from: hard({ correctStreak: 2, consecutiveErrors: 1 }), attempt: 1, correct: true, session: S2, to: { status: "hard", correctStreak: 3, consecutiveErrors: 0, lastCountedSessionId: S2, hardSince: EARLIER }, counted: true },
  { name: "сложное: верно с первой в том занятии, где стало сложным — не считается", from: hard({ consecutiveErrors: 2 }), attempt: 1, correct: true, session: S1, to: { correctStreak: 0, consecutiveErrors: 0, lastCountedSessionId: S1 }, counted: false },
  { name: "сложное: второй верный ответ в занятии — не считается", from: hard({ correctStreak: 3, lastCountedSessionId: S2 }), attempt: 1, correct: true, session: S2, to: { correctStreak: 3, lastCountedSessionId: S2 }, counted: false },
  { name: "сложное: ошибка с первой обнуляет серию", from: hard({ correctStreak: 4 }), attempt: 1, correct: false, session: S2, to: { status: "hard", correctStreak: 0, consecutiveErrors: 1, hardSince: EARLIER } },
  { name: "сложное: верно со второй — серия и ошибки не меняются", from: hard({ correctStreak: 0, consecutiveErrors: 1 }), attempt: 2, correct: true, session: S2, to: { status: "hard", correctStreak: 0, consecutiveErrors: 1, lastCountedSessionId: S1 }, counted: false },
  { name: "сложное: вторая ошибка — остаётся сложным, дата прежняя", from: hard({ consecutiveErrors: 1 }), attempt: 2, correct: false, session: S2, to: { status: "hard", correctStreak: 0, consecutiveErrors: 2, hardSince: EARLIER, lastCountedSessionId: S1 }, transition: "none" },
  { name: "сложное: четвёртый верный — ещё сложное", from: hard({ correctStreak: 3 }), attempt: 1, correct: true, session: S2, to: { status: "hard", correctStreak: 4, masteredAt: null }, counted: true },
  { name: "сложное: пятый верный — освоено", from: hard({ correctStreak: 4 }), attempt: 1, correct: true, session: S2, to: { status: "mastered", correctStreak: 5, consecutiveErrors: 0, masteredAt: NOW, hardSince: null, lastCountedSessionId: S2 }, transition: "mastered", counted: true },
  { name: "сложное: пятый верный в уже засчитанном занятии — не освоено", from: hard({ correctStreak: 4, lastCountedSessionId: S2 }), attempt: 1, correct: true, session: S2, to: { status: "hard", correctStreak: 4 }, transition: "none", counted: false },
  { name: "сложное: верно со второй на серии 4 — не освоено", from: hard({ correctStreak: 4, consecutiveErrors: 1 }), attempt: 2, correct: true, session: S2, to: { status: "hard", correctStreak: 4 }, transition: "none", counted: false },

  // Освоенное слово
  { name: "освоено: верно с первой — без изменений серии", from: mastered({ consecutiveErrors: 1 }), attempt: 1, correct: true, session: S2, to: { status: "mastered", correctStreak: 5, consecutiveErrors: 0, lastCountedSessionId: S1 }, counted: false },
  { name: "освоено: первая ошибка — остаётся освоенным", from: mastered(), attempt: 1, correct: false, session: S2, to: { status: "mastered", correctStreak: 5, consecutiveErrors: 1, masteredAt: EARLIER } },
  { name: "освоено: верно со второй — ошибка не снимается", from: mastered({ consecutiveErrors: 1 }), attempt: 2, correct: true, session: S2, to: { status: "mastered", consecutiveErrors: 1 } },
  { name: "освоено: вторая ошибка той же серии — снова сложное", from: mastered({ consecutiveErrors: 1 }), attempt: 2, correct: false, session: S2, to: { status: "hard", correctStreak: 0, consecutiveErrors: 2, hardSince: NOW, masteredAt: null, lastCountedSessionId: S2 }, transition: "returned_to_hard" },
  { name: "освоено: вторая ошибка подряд в новом занятии — снова сложное", from: mastered({ consecutiveErrors: 1 }), attempt: 1, correct: false, session: S2, to: { status: "hard", correctStreak: 0, consecutiveErrors: 2, hardSince: NOW, masteredAt: null, lastCountedSessionId: S2 }, transition: "returned_to_hard" },
];

describe("applyAnswer: таблица переходов", () => {
  it.each(table)("$name", ({ from, attempt, correct, session, to, transition, counted }) => {
    const before = structuredClone(from);
    const result = applyAnswer(from, { sessionId: session ?? S1, attemptNumber: attempt, isCorrect: correct, now: NOW });
    expect(result.word).toMatchObject(to);
    expect(result.transition).toBe(transition ?? "none");
    expect(result.countedInStreak).toBe(counted ?? false);
    expect(from).toEqual(before);
  });
});

describe("applyAnswer: последовательности", () => {
  function play(start: WordLearningState, answers: [number, AttemptNumber, boolean][]): WordLearningState {
    return answers.reduce(
      (word, [sessionId, attemptNumber, isCorrect]) =>
        applyAnswer(word, { sessionId, attemptNumber, isCorrect, now: NOW }).word,
      start,
    );
  }

  it("полный путь: сложное, 5 занятий верно, освоено, две ошибки, снова сложное", () => {
    let word = play(INITIAL_WORD_STATE, [[1, 1, false], [1, 2, false]]);
    expect(word).toMatchObject({ status: "hard", correctStreak: 0, lastCountedSessionId: 1 });

    word = play(word, [[1, 1, true]]);
    expect(word.correctStreak).toBe(0);

    for (const session of [2, 3, 4, 5]) word = play(word, [[session, 1, true]]);
    expect(word).toMatchObject({ status: "hard", correctStreak: 4 });

    word = play(word, [[6, 1, true]]);
    expect(word).toMatchObject({ status: "mastered", correctStreak: 5 });

    word = play(word, [[7, 1, false]]);
    expect(word.status).toBe("mastered");
    word = play(word, [[7, 2, true], [8, 1, false]]);
    expect(word).toMatchObject({ status: "hard", correctStreak: 0, consecutiveErrors: 2 });

    // В занятии 8 слово вернулось в сложные: верный ответ в нём не считается, в следующем считается.
    expect(play(word, [[8, 1, true]]).correctStreak).toBe(0);
    expect(play(word, [[9, 1, true]]).correctStreak).toBe(1);
  });

  it("много верных ответов в одном занятии дают +1", () => {
    const word = play(hard(), [[2, 1, true], [2, 1, true], [2, 1, true]]);
    expect(word.correctStreak).toBe(1);
  });

  it("серия обнуляется ошибкой и набирается заново", () => {
    const word = play(hard(), [[2, 1, true], [3, 1, true], [4, 1, false], [4, 2, true], [5, 1, true]]);
    expect(word).toMatchObject({ status: "hard", correctStreak: 1, consecutiveErrors: 0 });
  });

  it("верный ответ с первой попытки прерывает ошибки подряд у освоенного слова", () => {
    const word = play(mastered(), [[2, 1, false], [2, 2, true], [3, 1, true], [4, 1, false]]);
    expect(word).toMatchObject({ status: "mastered", consecutiveErrors: 1 });
  });

  it("порог серии задаётся настройками", () => {
    const settings = { masteryStreak: 2, masteredErrorsToHard: 2 };
    const answer = (sessionId: number) => ({ sessionId, attemptNumber: 1 as const, isCorrect: true, now: NOW });
    const first = applyAnswer(hard(), answer(2), settings);
    expect(first.transition).toBe("none");
    expect(applyAnswer(first.word, answer(3), settings).transition).toBe("mastered");
  });
});

describe("mergeWordStates: правка перевода привела карточку к существующему слову", () => {
  const word = (patch: Partial<WordLearningState>): WordLearningState => ({ ...INITIAL_WORD_STATE, ...patch });

  it("остаётся меньшая серия, «сложное» сохраняется, если было хотя бы у одного", () => {
    const hard = word({ status: "hard", correctStreak: 3, hardSince: EARLIER, lastCountedSessionId: 7 });
    const learning = word({ consecutiveErrors: 1 });
    for (const [a, b] of [
      [hard, learning],
      [learning, hard],
    ] as const) {
      expect(mergeWordStates(a, b)).toEqual({
        status: "hard",
        correctStreak: 0,
        consecutiveErrors: 1,
        lastCountedSessionId: 7,
        hardSince: EARLIER,
        masteredAt: null,
      });
    }
  });

  it("два сложных: меньшая серия и более ранняя дата; позднее засчитанное занятие", () => {
    const merged = mergeWordStates(
      word({ status: "hard", correctStreak: 4, hardSince: NOW, lastCountedSessionId: 3 }),
      word({ status: "hard", correctStreak: 2, hardSince: EARLIER, lastCountedSessionId: 9 }),
    );
    expect(merged).toMatchObject({ status: "hard", correctStreak: 2, hardSince: EARLIER, lastCountedSessionId: 9 });
  });

  it("освоено остаётся, только если освоены оба", () => {
    const mastered = word({ status: "mastered", correctStreak: 5, masteredAt: EARLIER });
    expect(mergeWordStates(mastered, word({ status: "mastered", correctStreak: 5, masteredAt: NOW }))).toMatchObject({
      status: "mastered",
      correctStreak: 5,
      masteredAt: NOW,
    });
    expect(mergeWordStates(mastered, word({}))).toEqual({ ...INITIAL_WORD_STATE });
    expect(mergeWordStates(mastered, word({ status: "hard", correctStreak: 1, hardSince: NOW }))).toMatchObject({
      status: "hard",
      correctStreak: 1,
      masteredAt: null,
      hardSince: NOW,
    });
  });
});

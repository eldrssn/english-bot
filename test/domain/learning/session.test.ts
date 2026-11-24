import { describe, expect, it } from "vitest";
import {
  buildSessionPlan,
  createSeededRng,
  createSessionState,
  nextStep,
  recordAnswer,
  removeWordsFromPlan,
  summarizeSession,
  type PlanItem,
  type SessionState,
} from "../../../src/domain/learning/index.js";

const words = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ studentWordId: index + 1, cardVersionId: 100 + index }));

/** План в заданном порядке: номер слова совпадает с позицией + 1, чтобы сценарии читались проще. */
const orderedPlan = (count: number): PlanItem[] =>
  words(count).map((word, index) => ({
    ...word,
    direction: index % 2 === 0 ? "ru_en" : "en_ru",
    format: "choice",
  }));

type Trace = { steps: string[]; state: SessionState };

/** Проходит занятие до конца. wrong — слова с ошибкой с первой попытки, wrongTwice — ошибка и на повторе. */
function run(start: SessionState, wrong: number[] = [], wrongTwice: number[] = []): Trace {
  let state = start;
  const steps: string[] = [];
  for (let guard = 0; guard < 1000; guard++) {
    const step = nextStep(state);
    if (step.kind === "finished") return { steps, state };
    const word = step.item.studentWordId;
    steps.push(step.kind === "new" ? `${word}` : `r${word}`);
    const isCorrect = step.kind === "new" ? !wrong.includes(word) : !wrongTwice.includes(word);
    const result = recordAnswer(state, { position: step.position, attemptNumber: step.attemptNumber, isCorrect });
    if (!result.accepted) throw new Error("ответ на текущий шаг должен приниматься");
    state = result.state;
  }
  throw new Error("занятие не завершилось");
}

describe("buildSessionPlan", () => {
  it("каждое слово один раз, дубли убираются", () => {
    const input = [...words(7), { studentWordId: 3, cardVersionId: 999 }];
    const plan = buildSessionPlan(input, { rng: createSeededRng(1) });
    expect(plan.map((item) => item.studentWordId).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(plan.find((item) => item.studentWordId === 3)?.cardVersionId).toBe(102);
  });

  it("alternate чередует направления, первое выбирает генератор", () => {
    const plan = buildSessionPlan(words(8), { rng: createSeededRng(5), directionMode: "alternate" });
    plan.forEach((item, index) => {
      if (index > 0) expect(item.direction).not.toBe(plan[index - 1]!.direction);
    });
    const firsts = new Set(
      Array.from({ length: 20 }, (_, seed) => buildSessionPlan(words(2), { rng: createSeededRng(seed) })[0]?.direction),
    );
    expect(firsts.size).toBe(2);
  });

  it("random берёт направления из генератора, встречаются оба и не чередование", () => {
    const plan = buildSessionPlan(words(60), { rng: createSeededRng(9), directionMode: "random" });
    expect(new Set(plan.map((item) => item.direction)).size).toBe(2);
    expect(plan.some((item, index) => index > 0 && item.direction === plan[index - 1]!.direction)).toBe(true);
  });

  it("один seed даёт один план, другой seed — другой порядок", () => {
    const make = (seed: number) => buildSessionPlan(words(20), { rng: createSeededRng(seed) });
    expect(make(7)).toEqual(make(7));
    expect(make(7)).not.toEqual(make(8));
  });

  it("формат передаётся параметром, по умолчанию кнопки", () => {
    expect(buildSessionPlan(words(1), { rng: createSeededRng(1) })[0]?.format).toBe("choice");
    expect(buildSessionPlan(words(1), { rng: createSeededRng(1), format: "typed" })[0]?.format).toBe("typed");
  });

  it("генератор вне диапазона — ошибка вызывающего кода", () => {
    expect(() => buildSessionPlan(words(2), { rng: () => 1 })).toThrow(RangeError);
  });
});

describe("nextStep и recordAnswer: порядок занятия", () => {
  it("пустой план сразу завершён", () => {
    expect(nextStep(createSessionState([]))).toEqual({ kind: "finished" });
  });

  it("все верные: без повторов, порядок плана", () => {
    const { steps, state } = run(createSessionState(orderedPlan(7)));
    expect(steps).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
    expect(state.seriesNumber).toBe(2);
  });

  it("повторы идут после 5 вопросов, затем следующая серия", () => {
    const { steps } = run(createSessionState(orderedPlan(12)), [2, 4, 7]);
    expect(steps).toEqual(["1", "2", "3", "4", "5", "r2", "r4", "6", "7", "8", "9", "10", "r7", "11", "12"]);
  });

  it("все ошибки в серии: каждый повтор по одному разу, третьей попытки нет", () => {
    const all = [1, 2, 3, 4, 5, 6];
    const { steps } = run(createSessionState(orderedPlan(6)), all, all);
    expect(steps).toEqual(["1", "2", "3", "4", "5", "r1", "r2", "r3", "r4", "r5", "6", "r6"]);
  });

  it("серия меньше 5: повторы сразу после последнего вопроса", () => {
    const { steps } = run(createSessionState(orderedPlan(3)), [1, 3]);
    expect(steps).toEqual(["1", "2", "3", "r1", "r3"]);
  });

  it("одно слово с ошибкой: один вопрос и один повтор", () => {
    const { steps } = run(createSessionState(orderedPlan(1)), [1], [1]);
    expect(steps).toEqual(["1", "r1"]);
  });

  it("размер серии передаётся параметром", () => {
    const { steps } = run(createSessionState(orderedPlan(5), { seriesSize: 2 }), [1, 4]);
    expect(steps).toEqual(["1", "2", "r1", "3", "4", "r4", "5"]);
  });

  it("недопустимый размер серии отклоняется", () => {
    expect(() => createSessionState([], { seriesSize: 0 })).toThrow(RangeError);
    expect(() => createSessionState([], { seriesSize: 1.5 })).toThrow(RangeError);
  });

  it("повтор задаётся в том же направлении и по той же позиции", () => {
    const plan = orderedPlan(2);
    let state = createSessionState(plan, { seriesSize: 2 });
    state = recordAnswer(state, { position: 0, attemptNumber: 1, isCorrect: true }).state;
    state = recordAnswer(state, { position: 1, attemptNumber: 1, isCorrect: false }).state;
    const step = nextStep(state);
    expect(step).toMatchObject({ kind: "repeat", position: 1, attemptNumber: 2 });
    if (step.kind === "repeat") expect(step.item).toEqual(plan[1]);
  });

  it("nextStep не меняет состояние и до ответа возвращает тот же шаг", () => {
    const state = createSessionState(orderedPlan(3));
    const snapshot = structuredClone(state);
    expect(nextStep(state)).toEqual(nextStep(state));
    expect(state).toEqual(snapshot);
  });

  it("recordAnswer не меняет исходное состояние", () => {
    const state = createSessionState(orderedPlan(3));
    const snapshot = structuredClone(state);
    recordAnswer(state, { position: 0, attemptNumber: 1, isCorrect: false });
    expect(state).toEqual(snapshot);
  });

  it("сообщает новый статус вопроса", () => {
    const state = createSessionState(orderedPlan(1));
    expect(recordAnswer(state, { position: 0, attemptNumber: 1, isCorrect: true })).toMatchObject({ accepted: true, questionStatus: "closed" });
    const wrong = recordAnswer(state, { position: 0, attemptNumber: 1, isCorrect: false });
    expect(wrong).toMatchObject({ accepted: true, questionStatus: "awaiting_repeat" });
    expect(recordAnswer(wrong.state, { position: 0, attemptNumber: 2, isCorrect: false })).toMatchObject({ accepted: true, questionStatus: "closed" });
  });

  it("старая кнопка и повторная доставка не меняют состояние", () => {
    const start = createSessionState(orderedPlan(2));
    const once = recordAnswer(start, { position: 0, attemptNumber: 1, isCorrect: false });
    expect(once.accepted).toBe(true);
    // Та же первая попытка, чужая позиция, преждевременный повтор.
    for (const stale of [
      { position: 0, attemptNumber: 1 as const, isCorrect: true },
      { position: 5, attemptNumber: 1 as const, isCorrect: true },
      { position: 0, attemptNumber: 2 as const, isCorrect: true },
    ]) {
      const result = recordAnswer(once.state, stale);
      expect(result.accepted).toBe(false);
      expect(result.state).toEqual(once.state);
    }
  });

  it("после завершения ответы не принимаются: третьей попытки нет", () => {
    const { state } = run(createSessionState(orderedPlan(1)), [1], [1]);
    expect(recordAnswer(state, { position: 0, attemptNumber: 2, isCorrect: true }).accepted).toBe(false);
  });
});

describe("продолжение из сохранённого состояния", () => {
  const wrong = [2, 4, 7];
  const wrongTwice = [4];
  const full = run(createSessionState(orderedPlan(12)), wrong, wrongTwice);

  it("после JSON на каждом шаге занятие идёт так же, как без перезапуска", () => {
    for (let cut = 0; cut <= full.steps.length; cut++) {
      let state = createSessionState(orderedPlan(12));
      const steps: string[] = [];
      for (let done = 0; done < cut; done++) {
        const step = nextStep(state);
        if (step.kind === "finished") throw new Error("занятие кончилось раньше");
        const word = step.item.studentWordId;
        steps.push(step.kind === "new" ? `${word}` : `r${word}`);
        const isCorrect = step.kind === "new" ? !wrong.includes(word) : !wrongTwice.includes(word);
        state = recordAnswer(state, { position: step.position, attemptNumber: step.attemptNumber, isCorrect }).state;
      }
      const restored = JSON.parse(JSON.stringify(state)) as SessionState;
      expect(restored).toEqual(state);
      const rest = run(restored, wrong, wrongTwice);
      expect([...steps, ...rest.steps]).toEqual(full.steps);
      expect(rest.state).toEqual(full.state);
    }
  });

  it("состояние можно собрать заново из записанных попыток", () => {
    const log: Parameters<typeof recordAnswer>[1][] = [];
    let live = createSessionState(orderedPlan(12));
    for (let step = nextStep(live); step.kind !== "finished"; step = nextStep(live)) {
      const word = step.item.studentWordId;
      const isCorrect = step.kind === "new" ? !wrong.includes(word) : !wrongTwice.includes(word);
      const answer = { position: step.position, attemptNumber: step.attemptNumber, isCorrect };
      log.push(answer);
      live = recordAnswer(live, answer).state;
    }
    const rebuilt = log.reduce((state, answer) => recordAnswer(state, answer).state, createSessionState(orderedPlan(12)));
    expect(rebuilt).toEqual(live);
  });

  it("один seed и одни ответы дают одинаковое занятие", () => {
    const make = () => run(createSessionState(buildSessionPlan(words(12), { rng: createSeededRng(11) })), [3, 8]);
    expect(make()).toEqual(make());
  });
});

describe("removeWordsFromPlan: удаление карточки", () => {
  it("незаданный вопрос исчезает, номера позиций остаются прежними", () => {
    const state = removeWordsFromPlan(createSessionState(orderedPlan(4)), [2]);
    expect(run(state).steps).toEqual(["1", "3", "4"]);
    expect(nextStep(recordAnswer(state, { position: 0, attemptNumber: 1, isCorrect: true }).state)).toMatchObject({ position: 2 });
    expect(summarizeSession(state).plannedCount).toBe(3);
  });

  it("повтор уже заданного вопроса завершается", () => {
    let state = createSessionState(orderedPlan(2));
    state = recordAnswer(state, { position: 0, attemptNumber: 1, isCorrect: false }).state;
    state = removeWordsFromPlan(state, [1]);
    expect(state.removedPositions).toEqual([]);
    expect(summarizeSession(state).plannedCount).toBe(2);
    expect(run(state).steps).toEqual(["2", "r1"]);
  });

  it("если снят последний новый вопрос, повторы идут сразу", () => {
    let state = createSessionState(orderedPlan(2));
    state = recordAnswer(state, { position: 0, attemptNumber: 1, isCorrect: false }).state;
    state = removeWordsFromPlan(state, [2]);
    expect(nextStep(state)).toMatchObject({ kind: "repeat", position: 0 });
  });

  it("все слова сняты: занятие завершено", () => {
    expect(nextStep(removeWordsFromPlan(createSessionState(orderedPlan(2)), [1, 2]))).toEqual({ kind: "finished" });
  });

  it("снятые вопросы не ломают границу серии", () => {
    const state = removeWordsFromPlan(createSessionState(orderedPlan(7)), [2]);
    expect(run(state, [1]).steps).toEqual(["1", "3", "4", "5", "6", "r1", "7"]);
  });
});

describe("summarizeSession", () => {
  it("ошибка и верный повтор не становятся «верно с первой попытки»", () => {
    const { state } = run(createSessionState(orderedPlan(5)), [1, 2], [2]);
    expect(summarizeSession(state)).toEqual({
      finished: true,
      plannedCount: 5,
      answeredCount: 5,
      firstAttempt: { correct: 3, wrong: 2 },
      afterRepeat: { correct: 4, wrong: 1, pending: 0 },
      firstAttemptCorrectWordIds: [3, 4, 5],
      correctedOnRepeatWordIds: [1],
      failedBothWordIds: [2],
      awaitingRepeatWordIds: [],
    });
  });

  it("все верные и все неверные", () => {
    const right = summarizeSession(run(createSessionState(orderedPlan(3))).state);
    expect(right.firstAttempt).toEqual({ correct: 3, wrong: 0 });
    expect(right.afterRepeat).toEqual({ correct: 3, wrong: 0, pending: 0 });
    const all = [1, 2, 3];
    const bad = summarizeSession(run(createSessionState(orderedPlan(3)), all, all).state);
    expect(bad.firstAttempt).toEqual({ correct: 0, wrong: 3 });
    expect(bad.afterRepeat).toEqual({ correct: 0, wrong: 3, pending: 0 });
  });

  it("незавершённое занятие: ожидающий повтор виден отдельно", () => {
    let state = createSessionState(orderedPlan(4));
    state = recordAnswer(state, { position: 0, attemptNumber: 1, isCorrect: false }).state;
    state = recordAnswer(state, { position: 1, attemptNumber: 1, isCorrect: true }).state;
    expect(summarizeSession(state)).toMatchObject({
      finished: false,
      plannedCount: 4,
      answeredCount: 2,
      firstAttempt: { correct: 1, wrong: 1 },
      afterRepeat: { correct: 1, wrong: 0, pending: 1 },
      awaitingRepeatWordIds: [1],
    });
  });

  it("пустое занятие", () => {
    expect(summarizeSession(createSessionState([]))).toMatchObject({ finished: true, plannedCount: 0, answeredCount: 0 });
  });
});

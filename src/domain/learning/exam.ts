// Экзамен: равномерная выборка из подборок (раздел 10 сценария, раздел 2.5 плана).
import { shuffled, type Rng } from "./rng.js";
import { buildSessionPlan, type PlanItem, type PlanWord } from "./session.js";
import { LEARNING_SETTINGS } from "./settings.js";

/** Слово словаря и подборки, где у него есть действующие карточки. */
export type ExamCandidate = PlanWord & { collectionIds: readonly number[] };

export type ExamOptions = { rng: Rng; size?: number };

/**
 * Слова экзамена. Подборки обходятся по кругу в случайном порядке, из каждой по очереди берётся следующее
 * случайное ещё не выбранное слово: так маленькая подборка не теряется среди больших. Слово из нескольких
 * подборок входит один раз. Если слов не больше size, в экзамен входят все.
 */
export function selectExamWords(candidates: readonly ExamCandidate[], options: ExamOptions): PlanWord[] {
  const size = options.size ?? LEARNING_SETTINGS.examSize;
  const byCollection = new Map<number, ExamCandidate[]>();
  const unique = new Map<number, ExamCandidate>();
  for (const candidate of candidates) {
    if (unique.has(candidate.studentWordId)) continue;
    unique.set(candidate.studentWordId, candidate);
    for (const collectionId of new Set(candidate.collectionIds)) {
      const list = byCollection.get(collectionId);
      if (list) list.push(candidate);
      else byCollection.set(collectionId, [candidate]);
    }
  }
  const all = [...unique.values()];
  if (all.length <= size) return all.map(toPlanWord);

  const queues = shuffled(
    [...byCollection.keys()].sort((a, b) => a - b),
    options.rng,
  ).map((collectionId) => shuffled(byCollection.get(collectionId)!, options.rng));
  const picked = new Map<number, ExamCandidate>();
  while (picked.size < size) {
    let progressed = false;
    for (const queue of queues) {
      if (picked.size >= size) break;
      let next = queue.shift();
      while (next && picked.has(next.studentWordId)) next = queue.shift();
      if (next) {
        picked.set(next.studentWordId, next);
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  return [...picked.values()].map(toPlanWord);
}

const toPlanWord = ({ studentWordId, cardVersionId }: ExamCandidate): PlanWord => ({ studentWordId, cardVersionId });

/** План экзамена: оба формата и оба направления вперемешку. */
export function buildExamPlan(candidates: readonly ExamCandidate[], options: ExamOptions): PlanItem[] {
  return buildSessionPlan(selectExamWords(candidates, options), { rng: options.rng, format: "mixed" });
}

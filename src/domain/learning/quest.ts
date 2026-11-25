// Ежедневный квест: состав, серия дней и устаревание (раздел 9 сценария, раздел 2.5 плана).
import { addDays } from "./local-time.js";
import { shuffled, type Rng } from "./rng.js";
import { buildSessionPlan, type PlanItem, type PlanWord } from "./session.js";
import { LEARNING_SETTINGS, type LearningSettings } from "./settings.js";
import type { WordStatus } from "./word-state.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Слово словаря ученика с действующей карточкой. */
export type QuestCandidate = PlanWord & {
  status: WordStatus;
  /** Когда у ученика появилась первая действующая карточка этого слова. */
  addedAt: Date;
};

export type QuestSettings = Pick<LearningSettings, "questSize" | "questMaxHard" | "questMaxRecent" | "questRecentDays">;

export type QuestOptions = {
  rng: Rng;
  now: Date;
  settings?: QuestSettings;
};

/**
 * Слова квеста: до questMaxHard сложных, до questMaxRecent недавно добавленных, остальное — старые слова.
 * Нехватка одной группы восполняется из других: сначала старыми, затем оставшимися сложными, затем недавними.
 * Среди старых сначала изучаемые, освоенные — только если изучаемых не хватило: освоенное слово уже ушло из активного списка.
 * Внутри группы слова выбираются случайно. Каждое слово входит один раз.
 */
export function selectQuestWords(candidates: readonly QuestCandidate[], options: QuestOptions): PlanWord[] {
  const settings = options.settings ?? LEARNING_SETTINGS;
  const unique = new Map<number, QuestCandidate>();
  for (const candidate of candidates) {
    if (!unique.has(candidate.studentWordId)) unique.set(candidate.studentWordId, candidate);
  }
  const words = [...unique.values()];
  const recentSince = options.now.getTime() - settings.questRecentDays * DAY_MS;
  const isRecent = (word: QuestCandidate) => word.addedAt.getTime() >= recentSince;

  const hard = shuffled(words.filter((word) => word.status === "hard"), options.rng);
  const recent = shuffled(words.filter((word) => word.status !== "hard" && isRecent(word)), options.rng);
  const oldLearning = shuffled(
    words.filter((word) => word.status === "learning" && !isRecent(word)),
    options.rng,
  );
  const oldMastered = shuffled(
    words.filter((word) => word.status === "mastered" && !isRecent(word)),
    options.rng,
  );

  const picked = [...hard.slice(0, settings.questMaxHard), ...recent.slice(0, settings.questMaxRecent)].slice(
    0,
    settings.questSize,
  );
  const rest = [
    ...oldLearning,
    ...oldMastered,
    ...hard.slice(settings.questMaxHard),
    ...recent.slice(settings.questMaxRecent),
  ];
  picked.push(...rest.slice(0, Math.max(settings.questSize - picked.length, 0)));
  return picked.map(({ studentWordId, cardVersionId }) => ({ studentWordId, cardVersionId }));
}

/** План квеста: кнопки и ввод чередуются, оба направления (раздел 9 сценария). Пустой словарь — пустой план. */
export function buildQuestPlan(candidates: readonly QuestCandidate[], options: QuestOptions): PlanItem[] {
  return buildSessionPlan(selectQuestWords(candidates, options), { rng: options.rng, format: "mixed" });
}

/**
 * Серия дней с завершённым квестом. Сегодняшний ещё не пройденный квест серию не обрывает:
 * она считается до вчерашнего дня. Пропущенный день обрывает серию.
 */
export function questStreak(completedLocalDates: readonly string[], today: string): number {
  const completed = new Set(completedLocalDates);
  let day = completed.has(today) ? today : addDays(today, -1);
  let streak = 0;
  while (completed.has(day)) {
    streak += 1;
    day = addDays(day, -1);
  }
  return streak;
}

/**
 * Квест относится только к своей локальной дате. Любой другой день — в том числе после смены часового пояса
 * назад через полночь — делает его устаревшим: он закрывается как незавершённый и не возобновляется.
 */
export function isQuestStale(questLocalDate: string, today: string): boolean {
  return questLocalDate !== today;
}

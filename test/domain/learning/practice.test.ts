// Чистая логика этапа 6: локальная дата, состав квеста, серия дней, экзамен, выбор учеников для напоминания.
// Время задаётся явно, случайность — генератором с фиксированным seed: результат не зависит от запуска.
import { describe, expect, it } from "vitest";
import {
  addDays,
  buildExamPlan,
  buildQuestPlan,
  createSeededRng,
  formatClock,
  isQuestStale,
  isValidTimeZone,
  localDate,
  localMinutes,
  parseClock,
  questStreak,
  reminderDecision,
  selectExamWords,
  selectQuestWords,
  selectReminderRecipients,
  utcOffsetLabel,
  type ExamCandidate,
  type QuestCandidate,
  type ReminderCandidate,
  type WordStatus,
} from "../../../src/domain/learning/index.js";

const NOW = new Date("2026-11-24T16:30:00Z");
const DAY = 24 * 60 * 60 * 1000;
const SEEDS = [1, 2, 3, 42, 2026, 99999];

describe("локальное время", () => {
  it("локальная дата зависит от пояса: в Москве уже завтра, в Нью-Йорке ещё сегодня", () => {
    const lateUtc = new Date("2026-11-24T22:30:00Z");
    expect(localDate(lateUtc, "UTC")).toBe("2026-11-24");
    expect(localDate(lateUtc, "Europe/Moscow")).toBe("2026-11-25");
    expect(localDate(lateUtc, "America/New_York")).toBe("2026-11-24");
    expect(localDate(new Date("2026-11-25T03:00:00Z"), "America/Los_Angeles")).toBe("2026-11-24");
    expect(localDate(new Date("2026-11-24T23:59:59Z"), "Asia/Kamchatka")).toBe("2026-11-25");
  });

  it("минуты от полуночи: полночь — 0, без «24:00»", () => {
    expect(localMinutes(new Date("2026-11-24T21:00:00Z"), "Europe/Moscow")).toBe(0);
    expect(localMinutes(NOW, "Europe/Moscow")).toBe(19 * 60 + 30);
    expect(localMinutes(NOW, "Asia/Kolkata")).toBe(22 * 60);
  });

  it("переход на летнее время учитывается", () => {
    // В Берлине 29 марта 2026 года в 02:00 часы переводятся на 03:00.
    expect(localMinutes(new Date("2026-03-29T00:30:00Z"), "Europe/Berlin")).toBe(60 + 30);
    expect(localMinutes(new Date("2026-03-29T01:30:00Z"), "Europe/Berlin")).toBe(3 * 60 + 30);
    expect(utcOffsetLabel(new Date("2026-01-15T12:00:00Z"), "Europe/Berlin")).toBe("UTC+1");
    expect(utcOffsetLabel(new Date("2026-07-15T12:00:00Z"), "Europe/Berlin")).toBe("UTC+2");
  });

  it("подпись смещения", () => {
    expect(utcOffsetLabel(NOW, "Europe/Moscow")).toBe("UTC+3");
    expect(utcOffsetLabel(NOW, "Asia/Kolkata")).toBe("UTC+5:30");
    expect(utcOffsetLabel(NOW, "America/Sao_Paulo")).toBe("UTC−3");
    expect(utcOffsetLabel(NOW, "UTC")).toBe("UTC");
    expect(utcOffsetLabel(NOW, "Etc/GMT-5")).toBe("UTC+5");
  });

  it("проверка пояса", () => {
    expect(isValidTimeZone("Europe/Moscow")).toBe(true);
    expect(isValidTimeZone("Europe/Kyiv")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });

  it("время напоминания: разбор и формат", () => {
    expect(parseClock("19:00")).toBe(19 * 60);
    expect(parseClock("19:00:00")).toBe(19 * 60);
    expect(parseClock("7:05")).toBe(7 * 60 + 5);
    expect(parseClock("24:00")).toBeNull();
    expect(parseClock("12:60")).toBeNull();
    expect(parseClock("вечер")).toBeNull();
    expect(formatClock(0)).toBe("00:00");
    expect(formatClock(19 * 60 + 5)).toBe("19:05");
    expect(() => formatClock(24 * 60)).toThrow(RangeError);
  });

  it("сдвиг даты через границы месяца, года и високосный день", () => {
    expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
    expect(addDays("2027-01-01", -1)).toBe("2026-12-31");
    expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
    expect(() => addDays("24.11.2026", 1)).toThrow(RangeError);
  });
});

const candidate = (id: number, status: WordStatus, ageDays: number): QuestCandidate => ({
  studentWordId: id,
  cardVersionId: 1000 + id,
  status,
  addedAt: new Date(NOW.getTime() - ageDays * DAY),
});

/** hard — сложные, recent — добавлены вчера, old — месяц назад; ID идут подряд. */
function pool(counts: { hard?: number; recent?: number; old?: number; mastered?: number }) {
  const result: QuestCandidate[] = [];
  let id = 1;
  for (let i = 0; i < (counts.hard ?? 0); i++) result.push(candidate(id++, "hard", 30));
  for (let i = 0; i < (counts.recent ?? 0); i++) result.push(candidate(id++, "learning", 1));
  for (let i = 0; i < (counts.old ?? 0); i++) result.push(candidate(id++, "learning", 30));
  for (let i = 0; i < (counts.mastered ?? 0); i++) result.push(candidate(id++, "mastered", 30));
  return result;
}

function composition(words: readonly QuestCandidate[], picked: { studentWordId: number }[]) {
  const byId = new Map(words.map((word) => [word.studentWordId, word]));
  const result = { hard: 0, recent: 0, old: 0, mastered: 0 };
  for (const { studentWordId } of picked) {
    const word = byId.get(studentWordId)!;
    if (word.status === "hard") result.hard += 1;
    else if (NOW.getTime() - word.addedAt.getTime() < 7 * DAY) result.recent += 1;
    else if (word.status === "mastered") result.mastered += 1;
    else result.old += 1;
  }
  return result;
}

describe("состав квеста", () => {
  it.each(SEEDS)("полный словарь: 5 сложных, 3 недавних, 2 старых (seed %i)", (seed) => {
    const words = pool({ hard: 8, recent: 6, old: 20 });
    const picked = selectQuestWords(words, { rng: createSeededRng(seed), now: NOW });
    expect(picked).toHaveLength(10);
    expect(new Set(picked.map((word) => word.studentWordId)).size).toBe(10);
    expect(composition(words, picked)).toEqual({ hard: 5, recent: 3, old: 2, mastered: 0 });
  });

  it("сложных нет: квест из обычного словаря, недавних не больше трёх", () => {
    const words = pool({ recent: 6, old: 20 });
    const picked = selectQuestWords(words, { rng: createSeededRng(7), now: NOW });
    expect(composition(words, picked)).toEqual({ hard: 0, recent: 3, old: 7, mastered: 0 });
  });

  it("старых не хватает: добираем оставшимися сложными, затем недавними", () => {
    const words = pool({ hard: 7, recent: 6, old: 1 });
    const picked = selectQuestWords(words, { rng: createSeededRng(7), now: NOW });
    expect(composition(words, picked)).toEqual({ hard: 6, recent: 3, old: 1, mastered: 0 });

    const fewHard = pool({ hard: 2, recent: 9, old: 1 });
    expect(composition(fewHard, selectQuestWords(fewHard, { rng: createSeededRng(7), now: NOW }))).toEqual({
      hard: 2,
      recent: 7,
      old: 1,
      mastered: 0,
    });
  });

  it("освоенные слова — только если изучаемых старых не хватило", () => {
    const words = pool({ old: 3, mastered: 10 });
    const picked = selectQuestWords(words, { rng: createSeededRng(1), now: NOW });
    expect(composition(words, picked)).toEqual({ hard: 0, recent: 0, old: 3, mastered: 7 });
  });

  it("мало слов: в квест входят все, каждое один раз; пустой словарь — пустой план", () => {
    const words = [...pool({ hard: 1, recent: 1, old: 1 }), candidate(1, "hard", 30)];
    const picked = selectQuestWords(words, { rng: createSeededRng(1), now: NOW });
    expect(picked.map((word) => word.studentWordId).sort()).toEqual([1, 2, 3]);
    expect(buildQuestPlan([], { rng: createSeededRng(1), now: NOW })).toEqual([]);
  });

  it("недавнее слово — добавленное не раньше, чем 7 дней назад", () => {
    const words = [candidate(1, "learning", 6.9), candidate(2, "learning", 7.1)];
    const settings = { questSize: 1, questMaxHard: 5, questMaxRecent: 1, questRecentDays: 7 };
    expect(selectQuestWords(words, { rng: createSeededRng(1), now: NOW, settings })).toEqual([
      { studentWordId: 1, cardVersionId: 1001 },
    ]);
  });

  it("план чередует кнопки и ввод в обоих направлениях; один seed — один план", () => {
    const words = pool({ hard: 5, recent: 3, old: 10 });
    const plan = buildQuestPlan(words, { rng: createSeededRng(5), now: NOW });
    expect(plan).toHaveLength(10);
    expect(new Set(plan.map((item) => item.format))).toEqual(new Set(["choice", "typed"]));
    expect(new Set(plan.map((item) => item.direction))).toEqual(new Set(["ru_en", "en_ru"]));
    expect(buildQuestPlan(words, { rng: createSeededRng(5), now: NOW })).toEqual(plan);
  });
});

describe("серия дней с завершённым квестом", () => {
  const today = "2026-11-24";
  it.each([
    [[], 0],
    [["2026-11-24"], 1],
    [["2026-11-23"], 1],
    [["2026-11-22"], 0],
    [["2026-11-24", "2026-11-23", "2026-11-22"], 3],
    // Сегодняшний ещё не пройден: серия считается до вчера.
    [["2026-11-23", "2026-11-22", "2026-11-21"], 3],
    // Пропуск обрывает серию.
    [["2026-11-24", "2026-11-23", "2026-11-21", "2026-11-20"], 2],
    // Повторы дат не удваивают день.
    [["2026-11-24", "2026-11-24"], 1],
  ] as [string[], number][])("%j → %i", (dates, expected) => {
    expect(questStreak(dates, today)).toBe(expected);
  });

  it("через границу месяца и года", () => {
    expect(questStreak(["2027-01-01", "2026-12-31", "2026-12-30"], "2027-01-01")).toBe(3);
  });

  it("квест другого дня устарел, сегодняшний — нет", () => {
    expect(isQuestStale("2026-11-23", today)).toBe(true);
    expect(isQuestStale("2026-11-25", today)).toBe(true);
    expect(isQuestStale(today, today)).toBe(false);
  });
});

const examWord = (id: number, collectionIds: number[]): ExamCandidate => ({
  studentWordId: id,
  cardVersionId: 1000 + id,
  collectionIds,
});

describe("экзамен", () => {
  it("слов не больше 20: в экзамен входят все", () => {
    const words = Array.from({ length: 12 }, (_, index) => examWord(index + 1, [index % 2]));
    expect(selectExamWords(words, { rng: createSeededRng(1) })).toHaveLength(12);
    expect(buildExamPlan([], { rng: createSeededRng(1) })).toEqual([]);
  });

  it.each(SEEDS)("равномерно из подборок разного размера: 30, 10 и 5 слов → 8/7/5 (seed %i)", (seed) => {
    const words = [
      ...Array.from({ length: 30 }, (_, index) => examWord(index + 1, [1])),
      ...Array.from({ length: 10 }, (_, index) => examWord(100 + index, [2])),
      ...Array.from({ length: 5 }, (_, index) => examWord(200 + index, [3])),
    ];
    const picked = selectExamWords(words, { rng: createSeededRng(seed) });
    expect(picked).toHaveLength(20);
    expect(new Set(picked.map((word) => word.studentWordId)).size).toBe(20);
    const fromSmall = picked.filter((word) => word.studentWordId >= 200).length;
    const fromMiddle = picked.filter((word) => word.studentWordId >= 100 && word.studentWordId < 200).length;
    const fromLarge = picked.filter((word) => word.studentWordId < 100).length;
    expect(fromSmall).toBe(5);
    expect([fromLarge, fromMiddle].sort()).toEqual([7, 8]);
  });

  it("слово из двух подборок входит один раз", () => {
    const words = [
      examWord(1, [1, 2]),
      ...Array.from({ length: 25 }, (_, index) => examWord(10 + index, [1])),
      ...Array.from({ length: 25 }, (_, index) => examWord(100 + index, [2])),
    ];
    for (const seed of SEEDS) {
      const picked = selectExamWords(words, { rng: createSeededRng(seed), size: 20 });
      expect(new Set(picked.map((word) => word.studentWordId)).size).toBe(20);
    }
  });

  it("план: 20 вопросов, оба формата и оба направления; один seed — один план", () => {
    const words = Array.from({ length: 40 }, (_, index) => examWord(index + 1, [index % 4]));
    const plan = buildExamPlan(words, { rng: createSeededRng(3) });
    expect(plan).toHaveLength(20);
    expect(new Set(plan.map((item) => item.format))).toEqual(new Set(["choice", "typed"]));
    expect(new Set(plan.map((item) => item.direction))).toEqual(new Set(["ru_en", "en_ru"]));
    expect(buildExamPlan(words, { rng: createSeededRng(3) })).toEqual(plan);
  });
});

describe("выбор учеников для напоминания", () => {
  const base: ReminderCandidate = {
    userId: 1,
    timezone: "Europe/Moscow",
    reminderTime: "19:00:00",
    remindersEnabled: true,
    botBlocked: false,
    hasWords: true,
    remindedLocalDates: [],
    completedQuestLocalDates: [],
  };
  // 16:30 UTC — 19:30 в Москве.
  const at = (iso: string) => new Date(iso);

  it("время наступило: напоминание с локальной датой", () => {
    expect(reminderDecision(base, NOW)).toEqual({ due: true, userId: 1, localDate: "2026-11-24" });
    expect(reminderDecision(base, at("2026-11-24T16:00:00Z")).due).toBe(true);
  });

  it.each([
    ["отключил напоминания", { remindersEnabled: false }, "disabled"],
    ["не выбрал пояс", { timezone: null }, "no_timezone"],
    ["пояс не распознан", { timezone: "Mars/Olympus" }, "no_timezone"],
    ["заблокировал бота", { botBlocked: true }, "blocked"],
    ["нет слов", { hasWords: false }, "no_words"],
    ["напоминание за сегодня уже есть", { remindedLocalDates: ["2026-11-24"] }, "already_reminded"],
    ["сегодняшний квест уже пройден", { completedQuestLocalDates: ["2026-11-24"] }, "quest_completed"],
    ["время ещё не наступило", { reminderTime: "20:00" }, "not_yet"],
  ] as [string, Partial<ReminderCandidate>, string][])("%s: не уходит", (_title, patch, reason) => {
    expect(reminderDecision({ ...base, ...patch }, NOW)).toEqual({ due: false, userId: 1, reason });
  });

  it("за минуту до времени — нет, ровно в 19:00 — да, в 23:59 — ещё да, вчерашнее напоминание не мешает", () => {
    expect(reminderDecision(base, at("2026-11-24T15:59:00Z")).due).toBe(false);
    expect(reminderDecision(base, at("2026-11-24T16:00:00Z")).due).toBe(true);
    expect(reminderDecision({ ...base, remindedLocalDates: ["2026-11-23"] }, at("2026-11-24T20:59:00Z")).due).toBe(true);
    // 00:00 следующего дня по Москве: время нового дня ещё не наступило.
    expect(reminderDecision({ ...base, remindedLocalDates: ["2026-11-24"] }, at("2026-11-24T21:00:00Z"))).toMatchObject({
      reason: "not_yet",
    });
  });

  it("одно и то же UTC-время: в Москве пора, в Нью-Йорке ещё нет; выбор возвращает только тех, кому пора", () => {
    const candidates = [
      base,
      { ...base, userId: 2, timezone: "America/New_York" },
      { ...base, userId: 3, timezone: "Asia/Tokyo", reminderTime: "01:00" },
      { ...base, userId: 4, remindersEnabled: false },
    ];
    expect(selectReminderRecipients(candidates, NOW)).toEqual([
      { userId: 1, localDate: "2026-11-24" },
      { userId: 3, localDate: "2026-11-25" },
    ]);
  });
});

describe("список часовых поясов в боте", () => {
  it("каждый пояс распознаётся, повторов нет, смещения от UTC−12 до UTC+14 подписаны верно", async () => {
    const { TIMEZONE_PAGES } = await import("../../../src/bot/timezones.js");
    const zones = TIMEZONE_PAGES.flatMap((page) => page.options.map((option) => option.zone));
    expect(new Set(zones).size).toBe(zones.length);
    for (const zone of zones) expect(isValidTimeZone(zone), zone).toBe(true);
    for (const option of TIMEZONE_PAGES[2]!.options) {
      expect(utcOffsetLabel(NOW, option.zone)).toBe(option.label);
    }
  });
});

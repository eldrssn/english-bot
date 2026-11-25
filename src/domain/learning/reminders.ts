// Кому пора отправить напоминание о ежедневной практике (раздел 9 сценария, раздел 6 плана).
// Планировщик вызывает выбор раз в минуту; время передаётся параметром.
import { isValidTimeZone, localDate, localMinutes, parseClock } from "./local-time.js";

export type ReminderCandidate = {
  userId: number;
  /** Часовой пояс IANA. Пусто: не выбран. */
  timezone: string | null;
  /** «ЧЧ:ММ» или «ЧЧ:ММ:СС». */
  reminderTime: string;
  remindersEnabled: boolean;
  /** Telegram сообщил, что ученик заблокировал бота. */
  botBlocked: boolean;
  /** Есть хотя бы одна действующая карточка. */
  hasWords: boolean;
  /** Локальные даты, за которые напоминание уже поставлено в очередь. */
  remindedLocalDates: readonly string[];
  /** Локальные даты завершённых квестов. */
  completedQuestLocalDates: readonly string[];
};

export type ReminderSkipReason =
  | "disabled"
  | "no_timezone"
  | "blocked"
  | "no_words"
  | "not_yet"
  | "already_reminded"
  | "quest_completed";

export type ReminderDecision =
  | { due: true; userId: number; localDate: string }
  | { due: false; userId: number; reason: ReminderSkipReason };

/**
 * Решение по одному ученику. Напоминание положено с наступления его времени и до конца локального дня:
 * если сервис простаивал в 19:00, напоминание уйдёт после перезапуска в тот же день, а не пропадёт.
 * Одно напоминание на локальную дату; после завершённого сегодня квеста оно не нужно.
 */
export function reminderDecision(candidate: ReminderCandidate, now: Date): ReminderDecision {
  const skip = (reason: ReminderSkipReason): ReminderDecision => ({ due: false, userId: candidate.userId, reason });
  if (!candidate.remindersEnabled) return skip("disabled");
  if (candidate.timezone === null || !isValidTimeZone(candidate.timezone)) return skip("no_timezone");
  if (candidate.botBlocked) return skip("blocked");
  if (!candidate.hasWords) return skip("no_words");
  const reminderMinutes = parseClock(candidate.reminderTime);
  if (reminderMinutes === null) return skip("disabled");
  if (localMinutes(now, candidate.timezone) < reminderMinutes) return skip("not_yet");
  const today = localDate(now, candidate.timezone);
  if (candidate.remindedLocalDates.includes(today)) return skip("already_reminded");
  if (candidate.completedQuestLocalDates.includes(today)) return skip("quest_completed");
  return { due: true, userId: candidate.userId, localDate: today };
}

/** Ученики, которым пора отправить напоминание, с их локальной датой. */
export function selectReminderRecipients(
  candidates: readonly ReminderCandidate[],
  now: Date,
): { userId: number; localDate: string }[] {
  return candidates.flatMap((candidate) => {
    const decision = reminderDecision(candidate, now);
    return decision.due ? [{ userId: decision.userId, localDate: decision.localDate }] : [];
  });
}

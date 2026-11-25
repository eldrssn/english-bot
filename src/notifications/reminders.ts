// Планировщик ежедневной практики: раз в минуту закрывает квесты прошлых дней и ставит в очередь напоминания
// тем, у кого наступило время. Решение «кому пора» принимает чистая функция selectReminderRecipients.
//
// Почему повтор безопасен: квест создаётся под блокировкой ученика, а unique(ученик, локальная дата) исключает второй;
// напоминание ставится с ключом daily_reminder:<ученик>:<дата>, повторная постановка не даёт второго сообщения.
// Поэтому перезапуск сервиса, два такта подряд и повторная доставка уведомления не создают лишних занятий.
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "../db/client.js";
import { notifications, sessions, users } from "../db/schema.js";
import {
  addDays,
  isQuestStale,
  isValidTimeZone,
  localDate,
  reminderDecision,
  selectReminderRecipients,
  type ReminderCandidate,
  type Rng,
} from "../domain/learning/index.js";
import { ensureTodayQuest } from "../learning/practice.js";
import { visibleCardExists } from "../learning/vocabulary.js";
import { lockUser } from "../linking/locks.js";
import { enqueueNotification } from "./queue.js";
import { appLogger, type Logger } from "../logger.js";

export const dailyReminderKey = (userId: number, questLocalDate: string) => `daily_reminder:${userId}:${questLocalDate}`;

export type ReminderTickOptions = { now?: Date; rng?: Rng };

export type ReminderTickReport = {
  /** Квесты прошлых дней, закрытые как незавершённые. */
  closedQuests: number;
  /** Напоминания, поставленные в очередь в этом такте. */
  reminded: number;
  /** Квесты, созданные в этом такте. */
  questsCreated: number;
};

/** Закрывает открытые квесты не за сегодняшнюю локальную дату ученика. */
async function closeStaleQuestsForAll(db: Db, now: Date): Promise<number> {
  const open = await db
    .select({ id: sessions.id, userId: sessions.studentUserId, date: sessions.questLocalDate, timezone: users.timezone })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.studentUserId))
    .where(and(eq(sessions.type, "daily_quest"), inArray(sessions.status, ["current", "paused"])));
  let closed = 0;
  for (const quest of open) {
    if (quest.timezone === null || quest.date === null || !isValidTimeZone(quest.timezone)) continue;
    if (!isQuestStale(quest.date, localDate(now, quest.timezone))) continue;
    // Под блокировкой ученика: ответ на вопрос этого квеста не пройдёт одновременно с закрытием.
    closed += await db.transaction(async (tx) => {
      await lockUser(tx, quest.userId);
      const updated = await tx
        .update(sessions)
        .set({ status: "incomplete", finishedAt: now })
        .where(and(eq(sessions.id, quest.id), inArray(sessions.status, ["current", "paused"])))
        .returning({ id: sessions.id });
      return updated.length;
    });
  }
  return closed;
}

/** Ученики с данными для решения о напоминании. С onlyUserId — один ученик: перепроверка под блокировкой. */
async function reminderCandidates(db: DbOrTx, now: Date, onlyUserId?: number): Promise<ReminderCandidate[]> {
  const rows = await db
    .select({
      userId: users.id,
      timezone: users.timezone,
      reminderTime: users.reminderTime,
      remindersEnabled: users.remindersEnabled,
      botBlocked: sql<boolean>`${users.botBlockedAt} IS NOT NULL`,
      hasWords: visibleCardExists(db, users.id),
    })
    .from(users)
    .where(and(eq(users.role, "student"), ...(onlyUserId === undefined ? [] : [eq(users.id, onlyUserId)])));
  if (rows.length === 0) return [];

  const today = new Map(
    rows.flatMap((row) =>
      row.timezone !== null && isValidTimeZone(row.timezone) ? [[row.userId, localDate(now, row.timezone)] as const] : [],
    ),
  );
  const keys = [...today].map(([userId, date]) => dailyReminderKey(userId, date));
  const reminded = new Set(
    keys.length === 0
      ? []
      : (
          await db
            .select({ key: notifications.dedupeKey })
            .from(notifications)
            .where(inArray(notifications.dedupeKey, keys))
        ).map((row) => row.key),
  );
  // Самая ранняя из «сегодняшних» дат: дальше в прошлое для решения смотреть не нужно.
  const earliest = [...today.values()].sort()[0];
  const completed =
    earliest === undefined
      ? []
      : await db
          .select({ userId: sessions.studentUserId, date: sessions.questLocalDate })
          .from(sessions)
          .where(
            and(
              eq(sessions.type, "daily_quest"),
              eq(sessions.status, "completed"),
              gte(sessions.questLocalDate, addDays(earliest, -1)),
              ...(onlyUserId === undefined ? [] : [eq(sessions.studentUserId, onlyUserId)]),
            ),
          );

  return rows.map((row) => {
    const date = today.get(row.userId);
    return {
      ...row,
      remindedLocalDates: date !== undefined && reminded.has(dailyReminderKey(row.userId, date)) ? [date] : [],
      completedQuestLocalDates: completed.filter((quest) => quest.userId === row.userId).map((quest) => quest.date!),
    };
  });
}

/**
 * Один такт планировщика. Решение проверяется ещё раз под блокировкой ученика: за время такта он мог
 * выключить напоминания или пройти квест.
 */
export async function runReminderTick(db: Db, options: ReminderTickOptions = {}): Promise<ReminderTickReport> {
  const now = options.now ?? new Date();
  const rng = options.rng ?? Math.random;
  const report: ReminderTickReport = { closedQuests: await closeStaleQuestsForAll(db, now), reminded: 0, questsCreated: 0 };

  for (const recipient of selectReminderRecipients(await reminderCandidates(db, now), now)) {
    await db.transaction(async (tx) => {
      const user = await lockUser(tx, recipient.userId);
      const [fresh] = await reminderCandidates(tx, now, user.id);
      if (!fresh || !reminderDecision(fresh, now).due || user.timezone === null) return;
      const ensured = await ensureTodayQuest(tx, { studentUserId: user.id, timezone: user.timezone, now, rng });
      if (!ensured) return;
      if (ensured.created) report.questsCreated += 1;
      if (ensured.session.status === "completed") return;
      await enqueueNotification(tx, {
        recipientUserId: user.id,
        reason: "daily_reminder",
        dedupeKey: dailyReminderKey(user.id, recipient.localDate),
        payload: { questLocalDate: recipient.localDate, sessionId: ensured.session.id },
      });
      report.reminded += 1;
    });
  }
  return report;
}

export type ReminderSchedulerOptions = {
  intervalMs?: number;
  /** Часы планировщика. В тестах подменяются. */
  now?: () => Date;
  rng?: Rng;
  logger?: Logger;
};

/** Фоновый цикл: такт сразу после запуска (после простоя напоминание не пропадает) и затем раз в минуту. */
export function startReminderScheduler(db: Db, options: ReminderSchedulerOptions = {}) {
  const { intervalMs = 60_000, now = () => new Date(), rng } = options;
  const logger = (options.logger ?? appLogger).child({ component: "reminders" });
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();

  const tick = async () => {
    try {
      await runReminderTick(db, { now: now(), ...(rng ? { rng } : {}) });
    } catch (error) {
      logger.error({ err: error }, "Ошибка планировщика напоминаний");
    }
    if (!stopped) {
      timer = setTimeout(() => {
        running = tick();
      }, intervalMs);
    }
  };
  running = tick();

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await running;
    },
  };
}

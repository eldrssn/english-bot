// Обработчик очереди. Telegram допускает около 30 сообщений в секунду и примерно одно в секунду
// в один чат: берём не больше 25 за такт и не больше одного на получателя.
import { eq, inArray, sql } from "drizzle-orm";
import { GrammyError, type Api } from "grammy";
import type { Db } from "../db/client.js";
import { notifications, users } from "../db/schema.js";
import { expireStale } from "../linking/locks.js";
import { notificationKeyboard, renderNotification } from "./render.js";
import { appLogger, type Logger } from "../logger.js";

export const MAX_MESSAGES_PER_SECOND = 25;
export const MAX_DELIVERY_ATTEMPTS = 8;
const LEASE_MS = 60_000;
const BASE_RETRY_MS = 30_000;
const MAX_RETRY_MS = 60 * 60 * 1000;

export type DeliveryOptions = {
  batchSize?: number;
  /** Пауза между отправками: 40 мс дают не больше 25 сообщений в секунду. */
  spacingMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type DeliveryReport = {
  sent: number;
  blocked: number;
  failed: number;
  retried: number;
  /** Telegram попросил подождать: следующий такт раньше этого срока не нужен. */
  pauseMs: number;
};

/** Сообщения одного получателя идут по порядку: следующее ждёт, пока не решится судьба предыдущего. */
async function claimDue(db: Db, limit: number): Promise<number[]> {
  const result = await db.execute(sql`
    UPDATE notifications
    SET next_attempt_at = now() + ${`${LEASE_MS} milliseconds`}::interval,
        delivery_attempts = delivery_attempts + 1
    WHERE id IN (
      SELECT id FROM notifications
      WHERE id IN (
        SELECT id FROM (
          SELECT id, row_number() OVER (PARTITION BY recipient_user_id ORDER BY id) AS position
          FROM notifications WHERE status = 'pending'
        ) ranked WHERE position = 1
      ) AND status = 'pending' AND next_attempt_at <= now()
      ORDER BY next_attempt_at, id
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id
  `);
  return result.rows.map((row) => Number(row.id)).sort((a, b) => a - b);
}

/** Отправляет одну партию. Запись «взята в работу» переживает падение: срок аренды истечёт, и она вернётся в очередь. */
export async function deliverDueNotifications(db: Db, api: Api, options: DeliveryOptions = {}): Promise<DeliveryReport> {
  const { batchSize = MAX_MESSAGES_PER_SECOND, spacingMs = 1000 / MAX_MESSAGES_PER_SECOND, sleep = defaultSleep } = options;
  const report: DeliveryReport = { sent: 0, blocked: 0, failed: 0, retried: 0, pauseMs: 0 };
  const ids = await claimDue(db, batchSize);
  if (ids.length === 0) return report;

  const rows = await db
    .select({ notification: notifications, telegramId: users.telegramId })
    .from(notifications)
    .innerJoin(users, eq(users.id, notifications.recipientUserId))
    .where(inArray(notifications.id, ids))
    .orderBy(notifications.id);

  for (const [index, { notification, telegramId }] of rows.entries()) {
    if (index > 0) await sleep(spacingMs);
    const text = renderNotification(notification.reason, notification.payload);
    if (text === null) {
      await db
        .update(notifications)
        .set({ status: "failed", lastError: "Для этой причины нет текста" })
        .where(eq(notifications.id, notification.id));
      report.failed += 1;
      continue;
    }
    try {
      const keyboard = notificationKeyboard(notification.reason, notification.payload);
      await api.sendMessage(telegramId, text, keyboard ? { reply_markup: keyboard } : {});
      await db
        .update(notifications)
        .set({ status: "sent", sentAt: new Date(), lastError: null })
        .where(eq(notifications.id, notification.id));
      report.sent += 1;
    } catch (error) {
      if (error instanceof GrammyError && error.error_code === 429) {
        // Лимит общий для всего бота: возвращаем в очередь эту запись и все оставшиеся, попытки не считаются.
        const retryAfterSeconds = error.parameters.retry_after ?? 1;
        report.pauseMs = retryAfterSeconds * 1000;
        const untouched = rows.slice(index).map((row) => row.notification.id);
        await db
          .update(notifications)
          .set({
            nextAttemptAt: new Date(Date.now() + report.pauseMs),
            deliveryAttempts: sql`greatest(${notifications.deliveryAttempts} - 1, 0)`,
            lastError: "429: превышен лимит Telegram",
          })
          .where(inArray(notifications.id, untouched));
        report.retried += untouched.length;
        return report;
      }
      if (error instanceof GrammyError && error.error_code === 403) {
        const now = new Date();
        await db.transaction(async (tx) => {
          await tx
            .update(notifications)
            .set({ status: "blocked", lastError: "403: бот заблокирован" })
            .where(eq(notifications.id, notification.id));
          await tx.update(users).set({ botBlockedAt: now }).where(eq(users.id, notification.recipientUserId));
        });
        report.blocked += 1;
        continue;
      }
      const message = error instanceof GrammyError ? `${error.error_code}: ${error.description}` : "Сбой сети";
      const permanent = error instanceof GrammyError && error.error_code >= 400 && error.error_code < 500;
      if (permanent || notification.deliveryAttempts >= MAX_DELIVERY_ATTEMPTS) {
        await db
          .update(notifications)
          .set({ status: "failed", lastError: message })
          .where(eq(notifications.id, notification.id));
        report.failed += 1;
      } else {
        const delay = Math.min(BASE_RETRY_MS * 2 ** (notification.deliveryAttempts - 1), MAX_RETRY_MS);
        await db
          .update(notifications)
          .set({ nextAttemptAt: new Date(Date.now() + delay), lastError: message })
          .where(eq(notifications.id, notification.id));
        report.retried += 1;
      }
    }
  }
  return report;
}

export type WorkerOptions = { tickMs?: number; sweepEveryMs?: number; logger?: Logger };

/** Фоновый цикл: отправка очереди раз в секунду и закрытие просроченных ссылок и заявок раз в минуту. */
export function startNotificationWorker(db: Db, api: Api, options: WorkerOptions = {}) {
  const { tickMs = 1000, sweepEveryMs = 60_000 } = options;
  const logger = (options.logger ?? appLogger).child({ component: "notifications" });
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let lastSweep = 0;
  let running: Promise<void> = Promise.resolve();

  const tick = async () => {
    let waitMs = tickMs;
    try {
      if (Date.now() - lastSweep >= sweepEveryMs) {
        lastSweep = Date.now();
        await expireStale(db);
      }
      const report = await deliverDueNotifications(db, api);
      waitMs = Math.max(tickMs, report.pauseMs);
      if (report.failed > 0 || report.blocked > 0) {
        logger.warn({ failed: report.failed, blocked: report.blocked, retried: report.retried }, "Часть уведомлений не доставлена");
      }
    } catch (error) {
      logger.error({ err: error }, "Ошибка обработчика уведомлений");
    }
    if (!stopped) {
      timer = setTimeout(() => {
        running = tick();
      }, waitMs);
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

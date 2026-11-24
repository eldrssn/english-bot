import { eq } from "drizzle-orm";
import type { MiddlewareFn } from "grammy";
import type { Db } from "../../db/client.js";
import { processedUpdates } from "../../db/schema.js";
import type { BotContext } from "../context.js";

/**
 * Повторная доставка события ничего не меняет. Если обработка упала, запись снимается,
 * чтобы Telegram мог доставить событие снова; повтор безопасен благодаря ограничениям базы.
 */
export function skipProcessedUpdates(db: Db): MiddlewareFn<BotContext> {
  return async (ctx, next) => {
    const updateId = ctx.update.update_id;
    const inserted = await db
      .insert(processedUpdates)
      .values({ updateId })
      .onConflictDoNothing()
      .returning({ updateId: processedUpdates.updateId });
    if (inserted.length === 0) return;
    try {
      await next();
    } catch (error) {
      await db.delete(processedUpdates).where(eq(processedUpdates.updateId, updateId));
      throw error;
    }
  };
}

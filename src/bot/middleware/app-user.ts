import type { MiddlewareFn } from "grammy";
import type { Db } from "../../db/client.js";
import { users } from "../../db/schema.js";
import type { BotContext } from "../context.js";

/** Создаёт или обновляет пользователя. Роль здесь никогда не выдаётся и не меняется. */
export function attachAppUser(db: Db): MiddlewareFn<BotContext> {
  return async (ctx, next) => {
    const from = ctx.from;
    if (from && !from.is_bot) {
      const profile = {
        telegramFirstName: from.first_name,
        telegramLastName: from.last_name ?? null,
        telegramUsername: from.username ?? null,
      };
      const [user] = await db
        .insert(users)
        .values({ telegramId: from.id, ...profile })
        // Раз ученик написал боту, бот больше не заблокирован.
        .onConflictDoUpdate({ target: users.telegramId, set: { ...profile, botBlockedAt: null } })
        .returning();
      ctx.appUser = user;
    }
    await next();
  };
}

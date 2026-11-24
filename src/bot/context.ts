import type { Context } from "grammy";
import type { users } from "../db/schema.js";
import type { StudentAccess } from "../linking/service.js";

export type AppUser = typeof users.$inferSelect;

export type BotContext = Context & {
  /** Пользователь из базы. Заполнен для всех событий, у которых есть отправитель. */
  appUser?: AppUser;
  /** Заполняется привязкой для тех, кого она пропускает к учебным разделам. */
  studentAccess?: Extract<StudentAccess, { kind: "active" | "former" }>;
};

// Смена роли администратором. Вызывается служебной командой на сервере; каждое изменение пишется в журнал.
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { adminAuditLog, studentLinks, users, webSessions } from "../db/schema.js";
import { expireStale, expireStudentRequest, lockUser } from "../linking/locks.js";

const OPEN_STATUSES = ["active", "pending_confirmation"] as const;

export type SetTeacherResult =
  | { kind: "granted"; userId: number }
  | { kind: "already_teacher"; userId: number }
  /** У ученика есть активная связь или незавершённая заявка. */
  | { kind: "student_has_open_link"; userId: number };

export type RemoveTeacherResult =
  | { kind: "removed"; userId: number }
  | { kind: "not_teacher" }
  /** У преподавателя есть подключённые ученики или заявки: ученики остались бы без преподавателя. */
  | { kind: "teacher_has_open_links"; userId: number };

export async function setTeacherRole(db: Db, input: { telegramId: number; actor: string }): Promise<SetTeacherResult> {
  await db
    .insert(users)
    .values({ telegramId: input.telegramId })
    .onConflictDoNothing({ target: users.telegramId });
  const [known] = await db.select({ id: users.id }).from(users).where(eq(users.telegramId, input.telegramId));
  if (!known) throw new Error("Пользователь не найден сразу после вставки");
  await expireStudentRequest(db, known.id);

  return db.transaction(async (tx): Promise<SetTeacherResult> => {
    // Подтверждение заявки берёт ту же блокировку, поэтому роль и заявка не появятся одновременно.
    const user = await lockUser(tx, known.id);
    if (user.role === "teacher") return { kind: "already_teacher", userId: user.id };
    const open = await tx
      .select({ id: studentLinks.id })
      .from(studentLinks)
      .where(and(eq(studentLinks.studentUserId, user.id), inArray(studentLinks.status, [...OPEN_STATUSES])));
    if (open.length > 0) return { kind: "student_has_open_link", userId: user.id };

    await tx.update(users).set({ role: "teacher" }).where(eq(users.id, user.id));
    await tx
      .insert(adminAuditLog)
      .values({ actor: input.actor, targetUserId: user.id, oldRole: user.role, newRole: "teacher" });
    return { kind: "granted", userId: user.id };
  });
}

export async function removeTeacherRole(db: Db, input: { telegramId: number; actor: string }): Promise<RemoveTeacherResult> {
  const [known] = await db.select({ id: users.id }).from(users).where(eq(users.telegramId, input.telegramId));
  if (!known) return { kind: "not_teacher" };
  await expireStale(db, { teacherUserId: known.id });

  return db.transaction(async (tx): Promise<RemoveTeacherResult> => {
    const user = await lockUser(tx, known.id);
    if (user.role !== "teacher") return { kind: "not_teacher" };
    const open = await tx
      .select({ id: studentLinks.id })
      .from(studentLinks)
      .where(and(eq(studentLinks.teacherUserId, user.id), inArray(studentLinks.status, [...OPEN_STATUSES])));
    if (open.length > 0) return { kind: "teacher_has_open_links", userId: user.id };

    await tx.update(users).set({ role: null }).where(eq(users.id, user.id));
    await tx
      .update(webSessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(webSessions.userId, user.id), isNull(webSessions.revokedAt)));
    await tx.insert(adminAuditLog).values({ actor: input.actor, targetUserId: user.id, oldRole: "teacher", newRole: null });
    return { kind: "removed", userId: user.id };
  });
}

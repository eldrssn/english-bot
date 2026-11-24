// Порядок блокировок один на все переходы, поэтому взаимных блокировок нет:
// сначала строка ученика в users, затем строки student_links по возрастанию ID, затем приглашение.
import { and, eq, inArray, lt, ne } from "drizzle-orm";
import type { Db, DbTx } from "../db/client.js";
import { invitations, studentLinks, users } from "../db/schema.js";

export type InvitationRow = typeof invitations.$inferSelect;
export type LinkRow = typeof studentLinks.$inferSelect;

export async function lockUser(tx: DbTx, userId: number) {
  const [user] = await tx.select().from(users).where(eq(users.id, userId)).for("update");
  if (!user) throw new Error(`Пользователь ${userId} не найден`);
  return user;
}

export async function lockLinks(tx: DbTx, linkIds: number[]): Promise<LinkRow[]> {
  return tx
    .select()
    .from(studentLinks)
    .where(inArray(studentLinks.id, [...new Set(linkIds)]))
    .orderBy(studentLinks.id)
    .for("update");
}

/** Закрывает заявку и возвращает запись ученика в «Ожидает подключения». Строки уже заблокированы. */
export async function closeRequest(
  tx: DbTx,
  invitation: Pick<InvitationRow, "id" | "studentLinkId">,
  status: "rejected" | "withdrawn" | "expired",
) {
  await tx
    .update(invitations)
    .set({ status, resolvedAt: new Date(), codeHash: null, codeExpiresAt: null })
    .where(eq(invitations.id, invitation.id));
  await tx
    .update(studentLinks)
    .set({ status: "pending_connection", studentUserId: null })
    .where(eq(studentLinks.id, invitation.studentLinkId));
}

async function expireRequestById(db: Db, invitationId: number, studentUserId: number) {
  await db.transaction(async (tx) => {
    await lockUser(tx, studentUserId);
    const [peek] = await tx
      .select({ studentLinkId: invitations.studentLinkId })
      .from(invitations)
      .where(eq(invitations.id, invitationId));
    if (!peek) return;
    await lockLinks(tx, [peek.studentLinkId]);
    const [current] = await tx.select().from(invitations).where(eq(invitations.id, invitationId)).for("update");
    if (
      current?.status === "awaiting_teacher" &&
      current.requestExpiresAt &&
      current.requestExpiresAt.getTime() <= Date.now()
    ) {
      await closeRequest(tx, current, "expired");
    }
  });
}

/** Переводит просроченные ссылки и заявки в expired. Без teacherId работает по всей базе (обработчик очереди). */
export async function expireStale(db: Db, scope: { teacherUserId?: number } = {}) {
  const now = new Date();
  const ownedBy = scope.teacherUserId
    ? [
        inArray(
          invitations.studentLinkId,
          db
            .select({ id: studentLinks.id })
            .from(studentLinks)
            .where(and(eq(studentLinks.teacherUserId, scope.teacherUserId), ne(studentLinks.status, "ended"))),
        ),
      ]
    : [];

  await db
    .update(invitations)
    .set({ status: "expired", resolvedAt: now })
    .where(and(eq(invitations.status, "pending"), lt(invitations.expiresAt, now), ...ownedBy));

  const stale = await db
    .select({ id: invitations.id, studentUserId: invitations.studentUserId })
    .from(invitations)
    .where(and(eq(invitations.status, "awaiting_teacher"), lt(invitations.requestExpiresAt, now), ...ownedBy));
  for (const row of stale) {
    if (row.studentUserId !== null) await expireRequestById(db, row.id, row.studentUserId);
  }
}

/** Закрывает просроченную заявку конкретного ученика. */
export async function expireStudentRequest(db: Db, studentUserId: number) {
  const stale = await db
    .select({ id: invitations.id })
    .from(invitations)
    .where(
      and(
        eq(invitations.studentUserId, studentUserId),
        eq(invitations.status, "awaiting_teacher"),
        lt(invitations.requestExpiresAt, new Date()),
      ),
    );
  for (const row of stale) await expireRequestById(db, row.id, studentUserId);
}

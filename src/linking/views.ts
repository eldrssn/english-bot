// Чтение для кабинета. Каждый запрос ограничен преподавателем и незавершёнными записями:
// завершённые связи и их история здесь не показываются.
import { and, desc, eq, inArray, isNull, max, ne, count, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { invitations, sessions, studentCards, studentCollections, studentLinks, users } from "../db/schema.js";
import { expireStale } from "./locks.js";
import { MAX_CODE_ATTEMPTS, personName } from "./service.js";
import { recentActivity } from "../results/student-results.js";

type LinkWithStudent = {
  link: typeof studentLinks.$inferSelect;
  student: typeof users.$inferSelect | null;
};

function ownLinks(teacherUserId: number) {
  return and(eq(studentLinks.teacherUserId, teacherUserId), ne(studentLinks.status, "ended"));
}

async function selectOwnLinks(db: Db, teacherUserId: number, linkId?: number): Promise<LinkWithStudent[]> {
  return db
    .select({ link: studentLinks, student: users })
    .from(studentLinks)
    .leftJoin(users, eq(users.id, studentLinks.studentUserId))
    .where(and(ownLinks(teacherUserId), ...(linkId === undefined ? [] : [eq(studentLinks.id, linkId)])))
    .orderBy(desc(studentLinks.createdAt), desc(studentLinks.id));
}

async function liveInvitations(db: Db, linkIds: number[]) {
  if (linkIds.length === 0) return new Map<number, typeof invitations.$inferSelect>();
  const rows = await db
    .select()
    .from(invitations)
    .where(and(inArray(invitations.studentLinkId, linkIds), inArray(invitations.status, ["pending", "awaiting_teacher"])));
  return new Map(rows.map((row) => [row.studentLinkId, row]));
}

/** Активность считается только по занятиям текущей связи. */
async function lastActivity(db: Db, linkIds: number[]) {
  if (linkIds.length === 0) return new Map<number, Date>();
  const rows = await db
    .select({ linkId: sessions.studentLinkId, at: max(sessions.updatedAt) })
    .from(sessions)
    .where(inArray(sessions.studentLinkId, linkIds))
    .groupBy(sessions.studentLinkId);
  return new Map(rows.flatMap((row) => (row.linkId !== null && row.at ? [[row.linkId, row.at] as const] : [])));
}

function pendingAction(link: LinkWithStudent["link"], live: typeof invitations.$inferSelect | undefined) {
  if (link.status === "pending_confirmation") return "confirm_request" as const;
  if (link.status === "pending_connection") return live ? ("wait_for_student" as const) : ("send_link" as const);
  return null;
}

function toListItem(row: LinkWithStudent, live: typeof invitations.$inferSelect | undefined, activity: Date | undefined) {
  const { link, student } = row;
  if (link.status === "ended") throw new Error("Завершённая связь не показывается");
  return {
    id: link.id,
    displayName: link.displayName,
    status: link.status,
    telegramName: student ? personName(student) : null,
    telegramUsername: student?.telegramUsername ?? null,
    lastActivityAt: activity?.toISOString() ?? null,
    pendingAction: pendingAction(link, live),
  };
}

function toRequest(row: LinkWithStudent, live: typeof invitations.$inferSelect | undefined) {
  const { link, student } = row;
  if (link.status !== "pending_confirmation" || !student || !live?.requestedAt || !live.requestExpiresAt) return null;
  const active =
    live.codeHash !== null &&
    live.codeExpiresAt !== null &&
    live.codeExpiresAt > new Date() &&
    live.codeAttempts < MAX_CODE_ATTEMPTS;
  return {
    telegramId: student.telegramId,
    telegramName: personName(student),
    telegramUsername: student.telegramUsername,
    requestedAt: live.requestedAt.toISOString(),
    expiresAt: live.requestExpiresAt.toISOString(),
    codeState: active ? ("active" as const) : ("inactive" as const),
    attemptsLeft: active ? MAX_CODE_ATTEMPTS - live.codeAttempts : 0,
  };
}

export async function listStudents(db: Db, teacherUserId: number) {
  await expireStale(db, { teacherUserId });
  const rows = await selectOwnLinks(db, teacherUserId);
  const linkIds = rows.map((row) => row.link.id);
  const [live, activity] = await Promise.all([liveInvitations(db, linkIds), lastActivity(db, linkIds)]);
  return rows.map((row) => toListItem(row, live.get(row.link.id), activity.get(row.link.id)));
}

export async function getDashboard(db: Db, teacherUserId: number) {
  await expireStale(db, { teacherUserId });
  const rows = await selectOwnLinks(db, teacherUserId);
  const live = await liveInvitations(db, rows.map((row) => row.link.id));
  const recent = await recentActivity(db, rows.map((row) => row.link));
  return {
    ...recent,
    studentCount: rows.length,
    activeStudentCount: rows.filter((row) => row.link.status === "active").length,
    pendingRequests: rows.flatMap((row) => {
      const request = toRequest(row, live.get(row.link.id));
      return request
        ? [
            {
              studentId: row.link.id,
              displayName: row.link.displayName,
              telegramName: request.telegramName,
              telegramUsername: request.telegramUsername,
              requestedAt: request.requestedAt,
              expiresAt: request.expiresAt,
            },
          ]
        : [];
    }),
  };
}

/** Карточка своей незавершённой записи. undefined значит: нет, чужая или завершена. */
export async function getStudentDetail(db: Db, teacherUserId: number, linkId: number) {
  await expireStale(db, { teacherUserId });
  const [row] = await selectOwnLinks(db, teacherUserId, linkId);
  if (!row) return undefined;
  const live = (await liveInvitations(db, [linkId])).get(linkId);
  const activity = (await lastActivity(db, [linkId])).get(linkId);

  let lastOutcome: "expired" | "revoked" | "rejected" | "withdrawn" | null = null;
  if (row.link.status === "pending_connection" && !live) {
    const [last] = await db
      .select({ status: invitations.status })
      .from(invitations)
      .where(eq(invitations.studentLinkId, linkId))
      .orderBy(desc(invitations.id))
      .limit(1);
    const status = last?.status;
    if (status === "expired" || status === "revoked" || status === "rejected" || status === "withdrawn") {
      lastOutcome = status;
    }
  }

  const collections = await db
    .select({
      id: studentCollections.id,
      title: studentCollections.title,
      status: studentCollections.status,
      publishedAt: studentCollections.publishedAt,
      sourceCollectionId: studentCollections.sourceCollectionId,
      wordCount: count(studentCards.id),
    })
    .from(studentCollections)
    .leftJoin(
      studentCards,
      and(eq(studentCards.studentCollectionId, studentCollections.id), isNull(studentCards.deletedAt)),
    )
    .where(and(eq(studentCollections.studentLinkId, linkId), isNull(studentCollections.deletedAt)))
    .groupBy(studentCollections.id)
    .orderBy(desc(studentCollections.publishedAt), sql`${studentCollections.id} DESC`);

  return {
    ...toListItem(row, live, activity),
    startedAt: row.link.startedAt?.toISOString() ?? null,
    invitation: {
      live: live?.status === "pending",
      expiresAt: live?.status === "pending" ? live.expiresAt.toISOString() : null,
      lastOutcome,
    },
    request: toRequest(row, live),
    collections: collections.map((collection) => ({
      ...collection,
      publishedAt: collection.publishedAt.toISOString(),
    })),
  };
}

export async function getRequest(db: Db, teacherUserId: number, linkId: number) {
  const detail = await getStudentDetail(db, teacherUserId, linkId);
  return detail ? { request: detail.request } : undefined;
}

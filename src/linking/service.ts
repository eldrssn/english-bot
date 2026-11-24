// Переходы привязки. Сервис не знает о Telegram и HTTP: его вызывают бот, API и служебные команды.
import { and, count, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Db, DbTx } from "../db/client.js";
import { attachCardsToStudent } from "../db/collections.js";
import { invitations, studentCards, studentCollections, studentLinks, users } from "../db/schema.js";
import { enqueueNewCollection, enqueueNotification } from "../notifications/queue.js";
import {
  closeRequest,
  expireStale,
  expireStudentRequest,
  lockLinks,
  lockUser,
  type InvitationRow,
  type LinkRow,
} from "./locks.js";
import { INVITE_TOKEN_PATTERN, createLinkingSecrets } from "./secrets.js";

const DAY_MS = 24 * 60 * 60 * 1000;
export const INVITATION_TTL_MS = 7 * DAY_MS;
export const REQUEST_TTL_MS = 7 * DAY_MS;
export const CODE_TTL_MS = DAY_MS;
export const MAX_CODE_ATTEMPTS = 5;

export type LinkingErrorCode =
  | "not_found"
  | "state_changed"
  | "link_not_pending"
  | "no_live_invitation"
  | "no_request"
  | "request_pending";

/** Отказ в действии преподавателя. Транзакция откатывается: ничего записано не будет. */
export class LinkingError extends Error {
  override name = "LinkingError";
  constructor(readonly code: LinkingErrorCode) {
    super(code);
  }
}

export type IssuedInvitation = { token: string; expiresAt: Date };

export type CodeState = { codeActive: boolean; requestExpiresAt: Date };

export type OpenLinkResult =
  | { kind: "invalid" }
  | { kind: "teacher_account" }
  | { kind: "has_active_link" }
  | ({ kind: "own_request" } & CodeState)
  | { kind: "confirm_required"; teacherName: string }
  | { kind: "switch_required"; teacherName: string };

export type ConfirmJoinResult =
  | { kind: "invalid" }
  | { kind: "teacher_account" }
  | { kind: "has_active_link" }
  | ({ kind: "own_request" } & CodeState)
  | { kind: "switch_required"; teacherName: string }
  | { kind: "joined"; code: string; codeExpiresAt: Date; teacherName: string };

export type ReissueCodeResult = { kind: "no_request" } | { kind: "issued"; code: string; codeExpiresAt: Date };

export type StudentAccess =
  | { kind: "teacher" }
  | { kind: "active"; linkId: number }
  /** Связь завершена, копии остались: ученик занимается по ним. Заявка к новому преподавателю им не мешает. */
  | { kind: "former"; request: CodeState | null }
  /** Связь завершена, а выданных копий не было. */
  | { kind: "former_no_copies" }
  | ({ kind: "request" } & CodeState)
  | { kind: "none" };

export type ApproveResult =
  | { kind: "approved" }
  | { kind: "wrong_code"; attemptsLeft: number }
  | { kind: "code_inactive" };

export function personName(person: {
  telegramFirstName: string | null;
  telegramLastName: string | null;
}): string | null {
  const name = [person.telegramFirstName, person.telegramLastName].filter(Boolean).join(" ");
  return name === "" ? null : name;
}

function codeIsActive(invitation: InvitationRow, now = new Date()): boolean {
  return (
    invitation.codeHash !== null &&
    invitation.codeExpiresAt !== null &&
    invitation.codeExpiresAt > now &&
    invitation.codeAttempts < MAX_CODE_ATTEMPTS
  );
}

function codeState(invitation: InvitationRow): CodeState {
  if (!invitation.requestExpiresAt) throw new Error(`У заявки ${invitation.id} нет срока`);
  return { codeActive: codeIsActive(invitation), requestExpiresAt: invitation.requestExpiresAt };
}

/**
 * Единственный способ получить запись для изменения в кабинете: проверяет владельца и
 * что запись не завершена. Сначала берёт блокировку заявителя, потом записи (см. locks.ts).
 */
async function lockTeacherLink(tx: DbTx, teacherUserId: number, linkId: number): Promise<LinkRow> {
  const ownedLink = and(
    eq(studentLinks.id, linkId),
    eq(studentLinks.teacherUserId, teacherUserId),
    ne(studentLinks.status, "ended"),
  );
  const [peek] = await tx.select({ studentUserId: studentLinks.studentUserId }).from(studentLinks).where(ownedLink);
  if (!peek) throw new LinkingError("not_found");
  if (peek.studentUserId !== null) await lockUser(tx, peek.studentUserId);
  const [link] = await tx.select().from(studentLinks).where(ownedLink).for("update");
  if (!link) throw new LinkingError("not_found");
  // Заявитель сменился между чтением и блокировкой: пусть преподаватель посмотрит на новое состояние.
  if (link.studentUserId !== peek.studentUserId) throw new LinkingError("state_changed");
  return link;
}

async function lockLiveInvitation(tx: DbTx, linkId: number): Promise<InvitationRow | undefined> {
  const [invitation] = await tx
    .select()
    .from(invitations)
    .where(and(eq(invitations.studentLinkId, linkId), inArray(invitations.status, ["pending", "awaiting_teacher"])))
    .for("update");
  return invitation;
}

export type LinkingService = ReturnType<typeof createLinkingService>;

export function createLinkingService(db: Db, appSecret: string) {
  const secrets = createLinkingSecrets(appSecret);

  async function insertInvitation(tx: DbTx, linkId: number): Promise<IssuedInvitation> {
    const token = secrets.generateInviteToken();
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
    await tx.insert(invitations).values({
      studentLinkId: linkId,
      tokenHash: secrets.hashInviteToken(token),
      expiresAt,
    });
    return { token, expiresAt };
  }

  async function issueCode(tx: DbTx, invitationId: number) {
    const code = secrets.generateCode();
    const codeExpiresAt = new Date(Date.now() + CODE_TTL_MS);
    await tx
      .update(invitations)
      .set({ codeHash: secrets.hashCode(invitationId, code), codeExpiresAt, codeAttempts: 0 })
      .where(eq(invitations.id, invitationId));
    return { code, codeExpiresAt };
  }

  async function findInvitationByToken(token: string) {
    if (!INVITE_TOKEN_PATTERN.test(token)) return undefined;
    const [row] = await db
      .select({ id: invitations.id, studentLinkId: invitations.studentLinkId })
      .from(invitations)
      .where(eq(invitations.tokenHash, secrets.hashInviteToken(token)));
    return row;
  }

  async function findTeacher(tx: Db | DbTx, linkId: number) {
    const [row] = await tx
      .select({ teacher: users })
      .from(studentLinks)
      .innerJoin(users, eq(users.id, studentLinks.teacherUserId))
      .where(eq(studentLinks.id, linkId));
    return row?.teacher;
  }

  async function findOwnRequest(tx: Db | DbTx, studentUserId: number) {
    const [invitation] = await tx
      .select()
      .from(invitations)
      .where(and(eq(invitations.studentUserId, studentUserId), eq(invitations.status, "awaiting_teacher")));
    return invitation;
  }

  async function hasActiveLink(tx: Db | DbTx, studentUserId: number) {
    const [link] = await tx
      .select({ id: studentLinks.id })
      .from(studentLinks)
      .where(and(eq(studentLinks.studentUserId, studentUserId), eq(studentLinks.status, "active")));
    return link?.id;
  }

  return {
    // ---------- Действия преподавателя ----------

    /** Создаёт запись ученика и сразу первую ссылку. */
    async createStudent(input: { teacherUserId: number; displayName: string }) {
      return db.transaction(async (tx) => {
        const [link] = await tx
          .insert(studentLinks)
          .values({ teacherUserId: input.teacherUserId, displayName: input.displayName })
          .returning({ id: studentLinks.id });
        if (!link) throw new Error("Запись ученика не создана");
        return { linkId: link.id, invitation: await insertInvitation(tx, link.id) };
      });
    },

    /** Новая ссылка: прежняя действующая перестаёт работать. */
    async issueInvitation(input: { teacherUserId: number; linkId: number }): Promise<IssuedInvitation> {
      await expireStale(db, { teacherUserId: input.teacherUserId });
      return db.transaction(async (tx) => {
        const link = await lockTeacherLink(tx, input.teacherUserId, input.linkId);
        if (link.status === "pending_confirmation") throw new LinkingError("request_pending");
        if (link.status !== "pending_connection") throw new LinkingError("link_not_pending");
        const live = await lockLiveInvitation(tx, link.id);
        if (live) {
          await tx
            .update(invitations)
            .set({ status: "revoked", resolvedAt: new Date() })
            .where(eq(invitations.id, live.id));
        }
        return insertInvitation(tx, link.id);
      });
    },

    async revokeInvitation(input: { teacherUserId: number; linkId: number }) {
      await expireStale(db, { teacherUserId: input.teacherUserId });
      await db.transaction(async (tx) => {
        const link = await lockTeacherLink(tx, input.teacherUserId, input.linkId);
        if (link.status === "pending_confirmation") throw new LinkingError("request_pending");
        if (link.status !== "pending_connection") throw new LinkingError("link_not_pending");
        const live = await lockLiveInvitation(tx, link.id);
        if (live?.status !== "pending") throw new LinkingError("no_live_invitation");
        await tx
          .update(invitations)
          .set({ status: "revoked", resolvedAt: new Date() })
          .where(eq(invitations.id, live.id));
      });
    },

    /**
     * Проверяет код и подтверждает заявку одним действием. Неверная попытка сохраняется,
     * поэтому результат возвращается, а не выбрасывается: транзакция должна зафиксироваться.
     */
    async approveRequest(input: { teacherUserId: number; linkId: number; code: string }): Promise<ApproveResult> {
      await expireStale(db, { teacherUserId: input.teacherUserId });
      return db.transaction(async (tx): Promise<ApproveResult> => {
        const link = await lockTeacherLink(tx, input.teacherUserId, input.linkId);
        if (link.status !== "pending_confirmation" || link.studentUserId === null) {
          throw new LinkingError("no_request");
        }
        const request = await lockLiveInvitation(tx, link.id);
        const now = new Date();
        if (
          request?.status !== "awaiting_teacher" ||
          request.studentUserId !== link.studentUserId ||
          !request.requestExpiresAt ||
          request.requestExpiresAt <= now
        ) {
          throw new LinkingError("no_request");
        }

        if (!codeIsActive(request, now) || request.codeHash === null) {
          // Истёкший код больше не проверяется и не хранится.
          await tx
            .update(invitations)
            .set({ codeHash: null, codeExpiresAt: null })
            .where(eq(invitations.id, request.id));
          return { kind: "code_inactive" };
        }

        if (!secrets.verifyCode(request.id, input.code, request.codeHash)) {
          const attempts = request.codeAttempts + 1;
          const exhausted = attempts >= MAX_CODE_ATTEMPTS;
          await tx
            .update(invitations)
            .set({ codeAttempts: attempts, ...(exhausted ? { codeHash: null, codeExpiresAt: null } : {}) })
            .where(eq(invitations.id, request.id));
          return exhausted ? { kind: "code_inactive" } : { kind: "wrong_code", attemptsLeft: MAX_CODE_ATTEMPTS - attempts };
        }

        const student = await lockUser(tx, link.studentUserId);
        if (student.role === "teacher") throw new LinkingError("state_changed");

        await tx
          .update(invitations)
          .set({ status: "approved", resolvedAt: now, codeHash: null, codeExpiresAt: null })
          .where(eq(invitations.id, request.id));
        await tx.update(studentLinks).set({ status: "active", startedAt: now }).where(eq(studentLinks.id, link.id));
        await tx.update(users).set({ role: "student" }).where(eq(users.id, student.id));
        await attachCardsToStudent(tx, link.id, student.id);

        await enqueueNotification(tx, {
          recipientUserId: student.id,
          reason: "link_confirmed",
          dedupeKey: `link_confirmed:${link.id}`,
          payload: { linkId: link.id },
        });
        const issued = await tx
          .select({ id: studentCollections.id, title: studentCollections.title, wordCount: count(studentCards.id) })
          .from(studentCollections)
          .leftJoin(
            studentCards,
            and(eq(studentCards.studentCollectionId, studentCollections.id), isNull(studentCards.deletedAt)),
          )
          .where(and(eq(studentCollections.studentLinkId, link.id), isNull(studentCollections.deletedAt)))
          .groupBy(studentCollections.id)
          .orderBy(studentCollections.publishedAt, studentCollections.id);
        for (const collection of issued) {
          await enqueueNewCollection(tx, student.id, collection);
        }
        return { kind: "approved" };
      });
    },

    /** Запись возвращается в «Ожидает подключения»; заявитель материалов не получает. Для ссылки нужна новая выдача. */
    async rejectRequest(input: { teacherUserId: number; linkId: number }) {
      await expireStale(db, { teacherUserId: input.teacherUserId });
      await db.transaction(async (tx) => {
        const link = await lockTeacherLink(tx, input.teacherUserId, input.linkId);
        if (link.status !== "pending_confirmation") throw new LinkingError("no_request");
        const request = await lockLiveInvitation(tx, link.id);
        if (request?.status !== "awaiting_teacher") throw new LinkingError("no_request");
        await closeRequest(tx, request, "rejected");
        if (request.studentUserId !== null) {
          // Заявитель узнаёт только сам факт отклонения: имя записи и причина в сообщение не входят.
          await enqueueNotification(tx, {
            recipientUserId: request.studentUserId,
            reason: "request_rejected",
            dedupeKey: `request_rejected:${request.id}`,
          });
        }
      });
    },

    /** Имя меняется только в записи: связь, ученик и история не затрагиваются. */
    async renameStudent(input: { teacherUserId: number; linkId: number; displayName: string }) {
      await db.transaction(async (tx) => {
        const link = await lockTeacherLink(tx, input.teacherUserId, input.linkId);
        await tx.update(studentLinks).set({ displayName: input.displayName }).where(eq(studentLinks.id, link.id));
      });
    },

    /**
     * Убирает ученика из списка. Учётная запись, прогресс и копии сохраняются,
     * новая связь с тем же преподавателем будет новой записью.
     */
    async unlinkStudent(input: { teacherUserId: number; linkId: number }) {
      await expireStale(db, { teacherUserId: input.teacherUserId });
      await db.transaction(async (tx) => {
        const link = await lockTeacherLink(tx, input.teacherUserId, input.linkId);
        if (link.status === "pending_confirmation") throw new LinkingError("request_pending");
        const now = new Date();
        const live = await lockLiveInvitation(tx, link.id);
        if (live) {
          await tx.update(invitations).set({ status: "revoked", resolvedAt: now }).where(eq(invitations.id, live.id));
        }
        await tx.update(studentLinks).set({ status: "ended", endedAt: now }).where(eq(studentLinks.id, link.id));
        if (link.status === "active" && link.studentUserId !== null) {
          await enqueueNotification(tx, {
            recipientUserId: link.studentUserId,
            reason: "link_ended",
            dedupeKey: `link_ended:${link.id}`,
            payload: { linkId: link.id },
          });
        }
      });
    },

    // ---------- Действия ученика ----------

    /** Открытие ссылки ничего не расходует: фиксируется только, кто её открыл. */
    async openLink(input: { userId: number; token: string }): Promise<OpenLinkResult> {
      const [user] = await db.select({ role: users.role, telegramId: users.telegramId }).from(users).where(eq(users.id, input.userId));
      if (!user) throw new Error(`Пользователь ${input.userId} не найден`);
      if (user.role === "teacher") return { kind: "teacher_account" };

      await expireStudentRequest(db, input.userId);
      const found = await findInvitationByToken(input.token);
      if (!found) return { kind: "invalid" };
      const [invitation] = await db.select().from(invitations).where(eq(invitations.id, found.id));
      if (!invitation) return { kind: "invalid" };

      if (invitation.status === "awaiting_teacher" && invitation.studentUserId === input.userId) {
        return { kind: "own_request", ...codeState(invitation) };
      }
      if (invitation.status !== "pending" || invitation.expiresAt <= new Date()) return { kind: "invalid" };
      const teacher = await findTeacher(db, invitation.studentLinkId);
      if (teacher?.role !== "teacher") return { kind: "invalid" };

      await db
        .update(invitations)
        .set({ openedByTelegramId: user.telegramId })
        .where(and(eq(invitations.id, invitation.id), eq(invitations.status, "pending")));

      if (await hasActiveLink(db, input.userId)) return { kind: "has_active_link" };
      const teacherName = personName(teacher) ?? "Преподаватель";
      if (await findOwnRequest(db, input.userId)) return { kind: "switch_required", teacherName };
      return { kind: "confirm_required", teacherName };
    },

    /**
     * Ученик подтверждает присоединение. Два ученика на одной ссылке: блокировка записи
     * пропускает первого, второй видит уже использованную ссылку.
     */
    async confirmJoin(input: { userId: number; token: string; allowSwitch: boolean }): Promise<ConfirmJoinResult> {
      await expireStudentRequest(db, input.userId);
      const found = await findInvitationByToken(input.token);
      return db.transaction(async (tx): Promise<ConfirmJoinResult> => {
        const student = await lockUser(tx, input.userId);
        if (student.role === "teacher") return { kind: "teacher_account" };
        if (!found) return { kind: "invalid" };

        const previous = await findOwnRequest(tx, student.id);
        const locked = await lockLinks(tx, [found.studentLinkId, ...(previous ? [previous.studentLinkId] : [])]);
        const link = locked.find((row) => row.id === found.studentLinkId);
        const [invitation] = await tx.select().from(invitations).where(eq(invitations.id, found.id)).for("update");
        if (!link || !invitation) return { kind: "invalid" };

        if (invitation.status === "awaiting_teacher" && invitation.studentUserId === student.id) {
          return { kind: "own_request", ...codeState(invitation) };
        }
        const now = new Date();
        if (invitation.status !== "pending" || invitation.expiresAt <= now || link.status !== "pending_connection") {
          return { kind: "invalid" };
        }
        // Блокировка не даёт снять роль с преподавателя, пока создаётся заявка к нему.
        const [teacher] = await tx.select().from(users).where(eq(users.id, link.teacherUserId)).for("share");
        if (teacher?.role !== "teacher") return { kind: "invalid" };
        if (await hasActiveLink(tx, student.id)) return { kind: "has_active_link" };

        const teacherName = personName(teacher) ?? "Преподаватель";
        if (previous) {
          if (!input.allowSwitch) return { kind: "switch_required", teacherName };
          const previousLink = locked.find((row) => row.id === previous.studentLinkId);
          await closeRequest(tx, previous, "withdrawn");
          if (previousLink) {
            await enqueueNotification(tx, {
              recipientUserId: previousLink.teacherUserId,
              reason: "request_withdrawn",
              dedupeKey: `request_withdrawn:${previous.id}`,
              payload: { linkId: previousLink.id, displayName: previousLink.displayName },
            });
          }
        }

        await tx
          .update(invitations)
          .set({
            status: "awaiting_teacher",
            studentUserId: student.id,
            openedByTelegramId: student.telegramId,
            requestedAt: now,
            requestExpiresAt: new Date(now.getTime() + REQUEST_TTL_MS),
          })
          .where(eq(invitations.id, invitation.id));
        await tx
          .update(studentLinks)
          .set({ status: "pending_confirmation", studentUserId: student.id })
          .where(eq(studentLinks.id, link.id));
        const { code, codeExpiresAt } = await issueCode(tx, invitation.id);

        await enqueueNotification(tx, {
          recipientUserId: link.teacherUserId,
          reason: "join_request",
          dedupeKey: `join_request:${invitation.id}`,
          payload: {
            linkId: link.id,
            displayName: link.displayName,
            telegramName: personName(student),
            telegramUsername: student.telegramUsername,
          },
        });
        return { kind: "joined", code, codeExpiresAt, teacherName };
      });
    },

    /** Новый код к своей заявке: прежний перестаёт действовать, счётчик попыток обнуляется. */
    async reissueCode(input: { userId: number }): Promise<ReissueCodeResult> {
      await expireStudentRequest(db, input.userId);
      return db.transaction(async (tx): Promise<ReissueCodeResult> => {
        await lockUser(tx, input.userId);
        const request = await findOwnRequest(tx, input.userId);
        if (!request) return { kind: "no_request" };
        await lockLinks(tx, [request.studentLinkId]);
        const [current] = await tx.select().from(invitations).where(eq(invitations.id, request.id)).for("update");
        if (current?.status !== "awaiting_teacher") return { kind: "no_request" };
        const issued = await issueCode(tx, current.id);
        return { kind: "issued", ...issued };
      });
    },

    /**
     * Что доступно аккаунту в боте. Учебные разделы — у «active» и у «former».
     * Заявитель материалы новой заявки не видит: копии записи откроются только после подтверждения.
     */
    async getStudentAccess(userId: number): Promise<StudentAccess> {
      const [user] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId));
      if (user?.role === "teacher") return { kind: "teacher" };
      await expireStudentRequest(db, userId);
      const linkId = user?.role === "student" ? await hasActiveLink(db, userId) : undefined;
      if (linkId) return { kind: "active", linkId };
      const request = await findOwnRequest(db, userId);
      if (user?.role === "student") {
        const [ended] = await db
          .select({ linkId: studentLinks.id, collectionId: studentCollections.id })
          .from(studentLinks)
          .leftJoin(
            studentCollections,
            and(eq(studentCollections.studentLinkId, studentLinks.id), isNull(studentCollections.deletedAt)),
          )
          .where(and(eq(studentLinks.studentUserId, userId), eq(studentLinks.status, "ended")))
          .orderBy(sql`${studentCollections.id} IS NULL`)
          .limit(1);
        if (ended?.collectionId != null) return { kind: "former", request: request ? codeState(request) : null };
        if (ended && !request) return { kind: "former_no_copies" };
      }
      return request ? { kind: "request", ...codeState(request) } : { kind: "none" };
    },
  };
}

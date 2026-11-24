import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { issueCollectionCopy } from "../../src/db/collections.js";
import { invitations, studentCards, studentLinks, studentWords, users } from "../../src/db/schema.js";
import { expireStale } from "../../src/linking/locks.js";
import { LinkingError, MAX_CODE_ATTEMPTS } from "../../src/linking/service.js";
import { getStudentDetail, listStudents } from "../../src/linking/views.js";
import { openTestDb, resetDb } from "../helpers/db.js";
import { getLink, linkingFor, makeTeacher, makeUser, reasons, seededCollectionId } from "../helpers/linking.js";

const { db, close } = openTestDb();
afterAll(close);
beforeEach(() => resetDb(db));

const linking = linkingFor(db);

async function setup() {
  const teacher = await makeTeacher(db, 100, "Мария");
  const student = await makeUser(db, 200);
  const created = await linking.createStudent({ teacherUserId: teacher.id, displayName: "Пётр" });
  return { teacher, student, linkId: created.linkId, token: created.invitation.token };
}

async function joined(userId: number, token: string) {
  const result = await linking.confirmJoin({ userId, token, allowSwitch: false });
  if (result.kind !== "joined") throw new Error(`Ожидалось joined, получено ${result.kind}`);
  return result;
}

const wrongCodeFor = (code: string) => (code === "000000" ? "000001" : "000000");
const shiftCode = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, "0");

async function invitationOf(linkId: number) {
  const rows = await db.select().from(invitations).where(eq(invitations.studentLinkId, linkId)).orderBy(invitations.id);
  return rows.at(-1)!;
}

describe("выдача ссылки", () => {
  it("в базе только хэш токена; запись без аккаунта", async () => {
    const { linkId, token } = await setup();
    const invitation = await invitationOf(linkId);
    expect(invitation.tokenHash).not.toContain(token);
    expect(invitation.status).toBe("pending");
    expect(JSON.stringify(invitation)).not.toContain(token);
    const link = await getLink(db, linkId);
    expect(link).toMatchObject({ status: "pending_connection", studentUserId: null });
    const days = (invitation.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.99);
    expect(days).toBeLessThanOrEqual(7);
  });

  it("новая ссылка отменяет прежнюю", async () => {
    const { teacher, student, linkId, token } = await setup();
    const fresh = await linking.issueInvitation({ teacherUserId: teacher.id, linkId });
    expect(await linking.openLink({ userId: student.id, token })).toEqual({ kind: "invalid" });
    expect((await linking.openLink({ userId: student.id, token: fresh.token })).kind).toBe("confirm_required");
  });

  it("отмена делает ссылку недействительной; повторная отмена — конфликт", async () => {
    const { teacher, student, linkId, token } = await setup();
    await linking.revokeInvitation({ teacherUserId: teacher.id, linkId });
    expect(await linking.openLink({ userId: student.id, token })).toEqual({ kind: "invalid" });
    await expect(linking.revokeInvitation({ teacherUserId: teacher.id, linkId })).rejects.toThrow("no_live_invitation");
    expect((await joinedAttempt(student.id, token)).kind).toBe("invalid");
  });

  it("при заявке новая ссылка и отмена не работают: сначала решение по заявке", async () => {
    const { teacher, student, linkId, token } = await setup();
    await joined(student.id, token);
    await expect(linking.issueInvitation({ teacherUserId: teacher.id, linkId })).rejects.toThrow("request_pending");
    await expect(linking.revokeInvitation({ teacherUserId: teacher.id, linkId })).rejects.toThrow("request_pending");
  });

  it("у подключённого ученика новой ссылки быть не может", async () => {
    const { teacher, student, linkId, token } = await setup();
    const { code } = await joined(student.id, token);
    await linking.approveRequest({ teacherUserId: teacher.id, linkId, code });
    await expect(linking.issueInvitation({ teacherUserId: teacher.id, linkId })).rejects.toThrow("link_not_pending");
  });
});

const joinedAttempt = (userId: number, token: string) => linking.confirmJoin({ userId, token, allowSwitch: false });

describe("открытие и подтверждение учеником", () => {
  it("открытие не расходует ссылку; подтверждение фиксирует аккаунт и создаёт заявку", async () => {
    const { teacher, student, linkId, token } = await setup();
    for (let i = 0; i < 3; i += 1) {
      expect(await linking.openLink({ userId: student.id, token })).toEqual({ kind: "confirm_required", teacherName: "Мария" });
    }
    const opened = await invitationOf(linkId);
    expect(opened).toMatchObject({ status: "pending", studentUserId: null, openedByTelegramId: 200 });
    expect(await reasons(db, teacher.id)).toEqual([]);

    const { code } = await joined(student.id, token);
    expect(code).toMatch(/^\d{6}$/);
    const invitation = await invitationOf(linkId);
    expect(invitation).toMatchObject({ status: "awaiting_teacher", studentUserId: student.id, codeAttempts: 0 });
    expect(invitation.codeHash).not.toBe(code);
    expect((invitation.requestExpiresAt!.getTime() - Date.now()) / 86_400_000).toBeGreaterThan(6.99);
    expect((invitation.codeExpiresAt!.getTime() - Date.now()) / 3_600_000).toBeGreaterThan(23.9);
    expect(await getLink(db, linkId)).toMatchObject({ status: "pending_confirmation", studentUserId: student.id });
    expect(await reasons(db, teacher.id)).toEqual(["join_request"]);
    // Заявка не даёт роль.
    const [row] = await db.select().from(users).where(eq(users.id, student.id));
    expect(row?.role).toBeNull();
  });

  it("повторное подтверждение своей ссылки не создаёт вторую заявку и уведомление", async () => {
    const { teacher, student, token } = await setup();
    await joined(student.id, token);
    const again = await joinedAttempt(student.id, token);
    expect(again).toMatchObject({ kind: "own_request", codeActive: true });
    expect(await reasons(db, teacher.id)).toEqual(["join_request"]);
    expect(await linking.openLink({ userId: student.id, token })).toMatchObject({ kind: "own_request" });
  });

  it("ссылку с заявкой другому человеку не открыть, детали не раскрываются", async () => {
    const { student, token } = await setup();
    const other = await makeUser(db, 201);
    await joined(student.id, token);
    expect(await linking.openLink({ userId: other.id, token })).toEqual({ kind: "invalid" });
    expect(await joinedAttempt(other.id, token)).toEqual({ kind: "invalid" });
  });

  it("истёкшая ссылка недействительна: и при открытии, и при подтверждении", async () => {
    const { student, linkId, token } = await setup();
    await db.update(invitations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invitations.studentLinkId, linkId));
    expect(await linking.openLink({ userId: student.id, token })).toEqual({ kind: "invalid" });
    expect(await joinedAttempt(student.id, token)).toEqual({ kind: "invalid" });
  });

  it("выдуманный токен и токен с недопустимыми символами недействительны", async () => {
    const { student } = await setup();
    expect(await linking.openLink({ userId: student.id, token: "x".repeat(43) })).toEqual({ kind: "invalid" });
    expect(await linking.openLink({ userId: student.id, token: "плохой токен" })).toEqual({ kind: "invalid" });
    expect(await linking.openLink({ userId: student.id, token: "x".repeat(65) })).toEqual({ kind: "invalid" });
  });

  it("ссылка преподавателя, у которого сняли роль, недействительна", async () => {
    const { teacher, student, token } = await setup();
    await db.update(users).set({ role: null }).where(eq(users.id, teacher.id));
    expect(await linking.openLink({ userId: student.id, token })).toEqual({ kind: "invalid" });
    expect(await joinedAttempt(student.id, token)).toEqual({ kind: "invalid" });
  });
});

describe("особые случаи", () => {
  it("аккаунт преподавателя: отказ на открытии и подтверждении", async () => {
    const { token, linkId } = await setup();
    const otherTeacher = await makeTeacher(db, 101);
    expect(await linking.openLink({ userId: otherTeacher.id, token })).toEqual({ kind: "teacher_account" });
    expect(await joinedAttempt(otherTeacher.id, token)).toEqual({ kind: "teacher_account" });
    expect(await getLink(db, linkId)).toMatchObject({ status: "pending_connection", studentUserId: null });
  });

  it("активная связь: ссылка другого преподавателя отклонена, новой заявки нет", async () => {
    const { teacher, student, linkId, token } = await setup();
    const { code } = await joined(student.id, token);
    await linking.approveRequest({ teacherUserId: teacher.id, linkId, code });

    const teacherB = await makeTeacher(db, 102);
    const b = await linking.createStudent({ teacherUserId: teacherB.id, displayName: "Другой" });
    expect(await linking.openLink({ userId: student.id, token: b.invitation.token })).toEqual({ kind: "has_active_link" });
    expect(await joinedAttempt(student.id, b.invitation.token)).toEqual({ kind: "has_active_link" });
    expect(await getLink(db, b.linkId)).toMatchObject({ status: "pending_connection", studentUserId: null });
    expect(await reasons(db, teacherB.id)).toEqual([]);
  });

  it("заявка к А и ссылка Б: вопрос; без согласия ничего не меняется", async () => {
    const { student, linkId, token } = await setup();
    await joined(student.id, token);
    const teacherB = await makeTeacher(db, 102, "Борис");
    const b = await linking.createStudent({ teacherUserId: teacherB.id, displayName: "Другой" });

    expect(await linking.openLink({ userId: student.id, token: b.invitation.token })).toEqual({ kind: "switch_required", teacherName: "Борис" });
    expect((await joinedAttempt(student.id, b.invitation.token)).kind).toBe("switch_required");
    expect(await getLink(db, linkId)).toMatchObject({ status: "pending_confirmation", studentUserId: student.id });
    expect(await getLink(db, b.linkId)).toMatchObject({ status: "pending_connection" });
  });

  it("заявка к А и согласие на Б: активна только новая заявка, А уведомлён и может выдать ссылку", async () => {
    const { teacher, student, linkId, token } = await setup();
    const { code: oldCode } = await joined(student.id, token);
    const teacherB = await makeTeacher(db, 102);
    const b = await linking.createStudent({ teacherUserId: teacherB.id, displayName: "Другой" });

    const switched = await linking.confirmJoin({ userId: student.id, token: b.invitation.token, allowSwitch: true });
    expect(switched.kind).toBe("joined");

    expect(await getLink(db, linkId)).toMatchObject({ status: "pending_connection", studentUserId: null });
    expect((await invitationOf(linkId)).status).toBe("withdrawn");
    expect((await invitationOf(linkId)).codeHash).toBeNull();
    expect(await getLink(db, b.linkId)).toMatchObject({ status: "pending_confirmation", studentUserId: student.id });
    const active = await db.select().from(invitations).where(eq(invitations.status, "awaiting_teacher"));
    expect(active.map((row) => row.studentLinkId)).toEqual([b.linkId]);
    expect(await reasons(db, teacher.id)).toEqual(["join_request", "request_withdrawn"]);

    await expect(linking.approveRequest({ teacherUserId: teacher.id, linkId, code: oldCode })).rejects.toThrow("no_request");
    const detail = await getStudentDetail(db, teacher.id, linkId);
    expect(detail?.invitation.lastOutcome).toBe("withdrawn");
    expect(detail?.pendingAction).toBe("send_link");
    await expect(linking.issueInvitation({ teacherUserId: teacher.id, linkId })).resolves.toBeTruthy();
    // Использованная прежняя ссылка назад не работает.
    expect(await linking.openLink({ userId: student.id, token })).toEqual({ kind: "invalid" });
  });
});

describe("код", () => {
  it("верный код подключает: роль ученика, статус, дата, запись заявки", async () => {
    const { teacher, student, linkId, token } = await setup();
    const { code } = await joined(student.id, token);
    expect(await linking.approveRequest({ teacherUserId: teacher.id, linkId, code })).toEqual({ kind: "approved" });
    const link = await getLink(db, linkId);
    expect(link.status).toBe("active");
    expect(link.startedAt).toBeInstanceOf(Date);
    expect((await invitationOf(linkId))).toMatchObject({ status: "approved", codeHash: null });
    const [row] = await db.select().from(users).where(eq(users.id, student.id));
    expect(row?.role).toBe("student");
    expect(await reasons(db, student.id)).toEqual(["link_confirmed"]);
    expect(await linking.getStudentAccess(student.id)).toEqual({ kind: "active", linkId });
    // Повтор не подключает второй раз.
    await expect(linking.approveRequest({ teacherUserId: teacher.id, linkId, code })).rejects.toThrow("no_request");
  });

  it("неверная попытка сохраняется, после пятой код не работает даже верный", async () => {
    const { teacher, student, linkId, token } = await setup();
    const { code } = await joined(student.id, token);
    const wrong = wrongCodeFor(code);
    for (let left = MAX_CODE_ATTEMPTS - 1; left > 0; left -= 1) {
      expect(await linking.approveRequest({ teacherUserId: teacher.id, linkId, code: wrong })).toEqual({ kind: "wrong_code", attemptsLeft: left });
    }
    expect((await invitationOf(linkId)).codeAttempts).toBe(4);
    expect(await linking.approveRequest({ teacherUserId: teacher.id, linkId, code: wrong })).toEqual({ kind: "code_inactive" });
    expect((await invitationOf(linkId))).toMatchObject({ codeHash: null, codeAttempts: 5 });
    expect(await linking.approveRequest({ teacherUserId: teacher.id, linkId, code })).toEqual({ kind: "code_inactive" });
    expect((await getLink(db, linkId)).status).toBe("pending_confirmation");

    // Заявка жива: новый код работает, счётчик обнулён.
    const fresh = await linking.reissueCode({ userId: student.id });
    if (fresh.kind !== "issued") throw new Error("Код не выпущен");
    expect((await invitationOf(linkId)).codeAttempts).toBe(0);
    expect(await linking.approveRequest({ teacherUserId: teacher.id, linkId, code: fresh.code })).toEqual({ kind: "approved" });
  });

  it("истёкший код не работает и не тратит попытку; новый работает", async () => {
    const { teacher, student, linkId, token } = await setup();
    const { code } = await joined(student.id, token);
    await db.update(invitations).set({ codeExpiresAt: new Date(Date.now() - 1000) }).where(eq(invitations.studentLinkId, linkId));
    expect(await linking.approveRequest({ teacherUserId: teacher.id, linkId, code })).toEqual({ kind: "code_inactive" });
    expect((await invitationOf(linkId)).codeAttempts).toBe(0);
    expect(await linking.getStudentAccess(student.id)).toMatchObject({ kind: "request", codeActive: false });
    const fresh = await linking.reissueCode({ userId: student.id });
    if (fresh.kind !== "issued") throw new Error("Код не выпущен");
    expect(await linking.approveRequest({ teacherUserId: teacher.id, linkId, code: fresh.code })).toEqual({ kind: "approved" });
  });

  it("перевыпуск отменяет прежний код", async () => {
    const { teacher, student, linkId, token } = await setup();
    const { code } = await joined(student.id, token);
    let fresh = await linking.reissueCode({ userId: student.id });
    if (fresh.kind !== "issued") throw new Error("Код не выпущен");
    while (fresh.kind === "issued" && fresh.code === code) fresh = await linking.reissueCode({ userId: student.id });
    expect((await linking.approveRequest({ teacherUserId: teacher.id, linkId, code })).kind).toBe("wrong_code");
  });

  it("новый код без заявки не выпускается", async () => {
    const { student } = await setup();
    expect(await linking.reissueCode({ userId: student.id })).toEqual({ kind: "no_request" });
  });
});

describe("срок заявки 7 дней", () => {
  it("после срока запись возвращается в ожидание, код не работает", async () => {
    const { teacher, student, linkId, token } = await setup();
    const { code } = await joined(student.id, token);
    await db.update(invitations).set({ requestExpiresAt: new Date(Date.now() - 1000) }).where(eq(invitations.studentLinkId, linkId));

    await expect(linking.approveRequest({ teacherUserId: teacher.id, linkId, code })).rejects.toThrow("no_request");
    expect(await getLink(db, linkId)).toMatchObject({ status: "pending_connection", studentUserId: null });
    expect((await invitationOf(linkId)).status).toBe("expired");
    expect(await linking.getStudentAccess(student.id)).toEqual({ kind: "none" });
    expect(await linking.reissueCode({ userId: student.id })).toEqual({ kind: "no_request" });
    expect(await linking.openLink({ userId: student.id, token })).toEqual({ kind: "invalid" });
  });

  it("фоновая очистка закрывает просроченные ссылки и заявки", async () => {
    const { student, linkId, token, teacher } = await setup();
    await joined(student.id, token);
    await db.update(invitations).set({ requestExpiresAt: new Date(Date.now() - 1000) }).where(eq(invitations.studentLinkId, linkId));
    const second = await linking.createStudent({ teacherUserId: teacher.id, displayName: "Второй" });
    await db.update(invitations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invitations.studentLinkId, second.linkId));

    await expireStale(db);
    expect((await invitationOf(linkId)).status).toBe("expired");
    expect((await invitationOf(second.linkId)).status).toBe("expired");
    expect(await getLink(db, linkId)).toMatchObject({ status: "pending_connection", studentUserId: null });
  });

  it("студент с просроченной заявкой может подать новую без вопроса о переходе", async () => {
    const { student, linkId, token } = await setup();
    await joined(student.id, token);
    await db.update(invitations).set({ requestExpiresAt: new Date(Date.now() - 1000) }).where(eq(invitations.studentLinkId, linkId));
    const teacherB = await makeTeacher(db, 102);
    const b = await linking.createStudent({ teacherUserId: teacherB.id, displayName: "Другой" });
    expect((await linking.openLink({ userId: student.id, token: b.invitation.token })).kind).toBe("confirm_required");
    expect((await joinedAttempt(student.id, b.invitation.token)).kind).toBe("joined");
  });
});

describe("материалы и подтверждение связи", () => {
  it("копия до подключения: слово появляется только после подтверждения, уведомление — тоже", async () => {
    const { teacher, student, linkId, token } = await setup();
    const { collectionId } = await seededCollectionId(db);
    const { studentCollectionId } = await issueCollectionCopy(db, { studentLinkId: linkId, sourceCollectionId: collectionId });

    const { code } = await joined(student.id, token);
    const cards = await db.select().from(studentCards).where(eq(studentCards.studentCollectionId, studentCollectionId));
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.every((card) => card.studentWordId === null)).toBe(true);
    expect(await db.select().from(studentWords)).toHaveLength(0);
    expect(await reasons(db, student.id)).toEqual([]);

    await linking.approveRequest({ teacherUserId: teacher.id, linkId, code });
    const after = await db.select().from(studentCards).where(eq(studentCards.studentCollectionId, studentCollectionId));
    expect(after.every((card) => card.studentWordId !== null)).toBe(true);
    const words = await db.select().from(studentWords).where(eq(studentWords.studentUserId, student.id));
    expect(words.length).toBeGreaterThan(0);
    expect(await reasons(db, student.id)).toEqual(["link_confirmed", "new_collection"]);
  });

  it("копия, выданная во время заявки, не создаёт слов заявителю", async () => {
    const { teacher, student, linkId, token } = await setup();
    await joined(student.id, token);
    const { collectionId } = await seededCollectionId(db);
    await issueCollectionCopy(db, { studentLinkId: linkId, sourceCollectionId: collectionId });
    expect(await db.select().from(studentWords)).toHaveLength(0);

    await linking.rejectRequest({ teacherUserId: teacher.id, linkId });
    expect(await db.select().from(studentWords)).toHaveLength(0);
    // Заявитель узнаёт об отклонении, но о материалах ему не сообщается.
    expect(await reasons(db, student.id)).toEqual(["request_rejected"]);
    expect(await linking.getStudentAccess(student.id)).toEqual({ kind: "none" });
  });

  it("заявка без подтверждения: учебного доступа нет", async () => {
    const { student, token } = await setup();
    await joined(student.id, token);
    expect((await linking.getStudentAccess(student.id)).kind).toBe("request");
  });
});

describe("отклонение", () => {
  it("запись возвращается в ожидание, заявитель обнулён, старая ссылка мертва, новая работает", async () => {
    const { teacher, student, linkId, token } = await setup();
    const { code } = await joined(student.id, token);
    await linking.rejectRequest({ teacherUserId: teacher.id, linkId });

    expect(await getLink(db, linkId)).toMatchObject({ status: "pending_connection", studentUserId: null });
    expect((await invitationOf(linkId))).toMatchObject({ status: "rejected", codeHash: null });
    const [row] = await db.select().from(users).where(eq(users.id, student.id));
    expect(row?.role).toBeNull();
    expect(await linking.openLink({ userId: student.id, token })).toEqual({ kind: "invalid" });
    await expect(linking.approveRequest({ teacherUserId: teacher.id, linkId, code })).rejects.toThrow("no_request");
    await expect(linking.rejectRequest({ teacherUserId: teacher.id, linkId })).rejects.toThrow("no_request");

    const fresh = await linking.issueInvitation({ teacherUserId: teacher.id, linkId });
    const other = await makeUser(db, 204);
    expect((await joinedAttempt(other.id, fresh.token)).kind).toBe("joined");
  });
});

describe("переименование и отвязка", () => {
  it("переименование меняет только имя", async () => {
    const { teacher, student, linkId, token } = await setup();
    const { code } = await joined(student.id, token);
    await linking.approveRequest({ teacherUserId: teacher.id, linkId, code });
    const before = await getLink(db, linkId);
    await linking.renameStudent({ teacherUserId: teacher.id, linkId, displayName: "Пётр Иванович" });
    const after = await getLink(db, linkId);
    expect(after.displayName).toBe("Пётр Иванович");
    expect(after).toMatchObject({ status: "active", studentUserId: student.id, startedAt: before.startedAt, teacherUserId: teacher.id });
    expect(await linking.getStudentAccess(student.id)).toEqual({ kind: "active", linkId });
  });

  it("отвязка: запись закрыта, ученик сохраняет роль, копии и слова, уведомлён; запись исчезает из кабинета", async () => {
    const { teacher, student, linkId, token } = await setup();
    const { collectionId } = await seededCollectionId(db);
    await issueCollectionCopy(db, { studentLinkId: linkId, sourceCollectionId: collectionId });
    const { code } = await joined(student.id, token);
    await linking.approveRequest({ teacherUserId: teacher.id, linkId, code });
    const wordsBefore = await db.select().from(studentWords).where(eq(studentWords.studentUserId, student.id));

    await linking.unlinkStudent({ teacherUserId: teacher.id, linkId });
    const link = await getLink(db, linkId);
    expect(link.status).toBe("ended");
    expect(link.studentUserId).toBe(student.id);
    expect(link.endedAt).toBeInstanceOf(Date);
    expect(await db.select().from(studentWords).where(eq(studentWords.studentUserId, student.id))).toEqual(wordsBefore);
    expect((await reasons(db, student.id)).at(-1)).toBe("link_ended");
    // Копии остались: ученик занимается по ним, новых материалов не получает.
    expect(await linking.getStudentAccess(student.id)).toEqual({ kind: "former", request: null });
    expect(await listStudents(db, teacher.id)).toEqual([]);
    expect(await getStudentDetail(db, teacher.id, linkId)).toBeUndefined();
    for (const action of [
      () => linking.renameStudent({ teacherUserId: teacher.id, linkId, displayName: "x" }),
      () => linking.unlinkStudent({ teacherUserId: teacher.id, linkId }),
      () => linking.issueInvitation({ teacherUserId: teacher.id, linkId }),
    ]) {
      await expect(action()).rejects.toThrow("not_found");
    }
  });

  it("запись без аккаунта можно убрать: ссылка перестаёт работать", async () => {
    const { teacher, student, linkId, token } = await setup();
    await linking.unlinkStudent({ teacherUserId: teacher.id, linkId });
    expect(await linking.openLink({ userId: student.id, token })).toEqual({ kind: "invalid" });
    expect((await getLink(db, linkId)).status).toBe("ended");
  });

  it("при заявке отвязка запрещена", async () => {
    const { teacher, student, linkId, token } = await setup();
    await joined(student.id, token);
    await expect(linking.unlinkStudent({ teacherUserId: teacher.id, linkId })).rejects.toThrow("request_pending");
  });

  it("ученик вернулся к тому же преподавателю: новая запись, прежняя не видна", async () => {
    const { teacher, student, linkId, token } = await setup();
    const { collectionId } = await seededCollectionId(db);
    await issueCollectionCopy(db, { studentLinkId: linkId, sourceCollectionId: collectionId });
    const { code } = await joined(student.id, token);
    await linking.approveRequest({ teacherUserId: teacher.id, linkId, code });
    await linking.unlinkStudent({ teacherUserId: teacher.id, linkId });

    const again = await linking.createStudent({ teacherUserId: teacher.id, displayName: "Снова Пётр" });
    const second = await joined(student.id, again.invitation.token);
    await linking.approveRequest({ teacherUserId: teacher.id, linkId: again.linkId, code: second.code });

    const list = await listStudents(db, teacher.id);
    expect(list.map((item) => item.id)).toEqual([again.linkId]);
    const detail = await getStudentDetail(db, teacher.id, again.linkId);
    expect(detail?.collections).toEqual([]);
    expect(await db.select().from(studentLinks).where(eq(studentLinks.studentUserId, student.id))).toHaveLength(2);
  });
});

describe("чужой преподаватель в сервисе", () => {
  it("каждое действие над чужой записью — not_found и ничего не меняет", async () => {
    const { student, linkId, token } = await setup();
    const { code } = await joined(student.id, token);
    const stranger = await makeTeacher(db, 105);
    const before = await getLink(db, linkId);
    const input = { teacherUserId: stranger.id, linkId };
    const attempts = [
      () => linking.approveRequest({ ...input, code }),
      () => linking.rejectRequest(input),
      () => linking.renameStudent({ ...input, displayName: "x" }),
      () => linking.unlinkStudent(input),
      () => linking.issueInvitation(input),
      () => linking.revokeInvitation(input),
    ];
    for (const attempt of attempts) {
      const error = await attempt().then(() => null, (reason: unknown) => reason);
      expect(error).toBeInstanceOf(LinkingError);
      expect((error as LinkingError).code).toBe("not_found");
    }
    expect(await getLink(db, linkId)).toEqual(before);
    expect(await getStudentDetail(db, stranger.id, linkId)).toBeUndefined();
    expect(await listStudents(db, stranger.id)).toEqual([]);
  });
});

describe("гонки", () => {
  it("два ученика на одной ссылке: заявка одна, у второго отказ", async () => {
    for (let round = 0; round < 10; round += 1) {
      await resetDb(db);
      const { teacher, linkId, token } = await setup();
      const students = await Promise.all([300, 301, 302, 303].map((id) => makeUser(db, id)));
      const results = await Promise.all(students.map((user) => joinedAttempt(user.id, token)));
      expect(results.filter((result) => result.kind === "joined")).toHaveLength(1);
      expect(results.filter((result) => result.kind === "invalid")).toHaveLength(3);
      expect(await reasons(db, teacher.id)).toEqual(["join_request"]);
      const winner = students[results.findIndex((result) => result.kind === "joined")]!;
      expect((await getLink(db, linkId)).studentUserId).toBe(winner.id);
    }
  });

  it("один ученик жмёт подтверждение дважды одновременно: один код, одна заявка", async () => {
    const { teacher, student, token } = await setup();
    const results = await Promise.all(Array.from({ length: 5 }, () => joinedAttempt(student.id, token)));
    expect(results.filter((result) => result.kind === "joined")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "own_request")).toHaveLength(4);
    expect(await reasons(db, teacher.id)).toEqual(["join_request"]);
  });

  it("ученик одновременно подтверждает ссылки двух преподавателей: заявка одна", async () => {
    for (let round = 0; round < 10; round += 1) {
      await resetDb(db);
      const { student, token } = await setup();
      const teacherB = await makeTeacher(db, 110);
      const b = await linking.createStudent({ teacherUserId: teacherB.id, displayName: "Б" });
      const results = await Promise.all([joinedAttempt(student.id, token), joinedAttempt(student.id, b.invitation.token)]);
      expect(results.map((result) => result.kind).sort()).toEqual(["joined", "switch_required"]);
      const active = await db.select().from(invitations).where(eq(invitations.status, "awaiting_teacher"));
      expect(active).toHaveLength(1);
    }
  });

  it("перекрёстный переход двух учеников не приводит к взаимной блокировке", async () => {
    for (let round = 0; round < 10; round += 1) {
      await resetDb(db);
      const teacher = await makeTeacher(db, 100);
      const [s1, s2] = [await makeUser(db, 301), await makeUser(db, 302)];
      const [a, b, c, d] = await Promise.all(
        [1, 2, 3, 4].map((n) => linking.createStudent({ teacherUserId: teacher.id, displayName: `Запись ${n}` })),
      );
      await joined(s1.id, a!.invitation.token);
      await joined(s2.id, b!.invitation.token);
      const results = await Promise.all([
        linking.confirmJoin({ userId: s1.id, token: c!.invitation.token, allowSwitch: true }),
        linking.confirmJoin({ userId: s2.id, token: d!.invitation.token, allowSwitch: true }),
        linking.rejectRequest({ teacherUserId: teacher.id, linkId: a!.linkId }).catch(() => null),
        linking.rejectRequest({ teacherUserId: teacher.id, linkId: b!.linkId }).catch(() => null),
      ]);
      expect(results[0]?.kind).toBe("joined");
      expect(results[1]?.kind).toBe("joined");
      const active = await db.select().from(invitations).where(eq(invitations.status, "awaiting_teacher"));
      expect(active).toHaveLength(2);
    }
  });

  it("одновременное подтверждение и отклонение: итог один, база согласована", async () => {
    for (let round = 0; round < 10; round += 1) {
      await resetDb(db);
      const { teacher, student, linkId, token } = await setup();
      const { code } = await joined(student.id, token);
      const results = await Promise.allSettled([
        linking.approveRequest({ teacherUserId: teacher.id, linkId, code }),
        linking.rejectRequest({ teacherUserId: teacher.id, linkId }),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const link = await getLink(db, linkId);
      const invitation = await invitationOf(linkId);
      if (link.status === "active") expect(invitation.status).toBe("approved");
      else expect(link).toMatchObject({ status: "pending_connection", studentUserId: null });
    }
  });

  it("параллельные неверные коды считаются все: больше пяти проверок не бывает", async () => {
    const { teacher, student, linkId, token } = await setup();
    const { code } = await joined(student.id, token);
    const wrong = shiftCode(code);
    const results = await Promise.all(
      Array.from({ length: 12 }, () => linking.approveRequest({ teacherUserId: teacher.id, linkId, code: wrong })),
    );
    expect(results.filter((result) => result.kind === "wrong_code")).toHaveLength(4);
    expect(results.filter((result) => result.kind === "code_inactive")).toHaveLength(8);
    expect((await invitationOf(linkId))).toMatchObject({ codeAttempts: 5, codeHash: null });
  });

  it("параллельное подтверждение одним кодом подключает один раз", async () => {
    const { teacher, student, linkId, token } = await setup();
    const { code } = await joined(student.id, token);
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => linking.approveRequest({ teacherUserId: teacher.id, linkId, code })),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await reasons(db, student.id)).toEqual(["link_confirmed"]);
  });

  it("отмена ссылки и подтверждение учеником: одно из двух, без рассогласования", async () => {
    for (let round = 0; round < 10; round += 1) {
      await resetDb(db);
      const { teacher, student, linkId, token } = await setup();
      const [revoke, confirm] = await Promise.allSettled([
        linking.revokeInvitation({ teacherUserId: teacher.id, linkId }),
        joinedAttempt(student.id, token),
      ]);
      const link = await getLink(db, linkId);
      const invitation = await invitationOf(linkId);
      if (invitation.status === "revoked") {
        expect(revoke.status).toBe("fulfilled");
        expect(confirm.status === "fulfilled" && confirm.value.kind).toBe("invalid");
        expect(link).toMatchObject({ status: "pending_connection", studentUserId: null });
      } else {
        expect(invitation.status).toBe("awaiting_teacher");
        expect(revoke.status).toBe("rejected");
        expect(link).toMatchObject({ status: "pending_confirmation", studentUserId: student.id });
      }
    }
  });
});

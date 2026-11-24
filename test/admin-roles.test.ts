import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { removeTeacherRole, setTeacherRole } from "../src/admin/roles.js";
import { adminAuditLog, invitations, users, webSessions } from "../src/db/schema.js";
import { TEST_DATABASE_URL, openTestDb, resetDb } from "./helpers/db.js";
import { connectDirectly, linkingFor, makeTeacher, makeUser } from "./helpers/linking.js";

const { db, close } = openTestDb();
afterAll(close);
beforeEach(() => resetDb(db));

const linking = linkingFor(db);
const actor = "test";
const roleOf = async (telegramId: number) => (await db.select().from(users).where(eq(users.telegramId, telegramId)))[0]?.role;

describe("выдача роли", () => {
  it("новому Telegram ID: создаёт пользователя и пишет журнал", async () => {
    expect(await setTeacherRole(db, { telegramId: 42, actor })).toMatchObject({ kind: "granted" });
    expect(await roleOf(42)).toBe("teacher");
    const log = await db.select().from(adminAuditLog);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ actor, oldRole: null, newRole: "teacher" });
  });

  it("повтор ничего не меняет и не пишет журнал", async () => {
    await setTeacherRole(db, { telegramId: 42, actor });
    expect(await setTeacherRole(db, { telegramId: 42, actor })).toMatchObject({ kind: "already_teacher" });
    expect(await db.select().from(adminAuditLog)).toHaveLength(1);
  });

  it("ученика с активной связью нельзя сделать преподавателем", async () => {
    const teacher = await makeTeacher(db, 1);
    await connectDirectly(db, teacher.id, 42);
    expect(await setTeacherRole(db, { telegramId: 42, actor })).toMatchObject({ kind: "student_has_open_link" });
    expect(await roleOf(42)).toBe("student");
    expect(await db.select().from(adminAuditLog)).toHaveLength(0);
  });

  it("заявителя нельзя сделать преподавателем; после истечения заявки можно", async () => {
    const teacher = await makeTeacher(db, 1);
    const student = await makeUser(db, 42);
    const { linkId, invitation } = await linking.createStudent({ teacherUserId: teacher.id, displayName: "Ю" });
    await linking.confirmJoin({ userId: student.id, token: invitation.token, allowSwitch: false });
    expect(await setTeacherRole(db, { telegramId: 42, actor })).toMatchObject({ kind: "student_has_open_link" });

    await db.update(invitations).set({ requestExpiresAt: new Date(Date.now() - 1000) }).where(eq(invitations.studentLinkId, linkId));
    expect(await setTeacherRole(db, { telegramId: 42, actor })).toMatchObject({ kind: "granted" });
  });

  it("бывшего ученика без связи можно: журнал хранит прежнюю роль", async () => {
    const teacher = await makeTeacher(db, 1);
    const { link } = await connectDirectly(db, teacher.id, 42);
    await linking.unlinkStudent({ teacherUserId: teacher.id, linkId: link.id });
    expect(await setTeacherRole(db, { telegramId: 42, actor })).toMatchObject({ kind: "granted" });
    expect((await db.select().from(adminAuditLog))[0]).toMatchObject({ oldRole: "student", newRole: "teacher" });
  });

  it("заявка и выдача роли одновременно: одно из двух", async () => {
    for (let round = 0; round < 10; round += 1) {
      await resetDb(db);
      const teacher = await makeTeacher(db, 1);
      const student = await makeUser(db, 42);
      const { invitation } = await linking.createStudent({ teacherUserId: teacher.id, displayName: "Ю" });
      const [role, join] = await Promise.all([
        setTeacherRole(db, { telegramId: 42, actor }),
        linking.confirmJoin({ userId: student.id, token: invitation.token, allowSwitch: false }),
      ]);
      expect(role.kind === "granted").toBe(join.kind === "teacher_account");
      expect(role.kind === "student_has_open_link").toBe(join.kind === "joined");
    }
  });
});

describe("снятие роли", () => {
  it("снимает роль, закрывает сессии, пишет журнал", async () => {
    const teacher = await makeTeacher(db, 42);
    await db.insert(webSessions).values({ userId: teacher.id, tokenHash: "h", csrfTokenHash: "c", expiresAt: new Date(Date.now() + 1000) });
    expect(await removeTeacherRole(db, { telegramId: 42, actor })).toMatchObject({ kind: "removed" });
    expect(await roleOf(42)).toBeNull();
    expect((await db.select().from(webSessions))[0]?.revokedAt).toBeInstanceOf(Date);
    expect((await db.select().from(adminAuditLog))[0]).toMatchObject({ oldRole: "teacher", newRole: null });
  });

  it("не преподаватель и незнакомый ID: ничего не меняется", async () => {
    await makeUser(db, 42);
    expect(await removeTeacherRole(db, { telegramId: 42, actor })).toEqual({ kind: "not_teacher" });
    expect(await removeTeacherRole(db, { telegramId: 43, actor })).toEqual({ kind: "not_teacher" });
    expect(await db.select().from(adminAuditLog)).toHaveLength(0);
  });

  it("при подключённых учениках и заявках отказ", async () => {
    const teacher = await makeTeacher(db, 42);
    await connectDirectly(db, teacher.id, 50);
    expect(await removeTeacherRole(db, { telegramId: 42, actor })).toMatchObject({ kind: "teacher_has_open_links" });
    expect(await roleOf(42)).toBe("teacher");
  });
});

describe("команда", () => {
  const exec = promisify(execFile);
  const run = (...args: string[]) =>
    exec(process.execPath, ["--import", "tsx", "scripts/admin-role.ts", ...args], {
      env: { PATH: process.env.PATH, DATABASE_URL: TEST_DATABASE_URL },
    });

  it("выдаёт и снимает роль", async () => {
    expect((await run("set-teacher", "4242")).stdout).toContain("роль преподавателя выдана");
    expect(await roleOf(4242)).toBe("teacher");
    const log = await db.select().from(adminAuditLog);
    expect(log[0]?.actor).toMatch(/^cli:/);
    expect((await run("remove-teacher", "4242")).stdout).toContain("снята");
    expect(await roleOf(4242)).toBeNull();
  });

  it("неверные аргументы и отказ: код ошибки", async () => {
    await expect(run("set-teacher", "abc")).rejects.toMatchObject({ code: 1 });
    const teacher = await makeTeacher(db, 1);
    await connectDirectly(db, teacher.id, 77);
    await expect(run("set-teacher", "77")).rejects.toMatchObject({ code: 1 });
    expect(await roleOf(77)).toBe("student");
  });
});

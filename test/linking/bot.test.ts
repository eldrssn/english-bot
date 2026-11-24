import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { DECLINE_JOIN, MENU, NEW_CODE, collectionsPage, joinButton } from "../../src/bot/callback-data.js";
import { invitations, sessions, studentLinks, users } from "../../src/db/schema.js";
import { openTestDb, resetDb } from "../helpers/db.js";
import { callbackUpdate, createFakeBot, lastButtons, sentTexts, textUpdate } from "../helpers/fake-telegram.js";
import { codeFrom, getLink, joinThroughBot, linkingFor, makeTeacher } from "../helpers/linking.js";

const { db, close } = openTestDb();
afterAll(close);
beforeEach(() => resetDb(db));

const STUDENT = 8001;
const OTHER = 8002;
const SECRET_NAME = "СекретноеИмя";
const linking = linkingFor(db);

async function setup() {
  const teacher = await makeTeacher(db, 9001, "Мария");
  const created = await linking.createStudent({ teacherUserId: teacher.id, displayName: SECRET_NAME });
  return { teacher, linkId: created.linkId, token: created.invitation.token };
}

const bot = () => createFakeBot(db);

function expectNoLeak(texts: string[]) {
  for (const text of texts) expect(text).not.toContain(SECRET_NAME);
}

describe("Start", () => {
  it("без ссылки: приветствие, совет запросить ссылку, роли нет", async () => {
    const { bot: b, calls } = bot();
    await b.handleUpdate(textUpdate(STUDENT, "/start"));
    expect(sentTexts(calls).at(-1)).toContain("попросите у преподавателя персональную ссылку");
    expect(lastButtons(calls)).toEqual([]);
    const [user] = await db.select().from(users).where(eq(users.telegramId, STUDENT));
    expect(user?.role).toBeNull();
    expect(await db.select().from(studentLinks)).toHaveLength(0);
  });

  it("с ссылкой: имя преподавателя и кнопки, ссылка не расходуется, имя ученика не показано", async () => {
    const { linkId, token } = await setup();
    const { bot: b, calls } = bot();
    await b.handleUpdate(textUpdate(STUDENT, `/start ${token}`));
    await b.handleUpdate(textUpdate(STUDENT, `/start ${token}`));
    expect(sentTexts(calls).at(-1)).toContain("Преподаватель Мария приглашает");
    expectNoLeak(sentTexts(calls));
    const buttons = lastButtons(calls);
    expect(buttons.map((button) => button.text)).toEqual(["Присоединиться", "Отказаться"]);
    for (const button of buttons) expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(64);
    const [invitation] = await db.select().from(invitations).where(eq(invitations.studentLinkId, linkId));
    expect(invitation?.status).toBe("pending");
    expect((await getLink(db, linkId)).studentUserId).toBeNull();
  });

  it("Отказаться: ссылка остаётся рабочей", async () => {
    const { token } = await setup();
    const { bot: b, calls } = bot();
    await b.handleUpdate(textUpdate(STUDENT, `/start ${token}`));
    await b.handleUpdate(callbackUpdate(STUDENT, DECLINE_JOIN));
    expect(sentTexts(calls).at(-1)).toContain("присоединение отменено");
    await b.handleUpdate(textUpdate(STUDENT, `/start ${token}`));
    expect(sentTexts(calls).at(-1)).toContain("Преподаватель Мария приглашает");
  });
});

describe("подтверждение и код", () => {
  it("присоединение показывает код и кнопку «Новый код»; материалов нет", async () => {
    const { token } = await setup();
    const fake = bot();
    const code = await joinThroughBot(fake, STUDENT, token);
    expect(code).toMatch(/^\d{6}$/);
    expect(sentTexts(fake.calls).at(-1)).toContain("Сообщите его преподавателю");
    expect(lastButtons(fake.calls).map((button) => button.text)).toEqual(["Новый код"]);

    // Учебные разделы закрыты.
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, collectionsPage(0)));
    expect(sentTexts(fake.calls).at(-1)).toContain("ждёт подтверждения");
    await fake.bot.handleUpdate(textUpdate(STUDENT, "завтрак"));
    expect(sentTexts(fake.calls).at(-1)).toContain("ждёт подтверждения");
    expect(await db.select().from(sessions)).toHaveLength(0);
    expectNoLeak(sentTexts(fake.calls));
  });

  it("повторное открытие своей ссылки: прежний код не показан (хэш), предлагается новый", async () => {
    const { token } = await setup();
    const fake = bot();
    const code = await joinThroughBot(fake, STUDENT, token);
    await fake.bot.handleUpdate(textUpdate(STUDENT, `/start ${token}`));
    expect(sentTexts(fake.calls).at(-1)).toContain("запросите новый");
    expect(sentTexts(fake.calls).at(-1)).not.toContain(code);
    expect(lastButtons(fake.calls).map((button) => button.text)).toEqual(["Новый код"]);
    await fake.bot.handleUpdate(textUpdate(STUDENT, "/start"));
    expect(sentTexts(fake.calls).at(-1)).toContain("ждёт подтверждения");
  });

  it("«Новый код» выдаёт код, старый перестаёт действовать", async () => {
    const { teacher, linkId, token } = await setup();
    const fake = bot();
    const code = await joinThroughBot(fake, STUDENT, token);
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, NEW_CODE));
    const fresh = codeFrom(sentTexts(fake.calls).at(-1));
    if (fresh !== code) {
      expect((await linking.approveRequest({ teacherUserId: teacher.id, linkId, code })).kind).toBe("wrong_code");
    }
    expect(await linking.approveRequest({ teacherUserId: teacher.id, linkId, code: fresh })).toEqual({ kind: "approved" });
  });

  it("код истёк: бот об этом говорит и предлагает новый", async () => {
    const { linkId, token } = await setup();
    const fake = bot();
    await joinThroughBot(fake, STUDENT, token);
    await db.update(invitations).set({ codeExpiresAt: new Date(Date.now() - 1000) }).where(eq(invitations.studentLinkId, linkId));
    await fake.bot.handleUpdate(textUpdate(STUDENT, "/start"));
    expect(sentTexts(fake.calls).at(-1)).toContain("Срок кода истёк");
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, NEW_CODE));
    expect(codeFrom(sentTexts(fake.calls).at(-1))).toMatch(/^\d{6}$/);
  });

  it("«Новый код» после отклонения: заявка не действует", async () => {
    const { teacher, linkId, token } = await setup();
    const fake = bot();
    await joinThroughBot(fake, STUDENT, token);
    await linking.rejectRequest({ teacherUserId: teacher.id, linkId });
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, NEW_CODE));
    expect(sentTexts(fake.calls).at(-1)).toContain("Заявка больше не действует");
    await fake.bot.handleUpdate(textUpdate(STUDENT, `/start ${token}`));
    expect(sentTexts(fake.calls).at(-1)).toContain("ссылка недействительна");
  });
});

describe("отказы", () => {
  it("истекла, отменена, использована повторно, переслана другому: один и тот же текст", async () => {
    const { teacher, linkId, token } = await setup();
    const fake = bot();
    const invalid = "Эта ссылка недействительна. Попросите у преподавателя новую.";

    await fake.bot.handleUpdate(textUpdate(STUDENT, "/start несуществующий"));
    expect(sentTexts(fake.calls).at(-1)).toBe(invalid);

    // Отменена.
    await linking.revokeInvitation({ teacherUserId: teacher.id, linkId });
    await fake.bot.handleUpdate(textUpdate(STUDENT, `/start ${token}`));
    expect(sentTexts(fake.calls).at(-1)).toBe(invalid);

    // Истекла.
    const expired = await linking.issueInvitation({ teacherUserId: teacher.id, linkId });
    await db.update(invitations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invitations.status, "pending"));
    await fake.bot.handleUpdate(textUpdate(STUDENT, `/start ${expired.token}`));
    expect(sentTexts(fake.calls).at(-1)).toBe(invalid);

    // Использована и переслана другому: тот не узнаёт, чья заявка.
    const used = await linking.issueInvitation({ teacherUserId: teacher.id, linkId });
    await joinThroughBot(fake, STUDENT, used.token);
    await fake.bot.handleUpdate(textUpdate(OTHER, `/start ${used.token}`));
    expect(sentTexts(fake.calls).at(-1)).toBe(invalid);
    await fake.bot.handleUpdate(callbackUpdate(OTHER, joinButton(used.token)));
    expect(sentTexts(fake.calls).at(-1)).toBe(invalid);

    // Подтверждена и открыта снова.
    const code = await linking.reissueCode({ userId: (await db.select().from(users).where(eq(users.telegramId, STUDENT)))[0]!.id });
    if (code.kind !== "issued") throw new Error("Код не выпущен");
    await linking.approveRequest({ teacherUserId: teacher.id, linkId, code: code.code });
    await fake.bot.handleUpdate(textUpdate(STUDENT, `/start ${used.token}`));
    expect(sentTexts(fake.calls).at(-1)).toBe(invalid);
    expectNoLeak(sentTexts(fake.calls));
  });

  it("аккаунт преподавателя: отказ и на Start, и на кнопке", async () => {
    const { token, linkId } = await setup();
    await makeTeacher(db, OTHER);
    const fake = bot();
    await fake.bot.handleUpdate(textUpdate(OTHER, `/start ${token}`));
    expect(sentTexts(fake.calls).at(-1)).toContain("преподавательский");
    await fake.bot.handleUpdate(callbackUpdate(OTHER, joinButton(token)));
    expect(sentTexts(fake.calls).at(-1)).toContain("преподавательский");
    await fake.bot.handleUpdate(textUpdate(OTHER, "/start"));
    expect(sentTexts(fake.calls).at(-1)).toContain("преподавательский");
    expect((await getLink(db, linkId)).status).toBe("pending_connection");
  });

  it("привязанный ученик и ссылка другого преподавателя: отказ", async () => {
    const { teacher, linkId, token } = await setup();
    const fake = bot();
    const code = await joinThroughBot(fake, STUDENT, token);
    await linking.approveRequest({ teacherUserId: teacher.id, linkId, code });

    const teacherB = await makeTeacher(db, 9002, "Борис");
    const b = await linking.createStudent({ teacherUserId: teacherB.id, displayName: "Другой" });
    await fake.bot.handleUpdate(textUpdate(STUDENT, `/start ${b.invitation.token}`));
    expect(sentTexts(fake.calls).at(-1)).toContain("прежний преподаватель должен сначала убрать");
    expect(sentTexts(fake.calls).at(-1)).not.toContain("Борис");
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, joinButton(b.invitation.token)));
    expect(sentTexts(fake.calls).at(-1)).toContain("прежний преподаватель должен сначала убрать");
    expect((await getLink(db, b.linkId)).status).toBe("pending_connection");
  });

  it("заявка к А и ссылка Б: вопрос и согласие", async () => {
    const { linkId, token } = await setup();
    const fake = bot();
    await joinThroughBot(fake, STUDENT, token);
    const teacherB = await makeTeacher(db, 9002, "Борис");
    const b = await linking.createStudent({ teacherUserId: teacherB.id, displayName: "Другой" });

    await fake.bot.handleUpdate(textUpdate(STUDENT, `/start ${b.invitation.token}`));
    expect(sentTexts(fake.calls).at(-1)).toContain("Перейти к преподавателю Борис");
    expect(sentTexts(fake.calls).at(-1)).not.toContain("Мария");
    const buttons = lastButtons(fake.calls);
    expect(buttons.map((button) => button.text)).toEqual(["Перейти", "Оставить прежнюю"]);

    // «Оставить прежнюю» ничего не меняет.
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, DECLINE_JOIN));
    expect((await getLink(db, linkId)).status).toBe("pending_confirmation");

    await fake.bot.handleUpdate(callbackUpdate(STUDENT, buttons[0]!.callback_data));
    expect(codeFrom(sentTexts(fake.calls).at(-1))).toMatch(/^\d{6}$/);
    expect(await getLink(db, linkId)).toMatchObject({ status: "pending_connection", studentUserId: null });
    expect((await getLink(db, b.linkId)).status).toBe("pending_confirmation");
    const active = await db.select().from(invitations).where(eq(invitations.status, "awaiting_teacher"));
    expect(active).toHaveLength(1);
  });

  it("подделанная кнопка без действующего токена ничего не даёт", async () => {
    await setup();
    const fake = bot();
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, joinButton("x".repeat(43))));
    expect(sentTexts(fake.calls).at(-1)).toContain("ссылка недействительна");
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, MENU));
    expect(sentTexts(fake.calls).at(-1)).toContain("попросите у преподавателя");
  });

  it("в группе ссылка и кнопки не обрабатываются: код не попадёт в общий чат", async () => {
    const { token } = await setup();
    const fake = bot();
    const update = textUpdate(STUDENT, `/start ${token}`);
    update.message!.chat = { id: -100, type: "group", title: "Группа" };
    await fake.bot.handleUpdate(update);
    expect(sentTexts(fake.calls).join(" ")).not.toContain("Мария");
    const [invitation] = await db.select().from(invitations);
    expect(invitation?.openedByTelegramId).toBeNull();
  });
});

describe("после подключения и после отвязки", () => {
  it("подключён: Start ведёт к меню; отвязан без копий: понятное сообщение, новая ссылка работает", async () => {
    const { teacher, linkId, token } = await setup();
    const fake = bot();
    const code = await joinThroughBot(fake, STUDENT, token);
    await linking.approveRequest({ teacherUserId: teacher.id, linkId, code });

    await fake.bot.handleUpdate(textUpdate(STUDENT, "/start"));
    expect(sentTexts(fake.calls).at(-1)).toContain("Выберите раздел");
    expect(lastButtons(fake.calls).map((button) => button.text)).toContain("Все слова");

    await linking.unlinkStudent({ teacherUserId: teacher.id, linkId });
    await fake.bot.handleUpdate(textUpdate(STUDENT, "/start"));
    expect(sentTexts(fake.calls).at(-1)).toContain("больше не ведёт");
    expect(sentTexts(fake.calls).at(-1)).toContain("персональную ссылку");
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, collectionsPage(0)));
    expect(sentTexts(fake.calls).at(-1)).toContain("персональную ссылку");

    const again = await linking.createStudent({ teacherUserId: teacher.id, displayName: "Снова" });
    await fake.bot.handleUpdate(textUpdate(STUDENT, `/start ${again.invitation.token}`));
    expect(sentTexts(fake.calls).at(-1)).toContain("приглашает");
  });
});

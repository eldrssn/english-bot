// Команда для разработки: готовый ученик с тремя подборками и сброс прогресса.
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { loadFixtureCollections } from "../../src/db/fixtures.js";
import { issueFixtureCollection } from "../../src/learning/issue.js";
import { createLearningService } from "../../src/learning/service.js";
import {
  attempts,
  cardViews,
  notifications,
  sessions,
  sourceCards,
  sourceCollections,
  studentCollections,
  studentLinks,
  studentWords,
  users,
} from "../../src/db/schema.js";
import { PrepareStudentError, prepareDevStudent } from "../../src/dev/prepare-student.js";
import { createSeededRng } from "../../src/domain/learning/index.js";
import { runReminderTick } from "../../src/notifications/reminders.js";
import { openTestDb, resetDb } from "../helpers/db.js";
import { TEST_APP_SECRET } from "../helpers/fake-telegram.js";
import { createFakeBot } from "../helpers/fake-telegram.js";
import { answer, connectStudent, startThroughMenu } from "../helpers/learning.js";
import { makeTeacher, reasons, seededCollectionId } from "../helpers/linking.js";

const { db, close } = openTestDb();
afterAll(close);
beforeEach(() => resetDb(db));

const TEACHER = 81001;
const STUDENT = 81002;
const fixtures = await loadFixtureCollections();
const prepare = (overrides: Partial<Parameters<typeof prepareDevStudent>[1]> = {}) =>
  prepareDevStudent(db, {
    appSecret: TEST_APP_SECRET,
    teacherTelegramId: TEACHER,
    studentTelegramId: STUDENT,
    fixtures,
    ...overrides,
  });

/** Настоящий путь в боте: открыть подборку (просмотры), начать тест и ошибиться. */
async function practice() {
  const fake = createFakeBot(db);
  const [collection] = await db.select().from(studentCollections).orderBy(studentCollections.id);
  await startThroughMenu(fake, STUDENT, collection!.id);
  await answer(fake, db, STUDENT, false);
}

const studentId = async () => (await db.select().from(users).where(eq(users.telegramId, STUDENT)))[0]!.id;

describe("dev:prepare-student", () => {
  it("новый аккаунт: обычная привязка, все подборки и уведомления", async () => {
    const result = await prepare();

    expect(result.link).toBe("created");
    expect(result.collections.map((c) => c.title).sort()).toEqual(fixtures.map((f) => f.title).sort());
    expect(result.collections.every((c) => c.created)).toBe(true);

    const [link] = await db.select().from(studentLinks).where(eq(studentLinks.id, result.linkId));
    expect(link?.status).toBe("active");
    const [teacher] = await db.select().from(users).where(eq(users.telegramId, TEACHER));
    expect(teacher?.role).toBe("teacher");
    expect(link?.teacherUserId).toBe(teacher?.id);

    const id = await studentId();
    const [student] = await db.select().from(users).where(eq(users.id, id));
    expect(student?.role).toBe("student");
    const notified = await reasons(db, id);
    expect(notified).toContain("link_confirmed");
    expect(notified.filter((r) => r === "new_collection")).toHaveLength(fixtures.length);
    // Слова привязаны к ученику: материалы видны в боте.
    expect((await db.select().from(studentWords).where(eq(studentWords.studentUserId, id))).length).toBeGreaterThan(0);
  });

  it("повторный запуск не создаёт дублей и использует существующую связь", async () => {
    const first = await prepare();
    const second = await prepare();

    expect(second.link).toBe("existing");
    expect(second.linkId).toBe(first.linkId);
    expect(second.collections.every((c) => !c.created)).toBe(true);
    expect(await db.select().from(studentCollections)).toHaveLength(fixtures.length);
    expect((await reasons(db, await studentId())).filter((r) => r === "new_collection")).toHaveLength(fixtures.length);
  });

  it("уже подключённый ученик другого преподавателя получает подборки в своей связи", async () => {
    const { link } = await connectStudent(db, STUDENT);
    const result = await prepare();

    expect(result.link).toBe("existing");
    expect(result.linkId).toBe(link.id);
    expect(await db.select().from(studentLinks)).toHaveLength(1);
  });

  it("--reset удаляет занятия, ответы и просмотры и возвращает слова в начальное состояние", async () => {
    await prepare();
    const id = await studentId();
    await practice();
    expect((await db.select().from(attempts)).length).toBeGreaterThan(0);
    expect((await db.select().from(cardViews)).length).toBeGreaterThan(0);

    const result = await prepare({ resetProgress: true });

    expect(result.resetSessions).toBeGreaterThan(0);
    expect(await db.select().from(sessions).where(eq(sessions.studentUserId, id))).toHaveLength(0);
    expect(await db.select().from(attempts)).toHaveLength(0);
    expect(await db.select().from(cardViews)).toHaveLength(0);
    const words = await db.select().from(studentWords).where(eq(studentWords.studentUserId, id));
    expect(words.every((w) => w.status === "learning" && w.correctStreak === 0 && w.lastCountedSessionId === null)).toBe(true);
    const collections = await db.select().from(studentCollections);
    expect(collections.every((c) => c.status === "assigned")).toBe(true);
  });

  it("--hard отмечает слова сложными после сброса: они в списке «Сложные слова», у первого серия 4 из 5", async () => {
    await prepare();
    await practice();
    const result = await prepare({ resetProgress: true, hardWords: 3 });
    expect(result.hardWords).toHaveLength(3);
    expect(result.hardWords.map((word) => word.correctStreak)).toEqual([4, 0, 0]);
    const id = await studentId();
    const hard = await db.select().from(studentWords).where(eq(studentWords.studentUserId, id));
    expect(hard.filter((word) => word.status === "hard")).toHaveLength(3);
    const screen = await createLearningService(db).openHardWords(id);
    expect(screen.words.map((word) => word.english)).toEqual(result.hardWords.map((word) => word.english));
    // Повторный запуск добавляет следующие слова, а не переписывает уже сложные.
    const again = await prepare({ hardWords: 1 });
    expect(result.hardWords.map((word) => word.english)).not.toContain(again.hardWords[0]!.english);
  });

  it("--tz задаёт часовой пояс, неизвестный пояс — отказ без изменений", async () => {
    expect((await prepare({ timezone: "Asia/Yekaterinburg" })).timezone).toBe("Asia/Yekaterinburg");
    await expect(prepare({ timezone: "Mars/Olympus" })).rejects.toBeInstanceOf(PrepareStudentError);
    expect((await db.select().from(users).where(eq(users.telegramId, STUDENT)))[0]!.timezone).toBe("Asia/Yekaterinburg");
  });

  it("--remind: время — текущая минута по поясу, планировщик сразу создаёт квест и одно напоминание; повтор команды шлёт его снова", async () => {
    const now = new Date("2026-11-24T10:17:30Z");
    const result = await prepare({ remindNow: true, now });
    expect(result.timezone).toBe("Europe/Moscow");
    expect(result.reminder).toEqual({ reminderTime: "13:17", localDate: "2026-11-24", questCompletedToday: false });
    const user = (await db.select().from(users).where(eq(users.telegramId, STUDENT)))[0]!;
    expect(user).toMatchObject({ reminderTime: "13:17:00", remindersEnabled: true, botBlockedAt: null });

    const tick = () => runReminderTick(db, { now, rng: createSeededRng(1) });
    expect(await tick()).toMatchObject({ reminded: 1, questsCreated: 1 });
    expect(await tick()).toMatchObject({ reminded: 0, questsCreated: 0 });
    await prepare({ remindNow: true, now });
    expect(await tick()).toMatchObject({ reminded: 1, questsCreated: 0 });
    const reminders = await db.select().from(notifications).where(eq(notifications.reason, "daily_reminder"));
    expect(reminders).toHaveLength(1);
    expect(await db.select().from(sessions).where(eq(sessions.type, "daily_quest"))).toHaveLength(1);

    // --reset удаляет квест и его напоминание.
    await prepare({ resetProgress: true });
    expect(await db.select().from(notifications).where(eq(notifications.reason, "daily_reminder"))).toHaveLength(0);
    expect(await db.select().from(sessions)).toHaveLength(0);
  });

  it("без --reset прогресс не трогается", async () => {
    await prepare();
    await practice();
    const before = (await db.select().from(attempts)).length;

    const result = await prepare();

    expect(result.resetSessions).toBeNull();
    expect(await db.select().from(attempts)).toHaveLength(before);
  });

  it("отказывает, если аккаунт ученика — преподаватель", async () => {
    await makeTeacher(db, STUDENT);
    await expect(prepare()).rejects.toBeInstanceOf(PrepareStudentError);
  });

  it("отказывает, если ученик и преподаватель — один аккаунт", async () => {
    await expect(prepare({ studentTelegramId: TEACHER })).rejects.toBeInstanceOf(PrepareStudentError);
  });

  it("тестовые подборки — собственные подборки преподавателя, копии выданы из них; повтор и правки в кабинете не перезаписываются", async () => {
    const result = await prepare();
    const [teacher] = await db.select().from(users).where(eq(users.telegramId, TEACHER));
    const own = await db.select().from(sourceCollections).where(eq(sourceCollections.teacherUserId, teacher!.id));
    expect(own.map((c) => c.title).sort()).toEqual(fixtures.map((f) => f.title).sort());
    expect(result.teacherCollections.every((c) => c.created)).toBe(true);
    expect(result.collections.every((c) => c.source === "own")).toBe(true);
    const copies = await db.select().from(studentCollections);
    expect(new Set(copies.map((c) => c.sourceCollectionId))).toEqual(new Set(own.map((c) => c.id)));
    const cardCount = fixtures.reduce((sum, f) => sum + f.cards.length, 0);
    expect(await db.select().from(sourceCards)).toHaveLength(cardCount);

    // Преподаватель поправил подборку в кабинете: повторный запуск её не трогает и новых не создаёт.
    await db.update(sourceCards).set({ example: "моя правка" }).where(eq(sourceCards.collectionId, own[0]!.id));
    const second = await prepare();
    expect(second.teacherCollections.every((c) => !c.created)).toBe(true);
    expect(await db.select().from(sourceCollections)).toHaveLength(fixtures.length);
    const edited = await db.select().from(sourceCards).where(eq(sourceCards.collectionId, own[0]!.id));
    expect(edited.every((c) => c.example === "моя правка")).toBe(true);
    expect(await db.select().from(studentCollections)).toHaveLength(fixtures.length);
  });

  it("прежние копии от служебного преподавателя остаются; вторая копия с тем же названием не выдаётся", async () => {
    const first = await prepare();
    // Состояние до этапа 4: вместо копии собственной подборки у ученика копия служебной.
    const { seedTeacherId } = await seededCollectionId(db, fixtures);
    const [title] = fixtures.map((f) => f.title);
    const [ownCopy] = await db
      .select()
      .from(studentCollections)
      .where(eq(studentCollections.title, title!));
    await db.update(studentCollections).set({ deletedAt: new Date() }).where(eq(studentCollections.id, ownCopy!.id));
    const seeded = await issueFixtureCollection(db, { studentLinkId: first.linkId, title: title!, fixtures });

    const again = await prepare();
    expect(again.collections.find((c) => c.title === title)).toMatchObject({ created: false, source: "seed" });
    expect(again.collections.filter((c) => c.title !== title).every((c) => c.source === "own" && !c.created)).toBe(true);
    const live = (await db.select().from(studentCollections)).filter((c) => c.deletedAt === null);
    expect(live).toHaveLength(fixtures.length);
    const [seedCopy] = await db.select().from(studentCollections).where(eq(studentCollections.id, seeded.studentCollectionId));
    expect(seedCopy).toMatchObject({ deletedAt: null });
    const [seedSource] = await db.select().from(sourceCollections).where(eq(sourceCollections.id, seedCopy!.sourceCollectionId));
    expect(seedSource!.teacherUserId).toBe(seedTeacherId);
  });

  it("ученик другого преподавателя: подборки этого преподавателя ему не выдаются, остаётся служебная выдача", async () => {
    await connectStudent(db, STUDENT);
    const result = await prepare();
    expect(result.collections.every((c) => c.source === "seed" && c.created)).toBe(true);
  });
});

import { and, eq } from "drizzle-orm";
import type { Db } from "../../src/db/client.js";
import { issueCollectionCopy } from "../../src/db/collections.js";
import { BASIC_COLLECTION_TITLE, SEED_TEACHER_TELEGRAM_ID, loadFixtureCollections, seedFixtures, type FixtureCollection } from "../../src/db/fixtures.js";
import { notifications, sourceCollections, studentLinks, users } from "../../src/db/schema.js";
import { createLinkingService } from "../../src/linking/service.js";
import { TEST_APP_SECRET, callbackUpdate, lastButtons, sentTexts, textUpdate, type createFakeBot } from "./fake-telegram.js";

export const linkingFor = (db: Db) => createLinkingService(db, TEST_APP_SECRET);

export async function makeUser(db: Db, telegramId: number, role: "teacher" | "student" | null = null, firstName = `Пользователь ${telegramId}`) {
  const [user] = await db.insert(users).values({ telegramId, role, telegramFirstName: firstName }).returning();
  return user!;
}

export const makeTeacher = (db: Db, telegramId: number, firstName = `Преподаватель ${telegramId}`) =>
  makeUser(db, telegramId, "teacher", firstName);

export async function reasons(db: Db, recipientUserId: number) {
  const rows = await db.select().from(notifications).where(eq(notifications.recipientUserId, recipientUserId)).orderBy(notifications.id);
  return rows.map((row) => row.reason);
}

export const getLink = async (db: Db, id: number) =>
  (await db.select().from(studentLinks).where(eq(studentLinks.id, id)))[0]!;

/** Подборка тестовых данных: материал служебного преподавателя. */
export async function seededCollectionId(db: Db, fixtures?: FixtureCollection[]) {
  const title = BASIC_COLLECTION_TITLE;
  await seedFixtures(db, fixtures ?? (await loadFixtureCollections()));
  const [teacher] = await db.select().from(users).where(eq(users.telegramId, SEED_TEACHER_TELEGRAM_ID));
  const [collection] = await db
    .select()
    .from(sourceCollections)
    .where(and(eq(sourceCollections.teacherUserId, teacher!.id), eq(sourceCollections.title, title)));
  return { collectionId: collection!.id, seedTeacherId: teacher!.id };
}

/** Активная связь напрямую в базе: для тестов, где путь подключения не важен. */
export async function connectDirectly(db: Db, teacherUserId: number, telegramId: number, sourceCollectionId?: number) {
  const [student] = await db
    .insert(users)
    .values({ telegramId, role: "student", telegramFirstName: "Анна" })
    .onConflictDoUpdate({ target: users.telegramId, set: { role: "student" } })
    .returning();
  const [link] = await db
    .insert(studentLinks)
    .values({ teacherUserId, studentUserId: student!.id, displayName: "Ученик", status: "active", startedAt: new Date() })
    .returning();
  if (sourceCollectionId) await issueCollectionCopy(db, { studentLinkId: link!.id, sourceCollectionId });
  return { student: student!, link: link! };
}

type FakeBot = ReturnType<typeof createFakeBot>;

export function codeFrom(text: string | undefined): string {
  const match = text?.match(/\b(\d{6})\b/);
  if (!match) throw new Error(`В сообщении нет кода: ${text}`);
  return match[1]!;
}

/** Ученик открывает ссылку и подтверждает присоединение через бота. Возвращает код. */
export async function joinThroughBot({ bot, calls }: FakeBot, telegramId: number, token: string) {
  await bot.handleUpdate(textUpdate(telegramId, `/start ${token}`));
  await bot.handleUpdate(callbackUpdate(telegramId, lastButtons(calls)[0]!.callback_data));
  return codeFrom(sentTexts(calls).at(-1));
}

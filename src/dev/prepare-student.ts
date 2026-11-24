// Только для разработки: готовит ученика к проверке со стороны бота.
// Подключает Telegram-аккаунт к преподавателю тем же путём, что и настоящая привязка (ссылка, заявка, код),
// заводит тестовые подборки как собственные подборки преподавателя для разработки (их можно править и выдавать
// в кабинете), выдаёт их ученику обычной выдачей и по желанию сбрасывает прогресс, чтобы пройти обучение заново.
import { and, eq, inArray, isNull } from "drizzle-orm";
import { setTeacherRole } from "../admin/roles.js";
import type { Db } from "../db/client.js";
import type { FixtureCollection } from "../db/fixtures.js";
import {
  attempts,
  cardViews,
  questions,
  sessions,
  sourceCards,
  sourceCollections,
  studentCards,
  studentCollections,
  studentLinks,
  studentWords,
  users,
} from "../db/schema.js";
import { issueFixtureCollection } from "../learning/issue.js";
import { createLinkingService } from "../linking/service.js";
import { createIssueService } from "../materials/issue.js";

export class PrepareStudentError extends Error {
  override name = "PrepareStudentError";
}

export type PrepareStudentInput = {
  appSecret: string;
  /** Преподаватель для разработки: тот, под кем выполняется вход в кабинет. */
  teacherTelegramId: number;
  studentTelegramId: number;
  /** Имя ученика в кабинете, если связь создаётся заново. */
  displayName?: string;
  fixtures: FixtureCollection[];
  /** Удалить занятия, ответы и просмотры ученика и вернуть слова в начальное состояние. */
  resetProgress?: boolean;
};

export type PrepareStudentResult = {
  linkId: number;
  /** created: связь создана сейчас; existing: уже была активной. */
  link: "created" | "existing";
  teacherTelegramId: number;
  /**
   * created — копия выдана сейчас. source — откуда копия: own — из собственной подборки преподавателя,
   * seed — из служебных тестовых данных (прежняя копия или ученик подключён к другому преподавателю).
   * Если у ученика уже есть копия с тем же названием (в том числе прежняя, от служебного преподавателя),
   * вторая не выдаётся, чтобы в боте не было двух одинаковых подборок.
   */
  collections: { title: string; created: boolean; source: "own" | "seed" }[];
  /** Собственные подборки преподавателя: созданы сейчас или уже были (поиск по названию). */
  teacherCollections: { title: string; id: number; created: boolean }[];
  /** Сколько занятий удалено при сбросе. null: сброс не запрашивался. */
  resetSessions: number | null;
};

export async function prepareDevStudent(db: Db, input: PrepareStudentInput): Promise<PrepareStudentResult> {
  if (input.teacherTelegramId === input.studentTelegramId) {
    throw new PrepareStudentError("Аккаунт ученика совпадает с преподавателем: один аккаунт имеет одну роль");
  }
  if (input.fixtures.length === 0) throw new PrepareStudentError("Нет тестовых подборок в папке fixtures");

  const teacherRole = await setTeacherRole(db, { telegramId: input.teacherTelegramId, actor: "dev:prepare-student" });
  if (teacherRole.kind === "student_has_open_link") {
    throw new PrepareStudentError(`Telegram ID ${input.teacherTelegramId} занят учеником и не может быть преподавателем`);
  }
  const teacherUserId = teacherRole.userId;

  await db
    .insert(users)
    .values({ telegramId: input.studentTelegramId, telegramFirstName: input.displayName ?? "Ученик" })
    .onConflictDoNothing({ target: users.telegramId });
  const [student] = await db.select().from(users).where(eq(users.telegramId, input.studentTelegramId));
  if (!student) throw new Error("Ученик не найден сразу после вставки");
  if (student.role === "teacher") {
    throw new PrepareStudentError(`Telegram ID ${input.studentTelegramId} — преподаватель, учеником он быть не может`);
  }

  const { linkId, link, teacherTelegramId } = await ensureActiveLink(db, input, student.id, teacherUserId);

  const [linkRow] = await db.select().from(studentLinks).where(eq(studentLinks.id, linkId));
  const ownTeacher = linkRow?.teacherUserId === teacherUserId;
  const teacherCollections = await ensureTeacherCollections(db, teacherUserId, input.fixtures);
  const issuing = createIssueService(db);

  const collections: PrepareStudentResult["collections"] = [];
  /** Действующие копии записи: название → исходная подборка. */
  const liveCopies = async () =>
    new Map(
      (
        await db
          .select({ title: studentCollections.title, sourceId: studentCollections.sourceCollectionId })
          .from(studentCollections)
          .where(and(eq(studentCollections.studentLinkId, linkId), isNull(studentCollections.deletedAt)))
      ).map((row) => [row.title, row.sourceId]),
    );
  for (const fixture of input.fixtures) {
    if (!ownTeacher) {
      // Чужому ученику подборки этого преподавателя выдать нельзя: остаётся служебная выдача из тестовых данных.
      const issued = await issueFixtureCollection(db, { studentLinkId: linkId, title: fixture.title, fixtures: input.fixtures });
      collections.push({ title: fixture.title, created: issued.created, source: "seed" });
      continue;
    }
    const source = teacherCollections.find((collection) => collection.title === fixture.title)!;
    const existingSource = (await liveCopies()).get(fixture.title);
    if (existingSource !== undefined) {
      collections.push({ title: fixture.title, created: false, source: existingSource === source.id ? "own" : "seed" });
      continue;
    }
    const { results } = await issuing.issue(teacherUserId, source.id, [linkId]);
    collections.push({ title: fixture.title, created: results[0]?.outcome !== "already_issued", source: "own" });
  }

  const resetSessions = input.resetProgress ? await resetStudentProgress(db, student.id) : null;
  return { linkId, link, teacherTelegramId, collections, teacherCollections, resetSessions };
}

/**
 * Тестовые подборки как собственные подборки преподавателя. Поиск по названию среди действующих:
 * повторный запуск ничего не создаёт и не перезаписывает правки, сделанные в кабинете.
 */
async function ensureTeacherCollections(db: Db, teacherUserId: number, fixtures: FixtureCollection[]) {
  return db.transaction(async (tx) => {
    // Блокировка преподавателя: два одновременных запуска не создадут подборку дважды.
    await tx.select({ id: users.id }).from(users).where(eq(users.id, teacherUserId)).for("update");
    const result: PrepareStudentResult["teacherCollections"] = [];
    for (const fixture of fixtures) {
      const [existing] = await tx
        .select({ id: sourceCollections.id })
        .from(sourceCollections)
        .where(
          and(
            eq(sourceCollections.teacherUserId, teacherUserId),
            eq(sourceCollections.title, fixture.title),
            isNull(sourceCollections.deletedAt),
          ),
        )
        .orderBy(sourceCollections.id)
        .limit(1);
      if (existing) {
        result.push({ title: fixture.title, id: existing.id, created: false });
        continue;
      }
      const [created] = await tx
        .insert(sourceCollections)
        .values({ teacherUserId, title: fixture.title })
        .returning({ id: sourceCollections.id });
      if (!created) throw new Error("Подборка не создана");
      await tx.insert(sourceCards).values(
        fixture.cards.map((card, position) => ({
          collectionId: created.id,
          position,
          english: card.english,
          primaryTranslation: card.translation,
          acceptedRuEn: card.acceptedRuEn,
          acceptedEnRu: card.acceptedEnRu,
          example: card.example,
          explanation: card.explanation,
          allowOmitTo: card.allowOmitTo,
        })),
      );
      result.push({ title: fixture.title, id: created.id, created: true });
    }
    return result;
  });
}

async function ensureActiveLink(db: Db, input: PrepareStudentInput, studentUserId: number, teacherUserId: number) {
  const [active] = await db
    .select({ id: studentLinks.id, teacherTelegramId: users.telegramId })
    .from(studentLinks)
    .innerJoin(users, eq(users.id, studentLinks.teacherUserId))
    .where(and(eq(studentLinks.studentUserId, studentUserId), eq(studentLinks.status, "active")));
  if (active) {
    return { linkId: active.id, link: "existing" as const, teacherTelegramId: active.teacherTelegramId };
  }

  // Новая связь проходит обычный путь: запись ученика, ссылка, согласие ученика, код преподавателя.
  const linking = createLinkingService(db, input.appSecret);
  const created = await linking.createStudent({ teacherUserId, displayName: input.displayName ?? "Тестовый ученик" });
  const joined = await linking.confirmJoin({ userId: studentUserId, token: created.invitation.token, allowSwitch: true });
  if (joined.kind !== "joined") {
    throw new PrepareStudentError(`Ученик не смог подать заявку: ${joined.kind}`);
  }
  const approved = await linking.approveRequest({ teacherUserId, linkId: created.linkId, code: joined.code });
  if (approved.kind !== "approved") {
    throw new PrepareStudentError(`Заявка не подтверждена: ${approved.kind}`);
  }
  return { linkId: created.linkId, link: "created" as const, teacherTelegramId: input.teacherTelegramId };
}

/** Удаляет занятия, ответы и просмотры ученика; слова и подборки возвращаются в начальное состояние. */
async function resetStudentProgress(db: Db, studentUserId: number): Promise<number> {
  return db.transaction(async (tx) => {
    const ownSessions = await tx
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.studentUserId, studentUserId));
    const sessionIds = ownSessions.map((row) => row.id);

    await tx
      .update(studentWords)
      .set({
        status: "learning",
        correctStreak: 0,
        consecutiveErrors: 0,
        lastCountedSessionId: null,
        hardSince: null,
        masteredAt: null,
      })
      .where(eq(studentWords.studentUserId, studentUserId));

    if (sessionIds.length > 0) {
      const ownQuestions = tx.select({ id: questions.id }).from(questions).where(inArray(questions.sessionId, sessionIds));
      await tx.delete(attempts).where(inArray(attempts.questionId, ownQuestions));
      await tx.delete(questions).where(inArray(questions.sessionId, sessionIds));
      await tx.delete(sessions).where(inArray(sessions.id, sessionIds));
    }

    const ownCollections = tx
      .select({ id: studentCollections.id })
      .from(studentCollections)
      .innerJoin(studentLinks, eq(studentLinks.id, studentCollections.studentLinkId))
      .where(eq(studentLinks.studentUserId, studentUserId));
    const ownCards = tx
      .select({ id: studentCards.id })
      .from(studentCards)
      .where(inArray(studentCards.studentCollectionId, ownCollections));
    await tx.delete(cardViews).where(inArray(cardViews.studentCardId, ownCards));
    await tx
      .update(studentCollections)
      .set({ status: "assigned" })
      .where(and(inArray(studentCollections.id, ownCollections), isNull(studentCollections.deletedAt)));

    return sessionIds.length;
  });
}

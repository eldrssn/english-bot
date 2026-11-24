import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  adminAuditLog,
  attempts,
  cardVersions,
  invitations,
  notifications,
  processedUpdates,
  questions,
  sessions,
  sourceCollections,
  studentCards,
  studentCollections,
  studentLinks,
  studentWords,
  users,
  webSessions,
} from "../src/db/schema.js";
import { expectConstraintViolation, openTestDb, resetDb } from "./helpers/db.js";

const { db, close } = openTestDb();
beforeEach(() => resetDb(db));
afterAll(close);

let telegramId = 1000;
async function makeUser(role: "teacher" | "student" | null = "student") {
  const [user] = await db.insert(users).values({ telegramId: telegramId++, role }).returning();
  return user!;
}

async function makeActiveLink(teacherId: number, studentId: number) {
  const [link] = await db
    .insert(studentLinks)
    .values({
      teacherUserId: teacherId,
      studentUserId: studentId,
      displayName: "Анна",
      status: "active",
      startedAt: new Date(),
    })
    .returning();
  return link!;
}

async function makeQuestion() {
  const teacher = await makeUser("teacher");
  const student = await makeUser();
  const link = await makeActiveLink(teacher.id, student.id);
  const [source] = await db.insert(sourceCollections).values({ teacherUserId: teacher.id, title: "Подборка" }).returning();
  const [copy] = await db
    .insert(studentCollections)
    .values({ studentLinkId: link.id, sourceCollectionId: source!.id, title: "Подборка" })
    .returning();
  const [word] = await db
    .insert(studentWords)
    .values({ studentUserId: student.id, normalizedEnglish: "fast", normalizedTranslation: "быстрый" })
    .returning();
  const [card] = await db
    .insert(studentCards)
    .values({ studentCollectionId: copy!.id, studentWordId: word!.id, position: 0 })
    .returning();
  const [version] = await db
    .insert(cardVersions)
    .values({ studentCardId: card!.id, versionNumber: 1, english: "fast", primaryTranslation: "быстрый" })
    .returning();
  const [session] = await db
    .insert(sessions)
    .values({ studentUserId: student.id, studentLinkId: link.id, type: "test" })
    .returning();
  const [question] = await db
    .insert(questions)
    .values({
      sessionId: session!.id,
      position: 0,
      studentWordId: word!.id,
      cardVersionId: version!.id,
      direction: "en_ru",
      format: "typed",
    })
    .returning();
  return { teacher, student, link, copy: copy!, card: card!, version: version!, session: session!, question: question! };
}

describe("вопрос и попытка", () => {
  it("(вопрос, номер попытки) уникальны, вторая попытка допустима", async () => {
    const { question, link } = await makeQuestion();
    const base = { questionId: question.id, studentLinkId: link.id, answerText: "x", isCorrect: false };
    await db.insert(attempts).values({ ...base, attemptNumber: 1 });
    await expectConstraintViolation(
      db.insert(attempts).values({ ...base, attemptNumber: 1 }),
      "attempts_question_attempt_unique",
    );
    await db.insert(attempts).values({ ...base, attemptNumber: 2 });
  });

  it("третьей попытки нет", async () => {
    const { question } = await makeQuestion();
    await expectConstraintViolation(
      db.insert(attempts).values({ questionId: question.id, attemptNumber: 3, answerText: "x", isCorrect: false }),
      "attempts_number_range",
    );
  });

  it("попытка и занятие допускают пустую связь", async () => {
    const { question, student } = await makeQuestion();
    await db.insert(attempts).values({ questionId: question.id, attemptNumber: 1, answerText: "x", isCorrect: true });
    await db.insert(sessions).values({ studentUserId: student.id, type: "exam", status: "paused" });
  });

  it("вопрос с кнопками обязан иметь варианты", async () => {
    const { question } = await makeQuestion();
    await expectConstraintViolation(
      db.insert(questions).values({
        sessionId: question.sessionId,
        position: 1,
        studentWordId: question.studentWordId,
        cardVersionId: question.cardVersionId,
        direction: "ru_en",
        format: "choice",
      }),
      "questions_choice_has_options",
    );
  });

  it("позиция вопроса в занятии уникальна", async () => {
    const { question } = await makeQuestion();
    await expectConstraintViolation(
      db.insert(questions).values({
        sessionId: question.sessionId,
        position: 0,
        studentWordId: question.studentWordId,
        cardVersionId: question.cardVersionId,
        direction: "ru_en",
        format: "typed",
      }),
      "questions_session_position_unique",
    );
  });
});

describe("занятие", () => {
  it("значения demo в перечислении нет, цепочка миграций сохранила ограничения", async () => {
    const result = await db.execute(sql`SELECT enum_range(NULL::session_type)::text AS values`);
    expect(result.rows[0]?.values).toBe("{test,translate,hard_words,daily_quest,exam}");
  });

  it("у ученика одно текущее занятие, на паузе может быть сколько угодно", async () => {
    const student = await makeUser();
    const other = await makeUser();
    await db.insert(sessions).values({ studentUserId: student.id, type: "test" });
    await db.insert(sessions).values({ studentUserId: student.id, type: "exam", status: "paused" });
    await db.insert(sessions).values({ studentUserId: student.id, type: "exam", status: "paused" });
    await db.insert(sessions).values({ studentUserId: other.id, type: "test" });
    await expectConstraintViolation(
      db.insert(sessions).values({ studentUserId: student.id, type: "exam" }),
      "sessions_one_current_per_student",
    );
  });

  it("один квест на ученика и локальную дату", async () => {
    const student = await makeUser();
    const quest = { studentUserId: student.id, type: "daily_quest", status: "incomplete" } as const;
    await db.insert(sessions).values({ ...quest, questLocalDate: "2026-11-05" });
    await db.insert(sessions).values({ ...quest, questLocalDate: "2026-11-06" });
    await expectConstraintViolation(
      db.insert(sessions).values({ ...quest, questLocalDate: "2026-11-05" }),
      "sessions_one_quest_per_local_date",
    );
  });

  it("локальная дата есть у квеста и только у него", async () => {
    const student = await makeUser();
    await expectConstraintViolation(
      db.insert(sessions).values({ studentUserId: student.id, type: "daily_quest" }),
      "sessions_quest_date_only_for_quest",
    );
    await expectConstraintViolation(
      db.insert(sessions).values({ studentUserId: student.id, type: "test", questLocalDate: "2026-11-05" }),
      "sessions_quest_date_only_for_quest",
    );
  });
});

describe("связь", () => {
  it("запись ученика существует без Telegram-аккаунта, но связь без него не активна", async () => {
    const teacher = await makeUser("teacher");
    const [record] = await db.insert(studentLinks).values({ teacherUserId: teacher.id, displayName: "Пётр" }).returning();
    expect(record?.status).toBe("pending_connection");
    expect(record?.studentUserId).toBeNull();
    await expectConstraintViolation(
      db.insert(studentLinks).values({
        teacherUserId: teacher.id,
        displayName: "Пётр",
        status: "active",
        startedAt: new Date(),
      }),
      "student_links_account_matches_status",
    );
  });

  it("одна активная связь у ученика, новая возможна после завершения прежней", async () => {
    const teacherA = await makeUser("teacher");
    const teacherB = await makeUser("teacher");
    const student = await makeUser();
    const first = await makeActiveLink(teacherA.id, student.id);
    await expectConstraintViolation(makeActiveLink(teacherB.id, student.id), "student_links_one_active_per_student");

    await db
      .update(studentLinks)
      .set({ status: "ended", endedAt: new Date() })
      .where(eq(studentLinks.id, first.id));
    // Возврат к тому же преподавателю — новая запись.
    const second = await makeActiveLink(teacherA.id, student.id);
    expect(second.id).not.toBe(first.id);
  });

  it("завершённая связь обязана иметь дату окончания", async () => {
    const teacher = await makeUser("teacher");
    await expectConstraintViolation(
      db.insert(studentLinks).values({ teacherUserId: teacher.id, displayName: "Пётр", status: "ended" }),
      "student_links_dates_match_status",
    );
  });
});

describe("приглашение и заявка", () => {
  async function makeRecord() {
    const teacher = await makeUser("teacher");
    const [record] = await db.insert(studentLinks).values({ teacherUserId: teacher.id, displayName: "Пётр" }).returning();
    return record!;
  }
  const expiresAt = new Date("2030-01-01");

  it("одна активная заявка у ученика", async () => {
    const student = await makeUser();
    const a = await makeRecord();
    const b = await makeRecord();
    const request = { status: "awaiting_teacher", studentUserId: student.id, expiresAt } as const;
    await db.insert(invitations).values({ ...request, studentLinkId: a.id, tokenHash: "a" });
    await expectConstraintViolation(
      db.insert(invitations).values({ ...request, studentLinkId: b.id, tokenHash: "b" }),
      "invitations_one_active_request_per_student",
    );
    await db
      .insert(invitations)
      .values({ ...request, status: "withdrawn", studentLinkId: b.id, tokenHash: "c" });
  });

  it("у записи одна действующая ссылка, хэш токена уникален", async () => {
    const record = await makeRecord();
    const other = await makeRecord();
    await db.insert(invitations).values({ studentLinkId: record.id, tokenHash: "a", expiresAt });
    await expectConstraintViolation(
      db.insert(invitations).values({ studentLinkId: record.id, tokenHash: "b", expiresAt }),
      "invitations_one_live_per_link",
    );
    await expectConstraintViolation(
      db.insert(invitations).values({ studentLinkId: other.id, tokenHash: "a", expiresAt }),
      "invitations_token_hash_unique",
    );
  });

  it("заявка без ученика невозможна", async () => {
    const record = await makeRecord();
    await expectConstraintViolation(
      db.insert(invitations).values({ studentLinkId: record.id, tokenHash: "a", expiresAt, status: "awaiting_teacher" }),
      "invitations_request_has_student",
    );
  });
});

describe("слова, версии, копии", () => {
  it("слово уникально по ученику и нормализованной паре", async () => {
    const student = await makeUser();
    const other = await makeUser();
    const word = { normalizedEnglish: "bank", normalizedTranslation: "банк" };
    await db.insert(studentWords).values({ ...word, studentUserId: student.id });
    await db.insert(studentWords).values({ ...word, studentUserId: other.id });
    await db.insert(studentWords).values({ ...word, studentUserId: student.id, normalizedTranslation: "берег" });
    await expectConstraintViolation(
      db.insert(studentWords).values({ ...word, studentUserId: student.id }),
      "student_words_student_pair_unique",
    );
  });

  it("номер версии карточки уникален", async () => {
    const { card } = await makeQuestion();
    await expectConstraintViolation(
      db.insert(cardVersions).values({ studentCardId: card.id, versionNumber: 1, english: "a", primaryTranslation: "б" }),
      "card_versions_card_number_unique",
    );
  });

  it("повторная выдача не создаёт вторую копию и дубль карточки", async () => {
    const { copy, link, card } = await makeQuestion();
    await expectConstraintViolation(
      db.insert(studentCollections).values({
        studentLinkId: link.id,
        sourceCollectionId: copy.sourceCollectionId,
        title: "Ещё раз",
      }),
      "student_collections_one_copy_per_link",
    );
    expect(card.sourceCardId).toBeNull();
    // Карточки, добавленные прямо в копию, не считаются дублями друг друга.
    await db.insert(studentCards).values({ studentCollectionId: copy.id, position: 1 });
  });
});

describe("служебные таблицы", () => {
  it("ключ от повторов не даёт поставить уведомление дважды", async () => {
    const user = await makeUser();
    const item = { recipientUserId: user.id, reason: "new_collection", dedupeKey: "copy:1" } as const;
    await db.insert(notifications).values(item);
    await expectConstraintViolation(db.insert(notifications).values(item), "notifications_dedupe_key_unique");
  });

  it("update_id и Telegram ID уникальны", async () => {
    await db.insert(processedUpdates).values({ updateId: 7 });
    await expectConstraintViolation(db.insert(processedUpdates).values({ updateId: 7 }), "processed_updates_pkey");
    await db.insert(users).values({ telegramId: 77 });
    await expectConstraintViolation(db.insert(users).values({ telegramId: 77 }), "users_telegram_id_unique");
  });

  it("журнал администратора и сессия кабинета записываются", async () => {
    const teacher = await makeUser("teacher");
    await db.insert(adminAuditLog).values({ actor: "admin", targetUserId: teacher.id, oldRole: null, newRole: "teacher" });
    const session = { userId: teacher.id, tokenHash: "t", csrfTokenHash: "c", expiresAt: new Date("2030-01-01") };
    await db.insert(webSessions).values(session);
    await expectConstraintViolation(db.insert(webSessions).values(session), "web_sessions_token_hash_unique");
  });

  it("значения по умолчанию пользователя: 19:00, напоминания включены, пояс и роль пусты", async () => {
    const user = await makeUser(null);
    expect(user).toMatchObject({ reminderTime: "19:00:00", remindersEnabled: true, timezone: null, role: null });
  });
});

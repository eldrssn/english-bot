// Полная схема данных из раздела 6 плана. Этот файл импортирует из проекта только типы: его читает drizzle-kit.
// Гарантии от дублей заданы ограничениями базы, а не проверками в коде.
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  time,
  timestamp,
  uniqueIndex,
  unique,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import type { SessionState } from "../domain/learning/session.js";

const id = () => bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity();
const ref = (name: string) => bigint(name, { mode: "number" });
const timestampTz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => timestampTz("created_at").notNull().defaultNow();
const updatedAt = () =>
  timestampTz("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

// ---------- Перечисления ----------

/** Роль аккаунта одна. Пусто: аккаунт открыл бота, но роль ещё не получена. */
export const userRole = pgEnum("user_role", ["teacher", "student"]);

export const studentLinkStatus = pgEnum("student_link_status", [
  "pending_connection", // Ожидает подключения: Telegram-аккаунта нет
  "pending_confirmation", // Ожидает подтверждения преподавателя
  "active", // Подключён
  "ended", // Запись закрыта: ученик убран из списка
]);

export const invitationStatus = pgEnum("invitation_status", [
  "pending", // Ссылка выдана, ученик ещё не подтвердил присоединение
  "awaiting_teacher", // Активная заявка: ученик подтвердил, ждём код от преподавателя
  "approved",
  "rejected", // Отклонена преподавателем
  "revoked", // Ссылка отменена преподавателем
  "withdrawn", // Ученик перешёл к другому преподавателю
  "expired",
]);

export const studentCollectionStatus = pgEnum("student_collection_status", [
  "assigned", // Назначено
  "started", // Начал
  "practicing", // Практикует
  "completed", // Завершил
]);

export const wordStatus = pgEnum("word_status", ["learning", "hard", "mastered"]);

export const sessionType = pgEnum("session_type", [
  "test",
  "translate",
  "hard_words",
  "daily_quest",
  "exam",
]);

export const sessionStatus = pgEnum("session_status", ["current", "paused", "completed", "incomplete"]);

export const questionDirection = pgEnum("question_direction", ["ru_en", "en_ru"]);
export const questionFormat = pgEnum("question_format", ["choice", "typed"]);

export const questionStatus = pgEnum("question_status", [
  "open", // Ждём ответа на текущую попытку
  "awaiting_repeat", // Первая ошибка, повтор в конце серии
  "closed",
]);

export const notificationReason = pgEnum("notification_reason", [
  "join_request", // Преподавателю: новая заявка
  "request_withdrawn", // Преподавателю: ученик отменил заявку
  "link_confirmed", // Ученику: подключён
  "link_ended", // Ученику: преподаватель больше не ведёт занятия
  "request_rejected", // Заявителю: преподаватель отклонил заявку
  "new_collection",
  "collection_extended",
  "daily_reminder",
]);

export const notificationStatus = pgEnum("notification_status", [
  "pending",
  "sent",
  "failed",
  "blocked", // Получатель заблокировал бота
]);

// ---------- Пользователь и журналы ----------

export const users = pgTable("users", {
  id: id(),
  telegramId: bigint("telegram_id", { mode: "number" }).notNull().unique(),
  role: userRole("role"),
  telegramFirstName: text("telegram_first_name"),
  telegramLastName: text("telegram_last_name"),
  telegramUsername: text("telegram_username"),
  /** Часовой пояс IANA. Пока пусто, напоминания не отправляются. */
  timezone: text("timezone"),
  reminderTime: time("reminder_time").notNull().default("19:00"),
  remindersEnabled: boolean("reminders_enabled").notNull().default(true),
  /** Когда Telegram сообщил, что бот заблокирован. Пусто: не заблокирован. */
  botBlockedAt: timestampTz("bot_blocked_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Журнал администратора: кто, когда и кому менял роль. Администратор работает на сервере и записью в users не является. */
export const adminAuditLog = pgTable(
  "admin_audit_log",
  {
    id: id(),
    actor: text("actor").notNull(),
    targetUserId: ref("target_user_id")
      .notNull()
      .references(() => users.id),
    oldRole: userRole("old_role"),
    newRole: userRole("new_role"),
    createdAt: createdAt(),
  },
  (t) => [index("admin_audit_log_target_idx").on(t.targetUserId)],
);

/** Журнал обработанных update_id: повторная доставка события ничего не меняет. */
export const processedUpdates = pgTable("processed_updates", {
  updateId: bigint("update_id", { mode: "number" }).primaryKey(),
  processedAt: timestampTz("processed_at").notNull().defaultNow(),
});

/** Сессия кабинета. Хранится только хэш токена из cookie. */
export const webSessions = pgTable(
  "web_sessions",
  {
    id: id(),
    userId: ref("user_id")
      .notNull()
      .references(() => users.id),
    tokenHash: text("token_hash").notNull().unique(),
    csrfTokenHash: text("csrf_token_hash").notNull(),
    expiresAt: timestampTz("expires_at").notNull(),
    revokedAt: timestampTz("revoked_at"),
    lastSeenAt: timestampTz("last_seen_at"),
    createdAt: createdAt(),
  },
  (t) => [index("web_sessions_user_idx").on(t.userId)],
);

// ---------- Запись ученика, связь, приглашение ----------

/**
 * Запись ученика и связь с преподавателем. Новая связь — новая запись, даже с тем же преподавателем.
 * До подключения student_user_id пуст: запись существует без Telegram-аккаунта.
 */
export const studentLinks = pgTable(
  "student_links",
  {
    id: id(),
    teacherUserId: ref("teacher_user_id")
      .notNull()
      .references(() => users.id),
    /** Имя, заданное преподавателем. */
    displayName: text("display_name").notNull(),
    studentUserId: ref("student_user_id").references(() => users.id),
    status: studentLinkStatus("status").notNull().default("pending_connection"),
    startedAt: timestampTz("started_at"),
    endedAt: timestampTz("ended_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // У ученика не более одной активной связи.
    uniqueIndex("student_links_one_active_per_student")
      .on(t.studentUserId)
      .where(sql`${t.status} = 'active'`),
    index("student_links_teacher_idx").on(t.teacherUserId, t.status),
    index("student_links_student_idx").on(t.studentUserId),
    check(
      "student_links_account_matches_status",
      sql`(${t.status} = 'pending_connection' AND ${t.studentUserId} IS NULL)
        OR (${t.status} IN ('pending_confirmation', 'active') AND ${t.studentUserId} IS NOT NULL)
        OR ${t.status} = 'ended'`,
    ),
    check(
      "student_links_dates_match_status",
      sql`(${t.status} <> 'active' OR ${t.startedAt} IS NOT NULL)
        AND ((${t.status} = 'ended') = (${t.endedAt} IS NOT NULL))`,
    ),
  ],
);

/** Приглашение и заявка: один процесс от выдачи ссылки до результата. Токен и код хранятся только хэшами. */
export const invitations = pgTable(
  "invitations",
  {
    id: id(),
    studentLinkId: ref("student_link_id")
      .notNull()
      .references(() => studentLinks.id),
    tokenHash: text("token_hash").notNull().unique(),
    /** Срок ссылки: 7 дней. */
    expiresAt: timestampTz("expires_at").notNull(),
    status: invitationStatus("status").notNull().default("pending"),
    openedByTelegramId: bigint("opened_by_telegram_id", { mode: "number" }),
    /** Заявитель: заполняется, когда ученик подтвердил присоединение. */
    studentUserId: ref("student_user_id").references(() => users.id),
    requestedAt: timestampTz("requested_at"),
    /** Срок заявки: 7 дней с подтверждения учеником. */
    requestExpiresAt: timestampTz("request_expires_at"),
    codeHash: text("code_hash"),
    codeExpiresAt: timestampTz("code_expires_at"),
    codeAttempts: integer("code_attempts").notNull().default(0),
    resolvedAt: timestampTz("resolved_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // У ученика не более одной активной заявки.
    uniqueIndex("invitations_one_active_request_per_student")
      .on(t.studentUserId)
      .where(sql`${t.status} = 'awaiting_teacher'`),
    // У записи ученика не более одной действующей ссылки или заявки.
    uniqueIndex("invitations_one_live_per_link")
      .on(t.studentLinkId)
      .where(sql`${t.status} IN ('pending', 'awaiting_teacher')`),
    check("invitations_code_attempts_non_negative", sql`${t.codeAttempts} >= 0`),
    check(
      "invitations_request_has_student",
      sql`${t.status} <> 'awaiting_teacher' OR ${t.studentUserId} IS NOT NULL`,
    ),
  ],
);

// ---------- Материалы преподавателя ----------

export const sourceCollections = pgTable(
  "source_collections",
  {
    id: id(),
    teacherUserId: ref("teacher_user_id")
      .notNull()
      .references(() => users.id),
    title: text("title").notNull(),
    deletedAt: timestampTz("deleted_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("source_collections_teacher_idx").on(t.teacherUserId)],
);

/**
 * Карточка оригинала. Основной текст всегда считается верным,
 * accepted_* хранят только дополнительные варианты:
 * accepted_ru_en — ответы по-английски, accepted_en_ru — ответы по-русски.
 */
export const sourceCards = pgTable(
  "source_cards",
  {
    id: id(),
    collectionId: ref("collection_id")
      .notNull()
      .references(() => sourceCollections.id),
    position: integer("position").notNull(),
    english: text("english").notNull(),
    primaryTranslation: text("primary_translation").notNull(),
    acceptedRuEn: text("accepted_ru_en").array().notNull().default(sql`'{}'::text[]`),
    acceptedEnRu: text("accepted_en_ru").array().notNull().default(sql`'{}'::text[]`),
    example: text("example"),
    explanation: text("explanation"),
    allowOmitTo: boolean("allow_omit_to").notNull().default(false),
    deletedAt: timestampTz("deleted_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("source_cards_collection_idx").on(t.collectionId)],
);

// ---------- Слово ученика и личные копии ----------

/** Один счётчик на слово: уникально по ученику и нормализованной паре. */
export const studentWords = pgTable(
  "student_words",
  {
    id: id(),
    studentUserId: ref("student_user_id")
      .notNull()
      .references(() => users.id),
    normalizedEnglish: text("normalized_english").notNull(),
    normalizedTranslation: text("normalized_translation").notNull(),
    status: wordStatus("status").notNull().default("learning"),
    /** Серия «5 из 5». */
    correctStreak: integer("correct_streak").notNull().default(0),
    /** Ошибки подряд: освоенное слово возвращается в список после двух. */
    consecutiveErrors: integer("consecutive_errors").notNull().default(0),
    /**
     * Занятие, которое больше не может увеличить серию: в нём ответ уже засчитан в серию
     * или слово стало сложным. Отдельного поля «занятие, где слово стало сложным» нет.
     */
    lastCountedSessionId: ref("last_counted_session_id").references((): AnyPgColumn => sessions.id),
    hardSince: timestampTz("hard_since"),
    masteredAt: timestampTz("mastered_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("student_words_student_pair_unique").on(t.studentUserId, t.normalizedEnglish, t.normalizedTranslation),
    index("student_words_student_status_idx").on(t.studentUserId, t.status),
    check("student_words_streak_non_negative", sql`${t.correctStreak} >= 0`),
    check("student_words_errors_non_negative", sql`${t.consecutiveErrors} >= 0`),
  ],
);

/**
 * Личная копия подборки. Принадлежит записи ученика, поэтому может быть выдана до подключения.
 * Ученик определяется через student_links.student_user_id и сохраняет копии после отвязки.
 */
export const studentCollections = pgTable(
  "student_collections",
  {
    id: id(),
    studentLinkId: ref("student_link_id")
      .notNull()
      .references(() => studentLinks.id),
    sourceCollectionId: ref("source_collection_id")
      .notNull()
      .references(() => sourceCollections.id),
    title: text("title").notNull(),
    publishedAt: timestampTz("published_at").notNull().defaultNow(),
    status: studentCollectionStatus("status").notNull().default("assigned"),
    deletedAt: timestampTz("deleted_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Повторная выдача той же подборки в рамках связи не создаёт вторую копию.
    uniqueIndex("student_collections_one_copy_per_link")
      .on(t.studentLinkId, t.sourceCollectionId)
      .where(sql`${t.deletedAt} IS NULL`),
  ],
);

/** Карточка копии. Её содержимое лежит в card_versions; текущая версия — с наибольшим номером. */
export const studentCards = pgTable(
  "student_cards",
  {
    id: id(),
    studentCollectionId: ref("student_collection_id")
      .notNull()
      .references(() => studentCollections.id),
    /** Пусто у карточки, добавленной прямо в копию. */
    sourceCardId: ref("source_card_id").references(() => sourceCards.id),
    /** Пусто, пока у записи ученика нет Telegram-аккаунта. */
    studentWordId: ref("student_word_id").references(() => studentWords.id),
    position: integer("position").notNull(),
    addedAt: timestampTz("added_at").notNull().defaultNow(),
    deletedAt: timestampTz("deleted_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Повторная отправка не создаёт дубли карточек. Пустой source_card_id ограничением не считается.
    unique("student_cards_one_per_source").on(t.studentCollectionId, t.sourceCardId),
    index("student_cards_word_idx").on(t.studentWordId),
  ],
);

/** Неизменяемая версия карточки: правка создаёт новую, старые ответы ссылаются на прежнюю. */
export const cardVersions = pgTable(
  "card_versions",
  {
    id: id(),
    studentCardId: ref("student_card_id")
      .notNull()
      .references(() => studentCards.id),
    versionNumber: integer("version_number").notNull(),
    english: text("english").notNull(),
    primaryTranslation: text("primary_translation").notNull(),
    acceptedRuEn: text("accepted_ru_en").array().notNull().default(sql`'{}'::text[]`),
    acceptedEnRu: text("accepted_en_ru").array().notNull().default(sql`'{}'::text[]`),
    example: text("example"),
    explanation: text("explanation"),
    allowOmitTo: boolean("allow_omit_to").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    unique("card_versions_card_number_unique").on(t.studentCardId, t.versionNumber),
    check("card_versions_number_positive", sql`${t.versionNumber} >= 1`),
  ],
);

// ---------- Занятие, вопрос, попытка ----------

export type SessionPlanItem = {
  studentWordId: number;
  cardVersionId: number;
  direction: "ru_en" | "en_ru";
  format: "choice" | "typed";
};

export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    studentUserId: ref("student_user_id")
      .notNull()
      .references(() => users.id),
    /** Связь на момент начала занятия. Пусто, если ученик занимается после отвязки. */
    studentLinkId: ref("student_link_id").references(() => studentLinks.id),
    type: sessionType("type").notNull(),
    status: sessionStatus("status").notNull().default("current"),
    /** Подборка, по которой идёт занятие, если оно привязано к одной подборке. */
    studentCollectionId: ref("student_collection_id").references(() => studentCollections.id),
    /** Локальная дата ученика: только у квеста. */
    questLocalDate: date("quest_local_date", { mode: "string" }),
    /** Заранее составленный порядок вопросов. Сами вопросы создаются перед отправкой. */
    questionPlan: jsonb("question_plan").$type<SessionPlanItem[]>().notNull().default([]),
    /** Позиция текущего шага в плане: для чтения. Решения принимаются по learning_state. */
    currentStep: integer("current_step").notNull().default(0),
    /**
     * Состояние занятия из логики обучения: ответы, серия, очередь повторов.
     * К нему ученик возвращается после перерыва и перезапуска. Пусто только у закрытых демо-занятий этапа 1.
     */
    learningState: jsonb("learning_state").$type<SessionState>(),
    startedAt: timestampTz("started_at").notNull().defaultNow(),
    finishedAt: timestampTz("finished_at"),
    updatedAt: updatedAt(),
  },
  (t) => [
    // У ученика одно текущее занятие.
    uniqueIndex("sessions_one_current_per_student")
      .on(t.studentUserId)
      .where(sql`${t.status} = 'current'`),
    // Один квест на ученика и локальную дату.
    uniqueIndex("sessions_one_quest_per_local_date")
      .on(t.studentUserId, t.questLocalDate)
      .where(sql`${t.type} = 'daily_quest'`),
    index("sessions_link_idx").on(t.studentLinkId),
    check(
      "sessions_quest_date_only_for_quest",
      sql`(${t.type} = 'daily_quest') = (${t.questLocalDate} IS NOT NULL)`,
    ),
    check("sessions_step_non_negative", sql`${t.currentStep} >= 0`),
  ],
);

export type QuestionOption = { text: string };

/** Вопрос сохраняется до отправки вместе с вариантами и направлением. */
export const questions = pgTable(
  "questions",
  {
    id: id(),
    sessionId: ref("session_id")
      .notNull()
      .references(() => sessions.id),
    position: integer("position").notNull(),
    studentWordId: ref("student_word_id")
      .notNull()
      .references(() => studentWords.id),
    /** Версия, по которой задан вопрос: правка карточки на него не влияет. */
    cardVersionId: ref("card_version_id")
      .notNull()
      .references(() => cardVersions.id),
    direction: questionDirection("direction").notNull(),
    format: questionFormat("format").notNull(),
    /** Варианты кнопок. Пусто у вопроса с вводом ответа. */
    options: jsonb("options").$type<QuestionOption[]>(),
    correctOptionIndex: integer("correct_option_index"),
    status: questionStatus("status").notNull().default("open"),
    /**
     * Сообщение Telegram, в котором вопрос показан последний раз. Номера сообщений личного чата растут,
     * поэтому текст, отправленный раньше показа, ответом на этот вопрос не считается. Пусто: показ не записан.
     */
    promptMessageId: bigint("prompt_message_id", { mode: "number" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("questions_session_position_unique").on(t.sessionId, t.position),
    index("questions_word_idx").on(t.studentWordId),
    check(
      "questions_choice_has_options",
      sql`(${t.format} = 'choice') = (${t.options} IS NOT NULL AND ${t.correctOptionIndex} IS NOT NULL)`,
    ),
  ],
);

/**
 * Попытка неизменна: триггер attempts_immutable (миграция 0002) запрещает UPDATE. Повторение сложных слов
 * и повтор ошибки создают новые попытки, исходный результат занятия не переписывается.
 */
export const attempts = pgTable(
  "attempts",
  {
    id: id(),
    questionId: ref("question_id")
      .notNull()
      .references(() => questions.id),
    attemptNumber: integer("attempt_number").notNull(),
    /** Связь на момент ответа. Пусто после отвязки: история связей разделена. */
    studentLinkId: ref("student_link_id").references(() => studentLinks.id),
    selectedOptionIndex: integer("selected_option_index"),
    /** Текст ответа: введённый учеником или текст выбранного варианта. */
    answerText: text("answer_text").notNull(),
    isCorrect: boolean("is_correct").notNull(),
    /** Эта попытка сделала слово сложным: итог занятия показывает такие слова, даже если слово потом освоено. */
    becameHard: boolean("became_hard").notNull().default(false),
    /** Эта попытка завершила серию «5 из 5»: слово освоено и ушло из «Сложных слов». */
    becameMastered: boolean("became_mastered").notNull().default(false),
    answeredAt: timestampTz("answered_at").notNull().defaultNow(),
  },
  (t) => [
    // Старая кнопка и повтор события не создают вторую такую же попытку.
    unique("attempts_question_attempt_unique").on(t.questionId, t.attemptNumber),
    index("attempts_link_idx").on(t.studentLinkId),
    check("attempts_number_range", sql`${t.attemptNumber} IN (1, 2)`),
    check("attempts_hard_or_mastered", sql`NOT (${t.becameHard} AND ${t.becameMastered})`),
  ],
);

// ---------- Просмотры и уведомления ----------

export const cardViews = pgTable(
  "card_views",
  {
    id: id(),
    studentCardId: ref("student_card_id")
      .notNull()
      .references(() => studentCards.id),
    cardVersionId: ref("card_version_id")
      .notNull()
      .references(() => cardVersions.id),
    /** Связь на момент просмотра. Пусто после отвязки. */
    studentLinkId: ref("student_link_id").references(() => studentLinks.id),
    viewedAt: timestampTz("viewed_at").notNull().defaultNow(),
  },
  (t) => [
    index("card_views_card_idx").on(t.studentCardId),
    index("card_views_link_idx").on(t.studentLinkId),
  ],
);

/** Очередь уведомлений. dedupe_key гарантирует, что повторная постановка не создаст второе сообщение. */
export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    recipientUserId: ref("recipient_user_id")
      .notNull()
      .references(() => users.id),
    reason: notificationReason("reason").notNull(),
    dedupeKey: text("dedupe_key").notNull().unique(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: notificationStatus("status").notNull().default("pending"),
    deliveryAttempts: integer("delivery_attempts").notNull().default(0),
    nextAttemptAt: timestampTz("next_attempt_at").notNull().defaultNow(),
    lastError: text("last_error"),
    sentAt: timestampTz("sent_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("notifications_queue_idx")
      .on(t.nextAttemptAt)
      .where(sql`${t.status} = 'pending'`),
    index("notifications_recipient_idx").on(t.recipientUserId),
  ],
);

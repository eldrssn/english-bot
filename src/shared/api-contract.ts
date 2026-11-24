// Контракт HTTP API кабинета. Единственная зависимость — zod: файл импортирует и сервер, и фронтенд.
//
// Правила для клиента:
// - сессия лежит в cookie HttpOnly, поэтому запросы идут с того же адреса (credentials: "same-origin");
// - изменяющие запросы несут заголовок x-csrf-token со значением csrfToken из GET /api/auth/me;
// - токен ссылки в базе не хранится: url приглашения приходит только в ответе на его выдачу;
// - POST без тела отправляйте без заголовка Content-Type: иначе Fastify ответит 400;
// - чужая и завершённая запись ученика неотличимы от несуществующей: 404 not_found.
import { z } from "zod";

export const CSRF_HEADER = "x-csrf-token";

const timestamp = z.iso.datetime();

// ---------- Ошибки ----------

export const apiErrorCodes = [
  "bad_request", // 400: тело или параметры не прошли проверку
  "unauthorized", // 401: нет действующей сессии
  "no_access", // 403: у аккаунта нет роли преподавателя
  "csrf_failed", // 403: нет или неверный x-csrf-token
  "not_found", // 404: записи нет, она чужая или завершена
  "rate_limited", // 429: слишком часто; см. заголовок Retry-After
  "state_changed", // 409: состояние записи изменилось, обновите экран
  "link_not_pending", // 409: выдать или отменить ссылку можно только у записи «Ожидает подключения»
  "no_live_invitation", // 409: нет действующей ссылки
  "no_request", // 409: заявки нет или её срок истёк
  "request_pending", // 409: сначала подтвердите или отклоните заявку
  "wrong_code", // 422: неверный код, см. attemptsLeft
  "code_inactive", // 422: код истёк или исчерпаны попытки; ученик запрашивает новый в боте
  "invalid_card", // 422: карточка не прошла проверку, ошибки по-русски в details
  "duplicate_card", // 409: в подборке уже есть карточка с тем же словом и переводом
  "import_too_large", // 422: во вставке больше строк, чем разрешено; ничего не сохранено
  "internal", // 500
] as const;

export const apiErrorCode = z.enum(apiErrorCodes);
export type ApiErrorCode = z.infer<typeof apiErrorCode>;

export const apiError = z.object({
  error: z.object({
    code: apiErrorCode,
    message: z.string(),
    attemptsLeft: z.number().int().min(0).optional(),
    /** Подробности для invalid_card: понятные преподавателю ошибки карточки. */
    details: z.array(z.string()).optional(),
  }),
});
export type ApiError = z.infer<typeof apiError>;

// ---------- Вход ----------

/** Значения login_error в адресе главной после неудачного входа. */
export const loginErrorCodes = ["not_configured", "invalid_state", "denied", "failed"] as const;
export type LoginErrorCode = (typeof loginErrorCodes)[number];

export const meResponse = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("anonymous"),
    loginAvailable: z.boolean(),
    devLoginAvailable: z.boolean(),
  }),
  /** Вход прошёл, но роли нет: показать «нет доступа» и Telegram ID. Сессии с доступом к данным нет. */
  z.object({ status: z.literal("no_access"), telegramId: z.number().int() }),
  z.object({
    status: z.literal("teacher"),
    user: z.object({
      telegramId: z.number().int(),
      name: z.string().nullable(),
      username: z.string().nullable(),
    }),
    csrfToken: z.string(),
  }),
]);
export type MeResponse = z.infer<typeof meResponse>;

// ---------- Ученики ----------

export const studentStatus = z.enum(["pending_connection", "pending_confirmation", "active"]);
export type StudentStatus = z.infer<typeof studentStatus>;

/** Что ждёт от преподавателя запись в списке. */
export const pendingAction = z.enum(["send_link", "wait_for_student", "confirm_request"]);
export type PendingAction = z.infer<typeof pendingAction>;

export const displayName = z.string().trim().min(1).max(100);

export const studentListItem = z.object({
  id: z.number().int(),
  displayName: z.string(),
  status: studentStatus,
  /** Telegram-имя и username заявителя или ученика. Пусто, пока аккаунта нет. */
  telegramName: z.string().nullable(),
  telegramUsername: z.string().nullable(),
  /** Последняя активность в рамках текущей связи. */
  lastActivityAt: timestamp.nullable(),
  pendingAction: pendingAction.nullable(),
});
export type StudentListItem = z.infer<typeof studentListItem>;

export const joinRequest = z.object({
  telegramId: z.number().int(),
  telegramName: z.string().nullable(),
  telegramUsername: z.string().nullable(),
  requestedAt: timestamp,
  /** Срок заявки: 7 дней с подтверждения учеником. */
  expiresAt: timestamp,
  /** inactive: код истёк или исчерпаны попытки, ученик запрашивает новый в боте. */
  codeState: z.enum(["active", "inactive"]),
  attemptsLeft: z.number().int().min(0),
});
export type JoinRequest = z.infer<typeof joinRequest>;

export const invitationOutcome = z.enum(["expired", "revoked", "rejected", "withdrawn"]);
export type InvitationOutcome = z.infer<typeof invitationOutcome>;

export const studentDetail = studentListItem.extend({
  startedAt: timestamp.nullable(),
  invitation: z.object({
    /** Действующая ссылка. Сам адрес больше не показать: в базе только хэш. */
    live: z.boolean(),
    expiresAt: timestamp.nullable(),
    /** Чем закончилась предыдущая ссылка записи: withdrawn значит, что ученик отменил заявку. */
    lastOutcome: invitationOutcome.nullable(),
  }),
  request: joinRequest.nullable(),
  /** Выданные подборки текущей связи. */
  collections: z.array(
    z.object({
      id: z.number().int(),
      title: z.string(),
      status: z.enum(["assigned", "started", "practicing", "completed"]),
      publishedAt: timestamp,
      wordCount: z.number().int(),
      /** Исходная подборка, из которой выдана копия. Может принадлежать и служебному преподавателю тестовых данных. */
      sourceCollectionId: z.number().int(),
    }),
  ),
});
export type StudentDetail = z.infer<typeof studentDetail>;

export const invitationResponse = z.object({ url: z.string(), expiresAt: timestamp });
export type InvitationResponse = z.infer<typeof invitationResponse>;

export const dashboardResponse = z.object({
  /** Все записи в списке, кроме завершённых. */
  studentCount: z.number().int(),
  activeStudentCount: z.number().int(),
  pendingRequests: z.array(
    z.object({
      studentId: z.number().int(),
      displayName: z.string(),
      telegramName: z.string().nullable(),
      telegramUsername: z.string().nullable(),
      requestedAt: timestamp,
      expiresAt: timestamp,
    }),
  ),
});
export type DashboardResponse = z.infer<typeof dashboardResponse>;

export const studentsResponse = z.object({ students: z.array(studentListItem) });
export type StudentsResponse = z.infer<typeof studentsResponse>;

export const createStudentBody = z.object({ displayName });
export type CreateStudentBody = z.infer<typeof createStudentBody>;
export const createStudentResponse = z.object({ student: studentDetail, invitation: invitationResponse });
export type CreateStudentResponse = z.infer<typeof createStudentResponse>;

export const renameStudentBody = z.object({ displayName });
export type RenameStudentBody = z.infer<typeof renameStudentBody>;

export const approveRequestBody = z.object({ code: z.string().trim().regex(/^\d{6}$/, "ожидается 6 цифр") });
export type ApproveRequestBody = z.infer<typeof approveRequestBody>;

export const requestResponse = z.object({ request: joinRequest.nullable() });
export type RequestResponse = z.infer<typeof requestResponse>;

// ---------- Материалы: исходные подборки и карточки ----------
//
// Карточка проверяется на сервере общим модулем src/shared/card-import (prepareCard и validateCard):
// пробелы обрезаются, варианты ответа можно прислать списком или строкой через «;».
// Ошибки проверки: 422 invalid_card с текстами в error.details. Дубль (то же слово и тот же перевод
// после нормализации) среди действующих карточек подборки: 409 duplicate_card, ничего не сохранено.

/** Ограничения здесь только от злоупотреблений; правила карточки — в validateCard. */
const answerList = z.union([z.array(z.string().max(1000)).max(200), z.string().max(20000)]);

export const cardInput = z.object({
  english: z.string().max(1000),
  translation: z.string().max(1000),
  example: z.string().max(5000).nullable().optional(),
  explanation: z.string().max(5000).nullable().optional(),
  /** Дополнительные ответы ru→en (по-английски). */
  acceptedRuEn: answerList.optional(),
  /** Дополнительные ответы en→ru (по-русски). */
  acceptedEnRu: answerList.optional(),
  /** Можно отвечать без `to`: только для английского текста вида «to go». */
  allowOmitTo: z.boolean().optional(),
});
export type CardInput = z.infer<typeof cardInput>;

/** Содержимое карточки в том виде, как оно сохранено. */
const cardContent = z.object({
  english: z.string(),
  translation: z.string(),
  example: z.string().nullable(),
  explanation: z.string().nullable(),
  acceptedRuEn: z.array(z.string()),
  acceptedEnRu: z.array(z.string()),
  allowOmitTo: z.boolean(),
});
export type CardContent = z.infer<typeof cardContent>;

export const collectionTitle = z.string().trim().min(1).max(200);

export const sourceCard = cardContent.extend({
  id: z.number().int(),
  /** Порядок в подборке: 0, 1, 2… */
  position: z.number().int(),
  updatedAt: timestamp,
});
export type SourceCard = z.infer<typeof sourceCard>;

export const sourceCollectionListItem = z.object({
  id: z.number().int(),
  title: z.string(),
  /** Действующие карточки. */
  cardCount: z.number().int(),
  /** Выдачи: копии у учеников текущего списка, не забранные. */
  issuedCount: z.number().int(),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type SourceCollectionListItem = z.infer<typeof sourceCollectionListItem>;

export const sourceCollectionsResponse = z.object({ collections: z.array(sourceCollectionListItem) });
export type SourceCollectionsResponse = z.infer<typeof sourceCollectionsResponse>;

export const sourceCollectionDetail = sourceCollectionListItem.extend({
  cards: z.array(sourceCard),
});
export type SourceCollectionDetail = z.infer<typeof sourceCollectionDetail>;

export const collectionTitleBody = z.object({ title: collectionTitle });
export type CollectionTitleBody = z.infer<typeof collectionTitleBody>;

export const sourceCardResponse = z.object({ card: sourceCard });
export type SourceCardResponse = z.infer<typeof sourceCardResponse>;

/** Новый порядок: ID всех действующих карточек подборки ровно по разу. Иначе 409 state_changed. */
export const reorderCardsBody = z.object({ cardIds: z.array(z.number().int().positive()).max(5000) });
export type ReorderCardsBody = z.infer<typeof reorderCardsBody>;

// ---------- Импорт ----------

/** Текст вставки из таблицы или содержимое CSV-файла (UTF-8). Файл клиент читает сам и присылает текстом. */
export const importBody = z.object({ text: z.string().max(1_000_000) });
export type ImportBody = z.infer<typeof importBody>;

export const importRow = z.object({
  /** Номер строки во вставке, с единицы. */
  line: z.number().int(),
  /** Карточка после подготовки; null, если строку не удалось прочитать. */
  card: cardContent.nullable(),
  errors: z.array(z.string()),
  /** in_import: повтор строки line этой же вставки; existing: такая карточка уже есть в подборке. */
  duplicate: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("in_import"), line: z.number().int() }),
      z.object({ kind: z.literal("existing") }),
    ])
    .nullable(),
});
export type ImportRow = z.infer<typeof importRow>;

/** Предпросмотр: ничего не сохраняется. Сохранятся строки без ошибок и не дубли. */
export const importPreviewResponse = z.object({
  rows: z.array(importRow),
  /** Определённый разделитель столбцов: табуляция (вставка из таблицы), запятая или точка с запятой. */
  delimiter: z.enum(["tab", "comma", "semicolon"]),
  hasHeader: z.boolean(),
  /** Строк больше лимита: сохранение ответит 422 import_too_large. */
  tooManyRows: z.boolean(),
  maxRows: z.number().int(),
  /** Сколько строк будет добавлено и сколько пропущено. */
  toAdd: z.number().int(),
  invalid: z.number().int(),
  duplicates: z.number().int(),
});
export type ImportPreviewResponse = z.infer<typeof importPreviewResponse>;

/** Сохранение: сервер заново разбирает присланный текст, а не доверяет предпросмотру. Всё или ничего. */
export const importResponse = z.object({
  added: z.number().int(),
  /** Пропущены строки с ошибками и дубли. */
  skippedInvalid: z.number().int(),
  skippedDuplicates: z.number().int(),
  collection: sourceCollectionDetail,
});
export type ImportResponse = z.infer<typeof importResponse>;

// ---------- Выдача ----------

/** Записи ученика из «Мои ученики»: подключённые, ожидающие подключения или подтверждения. */
export const issueBody = z.object({
  studentIds: z.array(z.number().int().positive()).min(1).max(100),
});
export type IssueBody = z.infer<typeof issueBody>;

/**
 * now — уведомление «Новая подборка» придёт сразу;
 * after_connection — копия сохранится, уведомление придёт после подтверждения связи («Не подключён»);
 * already_issued — у ученика уже есть копия этой подборки, вторая не создаётся и уведомления нет.
 */
export const issueOutcome = z.enum(["now", "after_connection", "already_issued"]);
export type IssueOutcome = z.infer<typeof issueOutcome>;

export const issuePreviewResponse = z.object({
  recipients: z.array(
    z.object({
      studentId: z.number().int(),
      displayName: z.string(),
      status: studentStatus,
      outcome: issueOutcome,
      /** Текст уведомления, которое получит ученик; null при already_issued. */
      message: z.string().nullable(),
    }),
  ),
});
export type IssuePreviewResponse = z.infer<typeof issuePreviewResponse>;

/** Итог по каждому ученику. Выдача атомарна для каждого ученика отдельно; повтор запроса дублей не создаёт. */
export const issueResponse = z.object({
  results: z.array(
    z.object({
      studentId: z.number().int(),
      displayName: z.string(),
      outcome: issueOutcome,
      /** Копия ученика: новая или уже существовавшая. */
      copyId: z.number().int(),
    }),
  ),
});
export type IssueResponse = z.infer<typeof issueResponse>;

// ---------- Копия ученика ----------

export const copyCard = cardContent.extend({
  id: z.number().int(),
  position: z.number().int(),
  /** Номер текущей версии: правка создаёт новую. */
  versionNumber: z.number().int(),
  /** Карточка исходной подборки; null у карточки, добавленной прямо в копию. */
  sourceCardId: z.number().int().nullable(),
  addedAt: timestamp,
  /** Добавлена после выдачи: в боте помечается как новая. */
  isNew: z.boolean(),
});
export type CopyCard = z.infer<typeof copyCard>;

export const copyDetail = z.object({
  id: z.number().int(),
  /** Запись ученика. */
  studentId: z.number().int(),
  studentDisplayName: z.string(),
  studentStatus,
  title: z.string(),
  sourceCollectionId: z.number().int(),
  status: z.enum(["assigned", "started", "practicing", "completed"]),
  publishedAt: timestamp,
  cards: z.array(copyCard),
});
export type CopyDetail = z.infer<typeof copyDetail>;

/** Добавление карточек в копию одним действием: одно уведомление «В подборку добавлены слова». */
export const addCopyCardsBody = z.object({ cards: z.array(cardInput).min(1).max(500) });
export type AddCopyCardsBody = z.infer<typeof addCopyCardsBody>;

export const addCopyCardsResponse = z.object({
  added: z.number().int(),
  /** Индексы присланных карточек, которые не добавлены как дубли (в копии или в самом запросе). */
  duplicates: z.array(z.number().int()),
  /** now — уведомление в очереди; none — ничего не добавлено или связь ещё не подтверждена (придёт «Новая подборка»). */
  notification: z.enum(["now", "none"]),
  copy: copyDetail,
});
export type AddCopyCardsResponse = z.infer<typeof addCopyCardsResponse>;

// ---------- Маршруты ----------

const emptyResponse = z.object({ ok: z.literal(true) });

/**
 * Полный список маршрутов. access:
 * public — без сессии; teacher — сессия и роль; остальные — ещё и право на объект :id:
 *   own-student — своя запись ученика, не завершённая;
 *   own-collection — своя исходная подборка, не удалённая;
 *   own-source-card — действующая карточка своей исходной подборки;
 *   own-copy — копия, выданная своей не завершённой записи ученика, не забранная;
 *   own-copy-card — действующая карточка такой копии.
 * Чужой, удалённый и несуществующий объект неотличимы: 404 not_found. Права проверяются до разбора тела.
 * Для всех изменяющих запросов, кроме public, обязателен CSRF (в том числе для POST-предпросмотров).
 * navigation — переход браузера, а не fetch.
 */
export const apiRoutes = {
  telegramLoginStart: { method: "GET", path: "/api/auth/telegram/start", access: "public", navigation: true },
  telegramLoginCallback: { method: "GET", path: "/api/auth/telegram/callback", access: "public", navigation: true },
  /** Есть, только если сервер запущен с DEV_LOGIN_TELEGRAM_ID (me покажет devLoginAvailable). */
  devLogin: { method: "GET", path: "/api/auth/dev-login", access: "public", navigation: true },
  me: { method: "GET", path: "/api/auth/me", access: "public", response: meResponse },
  /** При действующей сессии требует x-csrf-token. */
  logout: { method: "POST", path: "/api/auth/logout", access: "public", response: emptyResponse },

  dashboard: { method: "GET", path: "/api/dashboard", access: "teacher", response: dashboardResponse },
  listStudents: { method: "GET", path: "/api/students", access: "teacher", response: studentsResponse },
  createStudent: {
    method: "POST",
    path: "/api/students",
    access: "teacher",
    body: createStudentBody,
    response: createStudentResponse,
  },

  getStudent: { method: "GET", path: "/api/students/:id", access: "own-student", response: studentDetail },
  renameStudent: {
    method: "PATCH",
    path: "/api/students/:id",
    access: "own-student",
    body: renameStudentBody,
    response: studentDetail,
  },
  /** Убрать из моих учеников: действующая связь или запись без аккаунта. При заявке — 409 request_pending. */
  unlinkStudent: { method: "POST", path: "/api/students/:id/unlink", access: "own-student", response: emptyResponse },
  /** Новая ссылка. Прежняя действующая перестаёт работать. */
  issueInvitation: {
    method: "POST",
    path: "/api/students/:id/invitation",
    access: "own-student",
    response: invitationResponse,
  },
  revokeInvitation: {
    method: "DELETE",
    path: "/api/students/:id/invitation",
    access: "own-student",
    response: studentDetail,
  },
  getRequest: { method: "GET", path: "/api/students/:id/request", access: "own-student", response: requestResponse },
  /** Ввод кода и подтверждение одним действием. Неверный код: 422 wrong_code, попытка засчитана. */
  approveRequest: {
    method: "POST",
    path: "/api/students/:id/request/approve",
    access: "own-student",
    body: approveRequestBody,
    response: studentDetail,
  },
  rejectRequest: {
    method: "POST",
    path: "/api/students/:id/request/reject",
    access: "own-student",
    response: studentDetail,
  },

  // ---------- Исходные подборки ----------

  listCollections: { method: "GET", path: "/api/collections", access: "teacher", response: sourceCollectionsResponse },
  createCollection: {
    method: "POST",
    path: "/api/collections",
    access: "teacher",
    body: collectionTitleBody,
    response: sourceCollectionDetail,
  },
  getCollection: { method: "GET", path: "/api/collections/:id", access: "own-collection", response: sourceCollectionDetail },
  renameCollection: {
    method: "PATCH",
    path: "/api/collections/:id",
    access: "own-collection",
    body: collectionTitleBody,
    response: sourceCollectionDetail,
  },
  /** Мягкое удаление: подборка пропадает из списка, выданные копии остаются у учеников. */
  deleteCollection: { method: "DELETE", path: "/api/collections/:id", access: "own-collection", response: emptyResponse },
  /** Ручное добавление в конец. Дубль: 409 duplicate_card. Копии не меняются. */
  addCollectionCard: {
    method: "POST",
    path: "/api/collections/:id/cards",
    access: "own-collection",
    body: cardInput,
    response: sourceCardResponse,
  },
  reorderCollectionCards: {
    method: "PUT",
    path: "/api/collections/:id/order",
    access: "own-collection",
    body: reorderCardsBody,
    response: sourceCollectionDetail,
  },
  /** Правка на месте: уже выданные копии не меняются. */
  editSourceCard: {
    method: "PATCH",
    path: "/api/source-cards/:id",
    access: "own-source-card",
    body: cardInput,
    response: sourceCardResponse,
  },
  deleteSourceCard: { method: "DELETE", path: "/api/source-cards/:id", access: "own-source-card", response: emptyResponse },
  importPreview: {
    method: "POST",
    path: "/api/collections/:id/import/preview",
    access: "own-collection",
    body: importBody,
    response: importPreviewResponse,
  },
  importCards: {
    method: "POST",
    path: "/api/collections/:id/import",
    access: "own-collection",
    body: importBody,
    response: importResponse,
  },
  /** Кому и какое уведомление придёт. Ничего не меняет. Чужая или завершённая запись в списке: 404. */
  issuePreview: {
    method: "POST",
    path: "/api/collections/:id/issue/preview",
    access: "own-collection",
    body: issueBody,
    response: issuePreviewResponse,
  },
  /** Выдача: каждому ученику независимая копия. Чужая или завершённая запись в списке: 404, никому не выдано. */
  issueCollection: {
    method: "POST",
    path: "/api/collections/:id/issue",
    access: "own-collection",
    body: issueBody,
    response: issueResponse,
  },

  // ---------- Копия ученика (список копий — collections в GET /api/students/:id) ----------

  getCopy: { method: "GET", path: "/api/copies/:id", access: "own-copy", response: copyDetail },
  /** «Забрать у ученика»: копия скрывается из бота, история ответов сохраняется, занятие по ней завершается. */
  withdrawCopy: { method: "DELETE", path: "/api/copies/:id", access: "own-copy", response: emptyResponse },
  addCopyCards: {
    method: "POST",
    path: "/api/copies/:id/cards",
    access: "own-copy",
    body: addCopyCardsBody,
    response: addCopyCardsResponse,
  },
  /** Новая версия карточки. Дубль внутри копии: 409 duplicate_card. Без изменений версия не создаётся. */
  editCopyCard: {
    method: "PATCH",
    path: "/api/copy-cards/:id",
    access: "own-copy-card",
    body: cardInput,
    response: copyDetail,
  },
  deleteCopyCard: { method: "DELETE", path: "/api/copy-cards/:id", access: "own-copy-card", response: copyDetail },
} as const;

export type ApiRoutes = typeof apiRoutes;

import type {
  InvitationOutcome,
  IssueOutcome,
  LoginErrorCode,
  PendingAction,
  ResultSession,
  Score,
  SessionKind,
  StudentDetail,
  StudentStatus,
  WordState,
} from "../../shared/api-contract";

/** Формулировки статусов из плана разработки. */
export const STATUS_LABEL: Record<StudentStatus, string> = {
  pending_connection: "Ожидает подключения",
  pending_confirmation: "Ожидает подтверждения преподавателя",
  active: "Подключён",
};

export const PENDING_ACTION_LABEL: Record<PendingAction, string> = {
  send_link: "Выдать новую ссылку",
  wait_for_student: "Ученик ещё не открыл ссылку",
  confirm_request: "Проверить заявку",
};

export const COLLECTION_STATUS_LABEL: Record<StudentDetail["collections"][number]["status"], string> = {
  assigned: "Назначено",
  started: "Начал",
  practicing: "Практикует",
  completed: "Завершил",
};

export const OUTCOME_LABEL: Record<InvitationOutcome, string> = {
  expired: "Срок прежней ссылки истёк.",
  revoked: "Прежняя ссылка отменена.",
  rejected: "Прежняя заявка отклонена.",
  withdrawn: "Ученик отменил заявку: он подключается к другому преподавателю или передумал.",
};

export const LOGIN_ERROR_TEXT: Record<LoginErrorCode, string> = {
  not_configured: "Вход через Telegram на этом сервере не настроен. Сообщите администратору.",
  invalid_state: "Вход прервался: прошло слишком много времени или он начат в другой вкладке. Попробуйте ещё раз.",
  denied: "Вход отменён в Telegram. Чтобы открыть кабинет, разрешите вход.",
  failed: "Telegram не подтвердил вход. Попробуйте ещё раз.",
};

const sameYear = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
const otherYear = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return (date.getFullYear() === new Date().getFullYear() ? sameYear : otherYear).format(date);
}

const plural = new Intl.PluralRules("ru-RU");

/** Форма слова: one — «попытка», few — «попытки», many — «попыток». */
export function pluralize(count: number, forms: { one: string; few: string; many: string }): string {
  const category = plural.select(count);
  return category === "one" ? forms.one : category === "few" ? forms.few : forms.many;
}

export const attemptsText = (count: number) =>
  `${pluralize(count, { one: "Осталась", few: "Осталось", many: "Осталось" })} ${count} ${pluralize(count, { one: "попытка", few: "попытки", many: "попыток" })}`;

export const wordsText = (count: number) => `${count} ${pluralize(count, { one: "слово", few: "слова", many: "слов" })}`;

export const cardsText = (count: number) => `${count} ${pluralize(count, { one: "карточка", few: "карточки", many: "карточек" })}`;

export const studentsText = (count: number) => `${count} ${pluralize(count, { one: "ученик", few: "ученика", many: "учеников" })}`;

/** Исход выдачи для ученика: в предпросмотре и в результате. */
export const ISSUE_OUTCOME_LABEL: Record<IssueOutcome, { preview: string; done: string }> = {
  now: { preview: "Получит сразу", done: "Выдана, уведомление уходит сейчас" },
  after_connection: {
    preview: "Получит после подключения",
    done: "Выдана, уведомление придёт после подключения",
  },
  already_issued: { preview: "Уже выдана, второй копии не будет", done: "Уже была выдана раньше" },
};

export const SESSION_KIND_LABEL: Record<SessionKind, string> = {
  test: "Тест",
  translate: "«Переведи меня»",
  hard_words: "Практика сложных слов",
  daily_quest: "Ежедневный квест",
  exam: "Экзамен",
};

export const SESSION_STATUS_LABEL: Record<ResultSession["status"], string> = {
  current: "Идёт",
  paused: "На паузе",
  completed: "Завершено",
  incomplete: "Не завершено",
};

export const WORD_STATE_LABEL: Record<WordState, string> = {
  hard: "Сложное",
  learning: "Изучается",
  mastered: "Освоено",
};

/** «4 из 6 (67%)»; без ответов — «нет ответов». */
export function scoreText(score: Score): string {
  if (score.total === 0) return "нет ответов";
  return `${score.correct} из ${score.total} (${Math.round((score.correct / score.total) * 100)}%)`;
}

/** Название занятия: вид и подборка, если она есть. */
export const sessionTitle = (type: SessionKind, title: string | null) =>
  title ? `${SESSION_KIND_LABEL[type]}: ${title}` : SESSION_KIND_LABEL[type];

export const DIRECTION_LABEL = { ru_en: "ru→en", en_ru: "en→ru" } as const;

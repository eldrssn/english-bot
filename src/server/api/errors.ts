import type { ApiErrorCode } from "../../shared/api-contract.js";

const STATUS: Record<ApiErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  no_access: 403,
  csrf_failed: 403,
  not_found: 404,
  rate_limited: 429,
  state_changed: 409,
  link_not_pending: 409,
  no_live_invitation: 409,
  no_request: 409,
  request_pending: 409,
  wrong_code: 422,
  code_inactive: 422,
  invalid_card: 422,
  duplicate_card: 409,
  import_too_large: 422,
  internal: 500,
};

const MESSAGES: Record<ApiErrorCode, string> = {
  bad_request: "Проверьте введённые данные.",
  unauthorized: "Войдите в кабинет.",
  no_access: "У этого аккаунта нет доступа к кабинету.",
  csrf_failed: "Обновите страницу и повторите действие.",
  not_found: "Запись не найдена.",
  rate_limited: "Слишком много попыток. Подождите немного.",
  state_changed: "Состояние записи изменилось. Обновите страницу.",
  link_not_pending: "Для этой записи ссылка не выдаётся.",
  no_live_invitation: "Действующей ссылки нет.",
  no_request: "Заявки нет или её срок истёк.",
  request_pending: "Сначала подтвердите или отклоните заявку.",
  wrong_code: "Неверный код.",
  code_inactive: "Код истёк или закончились попытки. Ученик может запросить новый в боте.",
  invalid_card: "Проверьте карточку.",
  duplicate_card: "В подборке уже есть карточка с тем же словом и переводом.",
  import_too_large: "Слишком много строк. Разделите вставку на части.",
  internal: "Что-то пошло не так. Попробуйте ещё раз.",
};

export class ApiFailure extends Error {
  override name = "ApiFailure";
  readonly status: number;

  constructor(
    readonly code: ApiErrorCode,
    readonly extra: { attemptsLeft?: number; retryAfterSeconds?: number; details?: string[] } = {},
  ) {
    super(code);
    this.status = STATUS[code];
  }
}

export function errorBody(code: ApiErrorCode, attemptsLeft?: number, details?: string[]) {
  return {
    error: {
      code,
      message: MESSAGES[code],
      ...(attemptsLeft === undefined ? {} : { attemptsLeft }),
      ...(details === undefined ? {} : { details }),
    },
  };
}

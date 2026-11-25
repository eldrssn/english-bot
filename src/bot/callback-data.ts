// Данные кнопок ограничены 64 байтами Telegram, поэтому содержат только ID.
// В ответе есть номер попытки: кнопка первой попытки не должна засчитаться как повтор.

export const answerButton = (questionId: number, attemptNumber: number, optionIndex: number) =>
  `q:${questionId}:${attemptNumber}:${optionIndex}`;
export const ANSWER_PATTERN = /^q:(\d{1,15}):(\d{1,15}):(\d{1,15})$/;

// Привязка. Токен ссылки входит в кнопку: 43 символа плюс префикс укладываются в лимит,
// а подделать чужой ID в данных кнопки было бы проще, чем угадать токен.
export const joinButton = (token: string) => `jn:${token}`;
export const JOIN_PATTERN = /^jn:([A-Za-z0-9_-]{1,64})$/;
export const switchButton = (token: string) => `sw:${token}`;
export const SWITCH_PATTERN = /^sw:([A-Za-z0-9_-]{1,64})$/;
export const DECLINE_JOIN = "join:no";
export const NEW_CODE = "code:new";

// Меню ученика и учебные разделы. Владельца проверяет сервис: ID в кнопке ничего не разрешает.
export const MENU = "m:main";
/** Кнопки «появится позже» из сообщений до этапа 6: ведут в настоящие разделы. */
export const SOON_PATTERN = /^m:soon:(daily|exam|progress|settings)$/;
export type SoonSection = "daily" | "exam" | "progress" | "settings";

export const wordsPage = (page: number) => `w:p:${page}`;
export const WORDS_PAGE_PATTERN = /^w:p:(\d{1,15})$/;
export const wordCard = (wordId: number, page: number) => `w:o:${wordId}:${page}`;
export const WORD_CARD_PATTERN = /^w:o:(\d{1,15}):(\d{1,15})$/;

export const collectionsPage = (page: number) => `c:l:${page}`;
export const COLLECTIONS_PAGE_PATTERN = /^c:l:(\d{1,15})$/;
export const collectionPage = (collectionId: number, page: number) => `c:v:${collectionId}:${page}`;
export const COLLECTION_PAGE_PATTERN = /^c:v:(\d{1,15}):(\d{1,15})$/;
/** «Посмотреть» из уведомления: подборка приходит новым сообщением, а уведомление остаётся в чате. */
export const collectionFromNotification = (collectionId: number) => `c:n:${collectionId}`;
export const COLLECTION_NOTIFICATION_PATTERN = /^c:n:(\d{1,15})$/;
export const collectionCard = (cardId: number, page: number) => `c:o:${cardId}:${page}`;
export const COLLECTION_CARD_PATTERN = /^c:o:(\d{1,15}):(\d{1,15})$/;

export const startTest = (collectionId: number) => `t:s:${collectionId}`;
export const START_TEST_PATTERN = /^t:s:(\d{1,15})$/;
export const resumeSession = (sessionId: number) => `t:r:${sessionId}`;
export const RESUME_PATTERN = /^t:r:(\d{1,15})$/;
export const pauseSession = (sessionId: number) => `t:p:${sessionId}`;
export const PAUSE_PATTERN = /^t:p:(\d{1,15})$/;
export const startTranslate = (collectionId: number) => `tr:s:${collectionId}`;
export const START_TRANSLATE_PATTERN = /^tr:s:(\d{1,15})$/;

// Сложные слова. Выбор слов для повторения хранится в самой кнопке: номер страницы и битовая маска пунктов
// этой страницы (на странице не больше 8 пунктов). Слова по маске находит бот, проверяет сервис.
export const hardWordsPage = (page: number, mask = 0) => `h:l:${page}:${mask}`;
export const HARD_WORDS_PAGE_PATTERN = /^h:l:(\d{1,15}):(\d{1,3})$/;
export const START_HARD_ALL = "h:a";
export const startHardSelected = (page: number, mask: number) => `h:s:${page}:${mask}`;
export const START_HARD_SELECTED_PATTERN = /^h:s:(\d{1,15}):(\d{1,3})$/;

// Ежедневная практика, экзамен, прогресс. «Начать» из напоминания и из раздела — одна кнопка:
// она открывает сегодняшний квест, а второй за день не создаёт.
export const DAILY_OPEN = "d:o";
export const DAILY_START = "d:s";
export const EXAM_OPEN = "e:o";
export const EXAM_START = "e:s";
export const PROGRESS_OPEN = "p:o";

// Настройки. Пояс в кнопке — имя IANA: список в боте может меняться, а старая кнопка останется понятной.
export const SETTINGS_OPEN = "s:o";
export const remindersToggle = (enabled: boolean) => `s:r:${enabled ? 1 : 0}`;
export const REMINDERS_TOGGLE_PATTERN = /^s:r:([01])$/;
export const REMINDER_TIME_LIST = "s:tl";
export const reminderTimeButton = (minutes: number) => `s:t:${minutes}`;
export const REMINDER_TIME_PATTERN = /^s:t:(\d{1,4})$/;
export const timezoneList = (page: number) => `s:zl:${page}`;
export const TIMEZONE_LIST_PATTERN = /^s:zl:(\d{1,2})$/;
export const timezoneButton = (zone: string) => `s:z:${zone}`;
export const TIMEZONE_PATTERN = /^s:z:([A-Za-z0-9_+\-/]{1,60})$/;

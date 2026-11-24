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
export const soonButton = (section: SoonSection) => `m:soon:${section}`;
export const SOON_PATTERN = /^m:soon:(hard|daily|exam|progress|settings)$/;
export type SoonSection = "hard" | "daily" | "exam" | "progress" | "settings";

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
